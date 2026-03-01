import type {
  AgentToolCall,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  AgentToolName,
  ResolvedAgentToolTarget,
} from "./types";
import {
  executeFindClaimEvidenceCall,
  validateFindClaimEvidenceCall,
} from "./tools/findClaimEvidence";
import {
  executeReadPaperTextCall,
  validateReadPaperTextCall,
} from "./tools/readPaperText";
import {
  executeReadReferencesCall,
  validateReadReferencesCall,
} from "./tools/readReferences";

export type AgentToolDefinition = {
  name: AgentToolName;
  plannerDescription: string;
  validate(call: AgentToolCall): AgentToolCall | null;
  execute(
    ctx: AgentToolExecutionContext,
    call: AgentToolCall,
    target: ResolvedAgentToolTarget,
  ): Promise<AgentToolExecutionResult>;
};

const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: "read_paper_text",
    plannerDescription:
      "read the full body text of one specific paper after the target paper has been identified; use sparingly because it is expensive",
    validate: validateReadPaperTextCall,
    execute: executeReadPaperTextCall,
  },
  {
    name: "find_claim_evidence",
    plannerDescription:
      "retrieve the most relevant evidence snippets from one paper for the current user question or claim; cheaper and narrower than reading the full paper",
    validate: validateFindClaimEvidenceCall,
    execute: executeFindClaimEvidenceCall,
  },
  {
    name: "read_references",
    plannerDescription:
      "extract the references or bibliography section of one paper when the user asks what the paper cites or wants cited works",
    validate: validateReadReferencesCall,
    execute: executeReadReferencesCall,
  },
];

export function getAgentToolDefinitions(): readonly AgentToolDefinition[] {
  return AGENT_TOOL_DEFINITIONS;
}

export function getAgentToolDefinition(
  name: AgentToolName,
): AgentToolDefinition | null {
  return AGENT_TOOL_DEFINITIONS.find((definition) => definition.name === name) || null;
}
