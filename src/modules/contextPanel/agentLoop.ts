import type { ReasoningConfig } from "../../utils/llmClient";
import {
  estimateTextTokens,
  getModelInputTokenLimit,
} from "../../utils/modelInputCap";
import {
  normalizeInputTokenCap,
  normalizeMaxTokens,
} from "../../utils/normalization";
import {
  formatPaperCitationLabel,
  resolvePaperContextRefFromAttachment,
} from "./paperAttribution";
import { resolveAgentContext } from "./agentContext";
import {
  planAgentContinuation,
  planAgentQuery,
  type AgentContinuationContext,
  type AgentPlannerContext,
} from "./agentPlanner";
import { sanitizeText } from "./textUtils";
import type {
  AgentContinuationPlan,
  AgentPlannerAction,
  AgentQueryPlan,
} from "./agentTypes";
import {
  createAgentToolExecutorState,
  executeAgentToolCall,
} from "./agentTools/executor";
import type {
  AgentToolCall,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
} from "./agentTools/types";
import type { AdvancedModelParams, PaperContextRef } from "./types";

type AgentLoopState = {
  activeContextItem: Zotero.Item | null;
  conversationMode: "paper" | "open";
  activePaperContext: PaperContextRef | null;
  paperContexts: PaperContextRef[];
  pinnedPaperContexts: PaperContextRef[];
  recentPaperContexts: PaperContextRef[];
  retrievedPaperContexts: PaperContextRef[];
  retrievalSummary: string;
  contextPrefixBlocks: string[];
  contextPrefixEstimatedTokens: number;
  executedToolResults: AgentToolExecutionResult[];
};

export type AgentLoopParams = {
  item: Zotero.Item;
  question: string;
  activeContextItem: Zotero.Item | null;
  conversationMode: "paper" | "open";
  paperContexts: PaperContextRef[];
  pinnedPaperContexts: PaperContextRef[];
  recentPaperContexts: PaperContextRef[];
  model: string;
  apiBase?: string;
  apiKey?: string;
  reasoning?: ReasoningConfig;
  advanced?: AdvancedModelParams;
  availableContextBudgetTokens?: number;
  onStatus?: (statusText: string) => void;
  onTrace?: (line: string) => void;
};

export type AgentLoopResult = {
  activeContextItem: Zotero.Item | null;
  conversationMode: "paper" | "open";
  paperContexts: PaperContextRef[];
  pinnedPaperContexts: PaperContextRef[];
  recentPaperContexts: PaperContextRef[];
  contextPrefix: string;
};

export type AgentLoopDeps = {
  planAgentQuery: (params: AgentPlannerContext) => Promise<AgentQueryPlan>;
  planAgentContinuation: (
    params: AgentContinuationContext,
  ) => Promise<AgentContinuationPlan>;
  resolveAgentContext: typeof resolveAgentContext;
  executeAgentToolCall: typeof executeAgentToolCall;
};

const defaultDeps: AgentLoopDeps = {
  planAgentQuery,
  planAgentContinuation,
  resolveAgentContext,
  executeAgentToolCall,
};

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

function formatToolTarget(call: AgentToolCall): string {
  if ("index" in call.target) {
    return `${call.target.scope}#${call.target.index}`;
  }
  return call.target.scope;
}

function summarizeToolResult(result: AgentToolExecutionResult): string {
  const parts = [result.name, result.targetLabel];
  if (result.ok) {
    parts.push(result.truncated ? "truncated" : "complete");
  } else {
    parts.push("skipped");
  }
  return parts.join(" | ");
}

function summarizePaper(paper: PaperContextRef): string {
  const citation = formatPaperCitationLabel(paper);
  return citation ? `${citation} - ${paper.title}` : paper.title;
}

function questionRequestsReadingAllExistingPapers(question: string): boolean {
  const normalized = sanitizeText(question || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  const mentionsPaperGroup =
    /\b(?:papers?|pdfs?|articles?|studies|works)\b/.test(normalized);
  const mentionsAll = /\b(?:both|all|each|every|two)\b/.test(normalized);
  const mentionsRead =
    /\b(?:read|full text|full body|whole paper|paper body|body text)\b/.test(
      normalized,
    );
  return mentionsPaperGroup && mentionsAll && mentionsRead;
}

function collectSuccessfulReadKeys(
  results: AgentToolExecutionResult[],
): Set<string> {
  const out = new Set<string>();
  for (const result of results) {
    if (!result.ok || result.name !== "read_paper_text") continue;
    for (const paperContext of result.addedPaperContexts) {
      out.add(`${paperContext.itemId}:${paperContext.contextItemId}`);
    }
  }
  return out;
}

function buildExistingPaperToolQueue(
  state: AgentLoopState,
): Array<{ call: AgentToolCall; key: string }> {
  const out: Array<{ call: AgentToolCall; key: string }> = [];
  const seen = new Set<string>();
  const add = (
    scope: "selected-paper" | "pinned-paper" | "recent-paper",
    papers: PaperContextRef[],
  ) => {
    for (const [index, paper] of papers.entries()) {
      const key = `${paper.itemId}:${paper.contextItemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        call: {
          name: "read_paper_text",
          target: { scope, index: index + 1 },
        },
        key,
      });
    }
  };

  add("selected-paper", dedupePaperContexts(state.paperContexts));
  add("pinned-paper", dedupePaperContexts(state.pinnedPaperContexts));
  add("recent-paper", dedupePaperContexts(state.recentPaperContexts));
  return out;
}

function countPendingDeterministicExistingPaperReads(
  params: AgentLoopParams,
  state: AgentLoopState,
): number {
  const queue = buildExistingPaperToolQueue(state).slice(0, 2);
  if (!queue.length) return 0;
  const readKeys = collectSuccessfulReadKeys(state.executedToolResults);
  let pending = 0;
  for (const entry of queue) {
    if (!readKeys.has(entry.key)) pending += 1;
  }
  return pending;
}

function deriveAvailableContextBudgetTokens(params: AgentLoopParams): number {
  const explicitBudget = Math.floor(Number(params.availableContextBudgetTokens));
  if (Number.isFinite(explicitBudget) && explicitBudget >= 0) {
    return explicitBudget;
  }
  const modelLimitTokens = getModelInputTokenLimit(params.model);
  const limitTokens = normalizeInputTokenCap(
    params.advanced?.inputTokenCap,
    modelLimitTokens,
  );
  const softLimitTokens = Math.max(1, Math.floor(limitTokens * 0.9));
  const outputReserveTokens = normalizeMaxTokens(params.advanced?.maxTokens);
  return Math.max(0, softLimitTokens - outputReserveTokens);
}

function computeToolTokenCap(params: {
  runnerParams: AgentLoopParams;
  state: AgentLoopState;
  executorState: ReturnType<typeof createAgentToolExecutorState>;
  currentAction: AgentPlannerAction;
}): number {
  const totalBudget = deriveAvailableContextBudgetTokens(params.runnerParams);
  const remainingBudget = Math.max(
    0,
    totalBudget - params.state.contextPrefixEstimatedTokens,
  );
  if (remainingBudget <= 0) return 0;
  let divisor = Math.max(1, 2 - params.executorState.executedCallCount);
  if (
    params.currentAction === "existing-paper-contexts" &&
    questionRequestsReadingAllExistingPapers(params.runnerParams.question)
  ) {
    divisor = Math.max(
      divisor,
      Math.max(
        1,
        countPendingDeterministicExistingPaperReads(
          params.runnerParams,
          params.state,
        ),
      ),
    );
  }
  return Math.max(1, Math.floor(remainingBudget / divisor));
}

function getDeterministicExistingPaperToolCall(
  params: AgentLoopParams,
  state: AgentLoopState,
  currentAction: AgentPlannerAction,
): AgentToolCall | null {
  if (currentAction !== "existing-paper-contexts") return null;
  if (!questionRequestsReadingAllExistingPapers(params.question)) return null;
  const readKeys = collectSuccessfulReadKeys(state.executedToolResults);
  const queue = buildExistingPaperToolQueue(state).slice(0, 2);
  for (const entry of queue) {
    if (!readKeys.has(entry.key)) {
      return entry.call;
    }
  }
  return null;
}

function buildToolContext(
  params: AgentLoopParams,
  state: AgentLoopState,
  toolTokenCap?: number,
): AgentToolExecutionContext {
  return {
    question: params.question,
    libraryID: Number(params.item.libraryID),
    conversationMode: state.conversationMode,
    activePaperContext: state.activePaperContext,
    selectedPaperContexts: state.paperContexts,
    pinnedPaperContexts: state.pinnedPaperContexts,
    recentPaperContexts: state.recentPaperContexts,
    retrievedPaperContexts: state.retrievedPaperContexts,
    toolTokenCap,
    availableContextBudgetTokens: params.availableContextBudgetTokens,
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    onTrace: params.onTrace,
    onStatus: params.onStatus,
  };
}

async function applyPlannerAction(
  params: AgentLoopParams,
  state: AgentLoopState,
  plan: AgentQueryPlan,
  deps: AgentLoopDeps,
): Promise<void> {
  switch (plan.action) {
    case "library-overview":
    case "library-search": {
      params.onTrace?.(`Planner selected ${plan.action}.`);
      params.onTrace?.("Checking Zotero access now...");
      const agentContext = await deps.resolveAgentContext({
        question: params.question,
        libraryID: Number(params.item.libraryID),
        conversationMode: state.conversationMode,
        plan,
        availableContextBudgetTokens: params.availableContextBudgetTokens,
        onStatus: (statusText) => {
          params.onStatus?.(statusText);
          params.onTrace?.(statusText);
        },
      });
      if (!agentContext) {
        state.activeContextItem = null;
        state.conversationMode = "open";
        state.paperContexts = [];
        state.pinnedPaperContexts = [];
        state.recentPaperContexts = [];
        state.retrievedPaperContexts = [];
        state.retrievalSummary =
          "Planner requested library access, but no Zotero retrieval was available.";
        params.onTrace?.(state.retrievalSummary);
        return;
      }

      state.activeContextItem = null;
      state.conversationMode = "open";
      state.paperContexts = agentContext.paperContexts;
      state.pinnedPaperContexts = agentContext.pinnedPaperContexts;
      state.recentPaperContexts = [];
      state.retrievedPaperContexts = agentContext.paperContexts;
      state.retrievalSummary =
        plan.action === "library-overview"
          ? `Library overview loaded ${agentContext.paperContexts.length} papers.`
          : `Library search loaded ${agentContext.paperContexts.length} papers.`;
      const prefix = sanitizeText(agentContext.contextPrefix || "").trim();
      if (prefix) {
        state.contextPrefixBlocks.push(prefix);
        state.contextPrefixEstimatedTokens += estimateTextTokens(prefix);
      }
      params.onStatus?.(agentContext.statusText);
      params.onTrace?.(agentContext.statusText);
      for (const traceLine of agentContext.traceLines) {
        params.onTrace?.(traceLine);
      }
      return;
    }
    case "active-paper": {
      state.pinnedPaperContexts = [];
      state.recentPaperContexts = [];
      state.retrievedPaperContexts = [];
      if (state.activePaperContext) {
        state.paperContexts = [state.activePaperContext];
        state.retrievalSummary = `Using active paper ${summarizePaper(state.activePaperContext)}.`;
        params.onTrace?.(`Planner selected active-paper.`);
        params.onTrace?.(state.retrievalSummary);
      } else {
        state.paperContexts = [];
        state.activeContextItem = null;
        state.retrievalSummary =
          "No active paper was available, so Zotero retrieval was skipped.";
        params.onTrace?.(state.retrievalSummary);
      }
      return;
    }
    case "existing-paper-contexts": {
      state.activeContextItem = null;
      state.conversationMode = "open";
      state.retrievedPaperContexts = [];
      const count = dedupePaperContexts([
        ...state.paperContexts,
        ...state.pinnedPaperContexts,
        ...state.recentPaperContexts,
      ]).length;
      state.retrievalSummary = `Using ${count} existing paper context${count === 1 ? "" : "s"}.`;
      params.onTrace?.("Planner selected existing-paper-contexts.");
      params.onTrace?.(state.retrievalSummary);
      return;
    }
    case "skip":
    default: {
      state.activeContextItem = null;
      state.conversationMode = "open";
      state.paperContexts = [];
      state.pinnedPaperContexts = [];
      state.recentPaperContexts = [];
      state.retrievedPaperContexts = [];
      state.retrievalSummary = "No Zotero retrieval was needed.";
      params.onTrace?.("Planner selected skip.");
      params.onTrace?.(state.retrievalSummary);
    }
  }
}

async function executePlannedTool(
  params: AgentLoopParams,
  state: AgentLoopState,
  toolCall: AgentToolCall | null | undefined,
  currentAction: AgentPlannerAction,
  deps: AgentLoopDeps,
  executorState: ReturnType<typeof createAgentToolExecutorState>,
): Promise<AgentToolExecutionResult | null> {
  if (!toolCall) return null;
  params.onTrace?.(`Tool call: ${toolCall.name}(${formatToolTarget(toolCall)}).`);
  const toolTokenCap = computeToolTokenCap({
    runnerParams: params,
    state,
    executorState,
    currentAction,
  });
  if (toolTokenCap <= 0) {
    params.onTrace?.(
      `No remaining model context budget for ${toolCall.name}(${formatToolTarget(toolCall)}).`,
    );
    return null;
  }
  const result = await deps.executeAgentToolCall({
    call: toolCall,
    ctx: buildToolContext(params, state, toolTokenCap),
    state: executorState,
  });
  if (!result) return null;
  state.executedToolResults.push(result);
  for (const traceLine of result.traceLines) {
    params.onTrace?.(traceLine);
  }
  const groundingText = sanitizeText(result.groundingText || "").trim();
  if (result.ok && groundingText) {
    state.contextPrefixBlocks.push(groundingText);
    state.contextPrefixEstimatedTokens += result.estimatedTokens;
  }
  if (result.addedPaperContexts.length) {
    state.paperContexts = dedupePaperContexts([
      ...state.paperContexts,
      ...result.addedPaperContexts,
    ]);
  }
  return result;
}

async function executeToolSlotWithExistingPaperFallback(params: {
  runnerParams: AgentLoopParams;
  state: AgentLoopState;
  requestedToolCall?: AgentToolCall | null;
  currentAction: AgentPlannerAction;
  deps: AgentLoopDeps;
  executorState: ReturnType<typeof createAgentToolExecutorState>;
  fallbackReason: "invalid-target" | "read-all-selected";
}): Promise<AgentToolExecutionResult | null> {
  const requestedResult = await executePlannedTool(
    params.runnerParams,
    params.state,
    params.requestedToolCall,
    params.currentAction,
    params.deps,
    params.executorState,
  );
  const fallbackCall = getDeterministicExistingPaperToolCall(
    params.runnerParams,
    params.state,
    params.currentAction,
  );
  if (!fallbackCall) {
    return requestedResult;
  }

  const fallbackMatchesRequested =
    params.requestedToolCall &&
    params.requestedToolCall.name === fallbackCall.name &&
    formatToolTarget(params.requestedToolCall) === formatToolTarget(fallbackCall);
  if (fallbackMatchesRequested) {
    return requestedResult;
  }

  const shouldUseFallback =
    !params.requestedToolCall ||
    !requestedResult ||
    !requestedResult.ok ||
    params.fallbackReason === "read-all-selected";
  if (!shouldUseFallback) {
    return requestedResult;
  }

  if (params.requestedToolCall && (!requestedResult || !requestedResult.ok)) {
    params.runnerParams.onTrace?.(
      `Using ${formatToolTarget(fallbackCall)} from existing paper contexts because the previous tool target was unavailable.`,
    );
  } else if (!params.requestedToolCall) {
    params.runnerParams.onTrace?.(
      `Question asks to read both selected papers, so I will also read ${formatToolTarget(fallbackCall)}.`,
    );
  }

  const fallbackResult = await executePlannedTool(
    params.runnerParams,
    params.state,
    fallbackCall,
    params.currentAction,
    params.deps,
    params.executorState,
  );
  return fallbackResult || requestedResult;
}

export function createAgentLoopRunner(
  deps: Partial<AgentLoopDeps> = {},
): (params: AgentLoopParams) => Promise<AgentLoopResult> {
  const resolvedDeps = {
    ...defaultDeps,
    ...deps,
  } as AgentLoopDeps;

  return async function run(params: AgentLoopParams): Promise<AgentLoopResult> {
    const state: AgentLoopState = {
      activeContextItem: params.activeContextItem,
      conversationMode: params.conversationMode,
      activePaperContext: resolvePaperContextRefFromAttachment(
        params.activeContextItem,
      ),
      paperContexts: [...params.paperContexts],
      pinnedPaperContexts: [...params.pinnedPaperContexts],
      recentPaperContexts: [...params.recentPaperContexts],
      retrievedPaperContexts: [],
      retrievalSummary: "",
      contextPrefixBlocks: [],
      contextPrefixEstimatedTokens: 0,
      executedToolResults: [],
    };
    const executorState = createAgentToolExecutorState();

    params.onTrace?.("Planning Zotero retrieval...");
    const initialPlan = await resolvedDeps.planAgentQuery({
      question: params.question,
      conversationMode: state.conversationMode,
      libraryID: Number(params.item.libraryID),
      model: params.model,
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      reasoning: params.reasoning,
      activePaperContext: state.activePaperContext,
      paperContexts: state.paperContexts,
      pinnedPaperContexts: state.pinnedPaperContexts,
      recentPaperContexts: state.recentPaperContexts,
    });
    for (const traceLine of initialPlan.traceLines) {
      params.onTrace?.(traceLine);
    }

    await applyPlannerAction(params, state, initialPlan, resolvedDeps);
    const firstToolResult = await executeToolSlotWithExistingPaperFallback({
      runnerParams: params,
      state,
      requestedToolCall: initialPlan.toolCalls[0],
      currentAction: initialPlan.action,
      deps: resolvedDeps,
      executorState,
      fallbackReason: "invalid-target",
    });

    const continuationPlan = await resolvedDeps.planAgentContinuation({
      question: params.question,
      initialAction: initialPlan.action,
      retrievalSummary: state.retrievalSummary,
      model: params.model,
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      reasoning: params.reasoning,
      executedToolSummaries: state.executedToolResults.map(summarizeToolResult),
      alreadyExecutedToolCalls: Array.from(executorState.executedCallKeys),
      activePaperContext: state.activePaperContext,
      paperContexts: state.paperContexts,
      pinnedPaperContexts: state.pinnedPaperContexts,
      recentPaperContexts: state.recentPaperContexts,
      retrievedPaperContexts: state.retrievedPaperContexts,
    });
    if (continuationPlan.traceLines.length) {
      for (const traceLine of continuationPlan.traceLines) {
        params.onTrace?.(traceLine);
      }
    } else if (continuationPlan.decision === "stop") {
      params.onTrace?.("Continuation planner stopped after current grounding.");
    }

    const shouldForceSecondExistingPaperRead =
      initialPlan.action === "existing-paper-contexts" &&
      questionRequestsReadingAllExistingPapers(params.question) &&
      Boolean(firstToolResult?.ok);

    if (continuationPlan.decision === "tool" || shouldForceSecondExistingPaperRead) {
      await executeToolSlotWithExistingPaperFallback({
        runnerParams: params,
        state,
        requestedToolCall:
          continuationPlan.decision === "tool"
            ? continuationPlan.toolCalls[0]
            : null,
        currentAction: initialPlan.action,
        deps: resolvedDeps,
        executorState,
        fallbackReason: shouldForceSecondExistingPaperRead
          ? "read-all-selected"
          : "invalid-target",
      });
    }

    return {
      activeContextItem: state.activeContextItem,
      conversationMode: state.conversationMode,
      paperContexts: state.paperContexts,
      pinnedPaperContexts: state.pinnedPaperContexts,
      recentPaperContexts: state.recentPaperContexts,
      contextPrefix: state.contextPrefixBlocks
        .map((block) => sanitizeText(block).trim())
        .filter(Boolean)
        .join("\n\n---\n\n"),
    };
  };
}

export const runAgentLoop = createAgentLoopRunner();
