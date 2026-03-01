import { callLLM, type ReasoningConfig } from "../../utils/llmClient";
import {
  formatPaperCitationLabel,
  formatPaperContextReferenceLabel,
} from "./paperAttribution";
import type {
  AgentContinuationPlan,
  AgentPlannerAction,
  AgentQueryPlan,
} from "./agentTypes";
import { getAgentToolDefinitions } from "./agentTools/registry";
import type { AgentToolCall, AgentToolTarget } from "./agentTools/types";
import {
  isLibraryOverviewQuery,
  isLibraryScopedSearchQuery,
} from "./agentContext";
import { sanitizeText } from "./textUtils";
import type { PaperContextRef } from "./types";

const MAX_AGENT_TRACE_LINES = 4;
const MAX_AGENT_TRACE_LINE_LENGTH = 120;
const MAX_AGENT_TOOL_CALLS = 1;

export type AgentPlannerContext = {
  question: string;
  conversationMode: "paper" | "open";
  libraryID: number;
  model: string;
  apiBase?: string;
  apiKey?: string;
  reasoning?: ReasoningConfig;
  activePaperContext?: PaperContextRef | null;
  paperContexts?: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  recentPaperContexts?: PaperContextRef[];
};

export type AgentContinuationContext = {
  question: string;
  initialAction: AgentPlannerAction;
  retrievalSummary: string;
  model: string;
  apiBase?: string;
  apiKey?: string;
  reasoning?: ReasoningConfig;
  executedToolSummaries: string[];
  alreadyExecutedToolCalls: string[];
  activePaperContext?: PaperContextRef | null;
  paperContexts?: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  recentPaperContexts?: PaperContextRef[];
  retrievedPaperContexts?: PaperContextRef[];
};

function clampPapersToRead(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function dedupePaperContexts(
  values: (PaperContextRef | null | undefined)[],
): PaperContextRef[] {
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const key = `${value.itemId}:${value.contextItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function questionExplicitlyTargetsLibrary(question: string): boolean {
  return /\b(?:zotero\s+)?(?:library|collection)\b/i.test(question);
}

function normalizeTraceLines(value: unknown, fallback: string[]): string[] {
  const rawLines = Array.isArray(value) ? value : [];
  const lines = rawLines
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => sanitizeText(entry).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((entry) => entry.slice(0, MAX_AGENT_TRACE_LINE_LENGTH))
    .slice(0, MAX_AGENT_TRACE_LINES);
  return lines.length ? lines : fallback;
}

function normalizeSearchQuery(value: unknown): string {
  return sanitizeText(typeof value === "string" ? value : "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function summarizePaperContexts(
  paperContexts: PaperContextRef[] | undefined,
  maxItems: number,
): string {
  const entries = dedupePaperContexts(paperContexts || []);
  if (!entries.length) return "none";
  return entries
    .slice(0, maxItems)
    .map((entry) => formatPaperContextReferenceLabel(entry))
    .join(" | ");
}

function formatPaperSummary(
  label: string,
  paperContexts: PaperContextRef[] | undefined,
): string[] {
  const papers = dedupePaperContexts(paperContexts || []);
  if (!papers.length) return [`- ${label}: none`];
  return papers
    .slice(0, 4)
    .map((paper, index) => {
      return `- ${label}#${index + 1}: ${formatPaperContextReferenceLabel(paper)}`;
    });
}

function formatToolTarget(target: AgentToolTarget): string {
  if ("index" in target) {
    return `${target.scope}#${target.index}`;
  }
  return target.scope;
}

function buildAvailableToolsPrompt(): string[] {
  const toolLines = ["Available tools:"];
  for (const definition of getAgentToolDefinitions()) {
    toolLines.push(`- "${definition.name}": ${definition.plannerDescription}`);
  }
  toolLines.push(
    '- Tool call format example: {"name":"read_paper_text","target":{"scope":"retrieved-paper","index":1}}',
  );
  return toolLines;
}

function buildToolTargetingRules(): string[] {
  return [
    "Tool targeting rules:",
    '- If action is "library-overview" or "library-search", use "retrieved-paper#N" targets.',
    '- If action is "existing-paper-contexts", use "selected-paper#N", "pinned-paper#N", or "recent-paper#N".',
    '- If action is "active-paper", use "active-paper".',
    "- Target numbers refer to the numbered target list below, even when titles or authors are identical.",
  ];
}

function getFallbackTraceLines(action: AgentPlannerAction): string[] {
  switch (action) {
    case "library-overview":
      return [
        "This looks like a whole-library request.",
        "I will inspect the active Zotero library before answering.",
      ];
    case "library-search":
      return [
        "This looks like a library search request.",
        "I will search the active Zotero library for relevant papers.",
      ];
    case "existing-paper-contexts":
      return [
        "Existing paper contexts already look relevant.",
        "I will reuse those papers before answering.",
      ];
    case "active-paper":
      return [
        "The current paper looks sufficient for this request.",
        "I will ground the answer on the active paper first.",
      ];
    default:
      return ["No extra Zotero retrieval is needed for this request."];
  }
}

function buildFallbackPlan(params: AgentPlannerContext): AgentQueryPlan {
  const question = sanitizeText(params.question || "");
  const libraryAvailable = Number(params.libraryID) > 0;
  const existingPaperContexts = dedupePaperContexts([
    ...(params.paperContexts || []),
    ...(params.pinnedPaperContexts || []),
    ...(params.recentPaperContexts || []),
  ]);
  const activePaperAvailable = Boolean(params.activePaperContext);

  if (libraryAvailable && isLibraryOverviewQuery(question)) {
    return {
      action: "library-overview",
      maxPapersToRead: 8,
      traceLines: getFallbackTraceLines("library-overview"),
      toolCalls: [],
    };
  }
  if (
    existingPaperContexts.length &&
    !questionExplicitlyTargetsLibrary(question)
  ) {
    return {
      action: "existing-paper-contexts",
      maxPapersToRead: Math.min(existingPaperContexts.length, 6),
      traceLines: getFallbackTraceLines("existing-paper-contexts"),
      toolCalls: [],
    };
  }
  if (
    libraryAvailable &&
    isLibraryScopedSearchQuery(question, params.conversationMode)
  ) {
    return {
      action: "library-search",
      searchQuery: question,
      maxPapersToRead: 6,
      traceLines: getFallbackTraceLines("library-search"),
      toolCalls: [],
    };
  }
  if (activePaperAvailable) {
    return {
      action: "active-paper",
      maxPapersToRead: 1,
      traceLines: getFallbackTraceLines("active-paper"),
      toolCalls: [],
    };
  }
  return {
    action: "skip",
    maxPapersToRead: 1,
    traceLines: getFallbackTraceLines("skip"),
    toolCalls: [],
  };
}

function buildFallbackContinuationPlan(): AgentContinuationPlan {
  return {
    decision: "stop",
    traceLines: ["Current grounding looks sufficient, so I will stop tool use."],
    toolCalls: [],
  };
}

function normalizeAction(value: unknown): AgentPlannerAction | null {
  switch (sanitizeText(String(value || "")).trim().toLowerCase()) {
    case "skip":
    case "active-paper":
    case "existing-paper-contexts":
    case "library-overview":
    case "library-search":
      return sanitizeText(String(value || "")).trim().toLowerCase() as AgentPlannerAction;
    default:
      return null;
  }
}

function normalizeContinuationDecision(value: unknown): "stop" | "tool" | null {
  switch (sanitizeText(String(value || "")).trim().toLowerCase()) {
    case "stop":
    case "tool":
      return sanitizeText(String(value || "")).trim().toLowerCase() as
        | "stop"
        | "tool";
    default:
      return null;
  }
}

function normalizeToolTarget(value: unknown): AgentToolTarget | null {
  if (!value || typeof value !== "object") return null;
  const typed = value as { scope?: unknown; index?: unknown };
  const scope = sanitizeText(String(typed.scope || "")).trim().toLowerCase();
  switch (scope) {
    case "active-paper":
      return { scope: "active-paper" };
    case "selected-paper":
    case "pinned-paper":
    case "recent-paper":
    case "retrieved-paper": {
      const index = Math.floor(Number(typed.index));
      if (!Number.isFinite(index) || index < 1) return null;
      return {
        scope,
        index,
      } as AgentToolTarget;
    }
    default:
      return null;
  }
}

function normalizeToolCalls(value: unknown): AgentToolCall[] {
  const rawCalls = Array.isArray(value) ? value : [];
  const toolDefinitions = new Map(
    getAgentToolDefinitions().map((definition) => [definition.name, definition]),
  );
  const out: AgentToolCall[] = [];
  for (const rawCall of rawCalls) {
    if (!rawCall || typeof rawCall !== "object") continue;
    const typed = rawCall as { name?: unknown; target?: unknown };
    const name = sanitizeText(String(typed.name || "")).trim().toLowerCase();
    const definition = toolDefinitions.get(name as AgentToolCall["name"]);
    if (!definition) continue;
    const normalizedTarget = normalizeToolTarget(typed.target);
    if (!normalizedTarget) continue;
    const validated = definition.validate({
      name: definition.name,
      target: normalizedTarget,
    });
    if (!validated) continue;
    out.push(validated);
    if (out.length >= MAX_AGENT_TOOL_CALLS) break;
  }
  return out;
}

function normalizePlan(rawPlan: unknown, fallback: AgentQueryPlan): AgentQueryPlan {
  if (!rawPlan || typeof rawPlan !== "object") return fallback;
  const typed = rawPlan as {
    action?: unknown;
    searchQuery?: unknown;
    maxPapersToRead?: unknown;
    traceLines?: unknown;
    toolCalls?: unknown;
  };
  const action = normalizeAction(typed.action) || fallback.action;
  const searchQuery =
    action === "library-search"
      ? normalizeSearchQuery(typed.searchQuery) || fallback.searchQuery || ""
      : "";
  return {
    action,
    searchQuery: searchQuery || undefined,
    maxPapersToRead: clampPapersToRead(
      typed.maxPapersToRead,
      fallback.maxPapersToRead,
    ),
    traceLines: normalizeTraceLines(
      typed.traceLines,
      getFallbackTraceLines(action),
    ),
    toolCalls: normalizeToolCalls(typed.toolCalls),
  };
}

function normalizeContinuationPlan(
  rawPlan: unknown,
  fallback: AgentContinuationPlan,
): AgentContinuationPlan {
  if (!rawPlan || typeof rawPlan !== "object") return fallback;
  const typed = rawPlan as {
    decision?: unknown;
    traceLines?: unknown;
    toolCalls?: unknown;
  };
  const decision = normalizeContinuationDecision(typed.decision) || fallback.decision;
  const toolCalls = decision === "tool" ? normalizeToolCalls(typed.toolCalls) : [];
  if (decision === "tool" && !toolCalls.length) {
    return fallback;
  }
  return {
    decision,
    traceLines: normalizeTraceLines(typed.traceLines, fallback.traceLines),
    toolCalls,
  };
}

function buildPlannerPrompt(params: AgentPlannerContext): string {
  const libraryAvailable = Number(params.libraryID) > 0 ? "yes" : "no";
  const activePaper = params.activePaperContext
    ? `${formatPaperCitationLabel(params.activePaperContext)} - ${params.activePaperContext.title}`
    : "none";
  const selectedPapers = summarizePaperContexts(params.paperContexts, 4);
  const pinnedPapers = summarizePaperContexts(params.pinnedPaperContexts, 4);
  const recentPapers = summarizePaperContexts(params.recentPaperContexts, 4);
  const question = sanitizeText(params.question || "").trim() || "(empty)";

  return [
    "You are the planning step for a Zotero research assistant.",
    "Do not answer the user's question.",
    "Choose the best retrieval action before the final answer model runs.",
    "",
    "Available actions:",
    '- "skip": no extra Zotero retrieval',
    '- "active-paper": use only the current paper',
    '- "existing-paper-contexts": use already selected/pinned/recent paper contexts',
    '- "library-overview": inspect the active Zotero library as a whole',
    '- "library-search": search the active Zotero library for relevant papers',
    "",
    ...buildAvailableToolsPrompt(),
    ...buildToolTargetingRules(),
    "",
    "Return JSON only with this schema:",
    '{"action":"skip|active-paper|existing-paper-contexts|library-overview|library-search","searchQuery":"string","maxPapersToRead":6,"traceLines":["short public step"],"toolCalls":[{"name":"read_paper_text","target":{"scope":"retrieved-paper","index":1}}]}',
    "",
    "Rules:",
    "- traceLines are public UI log lines, not hidden reasoning.",
    "- Use 1 to 4 traceLines.",
    "- Each trace line must be concise, factual, and under 120 characters.",
    "- Keep at most one tool call.",
    '- If action is not "library-search", use an empty searchQuery.',
    "- Prefer find_claim_evidence when a few targeted snippets can answer the user's claim or verification request.",
    "- Prefer read_references when the user asks what a paper cites, references, or uses as prior work.",
    "- Use read_paper_text only when the full paper body is necessary.",
    '- "retrieved-paper#1" means the top paper returned after the retrieval step.',
    "- If the user asks about the whole library, all papers, counts, or an overview, prefer library-overview.",
    "- If the request is about the current paper only, prefer active-paper.",
    "- If existing selected/pinned papers are already sufficient, prefer existing-paper-contexts.",
    "",
    `User question: ${question}`,
    `Conversation mode: ${params.conversationMode}`,
    `Active library available: ${libraryAvailable}`,
    `Active paper: ${activePaper}`,
    `Selected paper contexts: ${selectedPapers}`,
    `Pinned paper contexts: ${pinnedPapers}`,
    `Recent paper contexts: ${recentPapers}`,
    "Available targets:",
    ...formatPaperSummary("selected-paper", params.paperContexts),
    ...formatPaperSummary("pinned-paper", params.pinnedPaperContexts),
    ...formatPaperSummary("recent-paper", params.recentPaperContexts),
    `- active-paper: ${activePaper}`,
  ].join("\n");
}

function buildContinuationPrompt(params: AgentContinuationContext): string {
  const question = sanitizeText(params.question || "").trim() || "(empty)";
  const activePaper = params.activePaperContext
    ? `${formatPaperCitationLabel(params.activePaperContext)} - ${params.activePaperContext.title}`
    : "none";
  const executedTools = params.executedToolSummaries.length
    ? params.executedToolSummaries.map((line) => `- ${line}`)
    : ["- none"];
  const executedCalls = params.alreadyExecutedToolCalls.length
    ? params.alreadyExecutedToolCalls.map((line) => `- ${line}`)
    : ["- none"];

  return [
    "You are the continuation planning step for a Zotero research assistant.",
    "Do not answer the user's question.",
    "Decide whether one more tool call is still needed before the final answer model runs.",
    "",
    ...buildAvailableToolsPrompt(),
    ...buildToolTargetingRules(),
    "",
    "Return JSON only with this schema:",
    '{"decision":"stop|tool","traceLines":["short public step"],"toolCalls":[{"name":"read_paper_text","target":{"scope":"retrieved-paper","index":1}}]}',
    "",
    "Rules:",
    "- Prefer decision=stop when the current grounding is already sufficient.",
    "- Keep at most one tool call.",
    "- Never repeat an already executed tool call.",
    "- traceLines are public UI log lines, not hidden reasoning.",
    "- Use 1 to 4 traceLines.",
    "- Prefer find_claim_evidence for claim-checking follow-ups and read_references for citation/reference follow-ups.",
    "",
    `User question: ${question}`,
    `Initial action: ${params.initialAction}`,
    `Retrieval summary: ${sanitizeText(params.retrievalSummary || "").trim() || "none"}`,
    `Active paper: ${activePaper}`,
    "Already executed tool calls:",
    ...executedCalls,
    "Executed tool summaries:",
    ...executedTools,
    "Available targets:",
    ...formatPaperSummary("selected-paper", params.paperContexts),
    ...formatPaperSummary("pinned-paper", params.pinnedPaperContexts),
    ...formatPaperSummary("recent-paper", params.recentPaperContexts),
    ...formatPaperSummary("retrieved-paper", params.retrievedPaperContexts),
    `- active-paper: ${activePaper}`,
  ].join("\n");
}

export function findAgentPlanJsonObject(raw: string): string {
  const source = String(raw || "");
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return "";
}

export async function planAgentQuery(
  params: AgentPlannerContext,
): Promise<AgentQueryPlan> {
  const fallback = buildFallbackPlan(params);
  if (!sanitizeText(params.question || "").trim()) {
    return fallback;
  }

  try {
    const raw = await callLLM({
      prompt: buildPlannerPrompt(params),
      model: params.model,
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      reasoning: params.reasoning,
      temperature: 0,
      maxTokens: 500,
    });
    const jsonText = findAgentPlanJsonObject(raw);
    if (!jsonText) return fallback;
    return parseAgentQueryPlan(jsonText, fallback);
  } catch (err) {
    ztoolkit.log("LLM: Agent planner failed, using fallback", err);
    return fallback;
  }
}

export async function planAgentContinuation(
  params: AgentContinuationContext,
): Promise<AgentContinuationPlan> {
  const fallback = buildFallbackContinuationPlan();
  if (!sanitizeText(params.question || "").trim()) {
    return fallback;
  }

  try {
    const raw = await callLLM({
      prompt: buildContinuationPrompt(params),
      model: params.model,
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      reasoning: params.reasoning,
      temperature: 0,
      maxTokens: 400,
    });
    const jsonText = findAgentPlanJsonObject(raw);
    if (!jsonText) return fallback;
    return parseAgentContinuationPlan(jsonText, fallback);
  } catch (err) {
    ztoolkit.log("LLM: Agent continuation planner failed, using fallback", err);
    return fallback;
  }
}

export function parseAgentQueryPlan(
  raw: string,
  fallback: AgentQueryPlan,
): AgentQueryPlan {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizePlan(parsed, fallback);
  } catch (_err) {
    return fallback;
  }
}

export function parseAgentContinuationPlan(
  raw: string,
  fallback: AgentContinuationPlan,
): AgentContinuationPlan {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeContinuationPlan(parsed, fallback);
  } catch (_err) {
    return fallback;
  }
}

export function buildFallbackAgentQueryPlan(
  params: AgentPlannerContext,
): AgentQueryPlan {
  return buildFallbackPlan(params);
}

export function buildFallbackAgentContinuationPlan(): AgentContinuationPlan {
  return buildFallbackContinuationPlan();
}

export function summarizeAgentToolCall(call: AgentToolCall): string {
  return `${call.name}(${formatToolTarget(call.target)})`;
}
