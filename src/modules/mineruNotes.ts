import {
  isMineruStoreOutputInNotesEnabled,
  isMineruUpdateExistingNotesEnabled,
} from "../utils/mineruConfig";

const MINERU_NOTE_MARKER = "LLM_FOR_ZOTERO_MINERU_NOTE_V1";
const MINERU_MODEL_VERSION = "pipeline";
const FNV1A_32_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;
const MINERU_NOTE_HEADER_PATTERN = new RegExp(
  [
    `${MINERU_NOTE_MARKER}\\s*[\\r\\n]+`,
    "attachment_id=(\\d+)\\s*[\\r\\n]+",
    "parent_item_id=(\\d+|none)\\s*[\\r\\n]+",
    "parsed_at=[^\\r\\n]+\\s*[\\r\\n]+",
    "mineru_version=[^\\r\\n]+\\s*[\\r\\n]+",
    "content_hash=([a-f0-9]{8,64})",
  ].join(""),
  "i",
);

type MineruNoteHeader = {
  attachmentId: number;
  parentItemId: number | null;
  contentHash: string;
};

type PersistMineruNoteParams = {
  attachmentId: number;
  parentItemId: number | null;
  libraryID: number;
  mdContent: string;
  parsedAt?: string;
};

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toTextContent(noteHtml: string): string {
  try {
    const Parser = (
      globalThis as typeof globalThis & { DOMParser?: typeof DOMParser }
    ).DOMParser;
    if (Parser) {
      const parsed = new Parser().parseFromString(noteHtml, "text/html");
      const text = parsed.body?.textContent;
      if (typeof text === "string") return text;
    }
  } catch {
    /* ignore */
  }
  return noteHtml;
}

function parseMineruNoteHeader(noteText: string): MineruNoteHeader | null {
  const match = noteText.match(MINERU_NOTE_HEADER_PATTERN);
  if (!match) return null;
  const attachmentId = Number(match[1]);
  const parentRaw = match[2];
  const contentHash = (match[3] || "").toLowerCase();
  if (!Number.isFinite(attachmentId) || attachmentId <= 0) return null;
  let parentItemId: number | null = null;
  if (parentRaw !== "none") {
    const parsedParent = Number.parseInt(parentRaw, 10);
    parentItemId = Number.isFinite(parsedParent) && parsedParent > 0
      ? parsedParent
      : null;
  }
  return { attachmentId, parentItemId, contentHash };
}

function renderMineruNoteText(params: {
  attachmentId: number;
  parentItemId: number | null;
  parsedAt: string;
  contentHash: string;
  mdContent: string;
}): string {
  const parentText = params.parentItemId ? String(params.parentItemId) : "none";
  return [
    MINERU_NOTE_MARKER,
    `attachment_id=${params.attachmentId}`,
    `parent_item_id=${parentText}`,
    `parsed_at=${params.parsedAt}`,
    `mineru_version=${MINERU_MODEL_VERSION}`,
    `content_hash=${params.contentHash}`,
    "",
    "---",
    "",
    params.mdContent,
  ].join("\n");
}

function renderMineruNoteHtml(text: string): string {
  return `<pre>${escapeHtml(text)}</pre>`;
}

function fnv1aHash32(input: string): string {
  let hash = FNV1A_32_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV1A_32_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function computeContentHash(mdContent: string): Promise<string> {
  const bytes = new TextEncoder().encode(mdContent);
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle?.digest) {
      const digest = await subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest))
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    /* fall back to FNV hash */
  }
  return fnv1aHash32(mdContent);
}

async function searchCandidateMineruNotes(libraryID: number): Promise<number[]> {
  try {
    const search = new Zotero.Search({ libraryID });
    search.addCondition("itemType", "is", "note");
    search.addCondition("quicksearch-everything", "contains", MINERU_NOTE_MARKER);
    const ids = await search.search();
    return ids
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0);
  } catch {
    return [];
  }
}

async function findExistingMineruNote(
  attachmentId: number,
  parentItemId: number | null,
  libraryID: number,
): Promise<Zotero.Item | null> {
  let candidateIds: number[] = [];
  if (parentItemId && parentItemId > 0) {
    const parentItem = Zotero.Items.get(parentItemId);
    if (parentItem?.isRegularItem?.()) {
      candidateIds = (parentItem.getNotes?.() || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0);
    }
  }
  if (!candidateIds.length) {
    candidateIds = await searchCandidateMineruNotes(libraryID);
  }
  if (!candidateIds.length) return null;

  const matches: Array<{ note: Zotero.Item; sameParent: boolean }> = [];
  for (const noteId of candidateIds) {
    const note = Zotero.Items.get(noteId);
    if (!note?.isNote?.()) continue;
    const raw = note.getNote?.() || "";
    const header = parseMineruNoteHeader(toTextContent(raw));
    if (!header || header.attachmentId !== attachmentId) continue;
    const sameParent = (header.parentItemId || null) === (parentItemId || null);
    matches.push({ note, sameParent });
  }

  if (!matches.length) return null;
  const preferred = matches.find((entry) => entry.sameParent);
  return (preferred || matches[0]).note;
}

export async function persistMineruNote(
  params: PersistMineruNoteParams,
): Promise<void> {
  if (!isMineruStoreOutputInNotesEnabled()) return;
  if (!params.mdContent.trim()) return;

  const contentHash = await computeContentHash(params.mdContent);
  const parsedAt = params.parsedAt || new Date().toISOString();
  const noteText = renderMineruNoteText({
    attachmentId: params.attachmentId,
    parentItemId: params.parentItemId,
    parsedAt,
    contentHash,
    mdContent: params.mdContent,
  });
  const noteHtml = renderMineruNoteHtml(noteText);

  if (isMineruUpdateExistingNotesEnabled()) {
    const existing = await findExistingMineruNote(
      params.attachmentId,
      params.parentItemId,
      params.libraryID,
    );
    if (existing) {
      const existingHeader = parseMineruNoteHeader(
        toTextContent(existing.getNote?.() || ""),
      );
      if (existingHeader?.contentHash === contentHash) {
        return;
      }
      existing.setNote(noteHtml);
      await existing.saveTx();
      return;
    }
  }

  const note = new Zotero.Item("note");
  note.libraryID = params.libraryID;
  if (params.parentItemId && params.parentItemId > 0) {
    note.parentID = params.parentItemId;
  }
  note.setNote(noteHtml);
  await note.saveTx();
}
