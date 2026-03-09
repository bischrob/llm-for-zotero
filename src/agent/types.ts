import type { ChatMessage } from "../utils/llmClient";
import type { ModelProviderAuthMode } from "../utils/modelProviders";
import type {
  AdvancedModelParams,
  ChatAttachment,
  PaperContextRef,
} from "../modules/contextPanel/types";
import type { ReasoningConfig as LLMReasoningConfig } from "../utils/llmClient";

export type AgentRequest = {
  conversationKey: number;
  mode: "agent";
  userText: string;
  activeItemId?: number;
  selectedTexts?: string[];
  selectedPaperContexts?: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  attachments?: ChatAttachment[];
  screenshots?: string[];
  model?: string;
  apiBase?: string;
  apiKey?: string;
  reasoning?: LLMReasoningConfig;
  advanced?: AdvancedModelParams;
};

export type PendingWriteAction = {
  toolName: string;
  args: unknown;
  title: string;
  confirmLabel: string;
  cancelLabel: string;
  editableContent?: string;
  contentLabel?: string;
  editorMode?: "plain" | "json";
  saveTargets?: Array<{
    id: string;
    label: string;
  }>;
  defaultTargetId?: string;
};

export type AgentConfirmationResolution = {
  approved: boolean;
  data?: unknown;
};

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: object;
  mutability: "read" | "write";
  requiresConfirmation: boolean;
};

export type ResourceSpec = {
  name: string;
  description: string;
  uri: string;
};

export type PromptSpec = {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
};

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; name: string; ok: boolean; content: unknown }
  | { type: "confirmation_required"; requestId: string; action: PendingWriteAction }
  | {
      type: "confirmation_resolved";
      requestId: string;
      approved: boolean;
      data?: unknown;
    }
  | { type: "message_delta"; text: string }
  | { type: "fallback"; reason: string }
  | { type: "final"; text: string };

export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";

export type AgentRunRecord = {
  runId: string;
  conversationKey: number;
  mode: "agent";
  model?: string;
  status: AgentRunStatus;
  createdAt: number;
  completedAt?: number;
  finalText?: string;
};

export type AgentRunEventRecord = {
  runId: string;
  seq: number;
  eventType: AgentEvent["type"];
  payload: AgentEvent;
  createdAt: number;
};

export type AgentToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type AgentModelCapabilities = {
  streaming: boolean;
  toolCalls: boolean;
  multimodal: boolean;
};

export type AgentModelContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export type AgentSystemMessage = {
  role: "system";
  content: string | AgentModelContentPart[];
};

export type AgentUserMessage = {
  role: "user";
  content: string | AgentModelContentPart[];
};

export type AgentAssistantMessage = {
  role: "assistant";
  content: string | AgentModelContentPart[];
  tool_calls?: AgentToolCall[];
};

export type AgentToolMessage = {
  role: "tool";
  content: string;
  tool_call_id: string;
  name: string;
};

export type AgentModelMessage =
  | AgentSystemMessage
  | AgentUserMessage
  | AgentAssistantMessage
  | AgentToolMessage;

export type AgentModelStep =
  | {
      kind: "final";
      text: string;
      assistantMessage?: AgentAssistantMessage;
    }
  | {
      kind: "tool_calls";
      calls: AgentToolCall[];
      assistantMessage: AgentAssistantMessage;
    };

export type AgentRuntimeRequest = AgentRequest & {
  item?: Zotero.Item | null;
  history?: ChatMessage[];
  authMode?: ModelProviderAuthMode;
  systemPrompt?: string;
  modelProviderLabel?: string;
  libraryID?: number;
};

export type AgentRuntimeOutcome =
  | {
      kind: "completed";
      runId: string;
      text: string;
      usedFallback: false;
    }
  | {
      kind: "fallback";
      runId: string;
      reason: string;
      usedFallback: true;
    };

export type AgentToolResult = {
  callId: string;
  name: string;
  ok: boolean;
  content: unknown;
};

export type AgentToolContext = {
  request: AgentRuntimeRequest;
  item: Zotero.Item | null;
  currentAnswerText: string;
  modelName: string;
  modelProviderLabel?: string;
};

export type AgentToolInputValidation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type AgentToolDefinition<TInput = unknown, TResult = unknown> = {
  spec: ToolSpec;
  validate: (args: unknown) => AgentToolInputValidation<TInput>;
  execute: (input: TInput, context: AgentToolContext) => Promise<TResult>;
  createPendingWriteAction?: (
    input: TInput,
    context: AgentToolContext,
  ) => PendingWriteAction;
  applyConfirmation?: (
    input: TInput,
    resolutionData: unknown,
    context: AgentToolContext,
  ) => AgentToolInputValidation<TInput>;
};

export type AgentResourceDefinition<TValue = unknown> = {
  spec: ResourceSpec;
  read: (context: AgentToolContext) => Promise<TValue>;
};

export type AgentPromptDefinition<TArgs = unknown> = {
  spec: PromptSpec;
  render: (args: TArgs, context: AgentToolContext) => Promise<string>;
};

export type PreparedToolExecution =
  | {
      kind: "result";
      result: AgentToolResult;
    }
  | {
      kind: "confirmation";
      requestId: string;
      action: PendingWriteAction;
      execute: (resolutionData?: unknown) => Promise<AgentToolResult>;
      deny: (resolutionData?: unknown) => AgentToolResult;
    };
