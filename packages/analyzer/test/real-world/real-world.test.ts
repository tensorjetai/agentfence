import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeWorkflowSource, createRealWorldReport } from "./runner.js";

const directory = dirname(fileURLToPath(import.meta.url));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("real-world observational corpus", () => {
  it("has pinned provenance and fixture hashes that match every checked-in excerpt", () => {
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    expect(manifest.cases.length).toBe(8);
    expect(
      manifest.cases.filter((entry: { category: string }) => entry.category === "agentic"),
    ).toHaveLength(4);
    for (const entry of manifest.cases) {
      expect(entry.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(entry.sourceUrl).toContain(entry.commit);
      expect(entry.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.license).toBeTruthy();
      expect(entry.excerpt).toBeTruthy();
      const fixtureHash = digest(readFileSync(join(directory, entry.fixture), "utf8"));
      expect(fixtureHash).toBe(entry.fixtureSha256);
      if (entry.fullFile) expect(entry.sourceSha256).toBe(fixtureHash);
      else expect(entry.excerpt.toLowerCase()).toMatch(/excerpt|condensed/);
    }
  });

  it("reproduces observations without presenting unlabeled findings as accuracy metrics", async () => {
    const report = await createRealWorldReport();
    expect(report).toMatchObject({ reportType: "observational-analysis", caseCount: 8 });
    expect(
      report.cases.filter((item) => item.category === "agentic" && item.fullFile),
    ).toHaveLength(4);
    expect(report.cases.every((item) => ["complete", "partial"].includes(item.completeness))).toBe(
      true,
    );
    expect(report.cases.every((item) => item.alerts.length === item.findings.length)).toBe(true);
    expect(report).not.toHaveProperty("precision");
    expect(report).not.toHaveProperty("recall");
    expect(report.notice).toContain("No independent labels");
    expect(await createRealWorldReport()).toEqual(report);
  });

  it("reports missing local dependencies as incomplete", async () => {
    const report = await analyzeWorkflowSource({
      path: ".github/workflows/test.yml",
      source:
        "permissions: {}\non: workflow_dispatch\njobs:\n  x:\n    steps:\n      - uses: ./.github/actions/missing\n",
    });
    expect(report.completeness).toBe("partial");
    expect(report.diagnostics.some((item) => item.code === "composite-missing-action")).toBe(true);
  });

  it("does not retain a provisional local-action diagnostic after successful expansion", async () => {
    const report = await analyzeWorkflowSource({
      path: ".github/workflows/test.yml",
      source:
        "permissions: {}\non: workflow_dispatch\njobs:\n  x:\n    steps:\n      - uses: ./.github/actions/safe\n",
      repositorySources: new Map([
        [
          ".github/actions/safe/action.yml",
          "name: safe\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo ok\n",
        ],
      ]),
    });
    expect(report.completeness).toBe("complete");
    expect(report.diagnostics).toEqual([]);
  });
});
