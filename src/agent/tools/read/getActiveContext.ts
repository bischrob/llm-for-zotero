import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok } from "../shared";

export function createGetActiveContextTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<{}, unknown> {
  return {
    spec: {
      name: "get_active_context",
      description:
        "Return the current Zotero paper context, selected text, attachments, active reader metadata, and editable bibliographic metadata for the active article.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    validate: () => ok({}),
    execute: async (_input, context) => {
      const activeItem =
        zoteroGateway.getItem(context.request.activeItemId) || context.item;
      const activeContextItem = zoteroGateway.getActiveContextItem(activeItem);
      const activePaperContext = zoteroGateway.getActivePaperContext(activeItem);
      const activeBibliographicItem = zoteroGateway.resolveMetadataItem({
        request: context.request,
        item: activeItem,
      });
      return {
        activeItemId: activeItem?.id,
        activeContextItemId: activeContextItem?.id,
        activeBibliographicItemId: activeBibliographicItem?.id,
        activePaperContext,
        activeItemMetadata:
          zoteroGateway.getEditableArticleMetadata(activeBibliographicItem),
        selectedTexts: context.request.selectedTexts || [],
        selectedPaperContexts: context.request.selectedPaperContexts || [],
        pinnedPaperContexts: context.request.pinnedPaperContexts || [],
        attachments:
          context.request.attachments?.map((entry) => ({
            id: entry.id,
            name: entry.name,
            mimeType: entry.mimeType,
            sizeBytes: entry.sizeBytes,
            category: entry.category,
          })) || [],
      };
    },
  };
}
