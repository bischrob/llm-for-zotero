/**
 * Focused facade tool for updating metadata fields on a Zotero item.
 * Replaces the opaque `mutate_library` interface with a rich, self-describing schema.
 */
import type { AgentToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type UpdateMetadataOperation,
} from "../../services/libraryMutationService";
import type {
  EditableArticleCreator,
  EditableArticleMetadataField,
  EditableArticleMetadataPatch,
  ZoteroGateway,
} from "../../services/zoteroGateway";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import {
  buildUpdateMetadataReviewField,
  executeAndRecordUndo,
} from "./mutateLibraryShared";

type UpdateMetadataInput = {
  operation: UpdateMetadataOperation;
};

// ── Creator normalization helpers ─────────────────────────────────────────────

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
    return list.length ? list : null;
  }
  // Model may send a comma/semicolon-separated string like "Stefan Leutgeb, Jill K. Leutgeb"
  if (typeof raw === "string" && raw.trim()) {
    const names = raw
      .split(/;|,(?![^(]*\))/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (!names.length) return null;
    return names.map((name) => ({
      creatorType: "author",
      name,
      fieldMode: 1 as const,
    }));
  }
  return null;
}

// ── Metadata normalization ────────────────────────────────────────────────────

function normalizeStringValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`.trim();
  }
  return null;
}

function normalizeMetadataPatch(
  value: unknown,
): EditableArticleMetadataPatch | null {
  if (!validateObject<Record<string, unknown>>(value)) return null;
  const metadata: EditableArticleMetadataPatch = {};
  for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, fieldName)) continue;
    const normalized = normalizeStringValue(value[fieldName]);
    if (normalized === null) continue;
    metadata[fieldName as EditableArticleMetadataField] = normalized;
  }
  // Accept "creators" or "authors" (common model alias). Handle arrays and
  // comma/semicolon-separated strings. Non-parseable values are silently skipped
  // so they do not abort the entire patch.
  const rawCreators =
    Object.prototype.hasOwnProperty.call(value, "creators")
      ? value.creators
      : Object.prototype.hasOwnProperty.call(value, "authors")
        ? value.authors
        : undefined;
  if (rawCreators !== undefined) {
    const creators = normalizeCreatorsList(rawCreators);
    if (creators !== null) {
      metadata.creators = creators;
    }
  }
  return Object.keys(metadata).length ? metadata : null;
}

// ── Tool factory ──────────────────────────────────────────────────────────────

export function createUpdateMetadataTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<UpdateMetadataInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "update_metadata",
      description:
        "Update metadata fields (title, authors, DOI, etc.) on a Zotero item.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          itemId: {
            type: "number",
            description:
              "Zotero item ID. If omitted, targets the active item.",
          },
          metadata: {
            type: "object",
            additionalProperties: true,
            properties: {
              title: { type: "string" },
              shortTitle: { type: "string" },
              abstractNote: { type: "string" },
              publicationTitle: { type: "string" },
              journalAbbreviation: { type: "string" },
              proceedingsTitle: { type: "string" },
              date: { type: "string" },
              volume: { type: "string" },
              issue: { type: "string" },
              pages: { type: "string" },
              DOI: { type: "string" },
              url: { type: "string" },
              language: { type: "string" },
              extra: { type: "string" },
              ISSN: { type: "string" },
              ISBN: { type: "string" },
              publisher: { type: "string" },
              place: { type: "string" },
              creators: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    firstName: { type: "string" },
                    lastName: { type: "string" },
                    name: { type: "string" },
                    creatorType: { type: "string" },
                  },
                  additionalProperties: false,
                },
                description:
                  "Author list. Use 'creators' not 'authors'. Each needs firstName+lastName or name. creatorType defaults to 'author'.",
              },
            },
            description:
              "Metadata fields to update. At least one field must be provided.",
          },
        },
        required: ["metadata"],
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Update Metadata",
      summaries: {
        onCall: "Preparing metadata update",
        onPending: "Waiting for confirmation on metadata changes",
        onApproved: "Applying metadata changes",
        onDenied: "Metadata update cancelled",
        onSuccess: "Metadata updated",
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          "Expected an object with metadata. Example: { metadata: { title: 'New Title' } }",
        );
      }

      const metadata = normalizeMetadataPatch(args.metadata);
      if (!metadata) {
        return fail(
          "metadata must be an object with at least one recognized field. " +
            "Example: { metadata: { title: 'Updated Title', DOI: '10.1234/example' } } " +
            "Supported fields: " +
            EDITABLE_ARTICLE_METADATA_FIELDS.join(", ") +
            ", creators.",
        );
      }

      const operation: UpdateMetadataOperation = {
        type: "update_metadata",
        itemId: normalizePositiveInt(args.itemId),
        metadata,
      };

      return ok({ operation });
    },

    createPendingAction(input, context) {
      const operation = input.operation;
      const item = zoteroGateway.resolveMetadataItem({
        itemId: operation.itemId,
        paperContext: operation.paperContext,
        request: context.request,
        item: context.item,
      });
      const title =
        zoteroGateway.getEditableArticleMetadata(item)?.title ||
        operation.paperContext?.title ||
        `Item ${operation.itemId ?? "active item"}`;

      const reviewField = buildUpdateMetadataReviewField(
        operation,
        zoteroGateway,
        context,
        title,
        false,
      );

      return {
        toolName: "update_metadata",
        mode: "review",
        title: `Update metadata for ${title}`,
        description: "Review the proposed field changes below.",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: reviewField ? [reviewField] : [],
      };
    },

    applyConfirmation(input, _resolutionData) {
      // review_table is read-only; pass through unchanged
      return ok(input);
    },

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "update_metadata",
      );
    },
  };
}
