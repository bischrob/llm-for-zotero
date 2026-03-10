import {
  normalizeProviderProtocolForAuthMode,
  supportsProviderProtocolFileInputs,
} from "../../../utils/providerProtocol";
import type { AgentToolDefinition } from "../../types";
import {
  isExplicitWholeDocumentRequest,
  type PdfPageService,
} from "../../services/pdfPageService";
import {
  buildPdfToolSchemaProperties,
  parsePdfTargetArgs,
  type PdfTargetArgs,
} from "./pdfToolShared";
import { fail, ok } from "../shared";

function supportsNativePdfInput(params: {
  providerProtocol?: string;
  apiBase?: string;
  authMode?: string;
}): boolean {
  const protocol = normalizeProviderProtocolForAuthMode({
    protocol: params.providerProtocol,
    authMode: params.authMode,
    apiBase: params.apiBase,
  });
  return supportsProviderProtocolFileInputs(protocol);
}

export function createPreparePdfFileForModelTool(
  pdfPageService: PdfPageService,
): AgentToolDefinition<PdfTargetArgs, unknown> {
  return {
    spec: {
      name: "prepare_pdf_file_for_model",
      description:
        "Prepare a whole PDF file for direct model input. Use this only when the user explicitly asks to inspect the entire PDF/document, and only on file-input capable models.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: buildPdfToolSchemaProperties(),
      },
      mutability: "read",
      requiresConfirmation: true,
    },
    presentation: {
      label: "Prepare PDF File",
      summaries: {
        onCall: "Preparing the full PDF for direct model reading",
        onPending: "Waiting for your approval before sending the whole PDF",
        onApproved: "Approval received - sending the whole PDF",
        onDenied: "Whole-PDF send cancelled",
        onSuccess: "Prepared the whole PDF for direct model reading",
      },
    },
    validate: (args) => {
      const parsed = parsePdfTargetArgs(args);
      if (!parsed.ok) return parsed;
      return ok({
        ...parsed.value,
        scope: "whole_document" as const,
      });
    },
    shouldRequireConfirmation: async () => true,
    createPendingAction: async (input, context) => {
      const prepared = await pdfPageService.preparePdfFileForModel({
        request: context.request,
        paperContext: input.paperContext,
        itemId: input.itemId,
        contextItemId: input.contextItemId,
        attachmentId: input.attachmentId,
        name: input.name,
      });
      return {
        toolName: "prepare_pdf_file_for_model",
        title: `Send whole PDF — ${prepared.target.title}`,
        description:
          "The entire PDF file will be sent to the model. Use this only when full-document inspection is necessary.",
        confirmLabel: "Send to model",
        cancelLabel: "Cancel",
        fields: [],
      };
    },
    execute: async (input, context) => {
      if (
        !supportsNativePdfInput({
          providerProtocol: context.request.providerProtocol,
          apiBase: context.request.apiBase,
          authMode: context.request.authMode,
        })
      ) {
        throw new Error(
          "Whole-document PDF input is only available on file-input capable models. Use page images instead for this model.",
        );
      }
      if (!isExplicitWholeDocumentRequest(context.request.userText)) {
        throw new Error(
          "Whole-document PDF input is only allowed when the user explicitly asks to inspect the entire PDF or document.",
        );
      }
      const prepared = await pdfPageService.preparePdfFileForModel({
        request: context.request,
        paperContext: input.paperContext,
        itemId: input.itemId,
        contextItemId: input.contextItemId,
        attachmentId: input.attachmentId,
        name: input.name,
      });
      return {
        content: {
          target: {
            source: prepared.target.source,
            title: prepared.target.title,
            paperContext: prepared.target.paperContext,
            contextItemId: prepared.target.contextItemId,
            itemId: prepared.target.itemId,
          },
          transport: "native_pdf_file",
          scope: "whole_document",
        },
        artifacts: [prepared.artifact],
      };
    },
  };
}
