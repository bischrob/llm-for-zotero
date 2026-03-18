/**
 * Shared helpers extracted from mutateLibrary.ts for use by
 * both the internal mutate_library tool and the focused facade tools.
 */
import type { AgentPendingField, AgentToolContext, AgentToolDefinition } from "../../types";
import type {
  ApplyTagsOperation,
  MoveToCollectionOperation,
  UpdateMetadataOperation,
  SaveNoteOperation,
  LibraryMutationOperation,
  LibraryMutationService,
} from "../../services/libraryMutationService";
import type {
  EditableArticleCreator,
  EditableArticleMetadataPatch,
  ZoteroGateway,
} from "../../services/zoteroGateway";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "../../services/zoteroGateway";
import { pushUndoEntry } from "../../store/undoStore";
import { normalizeNoteSourceText } from "../../../modules/contextPanel/notes";
import { normalizePositiveInt, normalizeStringArray, validateObject } from "../shared";

// ── Tag assignment helpers ──────────────────────────────────────────────────

export function getTagAssignmentFieldId(operation: ApplyTagsOperation): string {
  return `tagAssignments:${operation.id || "apply_tags"}`;
}

export function getTagAssignments(
  operation: ApplyTagsOperation,
): Array<{ itemId: number; tags: string[] }> {
  if (operation.assignments?.length) {
    return operation.assignments.map((assignment) => ({
      itemId: assignment.itemId,
      tags: Array.isArray(assignment.tags) ? assignment.tags : [],
    }));
  }
  if (!operation.itemIds?.length) {
    return [];
  }
  return operation.itemIds.map((itemId) => ({
    itemId,
    tags: operation.tags || [],
  }));
}

export function buildTagAssignmentField(
  operation: ApplyTagsOperation,
  zoteroGateway: ZoteroGateway,
) {
  const assignments = getTagAssignments(operation);
  if (!assignments.length) {
    return null;
  }
  const targetByItemId = new Map(
    zoteroGateway
      .getPaperTargetsByItemIds(assignments.map((assignment) => assignment.itemId))
      .map((target) => [target.itemId, target] as const),
  );
  return {
    type: "tag_assignment_table" as const,
    id: getTagAssignmentFieldId(operation),
    label: "Suggested tags",
    rows: assignments.map((assignment) => {
      const target = targetByItemId.get(assignment.itemId);
      const details = [target?.firstCreator || "", target?.year || ""].filter(Boolean);
      return {
        id: `${assignment.itemId}`,
        label: target?.title || `Item ${assignment.itemId}`,
        description: details.join(" · ") || undefined,
        value: assignment.tags,
        placeholder: "tag-one, tag-two",
      };
    }),
  };
}

export function normalizeTagAssignmentsFromResolution(
  value: unknown,
): Array<{ itemId: number; tags: string[] }> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .map((entry) => {
      if (!validateObject<Record<string, unknown>>(entry)) {
        return null;
      }
      const itemId = normalizePositiveInt(entry.id);
      const tags = normalizeStringArray(entry.value);
      if (!itemId || !tags?.length) {
        return null;
      }
      return { itemId, tags };
    })
    .filter((entry): entry is { itemId: number; tags: string[] } => Boolean(entry));
}

// ── Move assignment helpers ─────────────────────────────────────────────────

export function getMoveAssignmentFieldId(operation: MoveToCollectionOperation): string {
  return `moveAssignments:${operation.id || "move_to_collection"}`;
}

function normalizeCollectionKey(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function describeCollection(
  collection: ReturnType<ZoteroGateway["getCollectionSummary"]>,
): string {
  return collection ? collection.path || collection.name : "unknown collection";
}

export function getMoveAssignments(
  operation: MoveToCollectionOperation,
): Array<{
  itemId: number;
  targetCollectionId?: number;
  targetCollectionName?: string;
  targetCollectionPath?: string;
}> {
  if (operation.assignments?.length) {
    return operation.assignments;
  }
  if (!operation.itemIds?.length) {
    return [];
  }
  return operation.itemIds.map((itemId) => ({
    itemId,
    targetCollectionId: operation.targetCollectionId,
    targetCollectionName: operation.targetCollectionName,
    targetCollectionPath: operation.targetCollectionPath,
  }));
}

export function buildCollectionSelectOptions(
  zoteroGateway: ZoteroGateway,
  context: AgentToolContext,
): Array<{
  id: string;
  label: string;
  name: string;
  path: string;
}> {
  const libraryID = zoteroGateway.resolveLibraryID({
    request: context.request,
    item: context.item,
  });
  if (!libraryID) {
    return [];
  }
  const summaries = zoteroGateway.listCollectionSummaries(libraryID);
  return summaries.map((collection) => ({
    id: `${collection.collectionId}`,
    label: collection.path || collection.name,
    name: collection.name,
    path: collection.path || collection.name,
  }));
}

function resolveInitialCollectionSelection(
  assignment: ReturnType<typeof getMoveAssignments>[number],
  options: ReturnType<typeof buildCollectionSelectOptions>,
): string | undefined {
  if (assignment.targetCollectionId) {
    const direct = options.find(
      (option) => option.id === `${assignment.targetCollectionId}`,
    );
    if (direct) return direct.id;
  }
  const pathKey = normalizeCollectionKey(assignment.targetCollectionPath);
  if (pathKey) {
    const pathMatch = options.find(
      (option) => normalizeCollectionKey(option.path) === pathKey,
    );
    if (pathMatch) return pathMatch.id;
  }
  const nameKey = normalizeCollectionKey(assignment.targetCollectionName);
  if (nameKey) {
    const matches = options.filter(
      (option) =>
        normalizeCollectionKey(option.name) === nameKey ||
        normalizeCollectionKey(option.path) === nameKey,
    );
    if (matches.length === 1) {
      return matches[0].id;
    }
  }
  return undefined;
}

export function buildMoveAssignmentField(
  operation: MoveToCollectionOperation,
  zoteroGateway: ZoteroGateway,
  context: AgentToolContext,
) {
  const assignments = getMoveAssignments(operation);
  if (!assignments.length) {
    return null;
  }
  const options = buildCollectionSelectOptions(zoteroGateway, context);
  if (!options.length) {
    return null;
  }
  const itemIds = assignments.map((assignment) => assignment.itemId);
  const targetByItemId = new Map(
    zoteroGateway
      .getPaperTargetsByItemIds(itemIds)
      .map((target) => [target.itemId, target] as const),
  );
  return {
    type: "assignment_table" as const,
    id: getMoveAssignmentFieldId(operation),
    label: assignments.length === 1 ? "Destination folder" : "Destination folders",
    options: [
      { id: "__skip__", label: "Leave untouched" },
      ...options.map((option) => ({
        id: option.id,
        label: option.label,
      })),
    ],
    rows: assignments.map((assignment) => {
      const target = targetByItemId.get(assignment.itemId);
      const currentCollections = (target?.collectionIds || [])
        .map((collectionId) => zoteroGateway.getCollectionSummary(collectionId))
        .filter(Boolean)
        .map((collection) => describeCollection(collection));
      const details = [
        target?.firstCreator || "",
        target?.year || "",
        currentCollections.length
          ? `Current: ${currentCollections.join(", ")}`
          : "Current: unfiled",
      ].filter(Boolean);
      return {
        id: `${assignment.itemId}`,
        label: target?.title || `Item ${assignment.itemId}`,
        description: details.join(" | "),
        value:
          resolveInitialCollectionSelection(assignment, options) || "__skip__",
        checked: true,
      };
    }),
  };
}

export function normalizeMoveAssignmentsFromResolution(
  value: unknown,
): Array<{ itemId: number; targetCollectionId: number }> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .map((entry) => {
      if (!validateObject<Record<string, unknown>>(entry)) {
        return null;
      }
      if (entry.checked === false || entry.value === "__skip__") {
        return null;
      }
      const itemId = normalizePositiveInt(entry.id);
      const targetCollectionId = normalizePositiveInt(entry.value);
      if (!itemId || !targetCollectionId) {
        return null;
      }
      return { itemId, targetCollectionId };
    })
    .filter(
      (entry): entry is { itemId: number; targetCollectionId: number } =>
        Boolean(entry),
    );
}

// ── Metadata review helpers ─────────────────────────────────────────────────

export const METADATA_FIELD_DISPLAY_LABELS: Record<string, string> = {
  title: "Title",
  shortTitle: "Short title",
  abstractNote: "Abstract",
  publicationTitle: "Journal",
  journalAbbreviation: "Journal abbreviation",
  proceedingsTitle: "Proceedings title",
  date: "Date",
  volume: "Volume",
  issue: "Issue",
  pages: "Pages",
  DOI: "DOI",
  url: "URL",
  language: "Language",
  extra: "Extra",
  ISSN: "ISSN",
  ISBN: "ISBN",
  publisher: "Publisher",
  place: "Place",
};

export function formatCreatorsDisplay(
  creators: EditableArticleCreator[],
): string {
  return creators
    .map((c) => {
      if (c.name) return c.name;
      return [c.firstName, c.lastName].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join("; ");
}

export function buildUpdateMetadataReviewField(
  operation: UpdateMetadataOperation,
  zoteroGateway: ZoteroGateway,
  context: AgentToolContext,
  itemTitle: string,
  showTitle: boolean,
): Extract<AgentPendingField, { type: "review_table" }> | null {
  const item = zoteroGateway.resolveMetadataItem({
    itemId: operation.itemId,
    paperContext: operation.paperContext,
    request: context.request,
    item: context.item,
  });
  const snapshot = zoteroGateway.getEditableArticleMetadata(item);
  const rows: Extract<AgentPendingField, { type: "review_table" }>["rows"] =
    [];

  for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(operation.metadata, fieldName))
      continue;
    const newValue = operation.metadata[fieldName] ?? "";
    const label = METADATA_FIELD_DISPLAY_LABELS[fieldName] || fieldName;
    const before = snapshot?.fields[fieldName] ?? "";
    rows.push({
      key: fieldName,
      label,
      before,
      after: newValue,
      multiline: fieldName === "abstractNote",
    });
  }

  if (operation.metadata.creators !== undefined) {
    const before = snapshot ? formatCreatorsDisplay(snapshot.creators) : "";
    const after = formatCreatorsDisplay(operation.metadata.creators);
    rows.push({ key: "creators", label: "Authors", before, after });
  }

  if (!rows.length) return null;

  return {
    type: "review_table",
    id: `metadataReview:${operation.id}`,
    label: showTitle ? itemTitle : undefined,
    rows,
  };
}

// ── Save note review helpers ────────────────────────────────────────────────

export function getSaveNoteContentFieldId(operation: SaveNoteOperation): string {
  return `saveNoteContent:${operation.id || "save_note"}`;
}

export function buildSaveNoteReviewFields(
  operations: LibraryMutationOperation[],
): AgentPendingField[] {
  const saveNoteOperations = operations.filter(
    (operation): operation is SaveNoteOperation =>
      operation.type === "save_note",
  );
  if (!saveNoteOperations.length) return [];
  return saveNoteOperations.flatMap((operation, index) => {
    const suffix = saveNoteOperations.length > 1 ? ` ${index + 1}` : "";
    return [
      {
        type: "diff_preview" as const,
        id: `saveNoteDiff:${operation.id || "save_note"}`,
        label: `Note changes${suffix}`,
        before: "",
        after: operation.content,
        sourceFieldId: getSaveNoteContentFieldId(operation),
        contextLines: 2,
        emptyMessage: "No note content yet.",
      },
      {
        type: "textarea" as const,
        id: getSaveNoteContentFieldId(operation),
        label: `Final note content${suffix}`,
        value: operation.content,
      },
    ];
  });
}

// ── Operation summary ───────────────────────────────────────────────────────

export function summarizeOperation(
  operation: LibraryMutationOperation,
  zoteroGateway: ZoteroGateway,
): { label: string; description: string } {
  switch (operation.type) {
    case "update_metadata": {
      const fieldNames = Object.keys(operation.metadata);
      const item = zoteroGateway.resolveMetadataItem({
        itemId: operation.itemId,
        paperContext: operation.paperContext,
      });
      const title =
        zoteroGateway.getEditableArticleMetadata(item)?.title ||
        operation.paperContext?.title ||
        "selected item";
      return {
        label: `Update metadata for ${title}`,
        description: `Fields: ${fieldNames.join(", ")}`,
      };
    }
    case "apply_tags": {
      const count =
        operation.assignments?.length || operation.itemIds?.length || 0;
      return {
        label: `Apply tags to ${count} paper${count === 1 ? "" : "s"}`,
        description: operation.tags?.length
          ? `Tags: ${operation.tags.join(", ")}`
          : "Per-paper tag assignments",
      };
    }
    case "remove_tags":
      return {
        label: `Remove tags from ${operation.itemIds.length} paper${
          operation.itemIds.length === 1 ? "" : "s"
        }`,
        description: `Tags: ${operation.tags.join(", ")}`,
      };
    case "move_to_collection": {
      const count =
        operation.assignments?.length || operation.itemIds?.length || 0;
      const collection = operation.targetCollectionId
        ? zoteroGateway.getCollectionSummary(operation.targetCollectionId)
        : null;
      return {
        label: `Add ${count} paper${count === 1 ? "" : "s"} to a collection`,
        description: collection
          ? `Target: ${describeCollection(collection)}`
          : "Per-paper collection assignments",
      };
    }
    case "remove_from_collection": {
      const collection = zoteroGateway.getCollectionSummary(
        operation.collectionId,
      );
      return {
        label: `Remove ${operation.itemIds.length} paper${
          operation.itemIds.length === 1 ? "" : "s"
        } from a collection`,
        description: `Collection: ${describeCollection(collection)}`,
      };
    }
    case "create_collection":
      return {
        label: `Create collection "${operation.name}"`,
        description: operation.parentCollectionId
          ? `Parent: ${describeCollection(
              zoteroGateway.getCollectionSummary(
                operation.parentCollectionId,
              ),
            )}`
          : "Top-level collection",
      };
    case "delete_collection":
      return {
        label: "Delete collection",
        description: describeCollection(
          zoteroGateway.getCollectionSummary(operation.collectionId),
        ),
      };
    case "save_note":
      return {
        label: "Save note",
        description:
          operation.target === "standalone"
            ? "Standalone note"
            : "Attach to current or selected item",
      };
    case "import_identifiers": {
      const collection = operation.targetCollectionId
        ? zoteroGateway.getCollectionSummary(operation.targetCollectionId)
        : null;
      return {
        label: `Import ${operation.identifiers.length} identifier${
          operation.identifiers.length === 1 ? "" : "s"
        }`,
        description: collection
          ? `${operation.identifiers.join(", ")} → ${describeCollection(collection)}`
          : operation.identifiers.join(", "),
      };
    }
    case "trash_items": {
      const titles = operation.itemIds.map((id) => {
        const item = zoteroGateway.getItem(id);
        return item
          ? String(item.getField?.("title") || `Item ${id}`)
          : `Item ${id}`;
      });
      return {
        label: `Trash ${operation.itemIds.length} item${
          operation.itemIds.length === 1 ? "" : "s"
        }`,
        description:
          titles.slice(0, 5).join(", ") +
          (titles.length > 5 ? `, +${titles.length - 5} more` : ""),
      };
    }
  }
}

// ── Execution + undo helper ─────────────────────────────────────────────────

/**
 * Execute a single operation via the mutation service and register undo.
 * Used by both the internal mutate_library and the focused facade tools.
 */
export async function executeAndRecordUndo(
  mutationService: LibraryMutationService,
  operation: LibraryMutationOperation,
  context: AgentToolContext,
  facadeToolName: string,
): Promise<{ result: unknown }> {
  const executed = await mutationService.executeOperation(operation, context);
  if (executed.undo) {
    pushUndoEntry(context.request.conversationKey, {
      id: `undo-${facadeToolName}-${Date.now()}`,
      toolName: facadeToolName,
      description: executed.undo.description,
      revert: executed.undo.revert,
    });
  }
  return { result: executed.result };
}
