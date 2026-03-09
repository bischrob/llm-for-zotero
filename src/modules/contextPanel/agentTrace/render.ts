import { getAgentRuntime } from "../../../agent";
import type {
  AgentRunEventRecord,
  PendingWriteAction,
} from "../../../agent/types";
import type { Message, PaperContextRef } from "../types";
import { sanitizeText, getSelectedTextSourceIcon } from "../textUtils";
import {
  normalizePaperContextRefs,
  normalizeSelectedTextSources,
} from "../normalizers";

type AgentTraceSummaryKind = "plan" | "tool" | "ok" | "skip" | "done";

type AgentTraceSummaryRow = {
  kind: AgentTraceSummaryKind;
  icon: string;
  text: string;
};

type AgentTraceChip = {
  icon: string;
  label: string;
  title?: string;
};

type AgentTraceDisplayItem =
  | {
      type: "message";
      tone: "neutral" | "success" | "warning";
      text: string;
    }
  | {
      type: "action";
      row: AgentTraceSummaryRow;
      chips?: AgentTraceChip[];
    };

type RenderAgentTraceParams = {
  doc: Document;
  message: Message;
  userMessage?: Message | null;
  events: AgentRunEventRecord[];
  onTraceMissing?: () => void;
};

const AGENT_TRACE_TOOL_LABELS: Record<string, string> = {
  get_active_context: "Inspect Context",
  list_paper_contexts: "List Papers",
  retrieve_paper_evidence: "Retrieve Evidence",
  read_paper_excerpt: "Read Excerpt",
  search_library_items: "Search Library",
  read_attachment_text: "Read Attachment",
  save_answer_to_note: "Save to Note",
  edit_article_metadata: "Edit Metadata",
};

type AgentRunEventPayload = AgentRunEventRecord["payload"];

function normalizeSelectedTexts(
  selectedTexts: unknown,
  legacySelectedText?: unknown,
): string[] {
  const normalize = (value: unknown): string => {
    if (typeof value !== "string") return "";
    return sanitizeText(value).trim();
  };
  if (Array.isArray(selectedTexts)) {
    return selectedTexts.map((value) => normalize(value)).filter(Boolean);
  }
  const legacy = normalize(legacySelectedText);
  return legacy ? [legacy] : [];
}

function getMessageSelectedTexts(message: Message): string[] {
  return normalizeSelectedTexts(message.selectedTexts, message.selectedText);
}

function normalizePaperContexts(paperContexts: unknown): PaperContextRef[] {
  return normalizePaperContextRefs(paperContexts, { sanitizeText });
}

function getPendingWriteConfirmation(
  events: AgentRunEventRecord[],
): { requestId: string; action: PendingWriteAction } | null {
  const pending = new Map<string, PendingWriteAction>();
  for (const entry of events) {
    if (entry.payload.type === "confirmation_required") {
      pending.set(entry.payload.requestId, entry.payload.action);
      continue;
    }
    if (entry.payload.type === "confirmation_resolved") {
      pending.delete(entry.payload.requestId);
    }
  }
  const last = Array.from(pending.entries()).pop();
  if (!last) return null;
  return {
    requestId: last[0],
    action: last[1],
  };
}

function isAgentTraceRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readAgentTraceText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truncateAgentTraceText(value: unknown, max = 88): string {
  const raw = readAgentTraceText(value) || `${value ?? ""}`;
  const normalized = sanitizeText(raw).replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function formatAgentTraceToolName(name: string): string {
  const mapped = AGENT_TRACE_TOOL_LABELS[name];
  if (mapped) return mapped;
  return name
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function getPendingWriteEditableContent(action: PendingWriteAction): string {
  if (typeof action.editableContent === "string") {
    return action.editableContent;
  }
  const args = isAgentTraceRecord(action.args) ? action.args : null;
  return typeof args?.content === "string" ? args.content : "";
}

function getPendingWriteTargets(
  action: PendingWriteAction,
): Array<{ id: string; label: string }> {
  if (Array.isArray(action.saveTargets) && action.saveTargets.length) {
    return action.saveTargets
      .filter(
        (
          entry,
        ): entry is {
          id: string;
          label: string;
        } =>
          Boolean(entry) &&
          typeof entry.id === "string" &&
          entry.id.trim().length > 0 &&
          typeof entry.label === "string" &&
          entry.label.trim().length > 0,
      )
      .map((entry) => ({
        id: entry.id.trim(),
        label: entry.label.trim(),
      }));
  }
  return [
    {
      id: "default",
      label: action.confirmLabel || "Approve",
    },
  ];
}

function renderPendingWriteActionCard(
  doc: Document,
  pending: { requestId: string; action: PendingWriteAction },
): HTMLDivElement {
  const card = doc.createElement("div");
  card.className = "llm-agent-hitl-card";

  const header = doc.createElement("div");
  header.className = "llm-agent-hitl-header";
  header.textContent = "Action required";
  card.appendChild(header);

  const title = doc.createElement("div");
  title.className = "llm-agent-hitl-title";
  title.textContent = pending.action.title;
  card.appendChild(title);

  const contentLabel = doc.createElement("label");
  contentLabel.className = "llm-agent-hitl-label";
  contentLabel.textContent = pending.action.contentLabel || "Content";
  card.appendChild(contentLabel);

  const editor = doc.createElement("textarea");
  editor.className =
    pending.action.editorMode === "json"
      ? "llm-agent-hitl-input llm-agent-hitl-input-code"
      : "llm-agent-hitl-input";
  editor.value = getPendingWriteEditableContent(pending.action);
  editor.spellcheck = pending.action.editorMode !== "json";
  const resizeEditor = () => {
    editor.style.height = "auto";
    editor.style.height = `${Math.min(editor.scrollHeight, 260)}px`;
  };
  resizeEditor();
  editor.addEventListener("input", resizeEditor);
  card.appendChild(editor);

  const actionRow = doc.createElement("div");
  actionRow.className = "llm-agent-hitl-actions";
  const saveTargets = getPendingWriteTargets(pending.action);
  const defaultTargetId =
    saveTargets.find((entry) => entry.id === pending.action.defaultTargetId)
      ?.id ||
    saveTargets[0]?.id ||
    "default";
  const buttons: HTMLButtonElement[] = [];
  const setButtonsDisabled = (disabled: boolean) => {
    editor.disabled = disabled;
    for (const button of buttons) {
      button.disabled = disabled;
    }
  };
  const syncSaveButtons = () => {
    const hasContent = editor.value.trim().length > 0;
    for (const button of buttons) {
      if (button.dataset.kind === "save") {
        button.disabled = !hasContent;
      }
    }
  };
  const handleSave = (targetId: string) => {
    setButtonsDisabled(true);
    getAgentRuntime().resolveConfirmation(pending.requestId, true, {
      content: editor.value,
      target: targetId === "default" ? undefined : targetId,
    });
  };

  for (const target of saveTargets) {
    const saveButton = doc.createElement("button");
    saveButton.type = "button";
    saveButton.dataset.kind = "save";
    saveButton.className =
      target.id === defaultTargetId
        ? "llm-agent-hitl-btn"
        : "llm-agent-hitl-btn llm-agent-hitl-btn-alt";
    saveButton.textContent = target.label;
    saveButton.addEventListener("click", () => {
      handleSave(target.id);
    });
    buttons.push(saveButton);
    actionRow.appendChild(saveButton);
  }

  const cancelButton = doc.createElement("button");
  cancelButton.type = "button";
  cancelButton.dataset.kind = "cancel";
  cancelButton.className = "llm-agent-hitl-btn llm-agent-hitl-btn-secondary";
  cancelButton.textContent = pending.action.cancelLabel || "Cancel";
  cancelButton.addEventListener("click", () => {
    setButtonsDisabled(true);
    getAgentRuntime().resolveConfirmation(pending.requestId, false);
  });
  buttons.push(cancelButton);
  actionRow.appendChild(cancelButton);
  card.appendChild(actionRow);
  syncSaveButtons();
  editor.addEventListener("input", syncSaveButtons);

  return card;
}

function buildAgentTraceRequestChips(
  userMessage: Message | null | undefined,
): AgentTraceChip[] {
  if (!userMessage) return [];
  const chips: AgentTraceChip[] = [];
  const paperContexts = normalizePaperContexts(userMessage.paperContexts);
  if (paperContexts.length) {
    const label =
      paperContexts.length === 1
        ? truncateAgentTraceText(paperContexts[0]?.title || "Paper", 42)
        : `${paperContexts.length} papers`;
    chips.push({
      icon: "📚",
      label,
      title: paperContexts.map((entry) => entry.title).join("\n"),
    });
  }

  const selectedTexts = getMessageSelectedTexts(userMessage);
  if (selectedTexts.length) {
    const sources = normalizeSelectedTextSources(
      userMessage.selectedTextSources,
      selectedTexts.length,
    );
    const sourceIcon = getSelectedTextSourceIcon(sources[0] || "pdf");
    const label =
      selectedTexts.length === 1
        ? truncateAgentTraceText(selectedTexts[0], 42)
        : `${selectedTexts.length} text selections`;
    chips.push({
      icon: sourceIcon,
      label,
      title: selectedTexts.join("\n\n"),
    });
  }

  const screenshotCount = Array.isArray(userMessage.screenshotImages)
    ? userMessage.screenshotImages.filter(Boolean).length
    : 0;
  if (screenshotCount > 0) {
    chips.push({
      icon: "🖼",
      label: screenshotCount === 1 ? "1 figure" : `${screenshotCount} figures`,
    });
  }

  const fileAttachments = Array.isArray(userMessage.attachments)
    ? userMessage.attachments.filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          entry.category !== "image" &&
          typeof entry.name === "string",
      )
    : [];
  if (fileAttachments.length) {
    chips.push({
      icon: "📎",
      label:
        fileAttachments.length === 1
          ? truncateAgentTraceText(fileAttachments[0]?.name || "File", 32)
          : `${fileAttachments.length} files`,
      title: fileAttachments.map((entry) => entry.name).join("\n"),
    });
  }

  return chips;
}

function buildAgentTraceToolChips(
  toolName: string,
  args: unknown,
  userMessage: Message | null | undefined,
): AgentTraceChip[] {
  const record = isAgentTraceRecord(args) ? args : null;
  const chips: AgentTraceChip[] = [];
  const paperContext = isAgentTraceRecord(record?.paperContext)
    ? record?.paperContext
    : null;
  if (paperContext) {
    const paperTitle =
      readAgentTraceText(paperContext.title) ||
      `Paper ${paperContext.itemId ?? ""}`.trim();
    chips.push({
      icon: "📚",
      label: truncateAgentTraceText(paperTitle, 42),
      title: paperTitle,
    });
  }

  if (toolName === "search_library_items") {
    const query = readAgentTraceText(record?.query);
    if (query) {
      chips.push({
        icon: "⌕",
        label: truncateAgentTraceText(query, 36),
        title: query,
      });
    }
  }

  if (toolName === "read_attachment_text") {
    const attachmentName = readAgentTraceText(record?.name);
    if (attachmentName) {
      chips.push({
        icon: "📎",
        label: truncateAgentTraceText(attachmentName, 32),
        title: attachmentName,
      });
    }
  }

  if (toolName === "get_active_context" && !chips.length) {
    return buildAgentTraceRequestChips(userMessage);
  }

  return chips;
}

function summarizeAgentTraceToolCall(name: string): AgentTraceSummaryRow {
  switch (name) {
    case "get_active_context":
      return {
        kind: "tool",
        icon: "◎",
        text: "Checking the current Zotero context",
      };
    case "list_paper_contexts":
      return {
        kind: "tool",
        icon: "▤",
        text: "Reviewing the papers currently in scope",
      };
    case "retrieve_paper_evidence":
      return {
        kind: "tool",
        icon: "↓",
        text: "Pulling the most relevant evidence from the paper",
      };
    case "read_paper_excerpt":
      return {
        kind: "tool",
        icon: "¶",
        text: "Opening the exact passage behind that evidence",
      };
    case "search_library_items":
      return {
        kind: "tool",
        icon: "⌕",
        text: "Searching your library for matching papers",
      };
    case "read_attachment_text":
      return {
        kind: "tool",
        icon: "≣",
        text: "Reading the attached file",
      };
    case "save_answer_to_note":
      return {
        kind: "tool",
        icon: "✎",
        text: "Preparing a note draft",
      };
    case "edit_article_metadata":
      return {
        kind: "tool",
        icon: "✎",
        text: "Preparing metadata updates for the article",
      };
    default:
      return {
        kind: "tool",
        icon: "→",
        text: `Using ${formatAgentTraceToolName(name)}`,
      };
  }
}

function summarizeAgentTraceConfirmationRequest(
  toolName: string,
): AgentTraceSummaryRow {
  if (toolName === "save_answer_to_note") {
    return {
      kind: "plan",
      icon: "…",
      text: "Waiting for your approval before saving the note",
    };
  }
  if (toolName === "edit_article_metadata") {
    return {
      kind: "plan",
      icon: "…",
      text: "Waiting for your approval before applying the metadata changes",
    };
  }
  return {
    kind: "plan",
    icon: "…",
    text: `Waiting for your approval to continue with ${formatAgentTraceToolName(
      toolName,
    )}`,
  };
}

function summarizeAgentTraceConfirmationResolved(
  toolName: string,
  approved: boolean,
): AgentTraceSummaryRow {
  if (approved) {
    return {
      kind: "ok",
      icon: "✓",
      text:
        toolName === "save_answer_to_note"
          ? "Approval received — saving the note"
          : toolName === "edit_article_metadata"
            ? "Approval received — applying the metadata changes"
          : "Approval received — continuing",
    };
  }
  return {
    kind: "skip",
    icon: "−",
    text:
      toolName === "save_answer_to_note"
        ? "Note save cancelled"
        : toolName === "edit_article_metadata"
          ? "Metadata changes cancelled"
        : "Action cancelled",
  };
}

function summarizeAgentTraceToolResult(
  name: string,
  ok: boolean,
  content: unknown,
): AgentTraceSummaryRow | null {
  const normalized = isAgentTraceRecord(content) ? content : null;
  if (!ok) {
    const rawError = readAgentTraceText(normalized?.error);
    if (rawError?.toLowerCase() === "user denied action") {
      return null;
    }
    const errorText =
      rawError || `Tool failed: ${formatAgentTraceToolName(name)}`;
    return {
      kind: "skip",
      icon: "!",
      text: truncateAgentTraceText(
        `Could not complete ${formatAgentTraceToolName(name)}: ${errorText}`,
        92,
      ),
    };
  }

  switch (name) {
    case "get_active_context":
      return {
        kind: "ok",
        icon: "✓",
        text: "Confirmed the paper and attached context in scope",
      };
    case "list_paper_contexts": {
      const papers = Array.isArray(normalized?.papers) ? normalized.papers : [];
      return {
        kind: papers.length > 0 ? "ok" : "skip",
        icon: papers.length > 0 ? "✓" : "−",
        text:
          papers.length > 0
            ? `Confirmed ${papers.length} paper${papers.length === 1 ? "" : "s"} in scope`
            : "No paper context is currently in scope",
      };
    }
    case "retrieve_paper_evidence": {
      const evidence = Array.isArray(normalized?.evidence)
        ? normalized.evidence
        : [];
      return {
        kind: evidence.length > 0 ? "ok" : "skip",
        icon: evidence.length > 0 ? "✓" : "−",
        text:
          evidence.length > 0
            ? `Found ${evidence.length} relevant snippet${
                evidence.length === 1 ? "" : "s"
              }`
            : "No relevant snippets found",
      };
    }
    case "search_library_items": {
      const count = Array.isArray(normalized?.results)
        ? normalized.results.length
        : 0;
      return {
        kind: count > 0 ? "ok" : "skip",
        icon: count > 0 ? "✓" : "−",
        text:
          count > 0
            ? `Found ${count} matching paper${count === 1 ? "" : "s"} in your library`
            : "No matching papers found in the library",
      };
    }
    case "read_paper_excerpt":
      return {
        kind: "ok",
        icon: "✓",
        text: "Opened the strongest supporting passage",
      };
    case "read_attachment_text":
      return {
        kind: "ok",
        icon: "✓",
        text: "Read the attached file",
      };
    case "save_answer_to_note": {
      const status = readAgentTraceText(normalized?.status);
      return {
        kind: "ok",
        icon: "✓",
        text:
          status === "appended"
            ? "Saved the note to the current item"
            : status === "standalone_created"
              ? "Saved the note as a standalone note"
            : "Saved the note",
      };
    }
    case "edit_article_metadata": {
      const changedFields = Array.isArray(normalized?.changedFields)
        ? normalized.changedFields
        : [];
      return {
        kind: "ok",
        icon: "✓",
        text:
          changedFields.length > 0
            ? `Applied ${changedFields.length} metadata change${
                changedFields.length === 1 ? "" : "s"
              }`
            : "Applied the metadata changes",
      };
    }
    default:
      return null;
  }
}

function getNextMeaningfulPayload(
  events: AgentRunEventRecord[],
  fromIndex: number,
): AgentRunEventPayload | null {
  for (let index = fromIndex; index < events.length; index += 1) {
    const payload = events[index]?.payload;
    if (!payload || payload.type === "status") continue;
    return payload;
  }
  return null;
}

function getFirstToolName(events: AgentRunEventRecord[]): string | null {
  const toolCall = events.find((entry) => entry.payload.type === "tool_call");
  return toolCall?.payload.type === "tool_call" ? toolCall.payload.name : null;
}

function buildInitialAgentMessage(
  requestChips: AgentTraceChip[],
  firstToolName: string | null,
): string {
  if (firstToolName === "save_answer_to_note") {
    return requestChips.length
      ? "I’ve got your request and the attached context. I’ll draft the note first, then show it to you before I save anything."
      : "I’ve got your request. I’ll draft the note first, then show it to you before I save anything.";
  }
  if (firstToolName === "edit_article_metadata") {
    return requestChips.length
      ? "I’ve got your request and the attached context. I’ll review the article metadata first, then show you the proposed changes before I apply them."
      : "I’ve got your request. I’ll review the article metadata first, then show you the proposed changes before I apply them.";
  }
  return requestChips.length
    ? "I’ve got your question and the attached context. I’m checking that first so I can ground the answer properly."
    : "I’ve got your question. I’m checking the current context first.";
}

function buildToolFollowUpMessage(
  toolName: string,
  nextPayload: AgentRunEventPayload | null,
): string | null {
  if (!nextPayload) return null;
  if (nextPayload.type === "tool_call") {
    switch (nextPayload.name) {
      case "retrieve_paper_evidence":
        return toolName === "get_active_context" ||
          toolName === "list_paper_contexts"
          ? "I know which sources are in scope now, so I’m pulling the strongest evidence next."
          : "I have the right lead, so I’m pulling the strongest evidence next.";
      case "read_paper_excerpt":
        return "I found a useful lead, and I want to inspect the exact passage next.";
      case "search_library_items":
        return "I know what I need now, so I’m searching your library next.";
      case "read_attachment_text":
        return "I’ve narrowed it down, so I’m opening the attached file next.";
      case "save_answer_to_note":
        return "I have what I need, so I’m turning it into a note draft next.";
      case "edit_article_metadata":
        return "I know what should change now, so I’m preparing the metadata updates next.";
      default:
        return `I’m ready for the next step, so I’m using ${formatAgentTraceToolName(
          nextPayload.name,
        )} next.`;
    }
  }
  if (nextPayload.type === "confirmation_required") {
    return nextPayload.action.toolName === "save_answer_to_note"
      ? "I’ve prepared the draft. Review or edit it below, then choose where you want me to save it."
      : nextPayload.action.toolName === "edit_article_metadata"
        ? "I’ve prepared the metadata updates. Review or edit them below, then apply them if they look right."
      : "I’m ready for the next action. Review it below and approve if you want me to continue.";
  }
  if (nextPayload.type === "message_delta") {
    return "I have enough grounded information now, so I’m drafting the answer next.";
  }
  if (nextPayload.type === "final") {
    return "I have what I need now, so I can answer directly.";
  }
  return null;
}

function compactAgentTraceEvents(
  events: AgentRunEventRecord[],
): AgentRunEventRecord[] {
  const compact: AgentRunEventRecord[] = [];
  for (const entry of events) {
    const previous = compact[compact.length - 1];
    if (
      entry.payload.type === "message_delta" &&
      previous?.payload.type === "message_delta"
    ) {
      compact[compact.length - 1] = entry;
      continue;
    }
    compact.push(entry);
  }
  return compact;
}

function buildAgentTraceDisplayItems(
  events: AgentRunEventRecord[],
  userMessage: Message | null | undefined,
): AgentTraceDisplayItem[] {
  const items: AgentTraceDisplayItem[] = [];
  const compactedEvents = compactAgentTraceEvents(events);
  const requestChips = buildAgentTraceRequestChips(userMessage);
  const confirmationToolNames = new Map<string, string>();
  const firstToolName = getFirstToolName(compactedEvents);
  let announcedReadyToAnswer = false;
  let announcedWriting = false;

  items.push({
    type: "message",
    tone: "neutral",
    text: buildInitialAgentMessage(requestChips, firstToolName),
  });
  items.push({
    type: "action",
    row: {
      kind: "plan",
      icon: "↳",
      text: requestChips.length
        ? "Received your question and the attached context"
        : "Received your question",
    },
    chips: requestChips,
  });

  for (let index = 0; index < compactedEvents.length; index += 1) {
    const entry = compactedEvents[index];
    const nextPayload = getNextMeaningfulPayload(compactedEvents, index + 1);
    switch (entry.payload.type) {
      case "status":
        break;
      case "tool_call":
        items.push({
          type: "action",
          row: summarizeAgentTraceToolCall(entry.payload.name),
          chips: buildAgentTraceToolChips(
            entry.payload.name,
            entry.payload.args,
            userMessage,
          ),
        });
        break;
      case "tool_result": {
        const row = summarizeAgentTraceToolResult(
          entry.payload.name,
          entry.payload.ok,
          entry.payload.content,
        );
        if (row) {
          items.push({
            type: "action",
            row,
          });
          const followUp = buildToolFollowUpMessage(
            entry.payload.name,
            nextPayload,
          );
          if (followUp) {
            items.push({
              type: "message",
              tone: row.kind === "skip" ? "warning" : "neutral",
              text: followUp,
            });
          }
        }
        break;
      }
      case "confirmation_required":
        confirmationToolNames.set(
          entry.payload.requestId,
          entry.payload.action.toolName,
        );
        items.push({
          type: "message",
          tone: "warning",
          text:
            entry.payload.action.toolName === "save_answer_to_note"
              ? "I drafted the note. Review or edit it below, then tell me where you want me to save it."
              : entry.payload.action.toolName === "edit_article_metadata"
                ? "I drafted the metadata updates. Review or edit them below, then apply them if they look right."
              : "I’m ready for the next action, but I need your approval before I continue.",
        });
        items.push({
          type: "action",
          row: summarizeAgentTraceConfirmationRequest(
            entry.payload.action.toolName,
          ),
        });
        break;
      case "confirmation_resolved":
        items.push({
          type: "action",
          row: summarizeAgentTraceConfirmationResolved(
            confirmationToolNames.get(entry.payload.requestId) || "",
            entry.payload.approved,
          ),
        });
        items.push({
          type: "message",
          tone: entry.payload.approved ? "neutral" : "warning",
          text: entry.payload.approved
            ? confirmationToolNames.get(entry.payload.requestId) ===
              "save_answer_to_note"
              ? "Thanks — I’m saving the edited draft now."
              : confirmationToolNames.get(entry.payload.requestId) ===
                  "edit_article_metadata"
                ? "Thanks — I’m applying those metadata changes now."
              : "Thanks — I’m continuing with that action now."
            : confirmationToolNames.get(entry.payload.requestId) ===
                "save_answer_to_note"
              ? "No problem — I left the note unchanged."
              : confirmationToolNames.get(entry.payload.requestId) ===
                  "edit_article_metadata"
                ? "No problem — I left the metadata unchanged."
              : "No problem — I stopped there.",
        });
        break;
      case "message_delta":
        if (!announcedReadyToAnswer) {
          announcedReadyToAnswer = true;
          items.push({
            type: "message",
            tone: "neutral",
            text: "I have what I need now, so I’m turning it into a direct answer.",
          });
        }
        if (!announcedWriting) {
          announcedWriting = true;
          items.push({
            type: "action",
            row: {
              kind: "plan",
              icon: "✎",
              text: "Drafting the answer",
            },
          });
        }
        break;
      case "final":
        items.push({
          type: "action",
          row: {
            kind: "done",
            icon: "✓",
            text: "Response ready",
          },
        });
        break;
      case "fallback":
        items.push({
          type: "message",
          tone: "warning",
          text: "Tool use isn’t available for this model here, so I’m answering directly instead.",
        });
        break;
    }
  }

  return items;
}

export function renderAgentTrace({
  doc,
  message,
  userMessage,
  events,
  onTraceMissing,
}: RenderAgentTraceParams): HTMLElement | null {
  const runId = message.agentRunId?.trim();
  if (!runId) return null;
  const wrap = doc.createElement("div");
  wrap.className = "llm-agent-activity";
  const list = doc.createElement("div");
  list.className = "llm-agent-activity-list";

  if (!events.length) {
    onTraceMissing?.();
    const loadingRow = doc.createElement("div");
    loadingRow.className = "llm-at-row llm-at-row-plan";
    const loadingIcon = doc.createElement("span");
    loadingIcon.className = "llm-at-icon";
    loadingIcon.textContent = "...";
    const loadingText = doc.createElement("span");
    loadingText.className = "llm-at-text llm-at-plan-text";
    loadingText.textContent = "Loading agent activity...";
    loadingRow.append(loadingIcon, loadingText);
    list.appendChild(loadingRow);
    wrap.appendChild(list);
    return wrap;
  }
  const processItems = buildAgentTraceDisplayItems(events, userMessage);
  const pending = getPendingWriteConfirmation(events);
  const hasFinalResponse = events.some((entry) => entry.payload.type === "final");
  for (const itemEntry of processItems) {
    if (itemEntry.type === "message") {
      const messageEl = doc.createElement("div");
      messageEl.className = `llm-agent-process-message llm-agent-process-message-${itemEntry.tone}`;
      messageEl.textContent = itemEntry.text;
      list.appendChild(messageEl);
      continue;
    }

    const actionWrap = doc.createElement("div");
    actionWrap.className = "llm-agent-process-action";
    const row = doc.createElement("div");
    row.className = `llm-at-row llm-at-row-${itemEntry.row.kind}`;
    const icon = doc.createElement("span");
    icon.className = "llm-at-icon";
    icon.textContent = itemEntry.row.icon;
    const text = doc.createElement("span");
    text.className = `llm-at-text llm-at-${itemEntry.row.kind}-text`;
    text.textContent = itemEntry.row.text;
    row.append(icon, text);
    actionWrap.appendChild(row);

    if (itemEntry.chips?.length) {
      const chips = doc.createElement("div");
      chips.className = "llm-agent-process-chips";
      for (const chip of itemEntry.chips) {
        const chipEl = doc.createElement("div");
        chipEl.className = "llm-agent-process-chip";
        if (chip.title) {
          chipEl.title = chip.title;
        }
        const chipIcon = doc.createElement("span");
        chipIcon.className = "llm-agent-process-chip-icon";
        chipIcon.textContent = chip.icon;
        const chipLabel = doc.createElement("span");
        chipLabel.className = "llm-agent-process-chip-label";
        chipLabel.textContent = chip.label;
        chipEl.append(chipIcon, chipLabel);
        chips.appendChild(chipEl);
      }
      actionWrap.appendChild(chips);
    }

    list.appendChild(actionWrap);
  }
  wrap.appendChild(list);

  if (hasFinalResponse) {
    const divider = doc.createElement("div");
    divider.className = "llm-agent-output-divider";
    divider.setAttribute("aria-hidden", "true");
    wrap.appendChild(divider);
  }

  if (pending) {
    wrap.appendChild(renderPendingWriteActionCard(doc, pending));
  }

  return wrap;
}
