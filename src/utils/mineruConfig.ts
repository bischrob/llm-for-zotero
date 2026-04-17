import { config } from "../../package.json";

const MINERU_ENABLED_KEY = `${config.prefsPrefix}.mineruEnabled`;
const MINERU_API_KEY_KEY = `${config.prefsPrefix}.mineruApiKey`;
const MINERU_AUTO_WATCH_KEY = `${config.prefsPrefix}.mineruAutoWatchCollections`;
const MINERU_GLOBAL_AUTO_PARSE_KEY = `${config.prefsPrefix}.mineruGlobalAutoParse`;
const MINERU_STORE_OUTPUT_IN_NOTES_KEY = `${config.prefsPrefix}.mineruStoreOutputInNotes`;
const MINERU_UPDATE_EXISTING_NOTES_KEY = `${config.prefsPrefix}.mineruUpdateExistingNotes`;
const MINERU_AUTO_SPLIT_KEY = `${config.prefsPrefix}.mineruAutoSplit`;
const MINERU_SPLIT_PAGES_PER_CHUNK_KEY = `${config.prefsPrefix}.mineruSplitPagesPerChunk`;

export function isMineruEnabled(): boolean {
  const value = Zotero.Prefs.get(MINERU_ENABLED_KEY, true);
  return value === true || `${value || ""}`.toLowerCase() === "true";
}

export function getMineruApiKey(): string {
  const value = Zotero.Prefs.get(MINERU_API_KEY_KEY, true);
  return typeof value === "string" ? value : "";
}

export function setMineruEnabled(value: boolean): void {
  Zotero.Prefs.set(MINERU_ENABLED_KEY, value, true);
}

export function setMineruApiKey(value: string): void {
  Zotero.Prefs.set(MINERU_API_KEY_KEY, value, true);
}

// ── Global Auto-Parse Configuration ──────────────────────────────────────────

export function isGlobalAutoParseEnabled(): boolean {
  const value = Zotero.Prefs.get(MINERU_GLOBAL_AUTO_PARSE_KEY, true);
  return value === true || `${value || ""}`.toLowerCase() === "true";
}

export function setGlobalAutoParseEnabled(value: boolean): void {
  Zotero.Prefs.set(MINERU_GLOBAL_AUTO_PARSE_KEY, value, true);
}

// ── Note Persistence Configuration ────────────────────────────────────────────

export function isMineruStoreOutputInNotesEnabled(): boolean {
  const value = Zotero.Prefs.get(MINERU_STORE_OUTPUT_IN_NOTES_KEY, true);
  return value === true || `${value || ""}`.toLowerCase() === "true";
}

export function setMineruStoreOutputInNotesEnabled(value: boolean): void {
  Zotero.Prefs.set(MINERU_STORE_OUTPUT_IN_NOTES_KEY, value, true);
}

export function isMineruUpdateExistingNotesEnabled(): boolean {
  const value = Zotero.Prefs.get(MINERU_UPDATE_EXISTING_NOTES_KEY, true);
  return value === true || `${value || ""}`.toLowerCase() === "true";
}

export function setMineruUpdateExistingNotesEnabled(value: boolean): void {
  Zotero.Prefs.set(MINERU_UPDATE_EXISTING_NOTES_KEY, value, true);
}

// ── Auto-Split Configuration ──────────────────────────────────────────────────

/** Default max pages per chunk when auto-splitting. */
export const DEFAULT_SPLIT_PAGES_PER_CHUNK = 100;

/**
 * Whether the auto-split retry should trigger when a PDF is too large for a
 * single MinerU parse.  Defaults to true.
 */
export function isMineruAutoSplitEnabled(): boolean {
  const value = Zotero.Prefs.get(MINERU_AUTO_SPLIT_KEY, true);
  // Default to true when the preference has never been set
  if (value === undefined || value === null) return true;
  return value === true || `${value}`.toLowerCase() === "true";
}

export function setMineruAutoSplitEnabled(value: boolean): void {
  Zotero.Prefs.set(MINERU_AUTO_SPLIT_KEY, value, true);
}

/**
 * Number of pages per chunk when auto-splitting.  Must be ≥ 1.
 */
export function getMineruSplitPagesPerChunk(): number {
  const raw = Zotero.Prefs.get(MINERU_SPLIT_PAGES_PER_CHUNK_KEY, true);
  const n = typeof raw === "number" ? raw : parseInt(`${raw || ""}`, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_SPLIT_PAGES_PER_CHUNK;
}

export function setMineruSplitPagesPerChunk(value: number): void {
  const safe =
    Number.isFinite(value) && value >= 1
      ? Math.floor(value)
      : DEFAULT_SPLIT_PAGES_PER_CHUNK;
  Zotero.Prefs.set(MINERU_SPLIT_PAGES_PER_CHUNK_KEY, safe, true);
}

// ── Auto-Watch Collections Configuration ─────────────────────────────────────

export function getAutoWatchCollectionIds(): Set<number> {
  const value = Zotero.Prefs.get(MINERU_AUTO_WATCH_KEY, true);
  const str = typeof value === "string" ? value : "";
  if (!str) return new Set();
  const ids = str
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
  return new Set(ids);
}

export function setAutoWatchCollectionIds(ids: Set<number>): void {
  const str = Array.from(ids).join(",");
  Zotero.Prefs.set(MINERU_AUTO_WATCH_KEY, str, true);
}

export function addAutoWatchCollection(collectionId: number): void {
  const ids = getAutoWatchCollectionIds();
  ids.add(collectionId);
  setAutoWatchCollectionIds(ids);
}

export function removeAutoWatchCollection(collectionId: number): void {
  const ids = getAutoWatchCollectionIds();
  ids.delete(collectionId);
  setAutoWatchCollectionIds(ids);
}

export function isAutoWatchCollection(collectionId: number): boolean {
  return getAutoWatchCollectionIds().has(collectionId);
}

// ── Filename Exclusion Patterns ─────────────────────────────────────────────

const MINERU_EXCLUDE_PATTERNS_KEY = `${config.prefsPrefix}.mineruExcludePatterns`;

export function getMineruExcludePatterns(): string[] {
  const raw = Zotero.Prefs.get(MINERU_EXCLUDE_PATTERNS_KEY, true);
  const str = typeof raw === "string" ? raw : "";
  if (!str) return [];
  try {
    const parsed = JSON.parse(str);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map((v) => v.trim());
  } catch {
    return [];
  }
}

export function setMineruExcludePatterns(patterns: string[]): void {
  Zotero.Prefs.set(MINERU_EXCLUDE_PATTERNS_KEY, JSON.stringify(patterns), true);
}

export function isFilenameExcluded(filename: string): boolean {
  const patterns = getMineruExcludePatterns();
  if (patterns.length === 0) return false;
  const lower = filename.toLowerCase();
  for (const pat of patterns) {
    if (pat.startsWith("/") && pat.endsWith("/") && pat.length > 2) {
      try {
        if (new RegExp(pat.slice(1, -1), "i").test(filename)) return true;
      } catch {
        /* invalid regex — skip */
      }
    } else {
      if (lower.includes(pat.toLowerCase())) return true;
    }
  }
  return false;
}
