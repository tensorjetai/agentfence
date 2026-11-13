import { describe, expect, it } from "vitest";
import { scanWorkflow } from "../src/scan.js";

describe("expanded static scan integration", () => {
  it("detects documented implicit Claude context without prompt interpolation", () => {
    const result = scanWorkflow({
      path: ".github/workflows/claude.yml",
      source: `on: issue_comment
permissions: {}
jobs:
  review:
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: \${{ secrets.KEY }}
`,
    });
    expect(result.findings.some((finding) => finding.ruleId === "AF001")).toBe(true);
    expect(result.findings.some((finding) => finding.ruleId === "AF006")).toBe(true);
  });

  it("emits suppressible configuration findings without copying secrets", () => {
    const source = JSON.stringify({
      mcpServers: {
        test: { command: "npx", args: ["server@latest"], env: { TOKEN: "private-value" } },
      },
    });
    const result = scanWorkflow({ path: ".mcp.json", source });
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: "AF007", severity: "medium" })]),
    );
    expect(JSON.stringify(result.findings)).not.toContain("private-value");
  });

  it("does not treat standalone action metadata as a complete workflow scan", () => {
    const result = scanWorkflow({
      path: ".github/actions/test/action.yml",
      source: "runs:\n  using: composite\n  steps: []\n",
    });
    expect(result.completeness).toBe("partial");
    expect(result.diagnostics[0]?.code).toBe("composite-caller-context-required");
  });
});
