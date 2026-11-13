import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
  type Pair,
  type YAMLMap,
} from "yaml";
import { parseExpressions } from "../expressions/index.js";
import type {
  Diagnostic,
  PermissionMap,
  Trigger,
  WorkflowIR,
  WorkflowJob,
  WorkflowStep,
  WorkflowCallInput,
} from "../ir/types.js";
import { rangeFromOffsets } from "./locations.js";

export interface ParserLimits {
  maxBytes: number;
  maxAliases: number;
  maxDepth: number;
  maxNodes: number;
}

const defaultLimits: ParserLimits = {
  maxBytes: 1_000_000,
  maxAliases: 50,
  maxDepth: 40,
  maxNodes: 20_000,
};

export class WorkflowParseError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function parseYamlWorkflow(
  path: string,
  source: string,
  limits: Partial<ParserLimits> = {},
): WorkflowIR {
  const applied = { ...defaultLimits, ...limits };
  if (Buffer.byteLength(source) > applied.maxBytes) {
    throw new WorkflowParseError(`Workflow exceeds ${applied.maxBytes} bytes`, "file-too-large");
  }
  const aliases = (source.match(/(^|\s)\*[A-Za-z0-9_-]+/gm) ?? []).length;
  if (aliases > applied.maxAliases) {
    throw new WorkflowParseError(
      `Workflow exceeds ${applied.maxAliases} aliases`,
      "too-many-aliases",
    );
  }

  const document = parseDocument(source, { prettyErrors: false });
  if (document.errors.length > 0) {
    throw new WorkflowParseError(
      document.errors.map((error) => error.message).join("; "),
      "invalid-yaml",
    );
  }
  enforceTreeLimits(document.contents, applied);
  if (!isMap(document.contents))
    throw new WorkflowParseError("Workflow root must be a map", "invalid-root");

  const root = document.contents;
  const diagnostics: Diagnostic[] = document.warnings.map((warning) => ({
    code: "yaml-warning",
    message: warning.message,
  }));
  const triggers = parseTriggers(path, source, getPair(root, "on"));
  const permissions = parsePermissions(nodeValue(root, "permissions"));
  const jobsNode = nodeValue(root, "jobs");
  const jobs: WorkflowJob[] = [];
  if (isMap(jobsNode)) {
    for (const pair of jobsNode.items) {
      const id = scalarString(pair.key);
      if (!id || !isMap(pair.value)) continue;
      jobs.push(parseJob(path, source, id, pair.value));
    }
  }
  const rootEnv = stringMap(nodeValue(root, "env"));
  const expressionValues = [
    ...Object.values(rootEnv),
    ...jobs.flatMap((job) => [
      ...Object.values(job.env),
      job.if ?? "",
      ...job.steps.flatMap((step) =>
        Object.values({ ...step.with, ...step.env, run: step.run ?? "", if: step.if ?? "" }),
      ),
    ]),
  ];
  const unsupportedExpressions = expressionValues.flatMap(
    (value) => parseExpressions(value).unsupported,
  );
  diagnostics.push(
    ...unsupportedExpressions.map((expression) => ({
      code: "unsupported-expression",
      message: `Unsupported GitHub expression: ${expression}`,
    })),
  );

  return {
    path,
    kind: "actions-yaml",
    triggers,
    permissions,
    environment: scalarString(nodeValue(root, "environment")),
    env: rootEnv,
    inputs: workflowCallNames(root, "inputs"),
    workflowCallInputs: workflowCallInputs(root),
    workflowCallOutputs: workflowCallOutputs(root),
    secrets: workflowCallNames(root, "secrets"),
    jobs,
    completeness: diagnostics.some((item) => item.code === "unsupported-expression")
      ? "partial"
      : "complete",
    diagnostics,
    source,
  };
}

function parseJob(path: string, source: string, id: string, map: YAMLMap): WorkflowJob {
  const steps: WorkflowStep[] = [];
  const stepsNode = nodeValue(map, "steps");
  if (isSeq(stepsNode)) {
    for (const node of stepsNode.items) {
      if (!isMap(node)) continue;
      steps.push(parseStep(path, source, node));
    }
  }
  const uses = scalarString(nodeValue(map, "uses"));
  return {
    id,
    if: scalarString(nodeValue(map, "if")),
    permissions: parsePermissions(nodeValue(map, "permissions")),
    environment: environmentName(nodeValue(map, "environment")),
    env: stringMap(nodeValue(map, "env")),
    outputs: stringMap(nodeValue(map, "outputs")),
    secrets: secretNames(nodeValue(map, "secrets")),
    secretValues: stringMap(nodeValue(map, "secrets")),
    with: stringMap(nodeValue(map, "with")),
    steps,
    uses,
    range: nodeRange(path, source, map),
  };
}

function parseStep(path: string, source: string, map: YAMLMap): WorkflowStep {
  const uses = scalarString(nodeValue(map, "uses"));
  const run = scalarString(nodeValue(map, "run"));
  const withValues = stringMap(nodeValue(map, "with"));
  const env = stringMap(nodeValue(map, "env"));
  const expressionValues = [...Object.values(withValues), ...Object.values(env), run ?? ""];
  const expressions = expressionValues.flatMap((value) => parseExpressions(value).references);
  return {
    id: scalarString(nodeValue(map, "id")),
    name: scalarString(nodeValue(map, "name")),
    kind: uses?.startsWith("./.github/workflows/")
      ? "reusable-workflow"
      : run
        ? "shell"
        : uses
          ? "action"
          : "unknown",
    uses,
    run,
    if: scalarString(nodeValue(map, "if")),
    with: withValues,
    env,
    outputs: {},
    expressions,
    promptExpressions: [],
    capabilities: run ? ["SHELL_CAPABILITY"] : [],
    range: nodeRange(path, source, map),
  };
}

function parseTriggers(path: string, source: string, pair: Pair | undefined): Trigger[] {
  if (!pair) return [];
  const value = pair.value as Node | null;
  if (isScalar(value))
    return [{ event: String(value.value), range: nodeRange(path, source, value) }];
  if (isSeq(value)) {
    return value.items.flatMap((item) =>
      isScalar(item) ? [{ event: String(item.value), range: nodeRange(path, source, item) }] : [],
    );
  }
  if (isMap(value)) {
    return value.items.flatMap((item) => {
      const event = scalarString(item.key);
      const range = isNode(item.key) ? nodeRange(path, source, item.key) : undefined;
      const configuration = isNode(item.value) ? item.value.toJSON() : item.value;
      return event ? [{ event, configuration, range }] : [];
    });
  }
  return [];
}

function parsePermissions(node: Node | null | undefined): PermissionMap | undefined {
  if (isScalar(node)) {
    const value = String(node.value);
    if (value === "read-all" || value === "write-all") return value;
  }
  if (isMap(node)) {
    const result: Record<string, "read" | "write" | "none"> = {};
    for (const pair of node.items) {
      const key = scalarString(pair.key);
      const value = scalarString(pair.value);
      if (key && (value === "read" || value === "write" || value === "none")) result[key] = value;
    }
    return result;
  }
  return undefined;
}

function enforceTreeLimits(node: Node | null, limits: ParserLimits): void {
  let count = 0;
  const visit = (current: unknown, depth: number): void => {
    if (current === null || current === undefined || typeof current !== "object") return;
    count += 1;
    if (count > limits.maxNodes)
      throw new WorkflowParseError("Workflow node limit exceeded", "too-many-nodes");
    if (depth > limits.maxDepth)
      throw new WorkflowParseError("Workflow depth limit exceeded", "too-deep");
    if (isMap(current)) {
      for (const pair of current.items) {
        visit(pair.key, depth + 1);
        visit(pair.value, depth + 1);
      }
    }
    if (isSeq(current)) for (const item of current.items) visit(item, depth + 1);
  };
  visit(node, 0);
}

function getPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => scalarString(pair.key) === key);
}

function nodeValue(map: YAMLMap, key: string): Node | null | undefined {
  return getPair(map, key)?.value as Node | null | undefined;
}

function scalarString(node: unknown): string | undefined {
  if (!isScalar(node)) return undefined;
  if (node.value === null || node.value === undefined) return undefined;
  return String(node.value);
}

function stringMap(node: Node | null | undefined): Record<string, string> {
  if (!isMap(node)) return {};
  return Object.fromEntries(
    node.items.flatMap((pair) => {
      const key = scalarString(pair.key);
      const value = scalarString(pair.value);
      return key && value !== undefined ? [[key, value]] : [];
    }),
  );
}

function secretNames(node: Node | null | undefined): string[] {
  if (isScalar(node) && node.value === "inherit") return ["*"];
  return Object.keys(stringMap(node));
}

function environmentName(node: Node | null | undefined): string | undefined {
  if (isScalar(node)) return scalarString(node);
  if (isMap(node)) return scalarString(nodeValue(node, "name"));
  return undefined;
}

function workflowCallNames(root: YAMLMap, key: "inputs" | "secrets"): string[] {
  const on = nodeValue(root, "on");
  if (!isMap(on)) return [];
  const call = nodeValue(on, "workflow_call");
  if (!isMap(call)) return [];
  const values = nodeValue(call, key);
  if (!isMap(values)) return [];
  return values.items.flatMap((pair) => (scalarString(pair.key) ? [scalarString(pair.key)!] : []));
}

function workflowCallInputs(root: YAMLMap): Record<string, WorkflowCallInput> {
  const on = nodeValue(root, "on");
  if (!isMap(on)) return {};
  const call = nodeValue(on, "workflow_call");
  if (!isMap(call)) return {};
  const inputs = nodeValue(call, "inputs");
  if (!isMap(inputs)) return {};
  return Object.fromEntries(
    inputs.items.flatMap((pair) => {
      const name = scalarString(pair.key);
      if (!name || !isMap(pair.value)) return [];
      const defaultValue = scalarString(nodeValue(pair.value, "default"));
      return [[name, defaultValue === undefined ? {} : { default: defaultValue }]];
    }),
  );
}

function workflowCallOutputs(root: YAMLMap): Record<string, string> {
  const on = nodeValue(root, "on");
  if (!isMap(on)) return {};
  const call = nodeValue(on, "workflow_call");
  if (!isMap(call)) return {};
  const outputs = nodeValue(call, "outputs");
  if (!isMap(outputs)) return {};
  return Object.fromEntries(
    outputs.items.flatMap((pair) => {
      const name = scalarString(pair.key);
      if (!name || !isMap(pair.value)) return [];
      const value = scalarString(nodeValue(pair.value, "value"));
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function nodeRange(path: string, source: string, node: Node): ReturnType<typeof rangeFromOffsets> {
  const range = node.range;
  return rangeFromOffsets(path, source, range?.[0] ?? 0, range?.[1] ?? range?.[0] ?? 0);
}
