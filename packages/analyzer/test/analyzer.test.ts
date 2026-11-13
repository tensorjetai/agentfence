import { describe, expect, it } from "vitest";
import { parsePolicy } from "@agentfence/policy";
import { scanWorkflow } from "../src/index.js";

describe("scanWorkflow", () => {
  it("finds untrusted PR text reaching privileged Codex prompt", () => {
    const source = `
on: pull_request
permissions:
  contents: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: openai/codex-action@v1
        with:
          openai-api-key: \${{ secrets.OPENAI_API_KEY }}
          prompt: "Review: \${{ github.event.pull_request.body }}"
`;
    const result = scanWorkflow({ path: ".github/workflows/review.yml", source });
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining(["AF001", "AF005", "AF006"]),
    );
    expect(result.findings.some((finding) => finding.ruleId === "AF004")).toBe(false);
    expect(result.findings[0]?.trace.length).toBeGreaterThan(1);
  });

  it("finds agent output reaching shell", () => {
    const source = `
on: workflow_dispatch
permissions: {}
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - id: agent
        uses: openai/codex-action@v1
        with:
          prompt: inspect
      - run: \${{ steps.agent.outputs.final-message }}
`;
    expect(
      scanWorkflow({ path: ".github/workflows/shell.yml", source }).findings.some(
        (finding) => finding.ruleId === "AF002",
      ),
    ).toBe(true);
  });

  it("marks unsupported expressions partial instead of clean", () => {
    const source = `
on: issues
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: openai/codex-action@v1
        with:
          prompt: \${{ github.event.issue.body.* }}
`;
    const result = scanWorkflow({ path: ".github/workflows/partial.yml", source });
    expect(result.completeness).toBe("partial");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("scopes stable fingerprints to the repository", () => {
    const source = `on: issues
permissions:
  issues: write
jobs:
  x:
    steps:
      - uses: openai/codex-action@v1
        with:
          prompt: \${{ github.event.issue.body }}
`;
    const first = scanWorkflow({ path: ".github/workflows/x.yml", source, repository: "acme/a" });
    const second = scanWorkflow({ path: ".github/workflows/x.yml", source, repository: "acme/b" });
    expect(first.findings[0]?.fingerprint).not.toBe(second.findings[0]?.fingerprint);
  });

  it("honors the repository provider allowlist", () => {
    const source = `on: issues
permissions:
  issues: write
jobs:
  x:
    steps:
      - uses: openai/codex-action@v1
        with:
          prompt: \${{ github.event.issue.body }}
`;
    const policy = parsePolicy("version: 1\nproviders:\n  enabled: [gemini]\n").policy;

    const result = scanWorkflow({ path: ".github/workflows/x.yml", source, policy });

    expect(result.findings).toEqual([]);
    expect(result.workflow.jobs[0]?.steps[0]?.kind).toBe("action");
  });
});
