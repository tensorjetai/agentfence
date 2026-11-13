import type { RuleId, ScanResult } from "./ir/types.js";

export interface EvaluationCase {
  id: string;
  path: string;
  source: string;
  expectedRuleIds: RuleId[];
  expectedCompleteness: ScanResult["completeness"];
  provenance: "synthetic";
  designation: "development" | "heldout-candidate";
}

export interface RuleCounts {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number | null;
}

export interface FixtureEvaluation {
  id: string;
  expectedRuleIds: RuleId[];
  actualRuleIds: RuleId[];
  expectedCompleteness: ScanResult["completeness"];
  actualCompleteness: ScanResult["completeness"];
  completenessMatch: boolean;
  provenance: "synthetic";
  designation: EvaluationCase["designation"];
}

export interface EvaluationReport {
  provenance: "synthetic fixtures; not incident replay or independently labeled real-world data";
  fixtureCount: number;
  fixtureCoverage: number;
  completenessMatches: number;
  perRule: Record<RuleId, RuleCounts>;
  fixtures: FixtureEvaluation[];
}

const ruleIds: RuleId[] = ["AF001", "AF002", "AF003", "AF004", "AF005", "AF006", "AF007"];

export function evaluateCorpus(
  cases: EvaluationCase[],
  scan: (input: { path: string; source: string }) => ScanResult,
): EvaluationReport {
  const perRule = Object.fromEntries(
    ruleIds.map((ruleId) => [
      ruleId,
      { truePositive: 0, falsePositive: 0, falseNegative: 0, precision: null },
    ]),
  ) as Record<RuleId, RuleCounts>;
  const fixtures = cases.map((fixture): FixtureEvaluation => {
    const result = scan({ path: fixture.path, source: fixture.source });
    const expected = new Set(fixture.expectedRuleIds);
    const actual = new Set(result.findings.map((finding) => finding.ruleId));
    for (const ruleId of ruleIds) {
      const counts = perRule[ruleId];
      if (expected.has(ruleId) && actual.has(ruleId)) counts.truePositive += 1;
      else if (!expected.has(ruleId) && actual.has(ruleId)) counts.falsePositive += 1;
      else if (expected.has(ruleId) && !actual.has(ruleId)) counts.falseNegative += 1;
    }
    return {
      id: fixture.id,
      expectedRuleIds: [...fixture.expectedRuleIds].sort(),
      actualRuleIds: [...actual].sort(),
      expectedCompleteness: fixture.expectedCompleteness,
      actualCompleteness: result.completeness,
      completenessMatch: fixture.expectedCompleteness === result.completeness,
      provenance: fixture.provenance,
      designation: fixture.designation,
    };
  });
  for (const counts of Object.values(perRule)) {
    const predictedPositive = counts.truePositive + counts.falsePositive;
    counts.precision = predictedPositive === 0 ? null : counts.truePositive / predictedPositive;
  }
  return {
    provenance: "synthetic fixtures; not incident replay or independently labeled real-world data",
    fixtureCount: fixtures.length,
    fixtureCoverage:
      cases.length === 0
        ? 1
        : fixtures.filter(
            (item) => JSON.stringify(item.expectedRuleIds) === JSON.stringify(item.actualRuleIds),
          ).length / cases.length,
    completenessMatches: fixtures.filter((item) => item.completenessMatch).length,
    perRule,
    fixtures,
  };
}
