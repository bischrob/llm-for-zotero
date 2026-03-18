import type { PaperContextRef } from "../../../shared/types";
import { normalizeNoteSourceText } from "../../../modules/contextPanel/notes";
import type { AgentPendingField, AgentToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type ApplyTagsOperation,
  type CreateCollectionOperation,
  type DeleteCollectionOperation,
  type ImportIdentifiersOperation,
  type LibraryMutationOperation,
  type MoveToCollectionOperation,
  type RemoveFromCollectionOperation,
  type RemoveTagsOperation,
  type SaveNoteOperation,
  type TrashItemsOperation,
  type UpdateMetadataOperation,
} from "../../services/libraryMutationService";
import type {
  EditableArticleCreator,
  EditableArticleMetadataPatch,
  EditableArticleMetadataField,
  ZoteroGateway,
} from "../../services/zoteroGateway";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "../../services/zoteroGateway";
import { pushUndoEntry } from "../../store/undoStore";
import {
  fail,
  normalizePositiveInt,
  normalizePositiveIntArray,
  normalizeStringArray,
  normalizeToolPaperContext,
  ok,
  validateObject,
} from "../shared";

type MutateLibraryInput = {
  operations: LibraryMutationOperation[];
};

function normalizeOperationListValue(args: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(args, "operations")) {
    return args.operations;
  }
  if (Object.prototype.hasOwnProperty.call(args, "operation")) {
    return [args.operation];
  }
  if (typeof args.type === "string" && args.type.trim()) {
    return [args];
  }
  return args.operations;
}

function normalizeStringValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`.trim();
  }
  return null;
}

function normalizeCreator(value: unknown): EditableArticleCreator | null {
  if (!validateObject<Record<string, unknown>>(value)) return null;
  const creatorType =
    typeof value.creatorType === "string" && value.creatorType.trim()
      ? value.creatorType.trim()
      : "author";
  const name =
    typeof value.name === "string" && value.name.trim()
      ? value.name.trim()
      : undefined;
  const firstName =
    typeof value.firstName === "string" && value.firstName.trim()
      ? value.firstName.trim()
      : undefined;
  const lastName =
    typeof value.lastName === "string" && value.lastName.trim()
      ? value.lastName.trim()
      : undefined;
  if (!name && !firstName && !lastName) return null;
  return {
    creatorType,
    name,
    firstName,
    lastName,
    fieldMode: name ? 1 : 0,
  };
}

function normalizeCreatorsList(raw: unknown): EditableArticleCreator[] | null {
  if (Array.isArray(raw)) {
    const list = raw
      .map((entry) => normalizeCreator(entry))
      .filter((entry): entry is EditableArticleCreator => Boolean(entry));
    return list;
  }
  // Model may send a comma/semicolon-separated string like "Stefan Leutgeb, Jill K. Leutgeb"
  if (typeof raw === "string" && raw.trim()) {
    return raw
      .split(/;|,(?![^(]*\))/)
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ creatorType: "author", name, fieldMode: 1 as const }));
  }
  return null;
}

function normalizeMetadataPatch(value: unknown): EditableArticleMetadataPatch | null {
  if (!validateObject<Record<string, unknown>>(value)) return null;
  const normalizedValue = validateObject<Record<string, unknown>>(value.fields)
    ? {
        ...(value.fields as Record<string, unknown>),
        ...value,
      }
    : value;
  const metadata: EditableArticleMetadataPatch = {};
  for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(normalizedValue, fieldName)) continue;
    const normalized = normalizeStringValue(normalizedValue[fieldName]);
    if (normalized === null) return null;
    metadata[fieldName as EditableArticleMetadataField] = normalized;
  }
  // Accept "creators" or "authors" (common model alias). Handle arrays and
  // comma/semicolon-separated strings. Non-parseable values are silently skipped
  // so they do not abort the entire patch.
  const rawCreators =
    Object.prototype.hasOwnProperty.call(normalizedValue, "creators")
      ? normalizedValue.creators
      : Object.prototype.hasOwnProperty.call(normalizedValue, "authors")
        ? normalizedValue.authors
        : undefined;
  if (rawCreators !== undefined) {
    const creators = normalizeCreatorsList(rawCreators);
    if (creators !== null) {
      metadata.creators = creators;
    }
    // If unparseable, skip rather than aborting the whole patch
  }
  return Object.keys(metadata).length ? metadata : null;
}

function normalizePaperContext(value: unknown): PaperContextRef | undefined {
  if (!validateObject<Record<string, unknown>>(value)) return undefined;
  return normalizeToolPaperContext(value) || undefined;
}

function normalizeOperationId(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeUpdateMetadataOperation(
  value: Record<string, unknown>,
  fallbackId: string,
): UpdateMetadataOperation | null {
  const metadata =
    normalizeMetadataPatch(value.metadata) ||
    normalizeMetadataPatch(value.patch) ||
    normalizeMetadataPatch(value);
  if (!metadata) return null;
  return {
    id: normalizeOperationId(value.id, fallbackId),
    type: "update_metadata",
    itemId: normalizePositiveInt(value.itemId),
    paperContext: normalizePaperContext(value.paperContext),
    metadata,
  };
}

function normalizeAssignments(
  value: unknown,
): Array<{
  itemId: number;
  tags?: string[];
  targetCollectionId?: number;
  targetCollectionName?: string;
  targetCollectionPath?: string;
}> | null {
  if (!Array.isArray(value)) return null;
  const entries: Array<{
    itemId: number;
    tags?: string[];
    targetCollectionId?: number;
    targetCollectionName?: string;
    targetCollectionPath?: string;
  }> = [];
  for (const entry of value) {
    if (!validateObject<Record<string, unknown>>(entry)) continue;
    const itemId = normalizePositiveInt(entry.itemId);
    if (!itemId) continue;
    const targetCollectionName =
      typeof entry.targetCollectionName === "string" && entry.targetCollectionName.trim()
        ? entry.targetCollectionName.trim()
        : typeof entry.collectionName === "string" && entry.collectionName.trim()
          ? entry.collectionName.trim()
          : typeof entry.folderName === "string" && entry.folderName.trim()
            ? entry.folderName.trim()
            : undefined;
    const targetCollectionPath =
      typeof entry.targetCollectionPath === "string" && entry.targetCollectionPath.trim()
        ? entry.targetCollectionPath.trim()
        : typeof entry.collectionPath === "string" && entry.collectionPath.trim()
          ? entry.collectionPath.trim()
          : typeof entry.folderPath === "string" && entry.folderPath.trim()
            ? entry.folderPath.trim()
            : undefined;
    entries.push({
      itemId,
      tags: normalizeStringArray(entry.tags) || undefined,
      targetCollectionId:
        normalizePositiveInt(entry.targetCollectionId) ||
        normalizePositiveInt(entry.collectionId),
      targetCollectionName,
      targetCollectionPath,
    });
  }
  return entries.length ? entries : null;
}

function normalizeApplyTagsOperation(
  value: Record<string, unknown>,
  fallbackId: string,
): ApplyTagsOperation | null {
  const assignments = normalizeAssignments(value.assignments)?.map((entry) => ({
    itemId: entry.itemId,
    tags: entry.tags || [],
  }));
  const itemIds = normalizePositiveIntArray(value.itemIds) || undefined;
  const tags = normalizeStringArray(value.tags) || undefined;
  if (!assignments?.length && (!itemIds?.length || !tags?.length)) return null;
  return {
    id: normalizeOperationId(value.id, fallbackId),
    type: "apply_tags",
    assignments: assignments?.length ? assignments : undefined,
    itemIds,
    tags,
  };
}

function normalizeRemoveTagsOperation(
  value: Record<string, unknown>,
  fallbackId: string,
): RemoveTagsOperation | null {
  const itemIds = normalizePositiveIntArray(value.itemIds);
  const tags = normalizeStringArray(value.tags);
  if (!itemIds?.length || !tags?.length) return null;
  return {
    id: normalizeOperationId(value.id, fallbackId),
    type: "remove_tags",
    itemIds,
    tags,
  };
}

function normalizeMoveToCollectionOperation(
  value: Record<string, unknown>,
  fallbackId: string,
): MoveToCollectionOperation | null {
  const assignments = normalizeAssignments(value.assignments)?.map((entry) => ({
    itemId: entry.itemId,
    targetCollectionId: entry.targetCollectionId,
    targetCollectionName: entry.targetCollectionName,
    targetCollectionPath: entry.targetCollectionPath,
  }));
  const itemIds =
    normalizePositiveIntArray(value.itemIds) ||
    normalizePositiveIntArray(value.items) ||
    normalizePositiveIntArray(value.paperIds) ||
    normalizePositiveIntArray(value.papers) ||
    (normalizePositiveInt(value.itemId)
      ? [normalizePositiveInt(value.itemId) as number]
      : undefined);
  const targetCollectionId =
    normalizePositiveInt(value.targetCollectionId) ||
    normalizePositiveInt(value.collectionId) ||
    normalizePositiveInt(value.folderId);
  const targetCollectionName =
    typeof value.targetCollectionName === "string" && value.targetCollectionName.trim()
      ? value.targetCollectionName.trim()
      : typeof value.collectionName === "string" && value.collectionName.trim()
        ? value.collectionName.trim()
        : typeof value.folderName === "string" && value.folderName.trim()
          ? value.folderName.trim()
          : undefined;
  const targetCollectionPath =
    typeof value.targetCollectionPath === "string" && value.targetCollectionPath.trim()
      ? value.targetCollectionPath.trim()
      : typeof value.collectionPath === "string" && value.collectionPath.trim()
        ? value.collectionPath.trim()
        : typeof value.folderPath === "string" && value.folderPath.trim()
          ? value.folderPath.trim()
          : undefined;
  if (!assignments?.length && !itemIds?.length) return null;
  return {
    id: normalizeOperationId(value.id, fallbackId),
    type: "move_to_collection",
    assignments: assignments?.length ? assignments : undefined,
    itemIds,
    targetCollectionId,
    targetCollectionName,
    targetCollectionPath,
  };
}

function normalizeRemoveFromCollectionOperation(
  value: Record<string, unknown>,
  fallbackId: string,
): RemoveFromCollectionOperation | null {
  const itemIds = normalizePositiveIntArray(value.itemIds);
  const collectionId = normalizePositiveInt(value.collectionId);
  if (!itemIds?.length || !collectionId) return null;
  return {
    id: normalizeOperationId(value.id, fallbackId),
    type: "remove_from_collection",
    itemIds,
    collectionId,
  };
}

function normalizeCreateCollectionOperation(
  value: Record<string, unknown>,
  fallbackId: string,
): CreateCollectionOperation | null {
  const name =
    typeof value.name === "string" && value.name.trim() ? value.name.trim() : "";
  if (!name) return null;
  return {
    id: normalizeOperationId(value.id, fallbackId),
    type: "create_collection",
    name,
    parentCollectionId: normalizePositiveInt(value.parentCollectionId),
    libraryID: normalizePositiveInt(value.libraryID),
  };
}

function normalizeDeleteCollectionOperation(
  value: Record<string, unknown>,
  fallbackId: string,
): DeleteCollectionOperation | null {
  const collectionId = normalizePositiveInt(value.collectionId);
  if (!collectionId) return null;
  return {
    id: normalizeOperationId(value.id, fallbackId),
    type: "delete_collection",
    collectionId,
  };
}

function normalizeSaveNoteOperation(
  value: Record<string, unknown>,
  fallbackId: string,
): SaveNoteOperation | null {
  const content =
    typeof value.content === "string"
      ? normalizeNoteSourceText(value.content)
      : "";
  if (!content) return null;
  return {
    id: normalizeOperationId(value.id, fallbackId),
    type: "save_note",
    content,
    target:
      value.target === "item" || value.target === "standalone"
        ? value.target
        : undefined,
    targetItemId: normalizePositiveInt(value.targetItemId),
    modelName:
      typeof value.modelName === "string" && value.modelName.trim()
        ? value.modelName.trim()
        : undefined,
  };
}

function normalizeImportIdentifiersOperation(
  value: Record<string, unknown>,
  fallbackId: string,
): ImportIdentifiersOperation | null {
  const identifiers = normalizeStringArray(value.identifiers);
  if (!identifiers?.length) return null;
  return {
    id: normalizeOperationId(value.id, fallbackId),
    type: "import_identifiers",
    identifiers,
    libraryID: normalizePositiveInt(value.libraryID),
    targetCollectionId:
      normalizePositiveInt(value.targetCollectionId) ||
      normalizePositiveInt(value.collectionId) ||
      normalizePositiveInt(value.folderId),
  };
}

function normalizeTrashItemsOperation(
  value: Record<string, unknown>,
  fallbackId: string,
): TrashItemsOperation | null {
  const itemIds = normalizePositiveIntArray(value.itemIds);
  if (!itemIds?.length) return null;
  return {
    id: normalizeOperationId(value.id, fallbackId),
    type: "trash_items",
    itemIds,
  };
}

function normalizeOperation(
  value: unknown,
  index: number,
): LibraryMutationOperation | null {
  if (!validateObject<Record<string, unknown>>(value)) return null;
  const fallbackId = `op-${index + 1}`;
  switch (value.type) {
    case "update_metadata":
      return normalizeUpdateMetadataOperation(value, fallbackId);
    case "apply_tags":
      return normalizeApplyTagsOperation(value, fallbackId);
    case "remove_tags":
      return normalizeRemoveTagsOperation(value, fallbackId);
    case "move_to_collection":
      return normalizeMoveToCollectionOperation(value, fallbackId);
    case "remove_from_collection":
      return normalizeRemoveFromCollectionOperation(value, fallbackId);
    case "create_collection":
      return normalizeCreateCollectionOperation(value, fallbackId);
    case "delete_collection":
      return normalizeDeleteCollectionOperation(value, fallbackId);
    case "save_note":
      return normalizeSaveNoteOperation(value, fallbackId);
    case "import_identifiers":
      return normalizeImportIdentifiersOperation(value, fallbackId);
    case "trash_items":
      return normalizeTrashItemsOperation(value, fallbackId);
    default:
      return null;
  }
}

function normalizeOperations(value: unknown): LibraryMutationOperation[] | null {
  if (!Array.isArray(value)) return null;
  const operations = value
    .map((entry, index) => normalizeOperation(entry, index))
    .filter((entry): entry is LibraryMutationOperation => Boolean(entry));
  return operations.length ? operations : null;
}

function getMoveAssignmentFieldId(operation: MoveToCollectionOperation): string {
  return `moveAssignments:${operation.id || "move_to_collection"}`;
}

function getTagAssignmentFieldId(operation: ApplyTagsOperation): string {
  return `tagAssignments:${operation.id || "apply_tags"}`;
}

function getSaveNoteContentFieldId(operation: SaveNoteOperation): string {
  return `saveNoteContent:${operation.id || "save_note"}`;
}

function buildSaveNoteReviewFields(
  operations: LibraryMutationOperation[],
): AgentPendingField[] {
  const saveNoteOperations = operations.filter(
    (operation): operation is SaveNoteOperation => operation.type === "save_note",
  );
  if (!saveNoteOperations.length) return [];
  return saveNoteOperations.flatMap((operation, index) => {
    const suffix =
      saveNoteOperations.length > 1 ? ` ${index + 1}` : "";
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

function normalizeCollectionKey(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function getMoveAssignments(
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

function getTagAssignments(
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

function buildCollectionSelectOptions(
  zoteroGateway: ZoteroGateway,
  context: Parameters<
    NonNullable<AgentToolDefinition<MutateLibraryInput, unknown>["createPendingAction"]>
  >[1],
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
    const direct = options.find((option) => option.id === `${assignment.targetCollectionId}`);
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

function buildMoveAssignmentField(
  operation: MoveToCollectionOperation,
  zoteroGateway: ZoteroGateway,
  context: Parameters<
    NonNullable<AgentToolDefinition<MutateLibraryInput, unknown>["createPendingAction"]>
  >[1],
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
        value: resolveInitialCollectionSelection(assignment, options) || "__skip__",
        checked: true,
      };
    }),
  };
}

function buildTagAssignmentField(
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

function normalizeMoveAssignmentsFromResolution(
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
      return {
        itemId,
        targetCollectionId,
      };
    })
    .filter(
      (entry): entry is { itemId: number; targetCollectionId: number } =>
        Boolean(entry),
    );
}

function normalizeTagAssignmentsFromResolution(
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

function describeCollection(collection: ReturnType<ZoteroGateway["getCollectionSummary"]>) {
  return collection ? collection.path || collection.name : "unknown collection";
}

// ── Metadata before/after review helpers ────────────────────────────────────

const METADATA_FIELD_DISPLAY_LABELS: Record<string, string> = {
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

function formatCreatorsDisplay(creators: EditableArticleCreator[]): string {
  return creators
    .map((c) => {
      if (c.name) return c.name;
      return [c.firstName, c.lastName].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join("; ");
}

function buildUpdateMetadataReviewField(
  operation: UpdateMetadataOperation,
  zoteroGateway: ZoteroGateway,
  context: Parameters<
    NonNullable<AgentToolDefinition<MutateLibraryInput, unknown>["createPendingAction"]>
  >[1],
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
  const rows: Extract<AgentPendingField, { type: "review_table" }>["rows"] = [];

  for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(operation.metadata, fieldName)) continue;
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

function summarizeOperation(
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
      const count = operation.assignments?.length || operation.itemIds?.length || 0;
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
      const count = operation.assignments?.length || operation.itemIds?.length || 0;
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
      const collection = zoteroGateway.getCollectionSummary(operation.collectionId);
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
              zoteroGateway.getCollectionSummary(operation.parentCollectionId),
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
        return item ? String(item.getField?.("title") || `Item ${id}`) : `Item ${id}`;
      });
      return {
        label: `Trash ${operation.itemIds.length} item${
          operation.itemIds.length === 1 ? "" : "s"
        }`,
        description: titles.slice(0, 5).join(", ") +
          (titles.length > 5 ? `, +${titles.length - 5} more` : ""),
      };
    }
  }
}

function normalizeSelectedOperationIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value
    .map((entry) => {
      if (!validateObject<Record<string, unknown>>(entry)) return "";
      const id =
        typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "";
      return entry.checked === false ? "" : id;
    })
    .filter(Boolean);
  return ids.length ? ids : null;
}

function getOperationHint(type: string): string {
  switch (type) {
    case "apply_tags": return "Required: itemIds (number[]) and tags (string[]).";
    case "remove_tags": return "Required: itemIds (number[]) and tags (string[]).";
    case "update_metadata": return "Required: metadata (object with fields like title, DOI, etc).";
    case "move_to_collection": return "Required: itemIds (number[]).";
    case "remove_from_collection": return "Required: itemIds (number[]) and collectionId (number).";
    case "create_collection": return "Required: name (string).";
    case "delete_collection": return "Required: collectionId (number).";
    case "save_note": return "Required: content (string).";
    case "import_identifiers": return "Required: identifiers (string[] of DOIs or arXiv IDs).";
    case "trash_items": return "Required: itemIds (number[]).";
    default: return `Unknown type '${type}'. Valid types: apply_tags, remove_tags, update_metadata, move_to_collection, remove_from_collection, create_collection, delete_collection, save_note, import_identifiers, trash_items.`;
  }
}

function diagnoseOperationFailure(rawArgs: Record<string, unknown>): string {
  const rawOps = normalizeOperationListValue(rawArgs);
  if (!Array.isArray(rawOps)) {
    return `operations must be an array, got ${typeof rawOps}. ` +
      `Expected: { operations: [{ type: "apply_tags", itemIds: [...], tags: [...] }] }`;
  }
  if (rawOps.length === 0) {
    return `operations array is empty. Each operation needs a 'type' field. ` +
      `Valid types: update_metadata, apply_tags, remove_tags, move_to_collection, ` +
      `remove_from_collection, create_collection, delete_collection, save_note, ` +
      `import_identifiers, trash_items.`;
  }
  const diagnostics: string[] = [];
  for (let i = 0; i < rawOps.length; i++) {
    const entry = rawOps[i];
    if (!entry || typeof entry !== "object") {
      diagnostics.push(`operations[${i}]: expected an object, got ${typeof entry}`);
      continue;
    }
    const obj = entry as Record<string, unknown>;
    if (!obj.type || typeof obj.type !== "string") {
      diagnostics.push(
        `operations[${i}]: missing 'type' field. Valid types: apply_tags, update_metadata, move_to_collection, save_note, trash_items, ...`
      );
      continue;
    }
    const normalized = normalizeOperation(obj, i);
    if (!normalized) {
      diagnostics.push(
        `operations[${i}] (type='${obj.type}'): invalid or missing required fields. ${getOperationHint(String(obj.type))}`
      );
    }
  }
  return diagnostics.length
    ? diagnostics.join("; ")
    : "No recognizable operations found. Valid types: apply_tags, remove_tags, update_metadata, move_to_collection, remove_from_collection, create_collection, delete_collection, save_note, import_identifiers, trash_items.";
}

export function createMutateLibraryTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<MutateLibraryInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);
  return {
    spec: {
      name: "mutate_library",
      internalOnly: true,
      description:
        "Apply one or more Zotero write operations in a single batch. Supports metadata updates, tags, collection moves, note saving, collection creation/deletion, identifier import, and trashing items behind one confirmation step.",
      inputSchema: {
        type: "object",
        required: ["operations"],
        additionalProperties: false,
        properties: {
          operations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
            },
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    guidance: {
      matches: (request) =>
        /\b(move|file|organize|organise|apply|tag|untag|fix|update|save|write|create|delete|trash|import|reorganize|reorganise)\b/i.test(
          request.userText,
        ),
      instruction:
        "When the user asks you to change the Zotero library, call mutate_library as soon as you have the needed IDs. The confirmation card is the deliverable; do not stop with a prose summary." +
        "\n\nOperation shapes:" +
        "\n• Metadata (fields or authors): {type:'update_metadata', itemId:N, metadata:{title:'…', creators:[{firstName:'…', lastName:'…', creatorType:'author'}]}}" +
        "\n  — Use 'creators' (not 'authors') inside metadata. Each creator needs firstName+lastName or name. creatorType defaults to 'author'." +
        "\n• Tags: {type:'apply_tags', itemIds:[…], tags:['…']}" +
        "\n• Move: {type:'move_to_collection', itemIds:[…]} — let the confirmation card collect destinations, or prefill assignments:[{itemId, targetCollectionId}]." +
        "\n• Note: {type:'save_note', content:'…', targetItemId:N}" +
        "\n• Trash: {type:'trash_items', itemIds:[…]}",
    },
    presentation: {
      label: "Mutate Library",
      summaries: {
        onCall: "Preparing Zotero library changes",
        onPending: "Waiting for your approval on the requested changes",
        onApproved: "Approval received - applying library changes",
        onDenied: "Library changes cancelled",
        onSuccess: ({ content }) => {
          const appliedCount =
            content && typeof content === "object"
              ? Number((content as { appliedCount?: unknown }).appliedCount || 0)
              : 0;
          return appliedCount > 0
            ? `Applied ${appliedCount} library change${
                appliedCount === 1 ? "" : "s"
              }`
            : "No library changes were applied";
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with an 'operations' array");
      }
      const operations = normalizeOperations(normalizeOperationListValue(args));
      if (!operations?.length) {
        return fail(diagnoseOperationFailure(args));
      }
      return ok<MutateLibraryInput>({ operations });
    },
    shouldRequireConfirmation: async (input) => {
      return input.operations.length > 0;
    },
    acceptInheritedApproval: async (input, approval) => {
      if (approval.sourceToolName !== "search_literature_online") {
        return false;
      }
      if (approval.sourceActionId !== "import" && approval.sourceActionId !== "save_note") {
        return false;
      }
      return input.operations.every((operation) => {
        if (approval.sourceActionId === "import") {
          return operation.type === "import_identifiers";
        }
        return operation.type === "save_note";
      });
    },
    createPendingAction: async (input, context) => {
      const metadataOperations = input.operations.filter(
        (op): op is UpdateMetadataOperation => op.type === "update_metadata",
      );
      const showMetadataTitle = metadataOperations.length > 1;
      const metadataReviewFields = metadataOperations
        .map((op) => {
          const item = zoteroGateway.resolveMetadataItem({
            itemId: op.itemId,
            paperContext: op.paperContext,
            request: context.request,
            item: context.item,
          });
          const title =
            zoteroGateway.getEditableArticleMetadata(item)?.title ||
            op.paperContext?.title ||
            `Item ${op.itemId ?? ""}`;
          return buildUpdateMetadataReviewField(op, zoteroGateway, context, title, showMetadataTitle);
        })
        .filter(
          (f): f is NonNullable<ReturnType<typeof buildUpdateMetadataReviewField>> =>
            Boolean(f),
        );

      const moveAssignmentFields = input.operations
        .filter(
          (operation): operation is MoveToCollectionOperation =>
            operation.type === "move_to_collection",
        )
        .map((operation) => buildMoveAssignmentField(operation, zoteroGateway, context))
        .filter(
          (
            field,
          ): field is NonNullable<ReturnType<typeof buildMoveAssignmentField>> =>
            Boolean(field),
        );
      const tagAssignmentFields = input.operations
        .filter(
          (operation): operation is ApplyTagsOperation =>
            operation.type === "apply_tags",
        )
        .map((operation) => buildTagAssignmentField(operation, zoteroGateway))
        .filter(
          (
            field,
          ): field is NonNullable<ReturnType<typeof buildTagAssignmentField>> =>
            Boolean(field),
        );
      const saveNoteReviewFields = buildSaveNoteReviewFields(input.operations);
      const hasTagAssignments = tagAssignmentFields.length > 0;
      const hasMoveAssignments = moveAssignmentFields.length > 0;
      const hasNoteDrafts = saveNoteReviewFields.length > 0;
      const descriptions: string[] = [];
      if (metadataReviewFields.length > 0) descriptions.push("Review the changes below");
      if (hasNoteDrafts) descriptions.push("review the note drafts");
      if (hasTagAssignments) descriptions.push("edit any tag assignments");
      if (hasMoveAssignments) descriptions.push("choose destination folders");
      descriptions.push("uncheck any operation to skip it");
      const description =
        descriptions.length > 1
          ? descriptions.slice(0, -1).join(", ") +
            ", and " +
            descriptions[descriptions.length - 1] +
            "."
          : (descriptions[0] ?? "Uncheck any operation to skip it.") + ".";
      return {
        toolName: "mutate_library",
        title: `Review ${input.operations.length} library change${
          input.operations.length === 1 ? "" : "s"
        }`,
        description:
          description.charAt(0).toUpperCase() + description.slice(1),
        confirmLabel: "Apply changes",
        cancelLabel: "Cancel",
        fields: [
          ...metadataReviewFields,
          ...tagAssignmentFields,
          ...moveAssignmentFields,
          ...saveNoteReviewFields,
          {
            type: "checklist",
            id: "selectedOperations",
            label: "Operations",
            items: input.operations.map((operation) => {
              const summary = summarizeOperation(operation, zoteroGateway);
              return {
                id: operation.id || operation.type,
                label: summary.label,
                description: summary.description,
                checked: true,
              };
            }),
          },
        ],
      };
    },
    applyConfirmation: (_input, resolutionData) => {
      if (!validateObject<Record<string, unknown>>(resolutionData)) {
        return fail("confirmation data is required");
      }
      const originalSaveNoteContentById = new Map(
        _input.operations
          .filter(
            (operation): operation is SaveNoteOperation => operation.type === "save_note",
          )
          .map((operation) => [operation.id || "save_note", operation.content]),
      );
      // Fall back to _input.operations when no JSON was submitted (e.g. when
      // the confirmation card shows review_table instead of a raw JSON editor).
      const rawOps =
        typeof resolutionData.operationsJson === "string"
          ? (() => {
              try {
                return JSON.parse(resolutionData.operationsJson);
              } catch (_error) {
                return null;
              }
            })()
          : (resolutionData.operations ?? _input.operations);
      let operations = normalizeOperations(rawOps);
      if (!operations?.length) {
        return fail("No valid operations to apply");
      }
      const selectedIds = normalizeSelectedOperationIds(
        resolutionData.selectedOperations,
      );
      if (selectedIds?.length) {
        const selected = new Set(selectedIds);
        operations = operations.filter((operation) =>
          selected.has(operation.id || operation.type),
        );
      }
      operations = operations
        .map((operation) => {
          if (operation.type === "save_note") {
            const fieldId = getSaveNoteContentFieldId(operation);
            const editedContent =
              typeof resolutionData[fieldId] === "string"
                ? normalizeNoteSourceText(resolutionData[fieldId] as string)
                : "";
            const originalContent =
              originalSaveNoteContentById.get(operation.id || "save_note") || "";
            if (editedContent && editedContent !== originalContent) {
              return {
                ...operation,
                content: editedContent,
              };
            }
            return operation;
          }
          if (operation.type === "apply_tags") {
            const selectedAssignments = normalizeTagAssignmentsFromResolution(
              resolutionData[getTagAssignmentFieldId(operation)],
            );
            if (selectedAssignments) {
              if (!selectedAssignments.length) {
                return null;
              }
              return {
                ...operation,
                assignments: selectedAssignments,
                itemIds: undefined,
                tags: undefined,
              } satisfies ApplyTagsOperation;
            }
            const directAssignments =
              operation.assignments
                ?.filter(
                  (assignment) =>
                    Array.isArray(assignment.tags) && assignment.tags.length > 0,
                )
                .map((assignment) => ({
                  itemId: assignment.itemId,
                  tags: assignment.tags,
                })) || [];
            if (directAssignments.length) {
              return {
                ...operation,
                assignments: directAssignments,
              } satisfies ApplyTagsOperation;
            }
            if (operation.itemIds?.length && operation.tags?.length) {
              return operation;
            }
            return null;
          }
          if (operation.type !== "move_to_collection") {
            return operation;
          }
          const selectedAssignments = normalizeMoveAssignmentsFromResolution(
            resolutionData[getMoveAssignmentFieldId(operation)],
          );
          if (selectedAssignments) {
            if (!selectedAssignments.length) {
              return null;
            }
            return {
              ...operation,
              assignments: selectedAssignments,
              itemIds: undefined,
              targetCollectionId: undefined,
              targetCollectionName: undefined,
              targetCollectionPath: undefined,
            } satisfies MoveToCollectionOperation;
          }
          const directAssignments =
            operation.assignments
              ?.filter((assignment) => Boolean(assignment.targetCollectionId))
              .map((assignment) => ({
                itemId: assignment.itemId,
                targetCollectionId: assignment.targetCollectionId as number,
              })) || [];
          if (directAssignments.length) {
            return {
              ...operation,
              assignments: directAssignments,
              targetCollectionName: undefined,
              targetCollectionPath: undefined,
            } satisfies MoveToCollectionOperation;
          }
          if (operation.itemIds?.length && operation.targetCollectionId) {
            return operation;
          }
          return null;
        })
        .filter((operation): operation is LibraryMutationOperation => Boolean(operation));
      if (!operations.length) {
        return fail("Select at least one operation to apply");
      }
      return ok({ operations });
    },
    execute: async (input, context) => {
      const results = [];
      const undoEntries: Array<{
        toolName: string;
        description: string;
        revert: () => Promise<void>;
      }> = [];
      for (const operation of input.operations) {
        const executed = await mutationService.executeOperation(operation, context);
        results.push(executed.result);
        if (executed.undo) {
          undoEntries.push(executed.undo);
        }
      }
      if (undoEntries.length) {
        pushUndoEntry(context.request.conversationKey, {
          id: `undo-mutate-library-${Date.now()}`,
          toolName: "mutate_library",
          description: `Undo ${undoEntries.length} reversible library change${
            undoEntries.length === 1 ? "" : "s"
          }`,
          revert: async () => {
            for (const undo of [...undoEntries].reverse()) {
              await undo.revert();
            }
          },
        });
      }
      return {
        appliedCount: results.length,
        results,
        warnings: [],
      };
    },
  };
}
