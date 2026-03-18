import type { PaperContextRef } from "../../../shared/types";
import type { AgentToolDefinition } from "../../types";
import { LiteratureSearchService } from "../../services/literatureSearchService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  createSearchLiteratureReviewAction,
  resolveSearchLiteratureReview,
} from "../../reviewCards";
import {
  fail,
  normalizePositiveInt,
  normalizeToolPaperContext,
  ok,
  PAPER_CONTEXT_REF_SCHEMA,
  validateObject,
} from "../shared";

type SearchLiteratureOnlineMode =
  | "recommendations"
  | "references"
  | "citations"
  | "search"
  | "metadata";

type SearchLiteratureOnlineInput = {
  mode: SearchLiteratureOnlineMode;
  source?: "openalex" | "arxiv" | "europepmc";
  itemId?: number;
  paperContext?: PaperContextRef;
  doi?: string;
  title?: string;
  arxivId?: string;
  query?: string;
  limit?: number;
  libraryID?: number;
};

export function createSearchLiteratureOnlineTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<SearchLiteratureOnlineInput, unknown> {
  const service = new LiteratureSearchService(zoteroGateway);
  return {
    spec: {
      name: "search_literature_online",
      description:
        "Search live scholarly sources or fetch canonical external metadata through one general tool. Use mode:'metadata' for CrossRef/Semantic Scholar metadata, or recommendation/reference/citation/search modes for live literature discovery.",
      inputSchema: {
        type: "object",
        required: ["mode"],
        additionalProperties: false,
        properties: {
          mode: {
            type: "string",
            enum: [
              "recommendations",
              "references",
              "citations",
              "search",
              "metadata",
            ],
          },
          source: {
            type: "string",
            enum: ["openalex", "arxiv", "europepmc"],
          },
          itemId: { type: "number" },
          paperContext: PAPER_CONTEXT_REF_SCHEMA,
          doi: { type: "string" },
          title: { type: "string" },
          arxivId: { type: "string" },
          query: { type: "string" },
          limit: { type: "number" },
          libraryID: { type: "number" },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    guidance: {
      matches: (request) =>
        /\b(related papers?|similar papers?|find papers?|search (the )?(internet|literature)|citations?|references?)\b/i.test(
          request.userText,
        ),
      instruction:
        "For live paper discovery requests, call search_literature_online and let the review card present the result. Do not stop with an empty chat answer before using the tool.",
    },
    presentation: {
      label: "Search Literature Online",
      summaries: {
        onCall: ({ args }) => {
          const mode =
            args && typeof args === "object"
              ? String((args as { mode?: unknown }).mode || "search")
              : "search";
          return `Searching live literature (${mode})`;
        },
        onSuccess: ({ content }) => {
          const results =
            content &&
            typeof content === "object" &&
            Array.isArray((content as { results?: unknown[] }).results)
              ? (content as { results: unknown[] }).results
              : [];
          return results.length > 0
            ? `Found ${results.length} online result${results.length === 1 ? "" : "s"}`
            : "No online results found";
        },
        onPending: "Waiting for your review of the online search results",
        onApproved: "Review received - continuing with the selected literature action",
        onDenied: "Stopped after reviewing the online search results",
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const itemId = normalizePositiveInt(args.itemId);
      const mode =
        args.mode === "recommendations" ||
        args.mode === "references" ||
        args.mode === "citations" ||
        args.mode === "search" ||
        args.mode === "metadata"
          ? (args.mode as SearchLiteratureOnlineMode)
          : null;
      if (!mode) {
        return fail("mode is required");
      }
      const paperContext = validateObject<Record<string, unknown>>(args.paperContext)
        ? normalizeToolPaperContext(args.paperContext) || undefined
        : undefined;
      const query =
        typeof args.query === "string" && args.query.trim()
          ? args.query.trim()
          : undefined;
      const title =
        typeof args.title === "string" && args.title.trim()
          ? args.title.trim()
          : undefined;
      const doi =
        typeof args.doi === "string" && args.doi.trim()
          ? args.doi.trim()
          : undefined;
      const arxivId =
        typeof args.arxivId === "string" && args.arxivId.trim()
          ? args.arxivId.trim()
          : undefined;
      if (mode === "metadata" && !doi && !title && !arxivId && !query && !itemId && !paperContext) {
        return fail("metadata mode requires doi, title, arxivId, query, itemId, or paperContext");
      }
      if (mode === "search" && !query && !title) {
        return fail("search mode requires query or title");
      }
      return ok<SearchLiteratureOnlineInput>({
        mode,
        source:
          args.source === "openalex" ||
          args.source === "arxiv" ||
          args.source === "europepmc"
            ? args.source
            : undefined,
        itemId,
        paperContext,
        doi,
        title,
        arxivId,
        query,
        limit: normalizePositiveInt(args.limit),
        libraryID: normalizePositiveInt(args.libraryID),
      });
    },
    execute: async (input, context) => {
      const results = await service.execute(input, context);
      return {
        mode: input.mode,
        ...((results && typeof results === "object" ? results : { results }) as object),
      };
    },
    createResultReviewAction: (input, result, context) =>
      createSearchLiteratureReviewAction(result, context, input),
    resolveResultReview: (input, result, resolution, context) =>
      resolveSearchLiteratureReview(input, result, resolution, context),
  };
}
