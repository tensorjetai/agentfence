import { isMap, isSeq, parseDocument } from "yaml";
import { parseExpressions } from "../expressions/index.js";
import type { PermissionMap, WorkflowIR } from "../ir/types.js";
import { rangeFromOffsets } from "./locations.js";
import { WorkflowParseError } from "./yaml.js";

const frontmatterPattern = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export function parseMarkdownWorkflow(path: string, source: string): WorkflowIR {
  if (Buffer.byteLength(source) > 1_000_000) {
    throw new WorkflowParseError("Workflow exceeds 1000000 bytes", "file-too-large");
  }
  // Instruction documents are context, not executable gh-aw workflows. Their
  // prose must not be interpreted as workflow configuration or executable code.
  if (/^(?:(?:AGENTS|CLAUDE|GEMINI)\.md|\.github\/agents\/.*\.md)$/.test(path)) {
    return {
      path,
      kind: "instruction-markdown",
      triggers: [],
      env: {},
      inputs: [],
      secrets: [],
      jobs: [],
      completeness: "complete",
      diagnostics: [],
      source,
    };
  }
  const match = frontmatterPattern.exec(source);
  if (!match)
    throw new WorkflowParseError(
      "Agentic workflow requires YAML frontmatter",
      "missing-frontmatter",
    );
  const frontmatter = match[1] ?? "";
  const aliases = (frontmatter.match(/(^|\s)\*[A-Za-z0-9_-]+/gm) ?? []).length;
  if (aliases > 50) {
    throw new WorkflowParseError("Frontmatter exceeds 50 aliases", "too-many-aliases");
  }
  const document = parseDocument(frontmatter, { prettyErrors: false });
  if (document.errors.length > 0) {
    throw new WorkflowParseError(
      document.errors.map((error) => error.message).join("; "),
      "invalid-frontmatter",
    );
  }
  enforceFrontmatterLimits(document.contents);
  let data: Record<string, unknown>;
  try {
    data = (document.toJS({ maxAliasCount: 50 }) ?? {}) as Record<string, unknown>;
  } catch {
    throw new WorkflowParseError("Frontmatter alias expansion limit exceeded", "too-many-aliases");
  }
  const bodyOffset = match[0].length;
  const body = source.slice(bodyOffset);
  const expressions = parseExpressions(body);
  const engine = typeof data.engine === "string" ? data.engine : "copilot";
  const permissions = normalizePermissions(data.permissions);
  const env = normalizeStringMap(data.env);
  const triggerData = data.on;
  const triggers =
    typeof triggerData === "string"
      ? [{ event: triggerData }]
      : Array.isArray(triggerData)
        ? triggerData.map((event) => ({ event: String(event) }))
        : triggerData && typeof triggerData === "object"
          ? Object.entries(triggerData).map(([event, configuration]) => ({ event, configuration }))
          : [];
  const diagnostics = expressions.unsupported.map((value) => ({
    code: "unsupported-expression",
    message: `Unsupported GitHub expression: ${value}`,
  }));
  const secrets = collectSecretNames(data);
  const tools = data.tools && typeof data.tools === "object" ? Object.keys(data.tools) : [];
  return {
    path,
    kind: "agentic-markdown",
    triggers,
    permissions,
    environment: typeof data.environment === "string" ? data.environment : undefined,
    env,
    inputs: [],
    secrets,
    jobs: [
      {
        id: "agent",
        permissions,
        environment: typeof data.environment === "string" ? data.environment : undefined,
        env,
        outputs: {},
        secrets,
        secretValues: {},
        with: {},
        range: rangeFromOffsets(path, source, 0, source.length),
        steps: [
          {
            id: "agent",
            name: `${engine} agent`,
            kind: "agent",
            uses: `github-agentic-workflows/${engine}`,
            with: { prompt: body },
            env: {},
            outputs: { result: "agent output" },
            expressions: expressions.references,
            promptExpressions: [],
            capabilities: [
              "NETWORK_CAPABILITY",
              ...(tools.some((tool) => /bash|shell|edit/.test(tool))
                ? (["SHELL_CAPABILITY"] as const)
                : []),
            ],
            range: rangeFromOffsets(path, source, bodyOffset, source.length),
            providerId: "github-agentic-workflows",
          },
        ],
      },
    ],
    completeness: diagnostics.length > 0 ? "partial" : "complete",
    diagnostics,
    source,
  };
}

function enforceFrontmatterLimits(node: unknown): void {
  let count = 0;
  const visit = (current: unknown, depth: number): void => {
    if (current === null || current === undefined || typeof current !== "object") return;
    count += 1;
    if (count > 20_000) {
      throw new WorkflowParseError("Frontmatter node limit exceeded", "too-many-nodes");
    }
    if (depth > 40) {
      throw new WorkflowParseError("Frontmatter depth limit exceeded", "too-deep");
    }
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

function normalizeStringMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  );
}

function normalizePermissions(input: unknown): PermissionMap | undefined {
  if (input === "read-all" || input === "write-all") return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const result: Record<string, "read" | "write" | "none"> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === "read" || value === "write" || value === "none") result[key] = value;
  }
  return result;
}

function collectSecretNames(data: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const reference of parseExpressions(value).references) {
        if (reference.path.startsWith("secrets.")) names.add(reference.path.slice(8));
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(data);
  return [...names];
}
