import type { AgentFencePolicy } from "@agentfence/policy";
import type { ScanResult, WorkflowIR } from "./ir/types.js";
import { parseMarkdownWorkflow } from "./parse/markdown.js";
import { parseYamlWorkflow } from "./parse/yaml.js";
import { builtInProfiles, ProviderRegistry } from "./providers/index.js";
import { evaluateRules } from "./rules/index.js";
import { applyWorkflowInvocationContext } from "./reusable/index.js";
import { implicitPromptReferences } from "./providers/implicit.js";
import { scanConfiguration } from "./configuration/scan.js";
import { parseExpressions } from "./expressions/index.js";

export interface ScanInput {
  path: string;
  source: string;
  repository?: string;
  policy?: AgentFencePolicy;
  now?: Date;
}

export function scanWorkflow(input: ScanInput): ScanResult {
  if (input.path.endsWith(".json")) return scanConfiguration(input);
  if (/(?:^|\/)action\.ya?ml$/.test(input.path)) {
    const diagnostics = [
      {
        code: "composite-caller-context-required",
        message:
          "Action metadata must be analyzed through a calling workflow to determine inputs, permissions, and outputs.",
      },
    ];
    return {
      path: input.path,
      findings: [],
      completeness: "partial",
      diagnostics,
      workflow: {
        path: input.path,
        kind: "actions-yaml",
        triggers: [],
        env: {},
        inputs: [],
        secrets: [],
        jobs: [],
        completeness: "partial",
        diagnostics,
        source: input.source,
      },
    };
  }
  const workflow = input.path.endsWith(".md")
    ? parseMarkdownWorkflow(input.path, input.source)
    : parseYamlWorkflow(input.path, input.source);
  return scanPreparedWorkflow(workflow, input);
}

export function scanPreparedWorkflow(
  prepared: WorkflowIR,
  input: Omit<ScanInput, "path" | "source"> = {},
): ScanResult {
  let workflow = structuredClone(prepared);
  const enabledProviders = new Set(
    input.policy?.providers.enabled ?? builtInProfiles.map((profile) => profile.provider),
  );
  const registry = new ProviderRegistry(
    builtInProfiles.filter((profile) => enabledProviders.has(profile.provider)),
  );
  workflow.jobs = workflow.jobs.map((job) => ({
    ...job,
    steps: job.steps.map((step) => {
      const decorated = registry.decorate(step);
      const profile = builtInProfiles.find((candidate) => candidate.id === decorated.providerId);
      if (profile && decorated.expressionBindings) {
        decorated.promptExpressions = profile.promptInputs.flatMap(
          (field) =>
            decorated.expressionBindings?.[`with.${field}`] ??
            parseExpressions(decorated.with[field] ?? "").references,
        );
      }
      decorated.promptExpressions = [
        ...decorated.promptExpressions,
        ...implicitPromptReferences(workflow, job, decorated),
      ];
      if (profile && !enabledProviders.has(profile.provider)) {
        return {
          ...decorated,
          kind: "action",
          providerId: undefined,
          capabilities: [],
          outputs: {},
          promptExpressions: [],
        };
      }
      return decorated;
    }),
  }));
  workflow = applyWorkflowInvocationContext(workflow);
  const options = {
    ...(input.repository ? { repository: input.repository } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.now ? { now: input.now } : {}),
  };
  const findings = evaluateRules(workflow, options);
  return {
    path: workflow.path,
    completeness: workflow.completeness,
    diagnostics: workflow.diagnostics,
    findings,
    workflow,
  };
}
