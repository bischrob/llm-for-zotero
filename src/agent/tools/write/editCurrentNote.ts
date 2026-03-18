import type { ZoteroGateway } from "../../services/zoteroGateway";
import { LibraryMutationService } from "../../services/libraryMutationService";
import { pushUndoEntry } from "../../store/undoStore";
import type { AgentToolDefinition } from "../../types";
import { normalizeNoteSourceText } from "../../../modules/contextPanel/notes";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import { executeAndRecordUndo } from "./mutateLibraryShared";

type EditCurrentNoteInput = {
  mode: "edit" | "create";
  content: string;
  expectedOriginalHtml?: string;
  noteId?: number;
  noteTitle?: string;
  target?: "item" | "standalone";
  targetItemId?: number;
};

export function createEditCurrentNoteTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<EditCurrentNoteInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);
  return {
    spec: {
      name: "edit_current_note",
      description:
        "Edit the current open Zotero note, or create a new note attached to a paper or as a standalone note. Pass plain text or Markdown only; do not send raw HTML tags.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["content"],
        properties: {
          mode: {
            type: "string",
            enum: ["edit", "create"],
            description:
              "Use 'edit' to replace the current open note (default), or 'create' to create a new note.",
          },
          content: {
            type: "string",
            description:
              "The full note body as plain text or Markdown. Do not include raw HTML.",
          },
          target: {
            type: "string",
            enum: ["item", "standalone"],
            description:
              "For mode 'create': attach to a paper ('item', default) or create standalone ('standalone').",
          },
          targetItemId: {
            type: "number",
            description:
              "For mode 'create': attach note to this specific item ID. If omitted, attaches to the active item.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    guidance: {
      matches: (request) => Boolean(request.activeNoteContext),
      instruction:
        "When the user asks you to edit, rewrite, or update the current open note, call `edit_current_note` with mode 'edit'. When the user asks you to create a new note for a paper, call `edit_current_note` with mode 'create'. Always pass plain text or Markdown, never raw HTML.",
    },
    presentation: {
      label: "Edit / Create Note",
      summaries: {
        onCall: "Preparing note changes",
        onPending: "Waiting for confirmation on note changes",
        onApproved: "Applying note changes",
        onDenied: "Note changes cancelled",
        onSuccess: ({ content }) => {
          const title =
            content && typeof content === "object"
              ? String((content as { title?: unknown }).title || "")
              : "";
          return title ? `Note saved: ${title}` : "Note saved";
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with a 'content' string");
      }
      if (typeof args.content !== "string" || !args.content.trim()) {
        return fail(
          "content is required: provide the note body as a string, e.g. { content: 'My note text' }",
        );
      }
      const mode =
        args.mode === "create" ? ("create" as const) : ("edit" as const);
      const target =
        args.target === "standalone"
          ? ("standalone" as const)
          : ("item" as const);
      return ok<EditCurrentNoteInput>({
        mode,
        content: normalizeNoteSourceText(args.content),
        target: mode === "create" ? target : undefined,
        targetItemId:
          mode === "create"
            ? normalizePositiveInt(args.targetItemId)
            : undefined,
      });
    },
    createPendingAction: (input, context) => {
      const normalizedContent = normalizeNoteSourceText(input.content);
      input.content = normalizedContent;

      if (input.mode === "create") {
        return {
          toolName: "edit_current_note",
          mode: "review",
          title: "Review new note",
          description:
            input.target === "standalone"
              ? "Review the note content before creating a standalone note."
              : "Review the note content before attaching it to the paper.",
          confirmLabel: "Create note",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "diff_preview",
              id: "noteDiff",
              label: "Note content",
              before: "",
              after: normalizedContent,
              sourceFieldId: "content",
              contextLines: 2,
              emptyMessage: "No note content yet.",
            },
            {
              type: "textarea",
              id: "content",
              label: "Final note content",
              value: normalizedContent,
            },
          ],
        };
      }

      const snapshot = zoteroGateway.getActiveNoteSnapshot({
        request: context.request,
        item: context.item,
      });
      if (!snapshot) {
        throw new Error("No active note is available to edit");
      }
      input.expectedOriginalHtml = snapshot.html;
      input.noteId = snapshot.noteId;
      input.noteTitle = snapshot.title || "Untitled note";
      return {
        toolName: "edit_current_note",
        mode: "review",
        title: `Review note update`,
        description: `Review the proposed note changes for "${input.noteTitle}" and edit the final note text before applying it.`,
        confirmLabel: "Apply edit",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "diff_preview",
            id: "noteDiff",
            label: "Note changes",
            before: snapshot.text,
            after: normalizedContent,
            sourceFieldId: "content",
            contextLines: 2,
            emptyMessage: "No note changes yet.",
          },
          {
            type: "textarea",
            id: "content",
            label: "Final note content",
            value: normalizedContent,
          },
        ],
      };
    },
    applyConfirmation: (input, resolutionData) => {
      if (!validateObject<Record<string, unknown>>(resolutionData)) {
        return ok(input);
      }
      return ok({
        ...input,
        content:
          typeof resolutionData.content === "string"
            ? normalizeNoteSourceText(resolutionData.content)
            : input.content,
      });
    },
    execute: async (input, context) => {
      if (input.mode === "create") {
        const { result } = await executeAndRecordUndo(
          mutationService,
          {
            type: "save_note",
            content: input.content,
            target: input.target,
            targetItemId: input.targetItemId,
          },
          context,
          "edit_current_note",
        );
        return result;
      }

      const result = await zoteroGateway.replaceCurrentNote({
        request: context.request,
        item: context.item,
        content: input.content,
        expectedOriginalHtml: input.expectedOriginalHtml,
      });
      pushUndoEntry(context.request.conversationKey, {
        id: `undo-edit-current-note-${result.noteId}-${Date.now()}`,
        toolName: "edit_current_note",
        description: `Revert note edit: ${result.title}`,
        revert: async () => {
          await zoteroGateway.restoreNoteHtml({
            noteId: result.noteId,
            html: result.previousHtml,
          });
        },
      });
      return {
        status: "updated",
        noteId: result.noteId,
        title: result.title,
        noteText: result.nextText,
      };
    },
  };
}
