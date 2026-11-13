import { describe, expect, it } from "vitest";
import { scanWorkflow } from "../src/index.js";

describe("assessment regressions", () => {
  it.each(["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/agents/reviewer.md"])(
    "accepts %s as instruction context, not an executable workflow",
    (path) => {
      const result = scanWorkflow({ path, source: "# Instructions\nReview changes carefully.\n" });
      expect(result.workflow.kind).toBe("instruction-markdown");
      expect(result.workflow.jobs).toEqual([]);
      expect(result.completeness).toBe("complete");
      expect(result.diagnostics).toEqual([]);
    },
  );

  it("still rejects workflow Markdown without frontmatter", () => {
    expect(() => scanWorkflow({ path: ".github/workflows/review.md", source: "Review." })).toThrow(
      "frontmatter",
    );
  });

  it("does not invent shell access for gh-aw with only read tools", () => {
    const result = scanWorkflow({
      path: ".github/workflows/review.md",
      source:
        "---\non: issues\npermissions: {}\ntools:\n  github:\n    toolsets: [issues]\n---\nReview the issue.\n",
    });
    expect(result.workflow.jobs[0]?.steps[0]?.capabilities).not.toContain("SHELL_CAPABILITY");
  });

  it("preserves explicitly declared gh-aw shell access", () => {
    const result = scanWorkflow({
      path: ".github/workflows/review.md",
      source: "---\non: issues\npermissions: {}\ntools:\n  bash: true\n---\nReview.\n",
    });
    expect(result.workflow.jobs[0]?.steps[0]?.capabilities).toContain("SHELL_CAPABILITY");
  });
});
