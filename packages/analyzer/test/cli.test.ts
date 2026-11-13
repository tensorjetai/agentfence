import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";

const fixture = "packages/analyzer/test/fixtures/providers/";
const vulnerableWorkflow = `on: pull_request
permissions:
  contents: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: openai/codex-action@v1
        with:
          openai-api-key: \${{ secrets.OPENAI_API_KEY }}
          prompt: \${{ github.event.pull_request.body }}
`;

describe("local CLI", () => {
  it("reports findings and a failing exit code as SARIF", async () => {
    const result = await runCli(["--format", "sarif", `${fixture}codex-vulnerable.yml`]);
    const report = JSON.parse(result.output);
    expect(result.exitCode).toBe(1);
    expect(report.version).toBe("2.1.0");
    expect(report.runs[0].results.some((item: { ruleId: string }) => item.ruleId === "AF001")).toBe(
      true,
    );
    expect(report.runs[0].invocations[0].executionSuccessful).toBe(true);
  });

  it("makes unreadable files incomplete rather than clean", async () => {
    const result = await runCli(["--format", "sarif", "missing.yml"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output).runs[0].invocations[0].executionSuccessful).toBe(false);
  });

  it("rejects invalid format and unknown options", async () => {
    expect((await runCli(["--format", "xml", "workflow.yml"])).exitCode).toBe(2);
    expect((await runCli(["--upload", "workflow.yml"])).exitCode).toBe(2);
  });

  it("renders concise text reports while keeping JSON as the default format", async () => {
    const text = await runCli(["--format", "text", `${fixture}codex-vulnerable.yml`]);
    expect(text.exitCode).toBe(1);
    expect(text.output).toContain("AgentFence analysis: complete");
    expect(text.output).toContain("Findings:");
    expect(text.output).toContain("[CRITICAL] AF001");
    expect(text.output).toContain("Source:");
    expect(text.output).toContain("Remediation:");
    const defaultOutput = await runCli([`${fixture}codex-vulnerable.yml`]);
    expect(
      JSON.parse(defaultOutput.output).findings.some(
        (finding: { ruleId: string }) => finding.ruleId === "AF001",
      ),
    ).toBe(true);
  });

  it("prints the package version and exits successfully", async () => {
    expect(await runCli(["--version"])).toEqual({ exitCode: 0, output: "0.1.0\n" });
  });

  it("escapes terminal control characters in text output", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentfence-terminal-"));
    const filename = "workflow\u001b[2J.yml";
    try {
      await writeFile(join(root, filename), vulnerableWorkflow);
      const result = await runCli(["--format", "text", filename], root);
      expect(result.output).toContain("workflow\\u001b[2J.yml");
      expect(result.output).not.toContain("\u001b");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers workflows from a directory and sorts output deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentfence-cli-"));
    try {
      await mkdir(join(root, ".github/workflows"), { recursive: true });
      await mkdir(join(root, ".github/agents"), { recursive: true });
      await writeFile(join(root, ".github/workflows/z.yml"), vulnerableWorkflow);
      await writeFile(join(root, ".github/workflows/a.yml"), vulnerableWorkflow);
      await writeFile(join(root, "AGENTS.md"), "# Repository guidance\n");
      await writeFile(join(root, "CLAUDE.md"), "# Claude guidance\n");
      await writeFile(join(root, "GEMINI.md"), "# Gemini guidance\n");
      await writeFile(join(root, ".github/agents/reviewer.md"), "# Reviewer guidance\n");
      const result = await runCli([], root);
      const report = JSON.parse(result.output);
      expect(result.exitCode, result.output).toBe(1);
      expect(report.findings.length).toBeGreaterThan(0);
      expect(new Set(report.findings.map((finding: { path: string }) => finding.path))).toEqual(
        new Set([".github/workflows/a.yml", ".github/workflows/z.yml"]),
      );
      expect(report.instructionPaths).toEqual([
        ".github/agents/reviewer.md",
        "AGENTS.md",
        "CLAUDE.md",
        "GEMINI.md",
      ]);
      expect(result.output).toBe((await runCli([], root)).output);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads repository policy and treats invalid policy as incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentfence-policy-"));
    try {
      await mkdir(join(root, ".github/workflows"), { recursive: true });
      await writeFile(join(root, ".github/workflows/run.yml"), vulnerableWorkflow);
      await writeFile(join(root, ".agentfence.yml"), "version: 1\nblockingSeverity: high\n");
      const valid = await runCli([], root);
      expect(valid.exitCode).toBe(1);
      expect(JSON.parse(valid.output).findings.length).toBeGreaterThan(0);

      await writeFile(join(root, ".agentfence.yml"), "version: 99\n");
      const invalid = await runCli([], root);
      expect(invalid.exitCode).toBe(2);
      expect(JSON.parse(invalid.output).diagnostics[0].code).toBe("invalid-policy");

      await writeFile(join(root, ".agentfence.yml"), `version: 1\n#${"x".repeat(65_536)}`);
      const oversized = await runCli([], root);
      expect(oversized.exitCode).toBe(2);
      expect(JSON.parse(oversized.output).diagnostics[0].code).toBe("invalid-policy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow symlinked directories outside the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentfence-root-"));
    const outside = await mkdtemp(join(tmpdir(), "agentfence-outside-"));
    try {
      await mkdir(join(root, ".github/workflows"), { recursive: true });
      await writeFile(join(outside, "secret.yml"), "permissions: write-all\njobs: {}\n");
      await symlink(outside, join(root, ".github/workflows/external"), "dir");
      const result = await runCli([], root);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.output).findings).toEqual([]);
      expect(JSON.parse(result.output).diagnostics[0].code).toBe("symlink-skipped");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("diagnoses oversized workflow input without reading it into the analyzer", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentfence-limit-"));
    try {
      await mkdir(join(root, ".github/workflows"), { recursive: true });
      await writeFile(join(root, ".github/workflows/large.yml"), `#${"x".repeat(1_000_000)}`);
      const result = await runCli([], root);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.output).diagnostics[0].code).toBe("file-too-large");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds untrusted caller input in a local reusable workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentfence-reusable-cli-"));
    try {
      await mkdir(join(root, ".github/workflows"), { recursive: true });
      await writeFile(
        join(root, ".github/workflows/root.yml"),
        `on: pull_request\npermissions: write-all\njobs:\n  child:\n    uses: ./.github/workflows/child.yml\n    with:\n      prompt: \${{ github.event.pull_request.body }}\n`,
      );
      await writeFile(
        join(root, ".github/workflows/child.yml"),
        `on:\n  workflow_call:\n    inputs:\n      prompt: {}\njobs:\n  run:\n    steps:\n      - uses: openai/codex-action@v1\n        with:\n          openai-api-key: \${{ secrets.OPENAI_API_KEY }}\n          prompt: \${{ inputs.prompt }}\n`,
      );

      const result = await runCli([], root);
      const report = JSON.parse(result.output);
      expect(result.exitCode, result.output).toBe(1);
      expect(
        report.findings.some(
          (finding: { severity: string; path: string }) =>
            finding.severity === "critical" && finding.path === ".github/workflows/child.yml",
        ),
      ).toBe(true);
      await writeFile(
        join(root, ".github/workflows/root.yml"),
        "on: pull_request\npermissions: write-all\njobs:\n  child:\n    uses: ./.github/workflows/child.yml\n    with:\n      prompt: trusted text\n",
      );
      const literal = JSON.parse((await runCli([], root)).output);
      expect(
        literal.findings.some(
          (finding: { severity: string; path: string }) =>
            finding.severity === "critical" && finding.path === ".github/workflows/child.yml",
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects workflow discovery through a symlinked repository directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentfence-symlink-root-"));
    const outside = await mkdtemp(join(tmpdir(), "agentfence-symlink-outside-"));
    try {
      await mkdir(join(outside, "workflows"), { recursive: true });
      await writeFile(join(outside, "workflows/secret.yml"), vulnerableWorkflow);
      await symlink(outside, join(root, ".github"), "dir");
      const result = await runCli([], root);
      const report = JSON.parse(result.output);
      expect(result.exitCode).toBe(2);
      expect(report.findings).toEqual([]);
      expect(
        report.diagnostics.some(
          (diagnostic: { code: string }) => diagnostic.code === "outside-repository",
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("enforces a global workflow input byte budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentfence-total-limit-"));
    try {
      await mkdir(join(root, ".github/workflows"), { recursive: true });
      for (let index = 0; index < 11; index++) {
        await writeFile(join(root, `.github/workflows/${index}.yml`), `#${"x".repeat(999_999)}`);
      }
      const result = await runCli([], root);
      expect(result.exitCode).toBe(2);
      expect(
        JSON.parse(result.output).diagnostics.some(
          (diagnostic: { code: string }) => diagnostic.code === "repository-size-limit",
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
