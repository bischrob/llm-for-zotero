import { AgentToolRegistry } from "./registry";
import { PdfService } from "../services/pdfService";
import { RetrievalService } from "../services/retrievalService";
import { ZoteroGateway } from "../services/zoteroGateway";
import { createGetActiveContextTool } from "./read/getActiveContext";
import { createListPaperContextsTool } from "./read/listPaperContexts";
import { createRetrievePaperEvidenceTool } from "./read/retrievePaperEvidence";
import { createReadPaperExcerptTool } from "./read/readPaperExcerpt";
import { createSearchLibraryItemsTool } from "./read/searchLibraryItems";
import { createReadAttachmentTextTool } from "./read/readAttachmentText";
import { createSaveAnswerToNoteTool } from "./write/saveAnswerToNote";
import { createEditArticleMetadataTool } from "./write/editArticleMetadata";

type BuiltInAgentToolDeps = {
  zoteroGateway: ZoteroGateway;
  pdfService: PdfService;
  retrievalService: RetrievalService;
};

export function createBuiltInToolRegistry(
  deps: BuiltInAgentToolDeps,
): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  registry.register(createGetActiveContextTool(deps.zoteroGateway));
  registry.register(createListPaperContextsTool(deps.zoteroGateway));
  registry.register(
    createRetrievePaperEvidenceTool(
      deps.zoteroGateway,
      deps.retrievalService,
    ),
  );
  registry.register(createReadPaperExcerptTool(deps.pdfService));
  registry.register(createSearchLibraryItemsTool(deps.zoteroGateway));
  registry.register(createReadAttachmentTextTool());
  registry.register(createSaveAnswerToNoteTool(deps.zoteroGateway));
  registry.register(createEditArticleMetadataTool(deps.zoteroGateway));
  return registry;
}
