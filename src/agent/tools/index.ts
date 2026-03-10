import { AgentToolRegistry } from "./registry";
import { PdfService } from "../services/pdfService";
import { RetrievalService } from "../services/retrievalService";
import { ZoteroGateway } from "../services/zoteroGateway";
import { createGetActiveContextTool } from "./read/getActiveContext";
import { createListPaperContextsTool } from "./read/listPaperContexts";
import { createBrowseCollectionsTool } from "./read/browseCollections";
import { createListCollectionPapersTool } from "./read/listCollectionPapers";
import { createListUnfiledPapersTool } from "./read/listUnfiledPapers";
import { createListUntaggedPapersTool } from "./read/listUntaggedPapers";
import { createRetrievePaperEvidenceTool } from "./read/retrievePaperEvidence";
import { createReadPaperExcerptTool } from "./read/readPaperExcerpt";
import { createSearchLibraryItemsTool } from "./read/searchLibraryItems";
import { createReadAttachmentTextTool } from "./read/readAttachmentText";
import { createReadPaperFrontMatterTool } from "./read/readPaperFrontMatter";
import { createAuditArticleMetadataTool } from "./read/auditArticleMetadata";
import { createSearchPdfPagesTool } from "./read/searchPdfPages";
import { createPreparePdfPagesForModelTool } from "./read/preparePdfPagesForModel";
import { createPreparePdfFileForModelTool } from "./read/preparePdfFileForModel";
import { createCaptureReaderViewTool } from "./read/captureReaderView";
import { createComparePapersStructuredTool } from "./read/comparePapersStructured";
import { createSaveAnswerToNoteTool } from "./write/saveAnswerToNote";
import { createApplyTagsTool } from "./write/applyTags";
import { createEditArticleMetadataTool } from "./write/editArticleMetadata";
import { createMoveUnfiledPapersToCollectionTool } from "./write/moveUnfiledPapersToCollection";
import { PdfPageService } from "../services/pdfPageService";

type BuiltInAgentToolDeps = {
  zoteroGateway: ZoteroGateway;
  pdfService: PdfService;
  pdfPageService: PdfPageService;
  retrievalService: RetrievalService;
};

export function createBuiltInToolRegistry(
  deps: BuiltInAgentToolDeps,
): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  registry.register(createGetActiveContextTool(deps.zoteroGateway));
  registry.register(
    createMoveUnfiledPapersToCollectionTool(deps.zoteroGateway),
  );
  registry.register(createApplyTagsTool(deps.zoteroGateway));
  registry.register(createListPaperContextsTool(deps.zoteroGateway));
  registry.register(createBrowseCollectionsTool(deps.zoteroGateway));
  registry.register(createListCollectionPapersTool(deps.zoteroGateway));
  registry.register(createListUnfiledPapersTool(deps.zoteroGateway));
  registry.register(createListUntaggedPapersTool(deps.zoteroGateway));
  registry.register(
    createRetrievePaperEvidenceTool(
      deps.zoteroGateway,
      deps.retrievalService,
    ),
  );
  registry.register(createReadPaperExcerptTool(deps.pdfService));
  registry.register(
    createReadPaperFrontMatterTool(deps.pdfService, deps.zoteroGateway),
  );
  registry.register(createSearchLibraryItemsTool(deps.zoteroGateway));
  registry.register(
    createAuditArticleMetadataTool(deps.zoteroGateway, deps.pdfService),
  );
  registry.register(createSearchPdfPagesTool(deps.pdfPageService));
  registry.register(createPreparePdfPagesForModelTool(deps.pdfPageService));
  registry.register(createPreparePdfFileForModelTool(deps.pdfPageService));
  registry.register(createCaptureReaderViewTool(deps.pdfPageService));
  registry.register(createReadAttachmentTextTool());
  registry.register(
    createComparePapersStructuredTool(
      deps.pdfService,
      deps.retrievalService,
      deps.zoteroGateway,
    ),
  );
  registry.register(createSaveAnswerToNoteTool(deps.zoteroGateway));
  registry.register(createEditArticleMetadataTool(deps.zoteroGateway));
  return registry;
}
