import { describe, expect, it } from "vitest";
import { createBenchmarkReport, loadBenchmarkCases } from "./benchmark-runner.js";

describe("synthetic analyzer quality benchmark", () => {
  it("reports fixture-level rule and completeness results without real-world accuracy claims", () => {
    const report = createBenchmarkReport();

    expect(report.provenance).toContain("not incident replay");
    expect(report.fixtureCount).toBe(12);
    expect(report.fixtureCoverage).toBe(1);
    expect(report.completenessMatches).toBe(12);
    expect(report.perRule.AF001).toMatchObject({
      truePositive: 4,
      falsePositive: 0,
      falseNegative: 0,
      precision: 1,
    });
    expect(report.perRule.AF002).toMatchObject({
      truePositive: 2,
      falsePositive: 0,
      falseNegative: 0,
      precision: 1,
    });
    expect(report.perRule.AF004).toMatchObject({
      truePositive: 6,
      falsePositive: 0,
      falseNegative: 0,
      precision: 1,
    });
    expect(report.perRule.AF003.precision).toBeNull();
    expect(report.perRule.AF007).toMatchObject({
      truePositive: 1,
      falsePositive: 0,
      falseNegative: 0,
    });
    expect(
      report.fixtures.find((item) => item.id === "ghaw-read-tool-only")?.actualRuleIds,
    ).toEqual(["AF004"]);
  });

  it("keeps paired examples labeled synthetic and does not claim independent held-out validation", () => {
    const cases = loadBenchmarkCases();
    expect(cases.every((item) => item.provenance === "synthetic")).toBe(true);
    expect(cases.every((item) => item.designation === "development")).toBe(true);
  });
});
