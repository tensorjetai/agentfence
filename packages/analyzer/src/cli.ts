import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parsePolicy } from "@agentfence/policy";
import { resolveReusableWorkflows } from "./reusable/index.js";
import { scanPreparedWorkflow, scanWorkflow } from "./scan.js";
import type { Finding, WorkflowIR } from "./ir/types.js";
import { prepareWorkflowDependencies } from "./prepare.js";

const MAX_DISCOVERY_DEPTH = 24;
const MAX_DISCOVERED_FILES = 2_000;
const MAX_INPUT_BYTES = 1_000_000;
const MAX_REPOSITORY_BYTES = 10_000_000;
const MAX_PREPARED_WORKFLOWS = 2_000;
const POLICY_PATH = ".agentfence.yml";

type Diagnostic = { path: string; code: string; message: string };

/** Local, read-only analysis. Exit 1 means findings; exit 2 means incomplete usage/analysis. */
export async function runCli(
  args: string[],
  cwd = process.cwd(),
): Promise<{ exitCode: number; output: string }> {
  if (args.includes("--version")) return { exitCode: 0, output: "0.1.0\n" };
  if (args.includes("--help")) {
    return {
      exitCode: 0,
      output:
        "Usage: agentfence [--format json|sarif|text] [path ...]\nDefaults to discovering workflows under .github/workflows.\n",
    };
  }
  let format = "json";
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--format") format = args[++i] ?? "";
    else if (arg.startsWith("-")) return { exitCode: 2, output: `Unknown option: ${arg}\n` };
    else paths.push(arg);
  }
  if (!["json", "sarif", "text"].includes(format)) {
    return { exitCode: 2, output: "Specify --format json, sarif, or text.\n" };
  }

  const root = await realpath(resolve(cwd)).catch(() => resolve(cwd));
  const rootReal = root;
  const diagnostics: Diagnostic[] = [];
  let policy;
  try {
    const policyFile = resolve(root, POLICY_PATH);
    const policyStat = await lstat(policyFile);
    if (policyStat.isSymbolicLink() || !policyStat.isFile()) {
      diagnostics.push({
        path: POLICY_PATH,
        code: "unreadable-policy",
        message: "Policy must be a regular file inside the repository.",
      });
    } else if (policyStat.size > 65_536) {
      diagnostics.push({
        path: POLICY_PATH,
        code: "invalid-policy",
        message: "Policy exceeds 65536 bytes.",
      });
    } else {
      const parsed = parsePolicy(await readFile(policyFile, "utf8"));
      policy = parsed.policy;
      diagnostics.push(
        ...parsed.warnings.map((warning) => ({
          path: POLICY_PATH,
          code: warning.code,
          message: warning.message,
        })),
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({
        path: POLICY_PATH,
        code: "invalid-policy",
        message: "Unable to read or parse repository policy.",
      });
    }
  }

  const requested = paths.length ? [...new Set(paths)] : ["."];
  const workflowPaths = new Set<string>();
  for (const input of requested) {
    const absolute = resolve(root, input);
    if (!isWithin(rootReal, absolute)) {
      diagnostics.push({
        path: displayPath(root, absolute),
        code: "outside-repository",
        message: "Input path must be inside the repository.",
      });
      continue;
    }
    let info;
    try {
      info = await lstat(absolute);
    } catch {
      diagnostics.push({
        path: displayPath(root, absolute),
        code: "unreadable-file",
        message: "Unable to read input path.",
      });
      continue;
    }
    if (info.isSymbolicLink()) {
      diagnostics.push({
        path: displayPath(root, absolute),
        code: "symlink-skipped",
        message: "Symbolic links are not followed.",
      });
    } else if (info.isDirectory()) {
      await discoverDirectory(root, absolute, workflowPaths, diagnostics);
    } else {
      workflowPaths.add(displayPath(root, absolute));
    }
  }

  const findings: Finding[] = [];
  const instructionPaths: string[] = [];
  const preparedWorkflows: Array<{ workflow: WorkflowIR; rootPath: string }> = [];
  const invokedPaths = new Set<string>();
  const loadedFileSizes = new Map<string, number>();
  let loadedBytes = 0;
  let contextLimitReported = false;
  for (const path of [...workflowPaths].sort()) {
    if (!/\.(?:ya?ml|md|json)$/i.test(path) || path === POLICY_PATH) {
      diagnostics.push({
        path,
        code: "unsupported-file",
        message: "Expected a workflow YAML or Markdown file.",
      });
      continue;
    }
    const absolute = resolve(root, path);
    try {
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        diagnostics.push({
          path,
          code: "symlink-skipped",
          message: "Only regular files inside the repository are scanned.",
        });
        continue;
      }
      if (stat.size > MAX_INPUT_BYTES) {
        diagnostics.push({
          path,
          code: "file-too-large",
          message: `Input exceeds ${MAX_INPUT_BYTES} bytes.`,
        });
        continue;
      }
      const real = await realpath(absolute);
      if (!isWithin(rootReal, real)) {
        diagnostics.push({
          path,
          code: "outside-repository",
          message: "Input resolves outside the repository.",
        });
        continue;
      }
      const sizeAvailable = reserveInputBudget(absolute, stat.size, loadedFileSizes, loadedBytes);
      if (!sizeAvailable.allowed) {
        diagnostics.push({
          path,
          code: "repository-size-limit",
          message: `Workflow inputs exceed the ${MAX_REPOSITORY_BYTES}-byte repository budget.`,
        });
        break;
      }
      loadedBytes = sizeAvailable.loadedBytes;
      const source = await readFile(absolute, "utf8");
      if (/\.ya?ml$/i.test(path) && !/(?:^|\/)action\.ya?ml$/i.test(path)) {
        const resolution = await resolveReusableWorkflows(
          path,
          source,
          async (target) => {
            const safeRead = await readContainedWorkflow(
              root,
              rootReal,
              target,
              loadedFileSizes,
              loadedBytes,
            );
            loadedBytes = safeRead.loadedBytes;
            if (safeRead.exceeded && !contextLimitReported) {
              contextLimitReported = true;
              diagnostics.push({
                path: target,
                code: "repository-size-limit",
                message: `Workflow inputs exceed the ${MAX_REPOSITORY_BYTES}-byte repository budget.`,
              });
            }
            return safeRead.source;
          },
          policy?.limits.reusableWorkflowDepth,
          policy ? { enabledProviders: policy.providers.enabled } : undefined,
        );
        diagnostics.push(
          ...resolution.diagnostics
            .filter((item) => item.code !== "reusable-local-action-unsupported")
            .map((diagnostic) => ({ ...diagnostic, path })),
        );
        for (const workflow of resolution.workflows) {
          if (preparedWorkflows.length >= MAX_PREPARED_WORKFLOWS) {
            if (!contextLimitReported) {
              contextLimitReported = true;
              diagnostics.push({
                path,
                code: "reusable-context-limit",
                message: `Resolved workflows exceed the ${MAX_PREPARED_WORKFLOWS}-context CLI limit.`,
              });
            }
            break;
          }
          if (workflow.invocation) invokedPaths.add(workflow.path);
          preparedWorkflows.push({ workflow, rootPath: path });
          if (preparedWorkflows.length >= MAX_PREPARED_WORKFLOWS) {
            contextLimitReported = true;
            diagnostics.push({
              path,
              code: "reusable-context-limit",
              message: `Resolved workflows reached the ${MAX_PREPARED_WORKFLOWS}-context CLI limit.`,
            });
            break;
          }
        }
        if (preparedWorkflows.length >= MAX_PREPARED_WORKFLOWS) break;
      } else {
        const result = scanWorkflow({ path, source, ...(policy ? { policy } : {}) });
        if (result.workflow.kind === "instruction-markdown") instructionPaths.push(path);
        findings.push(...result.findings.filter((finding) => !finding.suppressed));
        diagnostics.push(...result.diagnostics.map((diagnostic) => ({ ...diagnostic, path })));
      }
    } catch {
      diagnostics.push({
        path,
        code: "analysis-failed",
        message: "Unable to read or parse workflow.",
      });
    }
  }

  const seenFingerprints = new Set<string>(findings.map((finding) => finding.fingerprint));
  for (const { workflow } of preparedWorkflows) {
    if (
      !workflow.invocation &&
      invokedPaths.has(workflow.path) &&
      workflow.triggers.every((trigger) => trigger.event === "workflow_call")
    )
      continue;
    const prepared = await prepareWorkflowDependencies(workflow, async (target) => {
      const safeRead = await readContainedWorkflow(
        root,
        rootReal,
        target,
        loadedFileSizes,
        loadedBytes,
      );
      loadedBytes = safeRead.loadedBytes;
      return safeRead.source;
    });
    const result = scanPreparedWorkflow(prepared, policy ? { policy } : {});
    for (const finding of result.findings) {
      if (!finding.suppressed && !seenFingerprints.has(finding.fingerprint)) {
        seenFingerprints.add(finding.fingerprint);
        findings.push(finding);
      }
    }
    diagnostics.push(
      ...result.diagnostics.map((diagnostic) => ({ ...diagnostic, path: workflow.path })),
    );
  }

  findings.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.range.start.line - b.range.start.line ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
  diagnostics.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
  instructionPaths.sort();
  const exitCode = diagnostics.length ? 2 : findings.length ? 1 : 0;
  const report =
    format === "json"
      ? {
          findings,
          diagnostics,
          instructionPaths,
          completeness: diagnostics.length ? "partial" : "complete",
        }
      : {
          version: "2.1.0",
          $schema: "https://json.schemastore.org/sarif-2.1.0.json",
          runs: [
            {
              tool: { driver: { name: "AgentFence", version: "0.1.0" } },
              results: findings.map((finding) => ({
                ruleId: finding.ruleId,
                level: ["critical", "high"].includes(finding.severity) ? "error" : "warning",
                message: { text: finding.explanation },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: {
                        uri: finding.path.split("/").map(encodeURIComponent).join("/"),
                      },
                      region: {
                        startLine: finding.range.start.line,
                        startColumn: finding.range.start.column,
                      },
                    },
                  },
                ],
                partialFingerprints: { "agentfence/v1": finding.fingerprint },
              })),
              invocations: [
                {
                  executionSuccessful: diagnostics.length === 0,
                  toolExecutionNotifications: diagnostics.map((diagnostic) => ({
                    level: "error",
                    descriptor: { id: diagnostic.code },
                    message: { text: `${diagnostic.path}: ${diagnostic.message}` },
                  })),
                },
              ],
              properties: { instructionPaths },
            },
          ],
        };
  return {
    exitCode,
    output:
      format === "text"
        ? renderTextReport(findings, diagnostics)
        : `${JSON.stringify(report, null, 2)}\n`,
  };
}

function renderTextReport(findings: Finding[], diagnostics: Diagnostic[]): string {
  const severities = ["critical", "high", "medium", "low"] as const;
  const completeness =
    diagnostics.length || findings.some((finding) => finding.completeness === "partial")
      ? "partial"
      : "complete";
  const counts = severities.map(
    (severity) =>
      `${severity}: ${findings.filter((finding) => finding.severity === severity).length}`,
  );
  const lines = [
    `AgentFence analysis: ${completeness}`,
    `Findings: ${findings.length} (${counts.join(", ")}); diagnostics: ${diagnostics.length}`,
  ];
  for (const finding of findings) {
    lines.push(
      "",
      `[${finding.severity.toUpperCase()}] ${finding.ruleId} ${terminalSafe(finding.path)}:${finding.range.start.line}:${finding.range.start.column} — ${terminalSafe(finding.explanation)}`,
      `Source: ${terminalSafe(finding.source)} -> Sink: ${terminalSafe(finding.sink)}`,
      `Remediation: ${terminalSafe(finding.remediation)}`,
    );
  }
  for (const diagnostic of diagnostics) {
    lines.push(
      "",
      `[DIAGNOSTIC] ${terminalSafe(diagnostic.code)} ${terminalSafe(diagnostic.path)} — ${terminalSafe(diagnostic.message)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function terminalSafe(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

async function discoverDirectory(
  root: string,
  directory: string,
  output: Set<string>,
  diagnostics: Diagnostic[],
): Promise<void> {
  const relativeDirectory = relative(root, directory).split(sep).join("/");
  const workflowDirectory =
    relativeDirectory === ".github/workflows" || relativeDirectory.endsWith("/.github/workflows");
  const instructionFile = relativeDirectory === "";
  const agentsDirectory =
    relativeDirectory === ".github/agents" || relativeDirectory.endsWith("/.github/agents");
  let capped = false;
  const visit = async (
    current: string,
    depth: number,
    mode: "workflows" | "root-instructions" | "agent-instructions",
  ): Promise<void> => {
    if (capped) return;
    if (depth > MAX_DISCOVERY_DEPTH) {
      diagnostics.push({
        path: displayPath(root, current),
        code: "discovery-depth-exceeded",
        message: `Directory depth exceeds ${MAX_DISCOVERY_DEPTH}.`,
      });
      return;
    }
    try {
      const actual = await realpath(current);
      if (!isWithin(root, actual)) {
        diagnostics.push({
          path: displayPath(root, current),
          code: "outside-repository",
          message: "Directory resolves outside the repository; discovery stopped.",
        });
        return;
      }
    } catch {
      diagnostics.push({
        path: displayPath(root, current),
        code: "unreadable-directory",
        message: "Unable to resolve directory inside the repository.",
      });
      return;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      diagnostics.push({
        path: displayPath(root, current),
        code: "unreadable-directory",
        message: "Unable to read directory.",
      });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = resolve(current, entry.name);
      const path = displayPath(root, child);
      if (entry.isSymbolicLink()) {
        if (mode === "workflows") {
          diagnostics.push({
            path,
            code: "symlink-skipped",
            message: "Symbolic-link directories are not followed during workflow discovery.",
          });
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (mode === "workflows") await visit(child, depth + 1, "workflows");
        continue;
      }
      const accepted =
        mode === "workflows"
          ? /\.(?:ya?ml|md)$/i.test(entry.name)
          : mode === "root-instructions"
            ? ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".mcp.json"].includes(entry.name)
            : entry.name.endsWith(".md");
      if (!entry.isFile() || !accepted) continue;
      output.add(path);
      if (output.size > MAX_DISCOVERED_FILES) {
        output.delete(path);
        capped = true;
        diagnostics.push({
          path,
          code: "discovery-limit-exceeded",
          message: `Discovery exceeds ${MAX_DISCOVERED_FILES} files.`,
        });
        return;
      }
    }
  };
  if (workflowDirectory) await visit(directory, 0, "workflows");
  else if (agentsDirectory) await visit(directory, 0, "agent-instructions");
  else {
    if (instructionFile) await visit(directory, 0, "root-instructions");
    for (const configPath of [".claude/settings.json", ".gemini/settings.json"]) {
      const candidate = resolve(directory, configPath);
      try {
        const info = await lstat(candidate);
        if (info.isFile() || info.isSymbolicLink()) output.add(displayPath(root, candidate));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          diagnostics.push({
            path: displayPath(root, candidate),
            code: "unreadable-configuration",
            message: "Unable to inspect agent configuration.",
          });
      }
    }
    const workflows = resolve(directory, ".github/workflows");
    try {
      const info = await lstat(workflows);
      if (info.isDirectory()) await visit(workflows, 0, "workflows");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        diagnostics.push({
          path: displayPath(root, workflows),
          code: "unreadable-directory",
          message: "Unable to read workflow directory.",
        });
    }
    const agents = resolve(directory, ".github/agents");
    try {
      const info = await lstat(agents);
      if (info.isDirectory()) await visit(agents, 0, "agent-instructions");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        diagnostics.push({
          path: displayPath(root, agents),
          code: "unreadable-directory",
          message: "Unable to read agent instructions directory.",
        });
    }
  }
}

function displayPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/") || ".";
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function readContainedWorkflow(
  root: string,
  rootReal: string,
  path: string,
  loadedFileSizes: Map<string, number>,
  loadedBytes: number,
): Promise<{ source?: string; loadedBytes: number; exceeded: boolean }> {
  const absolute = resolve(root, path);
  if (!isWithin(rootReal, absolute)) return { loadedBytes, exceeded: false };
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_INPUT_BYTES)
      return { loadedBytes, exceeded: false };
    if (!isWithin(rootReal, await realpath(absolute))) return { loadedBytes, exceeded: false };
    const budget = reserveInputBudget(absolute, stat.size, loadedFileSizes, loadedBytes);
    if (!budget.allowed) return { loadedBytes, exceeded: true };
    return {
      source: await readFile(absolute, "utf8"),
      loadedBytes: budget.loadedBytes,
      exceeded: false,
    };
  } catch {
    return { loadedBytes, exceeded: false };
  }
}

function reserveInputBudget(
  absolute: string,
  size: number,
  loadedFileSizes: Map<string, number>,
  loadedBytes: number,
): { allowed: boolean; loadedBytes: number } {
  if (loadedFileSizes.has(absolute)) return { allowed: true, loadedBytes };
  if (loadedBytes + size > MAX_REPOSITORY_BYTES) return { allowed: false, loadedBytes };
  loadedFileSizes.set(absolute, size);
  return { allowed: true, loadedBytes: loadedBytes + size };
}
