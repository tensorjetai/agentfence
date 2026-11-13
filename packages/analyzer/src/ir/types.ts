export type AnalysisCompleteness = "complete" | "partial";
export type StepKind = "action" | "shell" | "agent" | "reusable-workflow" | "unknown";
export type TaintLabel =
  | "UNTRUSTED_EVENT_TEXT"
  | "UNTRUSTED_REF"
  | "UNTRUSTED_REPOSITORY_CONTENT"
  | "WORKFLOW_DISPATCH_INPUT"
  | "AGENT_OUTPUT"
  | "SECRET_REFERENCE"
  | "WRITE_CAPABILITY"
  | "NETWORK_CAPABILITY"
  | "SHELL_CAPABILITY";

export interface Position {
  line: number;
  column: number;
  offset: number;
}

export interface SourceRange {
  path: string;
  start: Position;
  end: Position;
}

export interface ExpressionReference {
  path: string;
  raw: string;
  range: { start: number; end: number };
  mappedFrom?: string | undefined;
}

export interface ParsedExpressions {
  references: ExpressionReference[];
  unsupported: string[];
}

export interface Trigger {
  event: string;
  configuration?: unknown | undefined;
  range?: SourceRange | undefined;
}

export type PermissionMap = Record<string, "read" | "write" | "none"> | "read-all" | "write-all";

export interface WorkflowInvocation {
  callerPath: string;
  callerJobId: string;
  inputs: Record<string, string>;
  inputReferences: Record<string, ExpressionReference[]>;
  secrets: Record<string, string>;
  permissions?: PermissionMap | undefined;
  triggers: Trigger[];
}

export interface WorkflowCallInput {
  default?: string | undefined;
}

export interface WorkflowStep {
  id?: string | undefined;
  name?: string | undefined;
  kind: StepKind;
  uses?: string | undefined;
  run?: string | undefined;
  if?: string | undefined;
  with: Record<string, string>;
  env: Record<string, string>;
  outputs: Record<string, string>;
  /** Contextual references for source expressions, keyed by run/with.<name>/env.<name>/outputs.<name>. */
  expressionBindings?: Record<string, ExpressionReference[]> | undefined;
  expressions: ExpressionReference[];
  promptExpressions: ExpressionReference[];
  capabilities: TaintLabel[];
  range: SourceRange;
  providerId?: string | undefined;
}

export interface WorkflowJob {
  id: string;
  if?: string | undefined;
  permissions?: PermissionMap | undefined;
  environment?: string | undefined;
  env: Record<string, string>;
  outputs: Record<string, string>;
  secrets: string[];
  with?: Record<string, string> | undefined;
  secretValues?: Record<string, string> | undefined;
  /** Agent output leaves exposed by this reusable-workflow invocation, keyed by output name. */
  reusableOutputSources?: Record<string, string[]> | undefined;
  steps: WorkflowStep[];
  uses?: string | undefined;
  range: SourceRange;
}

export interface WorkflowIR {
  path: string;
  kind: "actions-yaml" | "agentic-markdown" | "instruction-markdown" | "agent-config";
  triggers: Trigger[];
  permissions?: PermissionMap | undefined;
  environment?: string | undefined;
  env: Record<string, string>;
  inputs: string[];
  workflowCallInputs?: Record<string, WorkflowCallInput> | undefined;
  workflowCallOutputs?: Record<string, string> | undefined;
  secrets: string[];
  jobs: WorkflowJob[];
  completeness: AnalysisCompleteness;
  diagnostics: Diagnostic[];
  source: string;
  invocation?: WorkflowInvocation | undefined;
}

export interface Diagnostic {
  code: string;
  message: string;
  range?: SourceRange | undefined;
}

export interface TracePoint {
  label: TaintLabel;
  description: string;
  range?: SourceRange;
}

export type RuleId = "AF001" | "AF002" | "AF003" | "AF004" | "AF005" | "AF006" | "AF007";
export type Severity = "critical" | "high" | "medium" | "low";

export interface Finding {
  fingerprint: string;
  ruleId: RuleId;
  severity: Severity;
  confidence: "high" | "medium";
  path: string;
  range: SourceRange;
  source: string;
  sink: string;
  privilegeContext: string[];
  trace: TracePoint[];
  explanation: string;
  remediation: string;
  suggestedPatch?: string | undefined;
  completeness: AnalysisCompleteness;
  suppressed?: { reason: string; expires?: string | undefined } | undefined;
}

export interface ScanResult {
  path: string;
  completeness: AnalysisCompleteness;
  diagnostics: Diagnostic[];
  findings: Finding[];
  workflow: WorkflowIR;
}
