import type { PaperContextRef } from "../types";

export type AgentToolName =
  | "read_paper_text"
  | "find_claim_evidence"
  | "read_references";

export type AgentToolTarget =
  | { scope: "active-paper" }
  | { scope: "selected-paper"; index: number }
  | { scope: "pinned-paper"; index: number }
  | { scope: "recent-paper"; index: number }
  | { scope: "retrieved-paper"; index: number };

export type AgentToolCall = {
  name: AgentToolName;
  target: AgentToolTarget;
};

export type ResolvedAgentToolTarget = {
  paperContext: PaperContextRef | null;
  contextItem: Zotero.Item | null;
  targetLabel: string;
  resolvedKey?: string;
  error?: string;
};

export type AgentToolExecutionResult = {
  name: AgentToolName;
  targetLabel: string;
  ok: boolean;
  traceLines: string[];
  groundingText: string;
  addedPaperContexts: PaperContextRef[];
  estimatedTokens: number;
  truncated: boolean;
};

export type AgentToolExecutionContext = {
  question: string;
  libraryID: number;
  conversationMode: "paper" | "open";
  activePaperContext?: PaperContextRef | null;
  selectedPaperContexts: PaperContextRef[];
  pinnedPaperContexts: PaperContextRef[];
  recentPaperContexts: PaperContextRef[];
  retrievedPaperContexts: PaperContextRef[];
  toolTokenCap?: number;
  availableContextBudgetTokens?: number;
  apiBase?: string;
  apiKey?: string;
  onTrace?: (line: string) => void;
  onStatus?: (line: string) => void;
};

export type AgentToolExecutorState = {
  executedCallKeys: Set<string>;
  totalEstimatedTokens: number;
  executedCallCount: number;
};
