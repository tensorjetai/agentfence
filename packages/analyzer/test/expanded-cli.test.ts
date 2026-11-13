import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { runCli } from "../src/cli.js";

it("analyzes composite prompt inputs and output bridges through the real CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentfence-composite-cli-"));
  try {
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await mkdir(join(root, ".github/actions/review"), { recursive: true });
    await writeFile(
      join(root, ".github/workflows/review.yml"),
      `on: issues
permissions: {}
jobs:
  review:
    steps:
      - id: wrapper
        uses: ./.github/actions/review
        with:
          message: \${{ github.event.issue.body }}
      - run: \${{ steps.wrapper.outputs.answer }}
`,
    );
    await writeFile(
      join(root, ".github/actions/review/action.yml"),
      `name: Review
inputs:
  message: {}
outputs:
  answer:
    value: \${{ steps.agent.outputs.final-message }}
runs:
  using: composite
  steps:
    - id: agent
      uses: openai/codex-action@v1
      with:
        prompt: \${{ inputs.message }}
`,
    );
    const result = await runCli([], root);
    const report = JSON.parse(result.output);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "AF001",
          path: ".github/actions/review/action.yml",
          source: "github.event.issue.body",
        }),
        expect.objectContaining({ ruleId: "AF002", path: ".github/workflows/review.yml" }),
      ]),
    );
    expect(report.completeness).toBe("complete");
    expect(result.exitCode).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("discovers MCP configuration and emits AF007 through the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentfence-mcp-cli-"));
  try {
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { db: { command: "npx", args: ["db-server"] } } }),
    );
    const report = await runCli([], root);
    expect(report.exitCode).toBe(1);
    expect(JSON.parse(report.output).findings[0]).toMatchObject({
      ruleId: "AF007",
      path: ".mcp.json",
    });
    await writeFile(
      join(root, ".agentfence.yml"),
      "version: 1\nsuppressions:\n  - rule: AF007\n    path: .mcp.json\n    reason: Reviewed launch configuration for this evaluation.\n",
    );
    const suppressed = await runCli([], root);
    expect(suppressed.exitCode).toBe(0);
    expect(JSON.parse(suppressed.output).findings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
