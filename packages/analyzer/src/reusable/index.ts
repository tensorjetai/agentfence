import { posix } from "node:path";
import { parseExpressions } from "../expressions/index.js";
import { builtInProfiles, ProviderRegistry, type ProviderProfile } from "../providers/index.js";
import type {
  AnalysisCompleteness,
  Diagnostic,
  ExpressionReference,
  PermissionMap,
  WorkflowJob,
  WorkflowIR,
  WorkflowInvocation,
} from "../ir/types.js";
import { parseYamlWorkflow } from "../parse/yaml.js";

export interface ReusableResolution {
  /** Root plus one contextual IR per local reusable-workflow invocation. */
  workflows: WorkflowIR[];
  diagnostics: Diagnostic[];
  completeness: AnalysisCompleteness;
}

export interface ReusableResolutionOptions {
  /** Enabled provider names from policy. Omitted means all built-in providers. */
  enabledProviders?: ProviderProfile["provider"][] | undefined;
}

export async function resolveReusableWorkflows(
  rootPath: string,
  rootSource: string,
  fetchFile: (path: string) => Promise<string | undefined>,
  maxDepth = 5,
  options: ReusableResolutionOptions = {},
): Promise<ReusableResolution> {
  const workflows: WorkflowIR[] = [];
  const diagnostics: Diagnostic[] = [];
  const sourceCache = new Map<string, string | undefined>([[rootPath, rootSource]]);
  const maxInvocations = 500;
  const enabledProviders = options.enabledProviders ? new Set(options.enabledProviders) : undefined;
  const providerRegistry = new ProviderRegistry(
    enabledProviders
      ? builtInProfiles.filter((profile) => enabledProviders.has(profile.provider))
      : builtInProfiles,
  );

  const visit = async (
    path: string,
    source: string,
    depth: number,
    stack: string[],
    invocation?: WorkflowInvocation,
    prepared?: WorkflowIR,
  ): Promise<void> => {
    if (workflows.length >= maxInvocations) {
      diagnostics.push({
        code: "reusable-invocation-limit",
        message: `Reusable workflow invocation limit (${maxInvocations}) exceeded at ${path}`,
      });
      return;
    }
    if (stack.includes(path)) {
      diagnostics.push({
        code: "reusable-cycle",
        message: `Reusable workflow cycle: ${[...stack, path].join(" -> ")}`,
      });
      return;
    }
    if (depth > maxDepth) {
      diagnostics.push({
        code: "reusable-depth",
        message: `Reusable workflow depth exceeds ${maxDepth} at ${path}`,
      });
      return;
    }

    let workflow: WorkflowIR;
    try {
      workflow = prepared ?? parseYamlWorkflow(path, source);
    } catch (error) {
      diagnostics.push({
        code: "reusable-parse-error",
        message: `Cannot analyze reusable workflow ${path}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (invocation) {
      workflow.invocation = invocation;
      // A called workflow runs in the caller's event context, not on workflow_call alone.
      workflow.triggers = invocation.triggers;
      if (invocation.permissions) {
        workflow.permissions = invocation.permissions;
        workflow.jobs = workflow.jobs.map((job) => ({
          ...job,
          secrets: [...new Set([...job.secrets, ...Object.keys(invocation.secrets)])],
          permissions: intersectPermissions(invocation.permissions, job.permissions),
        }));
      } else {
        workflow.permissions = undefined;
        workflow.jobs = workflow.jobs.map((job) => ({
          ...job,
          secrets: [...new Set([...job.secrets, ...Object.keys(invocation.secrets)])],
          permissions: undefined,
        }));
        const permissionDiagnostic: Diagnostic = {
          code: "reusable-unknown-permission-ceiling",
          message: `Caller permissions are not explicit for ${invocation.callerPath} job ${invocation.callerJobId}; child permissions are treated as unknown`,
        };
        workflow.diagnostics.push(permissionDiagnostic);
        workflow.completeness = "partial";
        diagnostics.push(permissionDiagnostic);
      }
      const contextDiagnostics = inputMappingDiagnostics(workflow);
      workflow.diagnostics.push(...contextDiagnostics);
      if (contextDiagnostics.length > 0) workflow.completeness = "partial";
      diagnostics.push(...contextDiagnostics);
    }
    workflows.push(workflow);

    for (const job of workflow.jobs) {
      if (job.uses && !job.uses.startsWith("./") && job.uses.includes(".github/workflows/")) {
        addDiagnostic(workflow, diagnostics, {
          code: "reusable-remote-unsupported",
          message: `Remote reusable workflow is not resolved: ${job.uses}`,
          range: job.range,
        });
      }
      for (const step of job.steps) {
        if (step.uses?.startsWith("./") && !step.uses.startsWith("./.github/workflows/")) {
          addDiagnostic(workflow, diagnostics, {
            code: "reusable-local-action-unsupported",
            message: `Local action behavior is not resolved: ${step.uses}`,
            range: step.range,
          });
        }
      }
    }

    for (const job of workflow.jobs) {
      if (!job.uses?.startsWith("./")) continue;
      const target = resolveLocalPath(path, job.uses);
      if (!target.startsWith(".github/workflows/") && rootPath.startsWith(".github/workflows/")) {
        diagnostics.push({
          code: "invalid-reusable-path",
          message: `Reusable workflow must stay in .github/workflows: ${target}`,
          range: job.range,
        });
        continue;
      }
      let child = sourceCache.get(target);
      if (!sourceCache.has(target)) {
        child = await fetchFile(target);
        sourceCache.set(target, child);
      }
      if (child === undefined) {
        diagnostics.push({
          code: "missing-reusable",
          message: `Reusable workflow not found: ${target}`,
          range: job.range,
        });
        continue;
      }
      const inputMap = { ...(job.with ?? {}) };
      let calledWorkflow: WorkflowIR | undefined;
      try {
        calledWorkflow = parseYamlWorkflow(target, child);
      } catch {
        // visit() reports this parse failure with the path and cause.
      }
      for (const [name, definition] of Object.entries(calledWorkflow?.workflowCallInputs ?? {})) {
        if (inputMap[name] === undefined && definition.default !== undefined)
          inputMap[name] = definition.default;
      }
      const inputReferences = Object.fromEntries(
        Object.entries(inputMap).map(([name, value]) => [
          name,
          parseExpressions(value).references.flatMap((reference) =>
            invocation ? mapThroughInvocation(reference, invocation) : [reference],
          ),
        ]),
      );
      const secretMap = job.secrets.includes("*")
        ? { "*": "inherit" }
        : { ...(job.secretValues ?? {}) };
      let requestedPermissions: PermissionMap | undefined;
      try {
        requestedPermissions =
          calledWorkflow?.permissions ?? parseYamlWorkflow(target, child).permissions;
      } catch {
        // visit() reports this parse failure with the path and cause.
      }
      const permissions = intersectPermissions(
        job.permissions ?? workflow.permissions,
        requestedPermissions,
      );
      const context: WorkflowInvocation = {
        callerPath: path,
        callerJobId: job.id,
        inputs: inputMap,
        inputReferences,
        secrets: secretMap,
        ...(permissions ? { permissions } : {}),
        triggers: invocation?.triggers ?? workflow.triggers,
      };
      await visit(target, child, depth + 1, [...stack, path], context, calledWorkflow);
      const referencedOutputs = referencedReusableOutputs(workflow, job.id);
      if (referencedOutputs.length > 0) {
        const projected: Record<string, string[]> = {};
        for (const name of referencedOutputs) {
          const output = calledWorkflow?.workflowCallOutputs?.[name];
          const sources = output
            ? resolveAgentOutputLeaves(
                calledWorkflow!,
                output,
                new Set(),
                undefined,
                providerRegistry,
              )
            : [];
          if (sources.length > 0) projected[name] = sources;
          else {
            addDiagnostic(workflow, diagnostics, {
              code: "reusable-output-unsupported",
              message: `Output ${name} from reusable workflow job ${job.id} is not mapped to a supported agent output`,
              range: job.range,
            });
          }
        }
        job.reusableOutputSources = projected;
      }
    }
  };

  await visit(rootPath, rootSource, 0, []);
  return {
    workflows,
    diagnostics,
    completeness:
      diagnostics.length > 0 || workflows.some((item) => item.completeness === "partial")
        ? "partial"
        : "complete",
  };
}

function addDiagnostic(
  workflow: WorkflowIR,
  diagnostics: Diagnostic[],
  diagnostic: Diagnostic,
): void {
  diagnostics.push(diagnostic);
  workflow.diagnostics.push(diagnostic);
  workflow.completeness = "partial";
}

function referencedReusableOutputs(workflow: WorkflowIR, jobId: string): string[] {
  const values = [
    ...Object.values(workflow.env),
    ...Object.values(workflow.workflowCallOutputs ?? {}),
    ...workflow.jobs.flatMap((job) => [
      ...Object.values(job.env),
      ...Object.values(job.outputs),
      ...job.steps.flatMap((step) => [
        ...Object.values(step.with),
        ...Object.values(step.env),
        step.run ?? "",
      ]),
    ]),
  ];
  return [
    ...new Set(
      values.flatMap((value) =>
        parseExpressions(value).references.flatMap((reference) => {
          const match = new RegExp(
            `^(?:needs|jobs)\\.${escapeRegExp(jobId)}\\.outputs\\.([^.]+)$`,
          ).exec(reference.path);
          return match?.[1] ? [match[1]] : [];
        }),
      ),
    ),
  ];
}

function resolveAgentOutputLeaves(
  workflow: WorkflowIR,
  expression: string,
  visited: Set<string>,
  currentJob: WorkflowJob | undefined,
  registry: ProviderRegistry,
): string[] {
  return parseExpressions(expression).references.flatMap((reference) =>
    resolveAgentOutputPath(workflow, reference.path, visited, currentJob, registry),
  );
}

function resolveAgentOutputPath(
  workflow: WorkflowIR,
  path: string,
  visited: Set<string>,
  currentJob: WorkflowJob | undefined,
  registry: ProviderRegistry,
): string[] {
  if (visited.has(path)) return [];
  visited.add(path);
  const jobOutput = /^(?:jobs|needs)\.([^.]+)\.outputs\.([^.]+)$/.exec(path);
  if (jobOutput) {
    const producer = workflow.jobs.find((item) => item.id === jobOutput[1]);
    const projected = producer?.reusableOutputSources?.[jobOutput[2]!];
    if (projected?.length) return projected;
    const value = producer?.outputs[jobOutput[2]!];
    return value ? resolveAgentOutputLeaves(workflow, value, visited, producer, registry) : [];
  }
  const stepOutput = /^steps\.([^.]+)\.outputs\.([^.]+)$/.exec(path);
  if (!stepOutput) return [];
  const producer = currentJob?.steps.find((item) => item.id === stepOutput[1]);
  if (!producer) return [];
  if (producer.kind === "agent" || (producer.uses && registry.match(producer.uses))) return [path];
  const field = stepOutput[2]!;
  const mappedReferences = producer.expressionBindings?.[`outputs.${field}`];
  if (mappedReferences)
    return mappedReferences.flatMap((item) =>
      resolveAgentOutputPath(workflow, item.path, visited, currentJob, registry),
    );
  const value = producer.outputs[field];
  return value ? resolveAgentOutputLeaves(workflow, value, visited, currentJob, registry) : [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

/** Apply invocation mappings to parsed references without rewriting expression source text. */
export function applyWorkflowInvocationContext(workflow: WorkflowIR): WorkflowIR {
  const invocation = workflow.invocation;
  if (!invocation) return workflow;
  const mapReference = (reference: ExpressionReference): ExpressionReference[] => {
    const inputName = /^inputs\.([^.]+)$/.exec(reference.path)?.[1];
    if (!inputName) return [reference];
    if (invocation.inputs[inputName] === undefined) return [reference];
    const mapped = invocation.inputReferences[inputName] ?? [];
    return mapped.map((item) => ({
      ...item,
      raw: reference.raw,
      range: reference.range,
      mappedFrom: reference.path,
    }));
  };
  return {
    ...workflow,
    jobs: workflow.jobs.map((job) => ({
      ...job,
      steps: job.steps.map((step) => ({
        ...step,
        expressions: step.expressions.flatMap(mapReference),
        promptExpressions: step.promptExpressions.flatMap(mapReference),
      })),
    })),
  };
}

function mapThroughInvocation(
  reference: ExpressionReference,
  invocation: WorkflowInvocation,
): ExpressionReference[] {
  const name = /^inputs\.([^.]+)$/.exec(reference.path)?.[1];
  if (!name || invocation.inputs[name] === undefined) return [reference];
  return (invocation.inputReferences[name] ?? []).map((item) => ({
    ...item,
    mappedFrom: reference.path,
  }));
}

function inputMappingDiagnostics(workflow: WorkflowIR): Diagnostic[] {
  const invocation = workflow.invocation!;
  const referenced = [
    ...Object.values(workflow.env).flatMap((value) => parseExpressions(value).references),
    ...workflow.jobs.flatMap((job) => [
      ...Object.values(job.env).flatMap((value) => parseExpressions(value).references),
      ...Object.values(job.outputs).flatMap((value) => parseExpressions(value).references),
      ...job.steps.flatMap((step) => [
        ...step.expressions,
        ...step.promptExpressions,
        ...Object.values(step.outputs).flatMap((value) => parseExpressions(value).references),
      ]),
    ]),
  ];
  const missing = [
    ...new Set(
      referenced.flatMap((item) => {
        const match = /^inputs\.([^.]+)$/.exec(item.path);
        return match && invocation.inputs[match[1]!] === undefined ? [match[1]!] : [];
      }),
    ),
  ];
  const diagnostics: Diagnostic[] = missing.map((name) => ({
    code: "reusable-unmapped-input",
    message: `Input ${name} is referenced by ${workflow.path} but was not supplied by ${invocation.callerPath} job ${invocation.callerJobId}`,
  }));
  for (const job of workflow.jobs) {
    const unsupportedValues = [
      job.if ?? "",
      ...Object.values(job.outputs),
      ...job.steps.flatMap((step) => [step.if ?? "", ...Object.values(step.outputs)]),
    ];
    if (
      unsupportedValues.some((value) =>
        parseExpressions(value).references.some((item) => /^inputs\.[^.]+$/.test(item.path)),
      )
    ) {
      diagnostics.push({
        code: "reusable-input-in-control-or-output",
        message: `Input mapping in conditions or outputs in ${workflow.path} is not modeled; analysis is partial`,
      });
    }
  }
  for (const [name, value] of Object.entries(invocation.inputs)) {
    const parsed = parseExpressions(value);
    if (parsed.unsupported.length > 0) {
      diagnostics.push({
        code: "reusable-unsupported-input-expression",
        message: `Input ${name} mapping at ${invocation.callerPath} job ${invocation.callerJobId} uses unsupported expression semantics`,
      });
    }
  }
  return diagnostics;
}

function intersectPermissions(
  ceiling: PermissionMap | undefined,
  requested: PermissionMap | undefined,
): PermissionMap | undefined {
  if (!ceiling) return undefined;
  if (!requested) return ceiling;
  if (ceiling === "write-all") return requested;
  if (requested === "write-all") return ceiling;
  if (ceiling === "read-all" && requested === "read-all") return "read-all";
  if (ceiling === "read-all" && typeof requested !== "string") {
    return Object.fromEntries(
      Object.keys(requested).map((scope) => [
        scope,
        requested[scope] === "write" ? "read" : requested[scope],
      ]),
    ) as PermissionMap;
  }
  if (requested === "read-all" && typeof ceiling !== "string") {
    return Object.fromEntries(
      Object.keys(ceiling).map((scope) => [
        scope,
        ceiling[scope] === "write" ? "read" : ceiling[scope],
      ]),
    ) as PermissionMap;
  }
  if (ceiling === "read-all" || requested === "read-all") return "read-all";
  if (typeof ceiling === "string" || typeof requested === "string") return ceiling;
  const result: Record<string, "read" | "write" | "none"> = {};
  for (const scope of new Set([...Object.keys(ceiling), ...Object.keys(requested)])) {
    const allowed = ceiling[scope] ?? "none";
    const asked = requested[scope] ?? "none";
    result[scope] =
      allowed === "none" || asked === "none"
        ? "none"
        : allowed === "read" || asked === "read"
          ? "read"
          : "write";
  }
  return result;
}

function resolveLocalPath(callerPath: string, uses: string): string {
  const withoutPrefix = uses.slice(2).split("@")[0]!;
  if (withoutPrefix.startsWith(".github/")) return posix.normalize(withoutPrefix);
  return posix.normalize(posix.join(posix.dirname(callerPath), withoutPrefix));
}
