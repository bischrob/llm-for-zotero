import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  normalizeToolPaperContext,
  ok,
  validateObject,
} from "../shared";
import type { PaperContextRef } from "../../../modules/contextPanel/types";

export type SearchMode =
  | "recommendations"
  | "references"
  | "citations"
  | "search";

export type SearchSource = "openalex" | "arxiv" | "europepmc";

type SearchRelatedPapersOnlineInput = {
  itemId?: number;
  paperContext?: PaperContextRef;
  doi?: string;
  query?: string;
  mode?: SearchMode;
  source?: SearchSource;
  limit?: number;
  libraryID?: number;
};

export type OnlinePaperResult = {
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  doi?: string;
  citationCount?: number;
  openAccessUrl?: string;
  sourceUrl?: string;
};

// ── OpenAlex constants ───────────────────────────────────────────────────────

/**
 * Fields requested from every work object.
 * abstract_inverted_index is OpenAlex's compressed abstract storage.
 */
const OA_SELECT =
  "id,doi,display_name,authorships,publication_year,abstract_inverted_index,cited_by_count,open_access";

/**
 * Including a mailto in the URL puts us in OpenAlex's "polite pool",
 * which has higher throughput. No account or key is needed.
 */
const OA_MAILTO = "mailto=llm-for-zotero@github.com";

const OA_BASE = "https://api.openalex.org";

const USER_AGENT =
  "llm-for-zotero/1.0 (https://github.com/yilewang/llm-for-zotero)";

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function oaFetch(url: string): Promise<unknown> {
  const sep = url.includes("?") ? "&" : "?";
  const fullUrl = `${url}${sep}${OA_MAILTO}`;
  const response = await (
    globalThis as typeof globalThis & {
      fetch?: (
        url: string,
        init?: { headers?: Record<string, string> },
      ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
    }
  ).fetch!(fullUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`OpenAlex HTTP ${response.status}`);
  }
  return response.json();
}

// ── OpenAlex data normalisation ──────────────────────────────────────────────

/**
 * Reconstructs a plain-text abstract from OpenAlex's inverted-index format,
 * which stores {word: [position, …]} mappings instead of raw text.
 */
function reconstructAbstract(
  invertedIndex: unknown,
): string {
  if (!invertedIndex || typeof invertedIndex !== "object" || Array.isArray(invertedIndex)) {
    return "";
  }
  const entries: Array<[string, number]> = [];
  for (const [word, positions] of Object.entries(
    invertedIndex as Record<string, unknown>,
  )) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (typeof pos === "number") entries.push([word, pos]);
    }
  }
  entries.sort((a, b) => a[1] - b[1]);
  return entries.map(([w]) => w).join(" ").trim();
}

function normStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normOpenAlexWork(raw: unknown): OnlinePaperResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const w = raw as Record<string, unknown>;

  const title = normStr(w.display_name);
  if (!title) return null;

  const authorships = Array.isArray(w.authorships) ? w.authorships : [];
  const authors = authorships
    .map((a) => {
      const author = (a as Record<string, unknown>)?.author;
      return normStr((author as Record<string, unknown>)?.display_name);
    })
    .filter(Boolean);

  const year =
    typeof w.publication_year === "number" && w.publication_year > 0
      ? w.publication_year
      : undefined;

  const abstractRaw = reconstructAbstract(w.abstract_inverted_index);
  const abstract = abstractRaw
    ? abstractRaw.slice(0, 400) + (abstractRaw.length > 400 ? "\u2026" : "")
    : undefined;

  const doiUrl = normStr(w.doi);
  const doi = doiUrl.startsWith("https://doi.org/")
    ? doiUrl.slice("https://doi.org/".length)
    : doiUrl || undefined;

  const citationCount =
    typeof w.cited_by_count === "number" ? w.cited_by_count : undefined;

  const openAccess = w.open_access as Record<string, unknown> | null | undefined;
  const openAccessUrl = normStr(openAccess?.oa_url) || undefined;

  const openAlexId = normStr(w.id) || undefined;

  return {
    title,
    authors,
    year,
    abstract,
    doi,
    citationCount,
    openAccessUrl,
    sourceUrl: openAlexId,
  };
}

/** Extract the bare OpenAlex work ID (e.g. "W2741809807") from a full URL. */
function extractOpenAlexId(url: string): string | null {
  const match = /\/(W\d+)$/.exec(url.trim());
  return match?.[1] ?? null;
}

// ── OpenAlex query helpers ───────────────────────────────────────────────────

/**
 * Fetch a work by DOI and return its full record (including related_works and
 * referenced_works arrays). Returns null if not found.
 */
async function resolveOpenAlexWork(doi: string): Promise<Record<string, unknown> | null> {
  try {
    const encodedDoi = encodeURIComponent(`https://doi.org/${doi}`);
    const raw = (await oaFetch(
      `${OA_BASE}/works/${encodedDoi}?select=${OA_SELECT},related_works,referenced_works`,
    )) as Record<string, unknown>;
    return raw ?? null;
  } catch {
    return null;
  }
}

/**
 * Batch-fetch up to `limit` works by their OpenAlex IDs.
 * Expects bare IDs like "W2741809807".
 */
async function batchFetchWorks(
  ids: string[],
  limit: number,
): Promise<OnlinePaperResult[]> {
  const slice = ids.slice(0, limit);
  if (!slice.length) return [];
  const filter = `openalex:${slice.join("|")}`;
  const raw = (await oaFetch(
    `${OA_BASE}/works?filter=${encodeURIComponent(filter)}&select=${OA_SELECT}&per-page=${slice.length}`,
  )) as { results?: unknown[] };
  return (raw.results ?? [])
    .map(normOpenAlexWork)
    .filter((p): p is OnlinePaperResult => Boolean(p));
}

/**
 * "Recommendations" — semantically related papers as computed by OpenAlex.
 * Uses the `related_works` field of the resolved work.
 */
async function fetchRelated(
  work: Record<string, unknown>,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const relatedUrls = Array.isArray(work.related_works)
    ? (work.related_works as string[])
    : [];
  const ids = relatedUrls
    .map(extractOpenAlexId)
    .filter((id): id is string => Boolean(id));
  return batchFetchWorks(ids, limit);
}

/**
 * References — papers cited by this paper (from `referenced_works`).
 * Sorted roughly by position (as returned by OpenAlex).
 */
async function fetchReferences(
  work: Record<string, unknown>,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const refUrls = Array.isArray(work.referenced_works)
    ? (work.referenced_works as string[])
    : [];
  const ids = refUrls
    .map(extractOpenAlexId)
    .filter((id): id is string => Boolean(id));
  return batchFetchWorks(ids, limit);
}

/**
 * Citations — papers that cite this paper, sorted by citation count descending.
 */
async function fetchCitations(
  openAlexId: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const raw = (await oaFetch(
    `${OA_BASE}/works?filter=cites:${encodeURIComponent(openAlexId)}&sort=cited_by_count:desc&select=${OA_SELECT}&per-page=${limit}`,
  )) as { results?: unknown[] };
  return (raw.results ?? [])
    .map(normOpenAlexWork)
    .filter((p): p is OnlinePaperResult => Boolean(p));
}

/** Free-text keyword search across all of OpenAlex. */
async function fetchKeywordSearch(
  query: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const raw = (await oaFetch(
    `${OA_BASE}/works?search=${encodeURIComponent(query)}&select=${OA_SELECT}&per-page=${limit}`,
  )) as { results?: unknown[] };
  return (raw.results ?? [])
    .map(normOpenAlexWork)
    .filter((p): p is OnlinePaperResult => Boolean(p));
}

// ── arXiv helpers ─────────────────────────────────────────────────────────────

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Minimal DOM element interface for XML parsing in the Zotero sandbox. */
interface XmlElement {
  querySelector(selector: string): XmlElement | null;
  querySelectorAll(selector: string): XmlElement[];
  getAttribute(name: string): string | null;
  textContent: string | null;
}

interface XmlDocument extends XmlElement {
  querySelectorAll(selector: string): XmlElement[];
}

interface XmlDomParser {
  parseFromString(text: string, mimeType: string): XmlDocument;
}

/**
 * Query arXiv's public API (Atom XML feed, no key needed).
 * Covers CS, Physics, Math, and quantitative biology preprints.
 */
async function fetchArXivSearch(
  query: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const url =
    `https://export.arxiv.org/api/query` +
    `?search_query=all:${encodeURIComponent(query)}` +
    `&start=0&max_results=${limit}&sortBy=relevance&sortOrder=descending`;
  const response = await (globalThis as typeof globalThis & { fetch?: FetchLike }).fetch!(url, {
    headers: {
      Accept: "application/atom+xml",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`arXiv HTTP ${response.status}`);
  }
  const xmlText = await response.text();

  const domParser = new (
    globalThis as typeof globalThis & { DOMParser: new () => XmlDomParser }
  ).DOMParser();
  const doc = domParser.parseFromString(xmlText, "text/xml");
  const entries = doc.querySelectorAll("entry");

  const results: OnlinePaperResult[] = [];
  for (const entry of entries) {
    const title = entry
      .querySelector("title")
      ?.textContent?.trim()
      .replace(/\s+/g, " ");
    if (!title) continue;

    const rawAbstract = entry
      .querySelector("summary")
      ?.textContent?.trim()
      .replace(/\s+/g, " ");
    const abstract = rawAbstract
      ? rawAbstract.slice(0, 400) + (rawAbstract.length > 400 ? "\u2026" : "")
      : undefined;

    const publishedStr =
      entry.querySelector("published")?.textContent?.trim() ?? "";
    const year = publishedStr
      ? (parseInt(publishedStr.slice(0, 4), 10) || undefined)
      : undefined;

    const authors: string[] = [];
    for (const authorEl of entry.querySelectorAll("author")) {
      const name = authorEl.querySelector("name")?.textContent?.trim();
      if (name) authors.push(name);
    }

    // arXiv entry id looks like http://arxiv.org/abs/2301.12345v1
    const idUrl = entry.querySelector("id")?.textContent?.trim() ?? "";
    // PDF link has type="application/pdf"
    const pdfLink =
      entry
        .querySelectorAll("link")
        .find((l: XmlElement) => l.getAttribute("type") === "application/pdf")
        ?.getAttribute("href") ?? undefined;

    // Some entries include a <arxiv:doi> element
    const doiEl = entry.querySelector("doi");
    const doi = doiEl?.textContent?.trim() || undefined;

    results.push({
      title,
      authors,
      year,
      abstract,
      doi,
      sourceUrl: idUrl || undefined,
      openAccessUrl: pdfLink || idUrl || undefined,
    });
  }
  return results;
}

// ── Europe PMC helper ─────────────────────────────────────────────────────────

/**
 * Search Europe PMC — indexes bioRxiv, medRxiv, PubMed, and PMC.
 * Ideal for life-science and biomedical queries.
 * No API key required.
 */
async function fetchEuropePmcSearch(
  query: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const url =
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search` +
    `?query=${encodeURIComponent(query)}` +
    `&format=json&pageSize=${limit}&resultType=core&sort=RELEVANCE`;
  const response = await (
    globalThis as typeof globalThis & {
      fetch?: (
        url: string,
        init?: { headers?: Record<string, string> },
      ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
    }
  ).fetch!(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Europe PMC HTTP ${response.status}`);
  }
  const raw = (await response.json()) as {
    resultList?: {
      result?: Array<Record<string, unknown>>;
    };
  };
  const items = raw.resultList?.result ?? [];
  return items
    .map((item): OnlinePaperResult | null => {
      const title =
        typeof item.title === "string" ? item.title.trim() : null;
      if (!title) return null;

      const authorString =
        typeof item.authorString === "string" ? item.authorString.trim() : "";
      const authors = authorString
        ? authorString.split(",").map((a) => a.trim()).filter(Boolean)
        : [];

      const yearRaw = item.pubYear ?? item.firstPublicationDate;
      const year =
        typeof yearRaw === "string"
          ? (parseInt(yearRaw.slice(0, 4), 10) || undefined)
          : typeof yearRaw === "number"
            ? yearRaw
            : undefined;

      const rawAbstract =
        typeof item.abstractText === "string" ? item.abstractText.trim() : "";
      const abstract = rawAbstract
        ? rawAbstract.slice(0, 400) + (rawAbstract.length > 400 ? "\u2026" : "")
        : undefined;

      const doi =
        typeof item.doi === "string" && item.doi.trim()
          ? item.doi.trim()
          : undefined;

      const citationCount =
        typeof item.citedByCount === "number" ? item.citedByCount : undefined;

      // Build a source URL from PMID or DOI
      const pmid = typeof item.id === "string" ? item.id.trim() : undefined;
      const sourceUrl = pmid
        ? `https://europepmc.org/article/${item.source ?? "MED"}/${pmid}`
        : doi
          ? `https://doi.org/${doi}`
          : undefined;

      // openAccessUrl: prefer fullTextUrl list if present
      const urlList =
        (item.fullTextUrlList as { fullTextUrl?: Array<{ url: string }> } | undefined)
          ?.fullTextUrl ?? [];
      const openAccessUrl = urlList[0]?.url || (doi ? `https://doi.org/${doi}` : undefined);

      return {
        title,
        authors,
        year,
        abstract,
        doi,
        citationCount,
        sourceUrl,
        openAccessUrl,
      };
    })
    .filter((p): p is OnlinePaperResult => Boolean(p));
}

// ── Result deduplication ─────────────────────────────────────────────────────

function normTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns true if `result` appears to be the same paper as the one the user
 * is currently looking at (same DOI, or same/near-identical title).
 * This catches the common case where OpenAlex returns a preprint and its
 * published version as results when searching by the paper's own title.
 */
function isActivePaper(
  activeDoi: string | undefined,
  activeTitleKey: string | undefined,
  result: OnlinePaperResult,
): boolean {
  if (activeDoi && result.doi) {
    if (activeDoi.trim().toLowerCase() === result.doi.trim().toLowerCase()) {
      return true;
    }
  }
  if (activeTitleKey && activeTitleKey.length > 20) {
    const resultKey = normTitleKey(result.title);
    if (resultKey === activeTitleKey) return true;
    // One is a leading substring of the other — catches preprint vs. published
    // versions that share a subtitle-stripped title.
    if (resultKey.startsWith(activeTitleKey) || activeTitleKey.startsWith(resultKey)) {
      return true;
    }
  }
  return false;
}

// ── Presentation helpers ─────────────────────────────────────────────────────

function modeLabel(mode: SearchMode): string {
  switch (mode) {
    case "recommendations":
      return "related papers";
    case "references":
      return "papers referenced by this paper";
    case "citations":
      return "papers that cite this paper";
    case "search":
      return "keyword search results";
  }
}

// ── Tool definition ──────────────────────────────────────────────────────────

export function createSearchRelatedPapersOnlineTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<SearchRelatedPapersOnlineInput, unknown> {
  return {
    spec: {
      name: "search_related_papers_online",
      description:
        "Find related or similar papers on the internet. " +
        "Three sources are supported: " +
        "'openalex' (default) — a free scholarly database of 250M+ works covering all fields; " +
        "'arxiv' — preprint server for CS, Physics, Math, and quantitative biology (often more current); " +
        "'europepmc' — indexes bioRxiv, medRxiv, PubMed, and PMC (best for life science and biomedical queries). " +
        "Supports four modes: " +
        "'recommendations' (semantically related papers; auto-falls back to keyword search for very new papers), " +
        "'references' (papers this paper cites — its reference list), " +
        "'citations' (papers that cite this paper, sorted by citation count), " +
        "'search' (free-text keyword search). " +
        "Resolves the active paper's DOI automatically when no explicit doi or query is given.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          itemId: {
            type: "number",
            description: "Zotero item ID to look up DOI from; defaults to active paper",
          },
          paperContext: {
            type: "object",
            additionalProperties: true,
            required: ["itemId", "contextItemId"],
            properties: {
              itemId: { type: "number" },
              contextItemId: { type: "number" },
              title: { type: "string" },
            },
          },
          doi: {
            type: "string",
            description: "Explicit DOI to use instead of resolving from Zotero",
          },
          query: {
            type: "string",
            description:
              "Free-text search query (required when mode is 'search', or as fallback when DOI is unavailable)",
          },
          mode: {
            type: "string",
            enum: ["recommendations", "references", "citations", "search"],
            description:
              "Which kind of results to fetch. Defaults to 'recommendations'.",
          },
          source: {
            type: "string",
            enum: ["openalex", "arxiv", "europepmc"],
            description:
              "Which database to query. " +
              "'openalex' (default) covers all published literature across all fields; " +
              "'arxiv' covers CS/Physics/Math/Quantitative Biology preprints and is often more current; " +
              "'europepmc' indexes bioRxiv, medRxiv, PubMed and PMC — use for biology, medicine, or neuroscience. " +
              "Use 'europepmc' when the user asks for bioRxiv papers or the topic is biomedical/life science.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default 10, max 25)",
          },
          libraryID: { type: "number" },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    guidance: {
      matches: (request) => {
        const text = (request.userText || "").toLowerCase();
        // Explicit online/internet intent
        if (
          /\b(internet|online|web|openalex|semantic scholar)\b/.test(text) &&
          /\b(paper|article|research|work|study|publication|literature)\b/.test(text)
        ) {
          return true;
        }
        // Related / similar / recommended paper requests
        return (
          /\b(related|similar|recommend|find papers?|search papers?|literature search|who cites|citing|cite this|references? of|based on|inspired by|follow.?up|follow up)\b/.test(
            text,
          ) ||
          /\b(papers? (about|on|similar|related|from internet|from web)|more (papers?|research|work|studies)|find (more|new) papers?)\b/.test(
            text,
          )
        );
      },
      instruction: [
        "IMPORTANT: When the user asks to find related papers, similar papers, recommendations, or to search the internet/web/online for papers, you MUST call search_related_papers_online immediately.",
        "Do NOT answer from training knowledge for these requests — this tool queries live scholarly databases so the user gets real, up-to-date results.",
        "Source selection:",
        "- source='openalex' (default): covers all published literature across all fields.",
        "- source='arxiv': preprints in CS, Physics, Math, Quantitative Biology — use when the user asks for arXiv papers or the field is STEM-heavy and currency matters.",
        "- source='europepmc': indexes bioRxiv, medRxiv, PubMed, and PMC — use when the user asks for bioRxiv papers or the topic is biology, medicine, neuroscience, or other life sciences.",
        "Mode selection:",
        "- mode='recommendations': general 'find related/similar papers' or 'search internet for papers'",
        "- mode='citations': 'who cites this paper' / 'how influential is this paper'",
        "- mode='references': 'what does this paper cite' / 'what is in the reference list'",
        "- mode='search': free-text topic search not tied to a specific paper",
        "When the active paper has a DOI, pass it via the doi field for accurate results; otherwise use the query field with the paper title or topic.",
      ].join("\n"),
    },
    presentation: {
      label: "Search Related Papers Online",
      summaries: {
        onCall: ({ args }) => {
          const a = args as { mode?: string; source?: string };
          const mode = a?.mode || "recommendations";
          const db =
            a?.source === "arxiv"
              ? "arXiv"
              : a?.source === "europepmc"
                ? "Europe PMC"
                : "OpenAlex";
          return `Searching ${db} for ${modeLabel(mode as SearchMode)}`;
        },
        onSuccess: ({ content }) => {
          if (!content || typeof content !== "object") return "No results found online";
          const c = content as { results?: unknown[]; source?: string };
          const count = c.results?.length ?? 0;
          const db = c.source ?? "OpenAlex";
          return count > 0
            ? `Found ${count} related paper${count === 1 ? "" : "s"} on ${db}`
            : `No results found on ${db}`;
        },
        onEmpty: "No results found online",
      },
      buildResultCards: (content) => {
        if (!content || typeof content !== "object") return null;
        const raw = content as { results?: unknown[] };
        if (!Array.isArray(raw.results) || !raw.results.length) return null;
        return raw.results
          .filter(
            (item): item is OnlinePaperResult =>
              Boolean(
                item && typeof item === "object" && (item as OnlinePaperResult).title,
              ),
          )
          .map((paper) => {
            const yearStr = paper.year ? String(paper.year) : null;
            const authorStr = paper.authors?.length
              ? paper.authors.slice(0, 3).join(", ") +
                (paper.authors.length > 3 ? " et al." : "")
              : null;
            const subtitle = [yearStr, authorStr].filter(Boolean).join(" · ");
            const badges: string[] = [];
            if (paper.citationCount != null) {
              badges.push(
                `${paper.citationCount.toLocaleString()} citation${paper.citationCount === 1 ? "" : "s"}`,
              );
            }
            if (paper.doi) badges.push(`DOI: ${paper.doi}`);

            // Build an importable identifier for "Add to Zotero" support.
            // Prefer DOI; fall back to extracting an arXiv ID from the source URL.
            let importIdentifier: string | undefined;
            if (paper.doi) {
              const bareDoi = paper.doi.replace(/^https?:\/\/doi\.org\//i, "");
              if (bareDoi.startsWith("10.")) importIdentifier = bareDoi;
            } else if (paper.sourceUrl) {
              const arxivMatch = /arxiv\.org\/abs\/([\d.]+)/i.exec(paper.sourceUrl);
              if (arxivMatch?.[1]) importIdentifier = `arxiv:${arxivMatch[1]}`;
            }

            return {
              title: paper.title,
              subtitle: subtitle || undefined,
              body: paper.abstract || undefined,
              badges: badges.length ? badges : undefined,
              href: paper.openAccessUrl || paper.sourceUrl || undefined,
              importIdentifier,
            };
          });
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const paperContext = validateObject<Record<string, unknown>>(args.paperContext)
        ? normalizeToolPaperContext(args.paperContext) || undefined
        : undefined;
      const rawMode = typeof args.mode === "string" ? args.mode.trim() : "";
      const mode: SearchMode =
        rawMode === "references" ||
        rawMode === "citations" ||
        rawMode === "search" ||
        rawMode === "recommendations"
          ? (rawMode as SearchMode)
          : "recommendations";
      const rawSource = typeof args.source === "string" ? args.source.trim() : "";
      const source: SearchSource =
        rawSource === "arxiv"
          ? "arxiv"
          : rawSource === "europepmc"
            ? "europepmc"
            : "openalex";
      const rawLimit = normalizePositiveInt(args.limit);
      const limit = rawLimit !== undefined ? Math.min(rawLimit, 25) : 10;
      const doi =
        typeof args.doi === "string" && args.doi.trim()
          ? args.doi.trim()
          : undefined;
      const query =
        typeof args.query === "string" && args.query.trim()
          ? args.query.trim()
          : undefined;
      if (mode === "search" && !doi && !query) {
        return fail("query is required when mode is 'search'");
      }
      return ok<SearchRelatedPapersOnlineInput>({
        itemId: normalizePositiveInt(args.itemId),
        paperContext,
        doi,
        query,
        mode,
        source,
        limit,
        libraryID: normalizePositiveInt(args.libraryID),
      });
    },
    execute: async (input, context) => {
      const mode = input.mode ?? "recommendations";
      const source = input.source ?? "openalex";
      const limit = input.limit ?? 10;

      // Resolve DOI: explicit > Zotero item > active paper
      let doi = input.doi;
      let titleFallback = input.query;
      let activeTitleKey: string | undefined;

      if (!doi) {
        const metadataItem = zoteroGateway.resolveMetadataItem({
          request: context.request,
          item: context.item,
          itemId: input.itemId ?? input.paperContext?.itemId,
          paperContext: input.paperContext,
        });
        if (metadataItem) {
          const snapshot = zoteroGateway.getEditableArticleMetadata(metadataItem);
          if (snapshot?.fields.DOI) {
            doi = snapshot.fields.DOI.trim();
          }
          if (!titleFallback && snapshot?.title) {
            titleFallback = snapshot.title.trim();
          }
          if (snapshot?.title) {
            activeTitleKey = normTitleKey(snapshot.title);
          }
        }
      }

      const dedup = (list: OnlinePaperResult[]): OnlinePaperResult[] =>
        list.filter((r) => !isActivePaper(doi, activeTitleKey, r));

      // ── arXiv source: keyword search only (arXiv has no DOI-based related API)
      if (source === "arxiv") {
        const q = input.query || titleFallback;
        if (!q) {
          return { results: [], message: "No search query available for arXiv." };
        }
        const results = dedup(await fetchArXivSearch(q, limit));
        return {
          mode: "search",
          query: q,
          results,
          total: results.length,
          source: "arXiv",
        };
      }

      // ── Europe PMC source: bioRxiv / medRxiv / PubMed search
      if (source === "europepmc") {
        const q = input.query || titleFallback;
        if (!q) {
          return { results: [], message: "No search query available for Europe PMC." };
        }
        const results = dedup(await fetchEuropePmcSearch(q, limit));
        return {
          mode: "search",
          query: q,
          results,
          total: results.length,
          source: "Europe PMC",
        };
      }

      // ── OpenAlex source (default) ─────────────────────────────────────────

      // Keyword search — no DOI needed
      if (mode === "search") {
        const q = input.query || titleFallback;
        if (!q) {
          return { results: [], message: "No search query available." };
        }
        const results = dedup(await fetchKeywordSearch(q, limit));
        return {
          mode,
          query: q,
          results,
          total: results.length,
          source: "OpenAlex",
        };
      }

      // For recommendations / references / citations we need to resolve the work
      if (!doi) {
        if (titleFallback) {
          const results = dedup(await fetchKeywordSearch(titleFallback, limit));
          return {
            mode: "search",
            query: titleFallback,
            results,
            total: results.length,
            source: "OpenAlex",
            note: "DOI unavailable — returned keyword search results instead.",
          };
        }
        throw new Error(
          "No DOI found for the active paper. Provide a doi or query explicitly.",
        );
      }

      const work = await resolveOpenAlexWork(doi);
      if (!work) {
        if (titleFallback) {
          const results = dedup(await fetchKeywordSearch(titleFallback, limit));
          return {
            mode: "search",
            query: titleFallback,
            results,
            total: results.length,
            source: "OpenAlex",
            note: "Paper not found on OpenAlex by DOI — returned keyword search results instead.",
          };
        }
        throw new Error(
          `Paper with DOI "${doi}" was not found on OpenAlex.`,
        );
      }

      const openAlexId = normStr(work.id) || null;

      let results: OnlinePaperResult[] = [];
      if (mode === "recommendations") {
        results = dedup(await fetchRelated(work, limit));
        // OpenAlex only computes related_works offline; very new papers may have none yet.
        // Auto-fall back to a keyword search using the paper title so we always return something.
        if (results.length === 0 && titleFallback) {
          const fallbackResults = dedup(await fetchKeywordSearch(titleFallback, limit));
          return {
            mode: "search",
            doi,
            openAlexId,
            results: fallbackResults,
            total: fallbackResults.length,
            source: "OpenAlex",
            note:
              "OpenAlex has not yet computed related_works for this paper (common for very recent publications). " +
              "Showing keyword search results instead.",
          };
        }
      } else if (mode === "references") {
        results = dedup(await fetchReferences(work, limit));
      } else {
        // citations
        if (!openAlexId) {
          throw new Error("Could not determine OpenAlex ID to query citations.");
        }
        results = dedup(await fetchCitations(openAlexId, limit));
      }

      return {
        mode,
        doi,
        openAlexId,
        results,
        total: results.length,
        source: "OpenAlex",
        openAlexUrl: openAlexId || undefined,
      };
    },
  };
}
