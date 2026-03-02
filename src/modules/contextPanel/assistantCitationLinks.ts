import { sanitizeText, setStatus } from "./textUtils";
import { formatPaperCitationLabel, formatPaperSourceLabel, resolvePaperContextRefFromAttachment } from "./paperAttribution";
import {
  normalizePaperContextRefs,
  normalizeSelectedTextPaperContexts,
} from "./normalizers";
import { getActiveReaderForSelectedTab, resolveContextSourceItem } from "./contextResolution";
import {
  flashPageInLivePdfReader,
  locateQuoteInLivePdfReader,
  warmPageTextCache,
} from "./livePdfSelectionLocator";
import { resolveConversationBaseItem } from "./portalScope";
import type { Message, PaperContextRef } from "./types";

export type AssistantCitationPaperCandidate = {
  paperContext: PaperContextRef;
  contextItemId: number;
  sourceLabel: string;
  citationLabel: string;
  normalizedSourceLabel: string;
  normalizedCitationLabel: string;
};

type ExtractedCitationLabel = {
  sourceLabel: string;
  citationLabel: string;
  normalizedSourceLabel: string;
  normalizedCitationLabel: string;
};

const citationPageCache = new Map<
  string,
  {
    pageIndex: number;
    pageLabel?: string;
  }
>();

export function formatSourceLabelWithPage(
  baseSourceLabel: string,
  pageLabel: string,
): string {
  if (!pageLabel) return baseSourceLabel;
  const match = baseSourceLabel.match(/^\((.+)\)$/);
  if (!match) return baseSourceLabel;
  return `(${match[1]}, page ${pageLabel})`;
}

function normalizeCitationLabel(value: string): string {
  return sanitizeText(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Extract the author surname from a citation label for fuzzy matching.
 * E.g. "zheng et al., 2026" → "zheng", "(zheng et al., 2026)" → "zheng"
 */
function extractAuthorKey(normalizedLabel: string): string {
  const stripped = normalizedLabel.replace(/^\(|\)$/g, "").trim();
  const match = stripped.match(/^(\S+)\s+et\s+al/i);
  return match ? match[1].replace(/[,;.]+$/g, "") : "";
}

function normalizeQuoteKey(value: string): string {
  return sanitizeText(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildCitationCacheKey(contextItemId: number, quoteText: string): string {
  return `${Math.floor(contextItemId)}\u241f${normalizeQuoteKey(quoteText)}`;
}

function getReaderItemId(reader: any): number {
  const raw = Number(reader?._item?.id || reader?.itemID || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function getSelectedTextCount(message: Message | null | undefined): number {
  const selectedTexts = Array.isArray(message?.selectedTexts)
    ? message!.selectedTexts!.filter(
        (entry): entry is string => typeof entry === "string" && Boolean(entry.trim()),
      )
    : [];
  if (selectedTexts.length) return selectedTexts.length;
  return typeof message?.selectedText === "string" && message.selectedText.trim()
    ? 1
    : 0;
}

function getFirstPdfAttachment(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!item) return null;
  if (
    item.isAttachment?.() &&
    item.attachmentContentType === "application/pdf"
  ) {
    return item;
  }
  const attachments = item.getAttachments?.() || [];
  for (const attachmentId of attachments) {
    const attachment = Zotero.Items.get(attachmentId) || null;
    if (attachment?.attachmentContentType === "application/pdf") {
      return attachment;
    }
  }
  return null;
}

function addCitationCandidate(
  out: AssistantCitationPaperCandidate[],
  seen: Set<string>,
  paperContext: PaperContextRef | null | undefined,
  contextItemId?: number | null,
): void {
  const normalizedContextItemId = Number(contextItemId || paperContext?.contextItemId || 0);
  if (!paperContext || !Number.isFinite(normalizedContextItemId) || normalizedContextItemId <= 0) {
    return;
  }
  const dedupeKey = `${Math.floor(paperContext.itemId)}:${Math.floor(normalizedContextItemId)}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  const sourceLabel = formatPaperSourceLabel(paperContext);
  const citationLabel = formatPaperCitationLabel(paperContext);
  out.push({
    paperContext,
    contextItemId: Math.floor(normalizedContextItemId),
    sourceLabel,
    citationLabel,
    normalizedSourceLabel: normalizeCitationLabel(sourceLabel),
    normalizedCitationLabel: normalizeCitationLabel(citationLabel),
  });
}

function collectAssistantCitationCandidates(
  panelItem: Zotero.Item,
  pairedUserMessage: Message | null | undefined,
): AssistantCitationPaperCandidate[] {
  const out: AssistantCitationPaperCandidate[] = [];
  const seen = new Set<string>();

  const selectedTextPaperContexts = normalizeSelectedTextPaperContexts(
    pairedUserMessage?.selectedTextPaperContexts,
    getSelectedTextCount(pairedUserMessage),
    { sanitizeText },
  );
  for (const paperContext of selectedTextPaperContexts) {
    addCitationCandidate(
      out,
      seen,
      paperContext,
      paperContext?.contextItemId,
    );
  }

  const paperContexts = normalizePaperContextRefs(
    pairedUserMessage?.paperContexts,
    { sanitizeText },
  );
  for (const paperContext of paperContexts) {
    addCitationCandidate(out, seen, paperContext, paperContext.contextItemId);
  }

  const resolvedContextItem = resolveContextSourceItem(panelItem).contextItem;
  const resolvedContextRef = resolvePaperContextRefFromAttachment(resolvedContextItem);
  addCitationCandidate(
    out,
    seen,
    resolvedContextRef,
    resolvedContextItem?.id,
  );

  const basePaper = resolveConversationBaseItem(panelItem);
  const basePaperAttachment = getFirstPdfAttachment(basePaper);
  const basePaperRef = resolvePaperContextRefFromAttachment(basePaperAttachment);
  addCitationCandidate(out, seen, basePaperRef, basePaperAttachment?.id);

  return out;
}

function buildCandidateListFromPaperContexts(
  paperContexts: PaperContextRef[],
): AssistantCitationPaperCandidate[] {
  return paperContexts.map((paperContext) => ({
    paperContext,
    contextItemId: Math.floor(paperContext.contextItemId),
    sourceLabel: formatPaperSourceLabel(paperContext),
    citationLabel: formatPaperCitationLabel(paperContext),
    normalizedSourceLabel: normalizeCitationLabel(formatPaperSourceLabel(paperContext)),
    normalizedCitationLabel: normalizeCitationLabel(formatPaperCitationLabel(paperContext)),
  }));
}

function getNextElementSibling(element: Element): Element | null {
  let current = element.nextElementSibling;
  while (current) {
    const text = sanitizeText(current.textContent || "").trim();
    if (text) return current;
    current = current.nextElementSibling;
  }
  return null;
}

export function extractStandalonePaperSourceLabel(
  value: string,
): ExtractedCitationLabel | null {
  const normalized = sanitizeText(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const match = normalized.match(/^\((.+)\)$/);
  if (!match) return null;
  const citationLabel = match[1].trim();
  if (!citationLabel || citationLabel.length < 4) return null;
  return {
    sourceLabel: `(${citationLabel})`,
    citationLabel,
    normalizedSourceLabel: normalizeCitationLabel(`(${citationLabel})`),
    normalizedCitationLabel: normalizeCitationLabel(citationLabel),
  };
}

export function matchAssistantCitationCandidates(
  citationLineText: string,
  paperContexts: PaperContextRef[],
): AssistantCitationPaperCandidate[] {
  const extracted = extractStandalonePaperSourceLabel(citationLineText);
  if (!extracted) return [];
  const candidates = buildCandidateListFromPaperContexts(paperContexts);
  return candidates.filter(
    (candidate) =>
      candidate.normalizedSourceLabel === extracted.normalizedSourceLabel ||
      candidate.normalizedCitationLabel === extracted.normalizedCitationLabel,
  );
}

async function waitForReaderForItem(targetItemId: number): Promise<any | null> {
  const normalizedTargetItemId = Math.floor(targetItemId);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1600) {
    const activeReader = getActiveReaderForSelectedTab();
    if (getReaderItemId(activeReader) === normalizedTargetItemId) {
      return activeReader;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return null;
}

async function openReaderForItem(targetItemId: number): Promise<any | null> {
  const normalizedTargetItemId = Math.floor(targetItemId);
  const activeReader = getActiveReaderForSelectedTab();
  if (getReaderItemId(activeReader) === normalizedTargetItemId) {
    return activeReader;
  }

  const readerApi = Zotero.Reader as
    | {
        open?: (
          itemID: number,
          location?: _ZoteroTypes.Reader.Location,
        ) => Promise<void | _ZoteroTypes.ReaderInstance>;
      }
    | undefined;
  if (typeof readerApi?.open === "function") {
    const openedReader = await readerApi.open(normalizedTargetItemId);
    if (getReaderItemId(openedReader) === normalizedTargetItemId) {
      return openedReader;
    }
  } else {
    const pane = Zotero.getActiveZoteroPane?.() as
      | {
          viewPDF?: (
            itemID: number,
            location: _ZoteroTypes.Reader.Location,
          ) => Promise<void>;
        }
      | undefined;
    if (typeof pane?.viewPDF === "function") {
      await pane.viewPDF(normalizedTargetItemId, {});
    }
  }

  return waitForReaderForItem(normalizedTargetItemId);
}

async function navigateReaderToPage(
  reader: any,
  pageIndex: number,
  pageLabel?: string,
): Promise<void> {
  if (typeof reader?.navigate !== "function") return;
  await reader.navigate({
    pageIndex: Math.floor(pageIndex),
    pageLabel: pageLabel || `${Math.floor(pageIndex) + 1}`,
  });
}

async function navigateToCachedCitationPage(
  contextItemId: number,
  quoteText: string,
): Promise<boolean> {
  const cacheKey = buildCitationCacheKey(contextItemId, quoteText);
  const cached = citationPageCache.get(cacheKey);
  if (!cached) return false;
  const reader = await openReaderForItem(contextItemId);
  if (!reader) return false;
  await navigateReaderToPage(reader, cached.pageIndex, cached.pageLabel);
  await flashPageInLivePdfReader(reader, cached.pageIndex);
  return true;
}

function sortCandidatesForActiveReader(
  candidates: AssistantCitationPaperCandidate[],
): AssistantCitationPaperCandidate[] {
  const activeReaderItemId = getReaderItemId(getActiveReaderForSelectedTab());
  if (!activeReaderItemId) return candidates.slice();
  return candidates
    .slice()
    .sort((left, right) =>
      Number(right.contextItemId === activeReaderItemId) -
      Number(left.contextItemId === activeReaderItemId),
    );
}

function updateCitationButtonPage(
  button: HTMLButtonElement,
  baseSourceLabel: string,
  pageLabel: string,
): void {
  if (!button || !pageLabel) return;
  if (!button.isConnected) return;
  const labelWithPage = formatSourceLabelWithPage(baseSourceLabel, pageLabel);
  button.textContent = labelWithPage;
}

async function resolvePageForCitationButton(params: {
  button: HTMLButtonElement;
  baseSourceLabel: string;
  candidates: AssistantCitationPaperCandidate[];
  quoteText: string;
}): Promise<void> {
  try {
    for (const candidate of params.candidates) {
      const cacheKey = buildCitationCacheKey(candidate.contextItemId, params.quoteText);
      const cached = citationPageCache.get(cacheKey);
      if (cached?.pageLabel) {
        updateCitationButtonPage(params.button, params.baseSourceLabel, cached.pageLabel);
        return;
      }
    }

    const activeReader = getActiveReaderForSelectedTab();
    if (!activeReader) return;
    const activeReaderItemId = getReaderItemId(activeReader);
    if (!activeReaderItemId) return;

    const matchingCandidate = params.candidates.find(
      (candidate) => candidate.contextItemId === activeReaderItemId,
    );
    if (!matchingCandidate) return;

    const result = await locateQuoteInLivePdfReader(activeReader, params.quoteText);
    if (result.status === "resolved" && result.computedPageIndex !== null) {
      const pageIndex = Math.floor(result.computedPageIndex);
      const pageLabel = `${pageIndex + 1}`;
      citationPageCache.set(
        buildCitationCacheKey(matchingCandidate.contextItemId, params.quoteText),
        { pageIndex, pageLabel },
      );
      updateCitationButtonPage(params.button, params.baseSourceLabel, pageLabel);
    }
  } catch {
    // Silently ignore eager resolution failures
  }
}

/**
 * Dynamically resolve fallback candidates from the panel item / active reader
 * at interaction time.  This runs when the static candidate list from the user
 * message turns out to be empty (e.g. because paperContexts weren't stored or
 * the agent was not enabled).
 */
function resolveFallbackCandidates(
  panelItem: Zotero.Item,
): AssistantCitationPaperCandidate[] {
  const out: AssistantCitationPaperCandidate[] = [];
  const seen = new Set<string>();

  // 1. Try the contextItem resolved from the active PDF reader tab
  const resolvedContextItem = resolveContextSourceItem(panelItem).contextItem;
  const resolvedContextRef = resolvePaperContextRefFromAttachment(resolvedContextItem);
  addCitationCandidate(out, seen, resolvedContextRef, resolvedContextItem?.id);

  // 2. Try the base paper's first PDF attachment
  const basePaper = resolveConversationBaseItem(panelItem);
  const basePaperAttachment = getFirstPdfAttachment(basePaper);
  const basePaperRef = resolvePaperContextRefFromAttachment(basePaperAttachment);
  addCitationCandidate(out, seen, basePaperRef, basePaperAttachment?.id);

  // 3. Try the active reader directly (handles cases where panelItem
  //    doesn't resolve but a PDF reader IS open)
  if (!out.length) {
    const activeReader = getActiveReaderForSelectedTab();
    const readerItemId = getReaderItemId(activeReader);
    if (readerItemId > 0) {
      const readerItem = Zotero.Items.get(readerItemId) || null;
      if (readerItem) {
        const readerRef = resolvePaperContextRefFromAttachment(readerItem);
        addCitationCandidate(out, seen, readerRef, readerItemId);
      }
    }
  }

  return out;
}

async function resolveAndNavigateAssistantCitation(params: {
  body: Element;
  button: HTMLButtonElement;
  baseSourceLabel: string;
  candidates: AssistantCitationPaperCandidate[];
  panelItem: Zotero.Item;
  quoteText: string;
}): Promise<void> {
  const status = params.body.querySelector("#llm-status") as HTMLElement | null;
  if (params.button.dataset.loading === "true") return;
  params.button.dataset.loading = "true";
  params.button.disabled = true;

  try {
    // Build effective candidates: use provided ones, plus a dynamic fallback
    // from the active reader or panel item when candidates are empty.
    const effectiveCandidates = params.candidates.length
      ? params.candidates
      : resolveFallbackCandidates(params.panelItem);
    const orderedCandidates = sortCandidatesForActiveReader(effectiveCandidates);
    for (const candidate of orderedCandidates) {
      const cached = await navigateToCachedCitationPage(
        candidate.contextItemId,
        params.quoteText,
      );
      if (cached) {
        const cacheKey = buildCitationCacheKey(candidate.contextItemId, params.quoteText);
        const cachedEntry = citationPageCache.get(cacheKey);
        if (cachedEntry?.pageLabel) {
          updateCitationButtonPage(params.button, params.baseSourceLabel, cachedEntry.pageLabel);
        }
        if (status) setStatus(status, "Jumped to cited source", "ready");
        return;
      }
    }

    if (status) setStatus(status, "Locating cited quote...", "sending");
    let lastReason = "Could not resolve the cited quote to a unique page.";

    // Last-resort: if there are still no candidates, try the active reader
    // directly without needing a candidate entry.
    if (!orderedCandidates.length) {
      const activeReader = getActiveReaderForSelectedTab();
      if (activeReader) {
        const result = await locateQuoteInLivePdfReader(activeReader, params.quoteText);
        if (result.status === "resolved" && result.computedPageIndex !== null) {
          const pageIndex = Math.floor(result.computedPageIndex);
          const pageLabel = `${pageIndex + 1}`;
          await navigateReaderToPage(activeReader, pageIndex, pageLabel);
          await flashPageInLivePdfReader(activeReader, pageIndex);
          updateCitationButtonPage(params.button, params.baseSourceLabel, pageLabel);
          if (status) setStatus(status, `Jumped to cited source (page ${pageLabel})`, "ready");
          return;
        }
        if (result.reason) lastReason = result.reason;
        else if (result.status === "not-found") lastReason = "The cited quote was not found in the paper text.";
        else if (result.status === "ambiguous") lastReason = "The cited quote matched multiple pages.";
      } else {
        lastReason = "No PDF reader is currently open.";
      }
    }

    for (const candidate of orderedCandidates) {
      const reader = await openReaderForItem(candidate.contextItemId);
      if (!reader) {
        lastReason = "Could not open the cited paper.";
        continue;
      }
      const result = await locateQuoteInLivePdfReader(reader, params.quoteText);
      if (result.status === "resolved" && result.computedPageIndex !== null) {
        const pageIndex = Math.floor(result.computedPageIndex);
        const pageLabel = `${pageIndex + 1}`;
        citationPageCache.set(
          buildCitationCacheKey(candidate.contextItemId, params.quoteText),
          { pageIndex, pageLabel },
        );
        await navigateReaderToPage(reader, pageIndex, pageLabel);
        await flashPageInLivePdfReader(reader, pageIndex);
        updateCitationButtonPage(params.button, params.baseSourceLabel, pageLabel);
        if (status) {
          setStatus(status, `Jumped to cited source (page ${pageLabel})`, "ready");
        }
        return;
      }
      if (result.reason) {
        lastReason = result.reason;
      } else if (result.status === "ambiguous") {
        lastReason = "The cited quote matched multiple pages.";
      } else if (result.status === "not-found") {
        lastReason = "The cited quote was not found in the paper text.";
      }
    }

    if (status) setStatus(status, lastReason, "error");
  } catch (error) {
    ztoolkit.log("LLM: Failed to navigate assistant citation", error);
    if (status) {
      setStatus(status, "Could not open the cited source", "error");
    }
  } finally {
    params.button.disabled = false;
    params.button.dataset.loading = "false";
  }
}

export function decorateAssistantCitationLinks(params: {
  body: Element;
  panelItem: Zotero.Item;
  bubble: HTMLDivElement;
  assistantMessage: Message;
  pairedUserMessage?: Message | null;
}): void {
  if (!params.assistantMessage.text.trim()) return;
  const ownerDoc = params.bubble.ownerDocument;
  if (!ownerDoc) return;

  // Pre-warm the page text cache in the background so that when the user
  // clicks a citation button the lookup is instant (pure in-memory search).
  const activeReader = getActiveReaderForSelectedTab();
  if (activeReader) {
    void warmPageTextCache(activeReader);
  }

  // Collect paper context candidates from the user message and panel item.
  // This list may be empty (e.g. when the agent is disabled and no paper
  // contexts were forwarded).  Buttons are still created in that case — the
  // click handler will dynamically resolve a fallback from the panel item.
  const candidates = collectAssistantCitationCandidates(
    params.panelItem,
    params.pairedUserMessage,
  );

  const blockquotes = Array.from(
    params.bubble.querySelectorAll("blockquote"),
  ) as Element[];
  ztoolkit.log("LLM citation decoration: blockquotes found =", blockquotes.length,
    "candidates =", candidates.length,
    "bubble HTML length =", String(params.bubble.innerHTML || "").length,
    "bubble child count =", params.bubble.childElementCount);
  for (const blockquote of blockquotes) {
    const quoteText = sanitizeText(blockquote.textContent || "").trim();
    if (!quoteText) continue;
    const citationEl = getNextElementSibling(blockquote);
    if (!citationEl) {
      ztoolkit.log("LLM citation decoration: no sibling for blockquote, text =",
        (blockquote.textContent || "").slice(0, 60));
      continue;
    }
    const extractedCitation = extractStandalonePaperSourceLabel(
      citationEl.textContent || "",
    );
    if (!extractedCitation) {
      ztoolkit.log("LLM citation decoration: sibling text not a citation, text =",
        JSON.stringify((citationEl.textContent || "").slice(0, 80)));
      continue;
    }
    ztoolkit.log("LLM citation decoration: creating button for", extractedCitation.sourceLabel);

    // Try to match the citation label against known paper candidates.
    const matchingCandidates: AssistantCitationPaperCandidate[] = candidates.filter(
      (candidate) =>
        candidate.normalizedSourceLabel === extractedCitation.normalizedSourceLabel ||
        candidate.normalizedCitationLabel === extractedCitation.normalizedCitationLabel,
    );
    if (!matchingCandidates.length && candidates.length) {
      // Fuzzy fallback: match by author surname only
      const citationAuthorKey = extractAuthorKey(extractedCitation.normalizedCitationLabel);
      if (citationAuthorKey) {
        const fuzzy = candidates.filter(
          (candidate) => extractAuthorKey(candidate.normalizedCitationLabel) === citationAuthorKey,
        );
        if (fuzzy.length) {
          matchingCandidates.push(...fuzzy);
        }
      }
    }
    if (!matchingCandidates.length && candidates.length === 1) {
      // Single-candidate fallback: if only one paper in context, use it
      matchingCandidates.push(candidates[0]);
    }
    // NOTE: matchingCandidates may still be empty here.  That is fine — the
    // click handler will resolve fallback candidates dynamically.

    const baseSourceLabel = extractedCitation.sourceLabel;
    const citationButton = ownerDoc.createElement("button") as HTMLButtonElement;
    citationButton.type = "button";
    citationButton.className = "llm-paper-citation-link";
    citationButton.textContent = baseSourceLabel;
    citationButton.title = "Jump to the cited source in the paper";
    citationButton.dataset.loading = "false";

    const handleCitationClick = () => {
      void resolveAndNavigateAssistantCitation({
        body: params.body,
        button: citationButton,
        baseSourceLabel,
        candidates: matchingCandidates,
        panelItem: params.panelItem,
        quoteText,
      });
    };

    citationButton.addEventListener("mousedown", (event: Event) => {
      const mouse = event as MouseEvent;
      if (typeof mouse.button === "number" && mouse.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      handleCitationClick();
    });
    citationButton.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    citationButton.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      handleCitationClick();
    });

    citationEl.classList.add("llm-paper-citation-row");
    citationEl.textContent = "";
    citationEl.appendChild(citationButton);

    if (matchingCandidates.length) {
      void resolvePageForCitationButton({
        button: citationButton,
        baseSourceLabel,
        candidates: matchingCandidates,
        quoteText,
      });
    }
  }
}
