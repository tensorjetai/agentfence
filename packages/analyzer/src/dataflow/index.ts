import { parseExpressions, taintForReference } from "../expressions/index.js";
import type { TaintLabel, TracePoint, WorkflowIR, WorkflowJob, WorkflowStep } from "../ir/types.js";

export interface TaintPath {
  label: TaintLabel;
  source: string;
  sink: string;
  trace: TracePoint[];
}

export function promptTaintPaths(
  workflow: WorkflowIR,
  job: WorkflowJob,
  step: WorkflowStep,
): TaintPath[] {
  return step.promptExpressions.flatMap((reference) => {
    const resolved = resolveTaint(workflow, job, step, reference.path, new Set());
    if (!resolved) return [];
    return [
      {
        label: resolved.label,
        source: resolved.source,
        sink: `${step.id ?? step.name ?? step.uses ?? "agent"}.prompt`,
        trace: [
          { label: resolved.label, description: resolved.source, range: step.range },
          { label: resolved.label, description: reference.path, range: step.range },
          {
            label: resolved.label,
            description: `step.${step.id ?? "agent"}.with.prompt`,
            range: step.range,
          },
        ],
      },
    ];
  });
}

function resolveTaint(
  workflow: WorkflowIR,
  job: WorkflowJob,
  step: WorkflowStep,
  path: string,
  visited: Set<string>,
): { label: TaintLabel; source: string } | undefined {
  const invocationInput = /^inputs\.([^.]+)$/.exec(path)?.[1];
  if (
    invocationInput &&
    workflow.invocation?.inputs[invocationInput] !== undefined &&
    !visited.has(path)
  ) {
    visited.add(path);
    for (const reference of workflow.invocation.inputReferences[invocationInput] ?? []) {
      const result = resolveTaint(workflow, job, step, reference.path, visited);
      if (result) return result;
    }
    return undefined;
  }
  const direct = taintForReference(path);
  if (direct) return { label: direct, source: path };
  if (!path.startsWith("env.") || visited.has(path)) return undefined;
  visited.add(path);
  const name = path.slice(4);
  const value = step.env[name] ?? job.env[name] ?? workflow.env[name];
  if (!value) return undefined;
  for (const reference of expressionReferences(step, `env.${name}`, value)) {
    const result = resolveTaint(workflow, job, step, reference.path, visited);
    if (result) return result;
  }
  return undefined;
}

export function agentOutputShellPath(
  workflow: WorkflowIR,
  job: WorkflowJob,
  shell: WorkflowStep,
): TaintPath | undefined {
  const reference = expressionReferences(shell, "run", shell.run ?? "")
    .map((item) => resolveAgentOutput(workflow, job, shell, item.path, new Set()))
    .find((item): item is string => Boolean(item));
  if (!reference) return undefined;
  return {
    label: "AGENT_OUTPUT",
    source: reference,
    sink: `run at line ${shell.range.start.line}`,
    trace: [
      { label: "AGENT_OUTPUT", description: reference },
      { label: "AGENT_OUTPUT", description: "shell.run", range: shell.range },
    ],
  };
}

function resolveAgentOutput(
  workflow: WorkflowIR,
  job: WorkflowJob,
  step: WorkflowStep,
  path: string,
  visited: Set<string>,
  includeStepEnv = true,
): string | undefined {
  if (visited.has(path)) return undefined;
  visited.add(path);
  const direct = /^steps\.([^.]+)\.outputs\.[^.]+$/.exec(path);
  if (
    direct &&
    job.steps.some((candidate) => candidate.kind === "agent" && candidate.id === direct[1])
  ) {
    return path;
  }
  const crossJob = /^needs\.([^.]+)\.outputs\.([^.]+)$/.exec(path);
  if (crossJob) {
    const producer = workflow.jobs.find((candidate) => candidate.id === crossJob[1]);
    if ((producer?.reusableOutputSources?.[crossJob[2] ?? ""]?.length ?? 0) > 0) return path;
    const output = producer?.outputs[crossJob[2] ?? ""];
    if (producer && output) {
      for (const reference of parseExpressions(output).references) {
        const resolved = resolveAgentOutput(
          workflow,
          producer,
          step,
          reference.path,
          visited,
          false,
        );
        if (resolved) return path;
      }
    }
  }
  const stepOutput = /^steps\.([^.]+)\.outputs\.([^.]+)$/.exec(path);
  if (stepOutput) {
    const producer = job.steps.find((candidate) => candidate.id === stepOutput[1]);
    if (producer?.kind === "agent") return path;
    const output = producer?.outputs[stepOutput[2] ?? ""];
    if (output) {
      for (const reference of expressionReferences(
        producer,
        `outputs.${stepOutput[2] ?? ""}`,
        output,
      )) {
        const resolved = resolveAgentOutput(workflow, job, producer, reference.path, visited);
        if (resolved) return resolved;
      }
    }
  }
  if (path.startsWith("env.")) {
    const name = path.slice(4);
    const value =
      (includeStepEnv ? step.env[name] : undefined) ?? job.env[name] ?? workflow.env[name];
    if (value) {
      const references = includeStepEnv
        ? expressionReferences(step, `env.${name}`, value)
        : parseExpressions(value).references;
      for (const reference of references) {
        const resolved = resolveAgentOutput(
          workflow,
          job,
          step,
          reference.path,
          visited,
          includeStepEnv,
        );
        if (resolved) return resolved;
      }
    }
  }
  return undefined;
}

function expressionReferences(
  step: WorkflowStep,
  key: string,
  value: string,
): ReturnType<typeof parseExpressions>["references"] {
  return step.expressionBindings?.[key] ?? parseExpressions(value).references;
}
