import { describe, expect, it } from "vitest";
import { parseExpressions, parseMarkdownWorkflow, parseYamlWorkflow } from "../src/index.js";

describe("workflow parsers", () => {
  it("keeps YAML step locations and treats on as a string key", () => {
    const workflow = parseYamlWorkflow(
      "x.yml",
      "on: issues\njobs:\n  x:\n    steps:\n      - run: echo hi\n",
    );
    expect(workflow.triggers[0]?.event).toBe("issues");
    expect(workflow.jobs[0]?.steps[0]?.range.start.line).toBe(5);
  });

  it("normalizes agentic Markdown frontmatter and instruction body", () => {
    const workflow = parseMarkdownWorkflow(
      "triage.md",
      "---\non: issues\nengine: codex\npermissions:\n  issues: write\n---\nTriage ${{ github.event.issue.body }}\n",
    );
    expect(workflow.kind).toBe("agentic-markdown");
    expect(workflow.jobs[0]?.steps[0]?.kind).toBe("agent");
    expect(workflow.jobs[0]?.steps[0]?.range.start.line).toBe(7);
  });

  it("extracts bracket-syntax secrets from agentic Markdown frontmatter", () => {
    const workflow = parseMarkdownWorkflow(
      "triage.md",
      "---\non: issues\ntools:\n  reviewer:\n    token: ${{ secrets['REVIEW_TOKEN'] }}\n---\nReview issue\n",
    );

    expect(workflow.jobs[0]?.secrets).toContain("REVIEW_TOKEN");
  });

  it("extracts nested and bracket expression references", () => {
    const result = parseExpressions(
      "x ${{ github.event.pull_request.body }} ${{ steps['agent'].outputs.result }}",
    );
    expect(result.references.map((ref) => ref.path)).toEqual([
      "github.event.pull_request.body",
      "steps.agent.outputs.result",
    ]);
  });

  it("rejects excessive aliases in Markdown frontmatter", () => {
    const aliases = Array.from({ length: 51 }, (_, index) => `  x${index}: *shared`).join("\n");
    expect(() =>
      parseMarkdownWorkflow(
        "agent.md",
        `---\nshared: &shared value\ntools:\n${aliases}\n---\ninspect\n`,
      ),
    ).toThrow(/aliases/);
  });

  it("rejects excessive Markdown frontmatter depth", () => {
    const nested = [
      ...Array.from({ length: 42 }, (_, index) => `${"  ".repeat(index)}x${index}:`),
      `${"  ".repeat(42)}value`,
    ].join("\n");
    expect(() => parseMarkdownWorkflow("agent.md", `---\n${nested}\n---\ninspect\n`)).toThrow(
      /depth/,
    );
  });
});
