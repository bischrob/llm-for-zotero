import {
  searchPaperCandidates,
  type PaperSearchGroupCandidate,
} from "../../modules/contextPanel/paperSearch";
import {
  createNoteFromAssistantText,
  createStandaloneNoteFromAssistantText,
} from "../../modules/contextPanel/notes";
import {
  getActiveContextAttachmentFromTabs,
  resolveContextSourceItem,
} from "../../modules/contextPanel/contextResolution";
import { resolvePaperContextRefFromAttachment } from "../../modules/contextPanel/paperAttribution";
import type { AgentRuntimeRequest } from "../types";
import type { PaperContextRef } from "../../modules/contextPanel/types";
import {
  isGlobalPortalItem,
  isPaperPortalItem,
  resolvePaperPortalBaseItem,
} from "../../modules/contextPanel/portalScope";

export const EDITABLE_ARTICLE_METADATA_FIELDS = [
  "title",
  "shortTitle",
  "abstractNote",
  "publicationTitle",
  "journalAbbreviation",
  "proceedingsTitle",
  "date",
  "volume",
  "issue",
  "pages",
  "DOI",
  "url",
  "language",
  "extra",
  "ISSN",
  "ISBN",
  "publisher",
  "place",
] as const;

export type EditableArticleMetadataField =
  (typeof EDITABLE_ARTICLE_METADATA_FIELDS)[number];

export type EditableArticleCreator = {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  fieldMode?: 0 | 1;
};

export type EditableArticleMetadataPatch = Partial<
  Record<EditableArticleMetadataField, string>
> & {
  creators?: EditableArticleCreator[];
};

export type EditableArticleMetadataSnapshot = {
  itemId: number;
  itemType: string;
  title: string;
  fields: Record<EditableArticleMetadataField, string>;
  creators: EditableArticleCreator[];
};

function normalizeMetadataValue(value: unknown): string {
  return `${value ?? ""}`.trim();
}

function resolveRegularItem(item: Zotero.Item | null | undefined): Zotero.Item | null {
  if (!item) return null;
  if (isGlobalPortalItem(item)) return null;
  if (isPaperPortalItem(item)) {
    return resolvePaperPortalBaseItem(item);
  }
  if (item.isAttachment() && item.parentID) {
    const parent = Zotero.Items.get(item.parentID) || null;
    return parent?.isRegularItem?.() ? parent : null;
  }
  return item?.isRegularItem?.() ? item : null;
}

function getItemTypeName(item: Zotero.Item): string {
  try {
    const name = (Zotero as unknown as { ItemTypes?: { getName?: (id: number) => string } })
      .ItemTypes?.getName?.(item.itemTypeID);
    return typeof name === "string" && name.trim() ? name.trim() : "";
  } catch (_error) {
    void _error;
    return "";
  }
}

function isFieldValidForItemType(
  item: Zotero.Item,
  fieldName: EditableArticleMetadataField,
): boolean {
  try {
    const itemFields = (Zotero as unknown as {
      ItemFields?: {
        getID?: (name: string) => number | false;
        isValidForType?: (fieldId: number, itemTypeId: number) => boolean;
      };
    }).ItemFields;
    const fieldId = itemFields?.getID?.(fieldName);
    if (fieldId === false || !fieldId) return false;
    if (typeof itemFields?.isValidForType !== "function") return true;
    return Boolean(itemFields.isValidForType(fieldId, item.itemTypeID));
  } catch (_error) {
    void _error;
    return true;
  }
}

function normalizeCreatorForSnapshot(
  creator: _ZoteroTypes.Item.CreatorJSON | _ZoteroTypes.Item.Creator,
): EditableArticleCreator | null {
  const creatorType =
    typeof (creator as { creatorType?: unknown }).creatorType === "string" &&
    (creator as { creatorType?: string }).creatorType?.trim()
      ? (creator as { creatorType: string }).creatorType.trim()
      : "author";
  const name =
    typeof (creator as { name?: unknown }).name === "string" &&
    (creator as { name?: string }).name?.trim()
      ? (creator as { name: string }).name.trim()
      : undefined;
  const firstName =
    typeof (creator as { firstName?: unknown }).firstName === "string" &&
    (creator as { firstName?: string }).firstName?.trim()
      ? (creator as { firstName: string }).firstName.trim()
      : undefined;
  const lastName =
    typeof (creator as { lastName?: unknown }).lastName === "string" &&
    (creator as { lastName?: string }).lastName?.trim()
      ? (creator as { lastName: string }).lastName.trim()
      : undefined;
  const fieldMode =
    Number((creator as { fieldMode?: unknown }).fieldMode) === 1 || name ? 1 : 0;
  if (!name && !firstName && !lastName) return null;
  return {
    creatorType,
    name,
    firstName,
    lastName,
    fieldMode,
  };
}

function normalizePaperContexts(
  entries: PaperContextRef[] | undefined,
): PaperContextRef[] {
  if (!Array.isArray(entries)) return [];
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry) continue;
    const itemId = Number(entry.itemId);
    const contextItemId = Number(entry.contextItemId);
    if (!Number.isFinite(itemId) || !Number.isFinite(contextItemId)) continue;
    const normalized: PaperContextRef = {
      itemId: Math.floor(itemId),
      contextItemId: Math.floor(contextItemId),
      title: `${entry.title || `Paper ${Math.floor(itemId)}`}`.trim(),
      attachmentTitle: entry.attachmentTitle?.trim() || undefined,
      citationKey: entry.citationKey?.trim() || undefined,
      firstCreator: entry.firstCreator?.trim() || undefined,
      year: entry.year?.trim() || undefined,
    };
    const key = `${normalized.itemId}:${normalized.contextItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export class ZoteroGateway {
  getItem(itemId: number | undefined): Zotero.Item | null {
    if (!Number.isFinite(itemId) || !itemId || itemId <= 0) return null;
    return Zotero.Items.get(Math.floor(itemId)) || null;
  }

  resolveBibliographicItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null {
    return resolveRegularItem(item);
  }

  resolveMetadataItem(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    itemId?: number;
    paperContext?: PaperContextRef | null;
  }): Zotero.Item | null {
    const byItemId = resolveRegularItem(this.getItem(params.itemId));
    if (byItemId) return byItemId;
    const byPaperContext = resolveRegularItem(this.getItem(params.paperContext?.itemId));
    if (byPaperContext) return byPaperContext;
    const byActiveItem = resolveRegularItem(
      this.getItem(params.request?.activeItemId),
    );
    if (byActiveItem) return byActiveItem;
    return resolveRegularItem(params.item || null);
  }

  getActiveContextItem(item: Zotero.Item | null | undefined): Zotero.Item | null {
    if (item) {
      return resolveContextSourceItem(item).contextItem;
    }
    return getActiveContextAttachmentFromTabs();
  }

  getActivePaperContext(
    item: Zotero.Item | null | undefined,
  ): PaperContextRef | null {
    return resolvePaperContextRefFromAttachment(this.getActiveContextItem(item));
  }

  getEditableArticleMetadata(
    item: Zotero.Item | null | undefined,
  ): EditableArticleMetadataSnapshot | null {
    const target = resolveRegularItem(item);
    if (!target) return null;
    const fields = Object.fromEntries(
      EDITABLE_ARTICLE_METADATA_FIELDS.map((fieldName) => {
        let value = "";
        try {
          value = normalizeMetadataValue(target.getField(fieldName));
        } catch (_error) {
          void _error;
        }
        return [fieldName, value];
      }),
    ) as Record<EditableArticleMetadataField, string>;
    let creators: EditableArticleCreator[] = [];
    try {
      creators = (target.getCreatorsJSON?.() || [])
        .map((creator) => normalizeCreatorForSnapshot(creator))
        .filter((creator): creator is EditableArticleCreator => Boolean(creator));
    } catch (_error) {
      void _error;
    }
    return {
      itemId: target.id,
      itemType: getItemTypeName(target),
      title:
        normalizeMetadataValue(target.getDisplayTitle?.()) ||
        fields.title ||
        `Item ${target.id}`,
      fields,
      creators,
    };
  }

  listPaperContexts(request: AgentRuntimeRequest): PaperContextRef[] {
    const out = [
      ...normalizePaperContexts(request.selectedPaperContexts),
      ...normalizePaperContexts(request.pinnedPaperContexts),
    ];
    const activeItem = this.getItem(request.activeItemId);
    const activeContext = this.getActivePaperContext(activeItem);
    if (activeContext) {
      const key = `${activeContext.itemId}:${activeContext.contextItemId}`;
      if (!out.some((entry) => `${entry.itemId}:${entry.contextItemId}` === key)) {
        out.unshift(activeContext);
      }
    }
    return out;
  }

  async searchLibraryItems(params: {
    libraryID: number;
    query: string;
    excludeContextItemId?: number | null;
    limit?: number;
  }): Promise<PaperSearchGroupCandidate[]> {
    return searchPaperCandidates(
      params.libraryID,
      params.query,
      params.excludeContextItemId,
      params.limit,
    );
  }

  async saveAnswerToNote(params: {
    item: Zotero.Item | null;
    libraryID?: number;
    content: string;
    modelName: string;
    target?: "item" | "standalone";
  }): Promise<"created" | "appended" | "standalone_created"> {
    if (params.target === "standalone") {
      const libraryID =
        Number.isFinite(params.libraryID) && (params.libraryID as number) > 0
          ? Math.floor(params.libraryID as number)
          : params.item?.libraryID || 0;
      await createStandaloneNoteFromAssistantText(
        libraryID,
        params.content,
        params.modelName,
      );
      return "standalone_created";
    }
    if (!params.item) {
      throw new Error("No Zotero item is active for item-note creation");
    }
    return createNoteFromAssistantText(
      params.item,
      params.content,
      params.modelName,
    );
  }

  async updateArticleMetadata(params: {
    item: Zotero.Item | null;
    metadata: EditableArticleMetadataPatch;
  }): Promise<{
    status: "updated";
    itemId: number;
    title: string;
    changedFields: string[];
  }> {
    const item = resolveRegularItem(params.item);
    if (!item) {
      throw new Error("No Zotero bibliographic item is active for metadata editing");
    }

    const fieldNames = EDITABLE_ARTICLE_METADATA_FIELDS.filter((fieldName) =>
      Object.prototype.hasOwnProperty.call(params.metadata, fieldName),
    );
    const unsupportedFields = fieldNames.filter(
      (fieldName) => !isFieldValidForItemType(item, fieldName),
    );
    if (unsupportedFields.length) {
      const itemTypeName = getItemTypeName(item) || "this item type";
      throw new Error(
        `Unsupported metadata fields for ${itemTypeName}: ${unsupportedFields.join(", ")}`,
      );
    }

    for (const fieldName of fieldNames) {
      item.setField(fieldName, params.metadata[fieldName] || "");
    }

    if (Array.isArray(params.metadata.creators)) {
      const creatorTypes = (Zotero as unknown as {
        CreatorTypes?: { itemTypeHasCreators?: (itemTypeId: number) => boolean };
      }).CreatorTypes;
      const supportsCreators =
        typeof creatorTypes?.itemTypeHasCreators === "function"
          ? creatorTypes.itemTypeHasCreators(item.itemTypeID)
          : true;
      if (!supportsCreators) {
        const itemTypeName = getItemTypeName(item) || "this item type";
        throw new Error(`Creators are not supported for ${itemTypeName}`);
      }
      item.setCreators(
        params.metadata.creators as Array<
          _ZoteroTypes.Item.CreatorJSON | _ZoteroTypes.Item.Creator
        >,
        { strict: true },
      );
    }

    await item.saveTx();
    const changedFields = [
      ...fieldNames,
      ...(Array.isArray(params.metadata.creators) ? ["creators"] : []),
    ];
    const snapshot = this.getEditableArticleMetadata(item);
    return {
      status: "updated",
      itemId: item.id,
      title: snapshot?.title || `Item ${item.id}`,
      changedFields,
    };
  }
}
