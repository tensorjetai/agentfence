import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanWorkflow } from "../src/scan.js";
import { evaluateCorpus, type EvaluationCase, type EvaluationReport } from "../src/evaluation.js";

const corpusDirectory = join(dirname(fileURLToPath(import.meta.url)), "benchmark-corpus");
const fixture = (
  id: string,
  filename: string,
  expectedRuleIds: EvaluationCase["expectedRuleIds"],
  expectedCompleteness: EvaluationCase["expectedCompleteness"] = "complete",
): EvaluationCase => ({
  id,
  path: `.github/workflows/${filename}`,
  source: readFileSync(join(corpusDirectory, filename), "utf8"),
  expectedRuleIds,
  expectedCompleteness,
  provenance: "synthetic",
  designation: "development",
});

export function loadBenchmarkCases(): EvaluationCase[] {
  return [
    fixture("codex-prompt-vulnerable", "codex-prompt-vulnerable.yml", [
      "AF001",
      "AF004",
      "AF005",
      "AF006",
    ]),
    fixture("codex-prompt-hardened", "codex-prompt-hardened.yml", []),
    fixture("agent-shell-vulnerable", "agent-shell-vulnerable.yml", ["AF002"]),
    fixture("agent-shell-hardened", "agent-shell-hardened.yml", []),
    fixture("claude-env-intermediary-vulnerable", "claude-env-intermediary-vulnerable.yml", [
      "AF001",
      "AF004",
      "AF005",
    ]),
    fixture("claude-env-intermediary-hardened", "claude-env-intermediary-hardened.yml", []),
    fixture("claude-base-action-vulnerable", "claude-base-action-vulnerable.yml", [
      "AF001",
      "AF004",
      "AF005",
      "AF006",
    ]),
    fixture("gemini-p2s-vulnerable", "gemini-p2s-vulnerable.yml", ["AF002", "AF004", "AF005"]),
    fixture("partial-expression", "partial-expression.yml", ["AF001", "AF004", "AF005"], "partial"),
    fixture("ghaw-read-tool-only", "ghaw-read-only.md", ["AF004"]),
    { ...fixture("mcp-unpinned", "mcp-unpinned.json", ["AF007"]), path: ".mcp.json" },
    { ...fixture("mcp-pinned", "mcp-pinned.json", []), path: ".mcp.json" },
  ];
}

export function createBenchmarkReport(): EvaluationReport {
  return evaluateCorpus(loadBenchmarkCases(), scanWorkflow);
}

export function benchmarkReportJson(): string {
  return JSON.stringify(createBenchmarkReport(), null, 2);
}
