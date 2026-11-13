import { posix } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type Node, type YAMLMap } from "yaml";
import { parseExpressions } from "../expressions/index.js";
import { rangeFromOffsets } from "../parse/locations.js";
import type {
  AnalysisCompleteness,
  Diagnostic,
  ExpressionReference,
  SourceRange,
  WorkflowIR,
  WorkflowJob,
  WorkflowStep,
} from "../ir/types.js";

export interface CompositeResolution {
  workflow: WorkflowIR;
  diagnostics: Diagnostic[];
  completeness: AnalysisCompleteness;
}

export interface CompositeOptions {
  maxDepth?: number;
  maxInvocations?: number;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_INVOCATIONS = 500;
const MAX_ACTION_BYTES = 1_000_000;
const MAX_ACTION_ALIASES = 50;
const MAX_ACTION_NODES = 20_000;
const MAX_ACTION_YAML_DEPTH = 40;

/** Expand local composite actions without running or interpreting action code. */
export async function expandCompositeActions(
  workflow: WorkflowIR,
  fetchFile: (path: string) => Promise<string | undefined>,
  options: CompositeOptions = {},
): Promise<CompositeResolution> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxInvocations = options.maxInvocations ?? DEFAULT_MAX_INVOCATIONS;
  const diagnostics: Diagnostic[] = [];
  const sourceCache = new Map<string, string | undefined>();
  const usedStepIds = new Set(
    workflow.jobs.flatMap((job) => job.steps.flatMap((step) => (step.id ? [step.id] : []))),
  );
  let invocationCount = 0;
  let anonymousScopeCount = 0;

  const addDiagnostic = (diagnostic: Diagnostic) => {
    diagnostics.push(diagnostic);
  };

  const expand = async (
    step: WorkflowStep,
    scope: string,
    inheritedEnv: Record<string, string>,
    inheritedEnvBindings: Record<string, ExpressionReference[]>,
    stack: string[],
    depth: number,
    inheritedGate?: { source?: string; references: ExpressionReference[] },
  ): Promise<WorkflowStep[] | undefined> => {
    if (!step.uses || !isLocalActionReference(step.uses)) return undefined;
    const directory = resolveRepositoryPath(step.uses);
    if (!directory) {
      addDiagnostic({
        code: "composite-invalid-path",
        message: `Local action path escapes the repository: ${step.uses}`,
        range: step.range,
      });
      return undefined;
    }
    if (stack.includes(directory)) {
      addDiagnostic({
        code: "composite-cycle",
        message: `Local composite action cycle: ${[...stack, directory].join(" -> ")}`,
        range: step.range,
      });
      return undefined;
    }
    if (depth >= maxDepth) {
      addDiagnostic({
        code: "composite-depth",
        message: `Composite action depth exceeds ${maxDepth} at ${directory}`,
        range: step.range,
      });
      return undefined;
    }
    if (invocationCount >= maxInvocations) {
      addDiagnostic({
        code: "composite-invocation-limit",
        message: `Composite action invocation limit (${maxInvocations}) exceeded at ${directory}`,
        range: step.range,
      });
      return undefined;
    }
    invocationCount += 1;

    const metadata = await loadAction(directory, fetchFile, sourceCache);
    if (!metadata) {
      addDiagnostic({
        code: "composite-missing-action",
        message: `Local action metadata not found: ${directory}/action.yml or action.yaml`,
        range: step.range,
      });
      return undefined;
    }
    if (metadata.error) {
      addDiagnostic({
        code: "composite-parse-error",
        message: `Cannot analyze local action ${metadata.path}: ${metadata.error}`,
        range: step.range,
      });
      return undefined;
    }
    if (metadata.using !== "composite") {
      addDiagnostic({
        code: "composite-unsupported-action",
        message: `Local action ${directory} uses ${metadata.using ?? "an unsupported runtime"}; only composite actions are expanded`,
        range: step.range,
      });
      return undefined;
    }

    const inputs = resolveInputs(metadata.inputs, step.with, step.expressionBindings);
    for (const [name, definition] of Object.entries(metadata.inputs)) {
      if (definition.required && inputs[name] === undefined) {
        addDiagnostic({
          code: "composite-required-input-missing",
          message: `Required input ${name} was not supplied to local action ${directory}`,
          range: step.range,
        });
      }
    }
    const localEnv = { ...inheritedEnv, ...step.env };
    const localEnvBindings = { ...inheritedEnvBindings };
    for (const [name, value] of Object.entries(step.env)) {
      localEnvBindings[name] =
        step.expressionBindings?.[`env.${name}`] ?? parseExpressions(value).references;
    }
    const gate = combineGates(inheritedGate, {
      ...(step.if === undefined ? {} : { source: step.if }),
      references:
        step.expressionBindings?.if ??
        (step.range.path === workflow.path
          ? parseExpressions(step.if ?? "").references
          : mapReferences(step.if ?? "", inputs, scope)),
    });
    const expanded: WorkflowStep[] = [];
    for (const [index, sourceStep] of metadata.steps.entries()) {
      const rewritten = mapActionStep(sourceStep, inputs, localEnv, localEnvBindings, scope, gate);
      if (rewritten.uses && isLocalActionReference(rewritten.uses)) {
        const childScope = sourceStep.id
          ? scopedId(scope, sourceStep.id)
          : `${scope}__anonymous_${index + 1}`;
        const nested = await expand(
          rewritten,
          childScope,
          { ...localEnv, ...rewritten.env },
          { ...localEnvBindings, ...bindingsFromStep(rewritten) },
          [...stack, directory],
          depth + 1,
          gate,
        );
        if (nested) expanded.push(...nested);
        else expanded.push(applyGate(rewritten, gate));
      } else {
        expanded.push(rewritten);
      }
    }

    if (Object.keys(metadata.outputs).length > 0) {
      const outputs = { ...metadata.outputs };
      const outputBindings = Object.fromEntries(
        Object.entries(outputs).map(([name, value]) => [
          `outputs.${name}`,
          mapReferences(value, inputs, scope),
        ]),
      );
      const expressions = Object.values(outputBindings).flat();
      expanded.push({
        id: step.id,
        name: step.name,
        kind: "action",
        with: {},
        env: {},
        outputs,
        expressions,
        promptExpressions: [],
        expressionBindings: {
          ...outputBindings,
          ...(gate ? { if: gate.references } : {}),
        },
        capabilities: [],
        range: metadata.range,
        ...(gate?.source === undefined ? {} : { if: gate.source }),
      });
    } else if (step.id) {
      // Keep the caller's step ID available even when the composite declares no outputs.
      expanded.push({
        id: step.id,
        name: step.name,
        kind: "action",
        with: {},
        env: {},
        outputs: {},
        expressions: gate?.references ?? [],
        promptExpressions: [],
        expressionBindings: gate ? { if: gate.references } : {},
        capabilities: [],
        range: step.range,
        ...(gate?.source === undefined ? {} : { if: gate.source }),
      });
    }
    return expanded;
  };

  const jobs: WorkflowJob[] = [];
  for (const job of workflow.jobs) {
    const steps: WorkflowStep[] = [];
    const inheritedEnv = { ...workflow.env, ...job.env };
    const inheritedEnvBindings = Object.fromEntries(
      Object.entries(inheritedEnv).map(([name, value]) => [
        name,
        parseExpressions(value).references,
      ]),
    );
    for (const step of job.steps) {
      const scope = nextAnonymousScope(usedStepIds, () => ++anonymousScopeCount);
      const expanded = await expand(step, scope, inheritedEnv, inheritedEnvBindings, [], 0);
      steps.push(...(expanded ?? [step]));
    }
    jobs.push({ ...job, steps });
  }
  const resultWorkflow: WorkflowIR = {
    ...workflow,
    jobs,
    diagnostics: [...workflow.diagnostics, ...diagnostics],
    completeness: diagnostics.length > 0 ? "partial" : workflow.completeness,
  };
  return {
    workflow: resultWorkflow,
    diagnostics,
    completeness: resultWorkflow.completeness,
  };
}

interface ActionMetadata {
  path: string;
  source: string;
  using?: string;
  inputs: Record<string, { default?: string; required?: boolean }>;
  outputs: Record<string, string>;
  steps: WorkflowStep[];
  range: SourceRange;
  error?: string;
}

async function loadAction(
  directory: string,
  fetchFile: (path: string) => Promise<string | undefined>,
  cache: Map<string, string | undefined>,
): Promise<ActionMetadata | undefined> {
  let path = `${directory}/action.yml`;
  let source = await cachedFetch(path, fetchFile, cache);
  if (source === undefined) {
    path = `${directory}/action.yaml`;
    source = await cachedFetch(path, fetchFile, cache);
  }
  if (source === undefined) return undefined;
  const fallbackRange = rangeFromOffsets(path, source, 0, source.length);
  try {
    enforceActionSourceLimits(path, source);
    const document = parseDocument(source, { prettyErrors: false });
    enforceActionTreeLimits(path, source, document.contents);
    if (document.errors.length)
      throw new Error(document.errors.map((error) => error.message).join("; "));
    if (!isMap(document.contents)) throw new Error("Action metadata root must be a map");
    const root = document.contents;
    const inputs = inputDefinitions(child(root, "inputs"));
    const outputs = Object.fromEntries(
      mapEntries(child(root, "outputs")).flatMap(([name, value]) => {
        const outputValue = scalarString(child(value, "value"));
        return outputValue === undefined ? [] : [[name, outputValue]];
      }),
    );
    const runs = child(root, "runs");
    const stepsNode = child(runs, "steps");
    const steps = isSeq(stepsNode)
      ? stepsNode.items.flatMap((node) =>
          isMap(node) ? [parseActionStep(path, source, node)] : [],
        )
      : [];
    const using = scalarString(child(runs, "using"));
    return {
      path,
      source,
      ...(using === undefined ? {} : { using }),
      inputs,
      outputs,
      steps,
      range: nodeRange(path, source, root),
    };
  } catch (error) {
    return {
      path,
      source,
      inputs: {},
      outputs: {},
      steps: [],
      range: fallbackRange,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function cachedFetch(
  path: string,
  fetchFile: (path: string) => Promise<string | undefined>,
  cache: Map<string, string | undefined>,
): Promise<string | undefined> {
  if (!cache.has(path)) cache.set(path, await fetchFile(path));
  return cache.get(path);
}

function parseActionStep(path: string, source: string, node: YAMLMap): WorkflowStep {
  const uses = scalarString(child(node, "uses"));
  const run = scalarString(child(node, "run"));
  const withValues = scalarMap(child(node, "with"));
  const env = scalarMap(child(node, "env"));
  const condition = scalarString(child(node, "if"));
  const expressionBindings: Record<string, ExpressionReference[]> = Object.fromEntries([
    ...Object.entries(withValues).map(([name, value]) => [
      `with.${name}`,
      parseExpressions(value).references,
    ]),
    ...Object.entries(env).map(([name, value]) => [
      `env.${name}`,
      parseExpressions(value).references,
    ]),
    ...(run === undefined ? [] : [["run", parseExpressions(run).references]]),
    ...(condition === undefined ? [] : [["if", parseExpressions(condition).references]]),
  ]);
  const expressionValues = [...Object.values(expressionBindings).flat()];
  return {
    id: scalarString(child(node, "id")),
    name: scalarString(child(node, "name")),
    kind: run ? "shell" : uses ? "action" : "unknown",
    uses,
    run,
    if: condition,
    with: withValues,
    env,
    outputs: {},
    expressions: expressionValues,
    expressionBindings,
    promptExpressions: [],
    capabilities: run ? ["SHELL_CAPABILITY"] : [],
    range: nodeRange(path, source, node),
  };
}

interface CompositeInputBinding {
  value: string;
  references: ExpressionReference[];
}

function resolveInputs(
  definitions: Record<string, { default?: string; required?: boolean }>,
  supplied: Record<string, string>,
  suppliedBindings?: Record<string, ExpressionReference[]>,
): Record<string, CompositeInputBinding> {
  const values: Record<string, CompositeInputBinding> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    if (supplied[name] !== undefined) {
      values[name] = {
        value: supplied[name]!,
        references:
          suppliedBindings?.[`with.${name}`] ?? parseExpressions(supplied[name]!).references,
      };
    } else if (definition.default !== undefined) {
      // Action metadata defaults are literal values, not workflow expression source.
      values[name] = { value: definition.default, references: [] };
    }
  }
  for (const [name, value] of Object.entries(supplied)) {
    if (values[name] === undefined) {
      values[name] = {
        value,
        references: suppliedBindings?.[`with.${name}`] ?? parseExpressions(value).references,
      };
    }
  }
  return values;
}

function mapActionStep(
  step: WorkflowStep,
  inputs: Record<string, CompositeInputBinding>,
  inheritedEnv: Record<string, string>,
  inheritedEnvBindings: Record<string, ExpressionReference[]>,
  scope: string,
  gate?: { source?: string; references: ExpressionReference[] },
): WorkflowStep {
  const bindings: Record<string, ExpressionReference[]> = {};
  for (const [name, value] of Object.entries(step.with)) {
    bindings[`with.${name}`] = mapReferences(value, inputs, scope);
  }
  const env = { ...inheritedEnv, ...step.env };
  const envBindings: Record<string, ExpressionReference[]> = { ...inheritedEnvBindings };
  for (const [name, value] of Object.entries(step.env)) {
    envBindings[name] = mapReferences(value, inputs, scope);
  }
  for (const [name, refs] of Object.entries(envBindings)) bindings[`env.${name}`] = refs;
  if (step.run !== undefined) bindings.run = mapReferences(step.run, inputs, scope);
  if (step.if !== undefined) bindings.if = mapReferences(step.if, inputs, scope);
  const expressions = Object.values(bindings).flat();
  const currentGate = {
    ...(step.if === undefined ? {} : { source: step.if }),
    references: bindings.if ?? [],
  };
  const localAction = !!step.uses && isLocalActionReference(step.uses);
  const mergedGate = localAction
    ? combineGates(undefined, currentGate)
    : combineGates(gate, currentGate);
  return {
    ...step,
    id: step.id ? scopedId(scope, step.id) : undefined,
    ...(mergedGate?.source === undefined ? {} : { if: mergedGate.source }),
    env,
    expressions,
    expressionBindings: {
      ...bindings,
      ...(mergedGate ? { if: mergedGate.references } : {}),
    },
  };
}

function applyGate(
  step: WorkflowStep,
  gate?: { source?: string; references: ExpressionReference[] },
): WorkflowStep {
  if (!gate || (step.if === undefined && gate.source === undefined)) return step;
  const combined = combineGates(gate, {
    ...(step.if === undefined ? {} : { source: step.if }),
    references: step.expressionBindings?.if ?? [],
  });
  const expressionBindings = {
    ...(step.expressionBindings ?? {}),
    ...(combined ? { if: combined.references } : {}),
  };
  return {
    ...step,
    ...(combined?.source === undefined ? {} : { if: combined.source }),
    expressionBindings,
    expressions: Object.values(expressionBindings).flat(),
  };
}

function combineGates(
  outer?: { source?: string; references: ExpressionReference[] },
  inner?: { source?: string; references: ExpressionReference[] },
): { source?: string; references: ExpressionReference[] } | undefined {
  const sources = [outer?.source, inner?.source].filter((source): source is string => !!source);
  const references = [...(outer?.references ?? []), ...(inner?.references ?? [])];
  if (sources.length === 0 && references.length === 0) return undefined;
  const uniqueSources = [...new Set(sources)];
  return {
    ...(uniqueSources.length === 0
      ? {}
      : {
          source:
            uniqueSources.length === 1
              ? uniqueSources[0]!
              : uniqueSources.map((source) => `(${source})`).join(" && "),
        }),
    references,
  };
}

function bindingsFromStep(step: WorkflowStep): Record<string, ExpressionReference[]> {
  return Object.fromEntries(
    Object.entries(step.expressionBindings ?? {})
      .filter(([key]) => key.startsWith("env."))
      .map(([key, references]) => [key.slice("env.".length), references]),
  );
}

function nextAnonymousScope(usedIds: Set<string>, next: () => number): string {
  let candidate = "";
  do {
    candidate = `__af_composite_call_${next()}`;
  } while (
    [...usedIds].some(
      (id) =>
        id === candidate || candidate.startsWith(`${id}__`) || id.startsWith(`${candidate}__`),
    )
  );
  usedIds.add(candidate);
  return candidate;
}

function enforceActionSourceLimits(path: string, source: string): void {
  if (Buffer.byteLength(source) > MAX_ACTION_BYTES) {
    throw new Error(`Action metadata exceeds ${MAX_ACTION_BYTES} bytes`);
  }
  const aliases = (source.match(/(^|\s)\*[A-Za-z0-9_-]+/gm) ?? []).length;
  if (aliases > MAX_ACTION_ALIASES) {
    throw new Error(`Action metadata exceeds ${MAX_ACTION_ALIASES} aliases`);
  }
  void path;
}

function enforceActionTreeLimits(path: string, source: string, node: unknown): void {
  let count = 0;
  const visit = (current: unknown, depth: number): void => {
    if (current === null || current === undefined || typeof current !== "object") return;
    count += 1;
    if (count > MAX_ACTION_NODES)
      throw new Error(`Action metadata exceeds ${MAX_ACTION_NODES} nodes`);
    if (depth > MAX_ACTION_YAML_DEPTH)
      throw new Error(`Action metadata exceeds depth ${MAX_ACTION_YAML_DEPTH}`);
    if (isMap(current)) {
      for (const pair of current.items) {
        visit(pair.key, depth + 1);
        visit(pair.value, depth + 1);
      }
    } else if (isSeq(current)) {
      for (const item of current.items) visit(item, depth + 1);
    }
  };
  visit(node, 0);
  void path;
  void source;
}

function scopedId(scope: string, id?: string): string {
  return id ? `${scope}__${id}` : scope;
}

function mapReferences(
  value: string,
  inputs: Record<string, CompositeInputBinding>,
  scope: string,
): ExpressionReference[] {
  return parseExpressions(value).references.flatMap((reference) => {
    const inputName = /^inputs\.([A-Za-z0-9_-]+)$/.exec(reference.path)?.[1];
    if (inputName && inputs[inputName]) {
      return inputs[inputName]!.references.map((mapped) => ({
        ...mapped,
        mappedFrom: reference.path,
      }));
    }
    const stepMatch = /^steps\.([A-Za-z0-9_-]+)(\..+)$/.exec(reference.path);
    if (!stepMatch) return [reference];
    return [
      {
        ...reference,
        path: `steps.${scopedId(scope, stepMatch[1])}${stepMatch[2]}`,
      },
    ];
  });
}

function resolveRepositoryPath(uses: string): string | undefined {
  const path = uses.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.startsWith("/")) return undefined;
  const normalized = posix.normalize(path);
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

function isLocalActionReference(uses: string): boolean {
  return uses.startsWith("./") || uses.startsWith("../") || uses.startsWith("/");
}

function inputDefinitions(node: unknown): Record<string, { default?: string; required?: boolean }> {
  return Object.fromEntries(
    mapEntries(node).map(([name, value]) => [
      name,
      {
        ...(scalarString(child(value, "default")) === undefined
          ? {}
          : { default: scalarString(child(value, "default"))! }),
        required: scalarString(child(value, "required")) === "true",
      },
    ]),
  );
}

function mapEntries(node: unknown): Array<[string, unknown]> {
  if (!isMap(node)) return [];
  return node.items.flatMap((pair) => {
    const key = scalarString(pair.key);
    return key === undefined ? [] : [[key, pair.value]];
  });
}

function child(node: unknown, key: string): unknown {
  if (!isMap(node)) return undefined;
  const pair = node.items.find((item) => scalarString(item.key) === key);
  return pair?.value;
}

function scalarMap(node: unknown): Record<string, string> {
  return Object.fromEntries(
    mapEntries(node).flatMap(([key, value]) => {
      const scalar = scalarString(value);
      return scalar === undefined ? [] : [[key, scalar]];
    }),
  );
}

function scalarString(node: unknown): string | undefined {
  if (!isScalar(node) || node.value === null || node.value === undefined) return undefined;
  return String(node.value);
}

function nodeRange(path: string, source: string, node: Node): SourceRange {
  const range = node.range;
  return rangeFromOffsets(path, source, range?.[0] ?? 0, range?.[1] ?? range?.[0] ?? 0);
}
