import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareWorkflowDependencies } from "../../src/prepare.js";
import { resolveReusableWorkflows } from "../../src/reusable/index.js";
import { scanPreparedWorkflow, scanWorkflow } from "../../src/scan.js";
import type { Diagnostic, Finding } from "../../src/ir/types.js";

const directory = dirname(fileURLToPath(import.meta.url));
type Manifest = {
  schemaVersion: number;
  purpose: string;
  cases: Array<{
    id: string;
    fixture: string;
    repository: string;
    commit: string;
    sourcePath: string;
    sourceUrl: string;
    sourceSha256: string;
    fixtureSha256: string;
    license: string;
    excerpt: string;
    category: "agentic" | "conventional-control";
    fullFile: boolean;
  }>;
};

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

export interface WorkflowObservationInput {
  path: string;
  source: string;
  repositorySources?: Map<string, string>;
}

export async function analyzeWorkflowSource({
  path,
  source,
  repositorySources = new Map(),
}: WorkflowObservationInput) {
  const fetchFile = async (target: string) => repositorySources.get(target);
  if (path.endsWith(".md")) {
    const result = scanWorkflow({ path, source });
    return {
      completeness: result.completeness,
      diagnostics: result.diagnostics.map((item) => ({ ...item, path })),
      findings: result.findings.filter((item) => !item.suppressed),
    };
  }

  const resolution = await resolveReusableWorkflows(path, source, fetchFile);
  const diagnostics: Array<Diagnostic & { path: string }> = resolution.diagnostics
    .filter((item) => item.code !== "reusable-local-action-unsupported")
    .map((item) => ({
      ...item,
      path,
    }));
  const findings: Finding[] = [];
  const seenFindings = new Set<string>();
  let completeness: "complete" | "partial" = diagnostics.length ? "partial" : "complete";
  for (const workflow of resolution.workflows) {
    const prepared = await prepareWorkflowDependencies(workflow, fetchFile);
    const result = scanPreparedWorkflow(prepared);
    if (prepared.completeness === "partial" || result.completeness === "partial") {
      completeness = "partial";
    }
    diagnostics.push(...result.diagnostics.map((item) => ({ ...item, path: workflow.path })));
    for (const finding of result.findings) {
      if (!finding.suppressed && !seenFindings.has(finding.fingerprint)) {
        seenFindings.add(finding.fingerprint);
        findings.push(finding);
      }
    }
  }
  if (diagnostics.length > 0) completeness = "partial";
  const uniqueDiagnostics = [
    ...new Map(
      diagnostics.map((item) => [`${item.path}\0${item.code}\0${item.message}`, item]),
    ).values(),
  ];
  findings.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.range.start.line - b.range.start.line ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
  uniqueDiagnostics.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
  return { completeness, diagnostics: uniqueDiagnostics, findings };
}

export async function createRealWorldReport() {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as Manifest;
  const loadedSources = manifest.cases.map((entry) => ({
    entry,
    source: readFileSync(join(directory, entry.fixture), "utf8"),
  }));
  const cases = await Promise.all(
    loadedSources.map(async ({ entry, source }) => {
      const actualHash = sha256(source);
      if (actualHash !== entry.fixtureSha256) {
        throw new Error(
          `Fixture hash mismatch for ${entry.id}: expected ${entry.fixtureSha256}, got ${actualHash}`,
        );
      }
      const repositorySources = new Map<string, string>();
      for (const candidate of loadedSources) {
        if (
          candidate.entry.fullFile &&
          candidate.entry.repository === entry.repository &&
          candidate.entry.commit === entry.commit
        ) {
          repositorySources.set(candidate.entry.sourcePath, candidate.source);
        }
      }
      const result = await analyzeWorkflowSource({
        path: entry.sourcePath,
        source,
        repositorySources,
      });
      return {
        id: entry.id,
        repository: entry.repository,
        commit: entry.commit,
        sourcePath: entry.sourcePath,
        sourceUrl: entry.sourceUrl,
        sourceSha256: entry.sourceSha256,
        fixtureSha256: actualHash,
        license: entry.license,
        category: entry.category,
        fullFile: entry.fullFile,
        completeness: entry.fullFile ? result.completeness : "partial",
        diagnostics: entry.fullFile
          ? result.diagnostics
          : [
              ...result.diagnostics,
              {
                path: entry.sourcePath,
                code: "corpus-excerpt",
                message:
                  "Only an adapted excerpt is present; full workflow context is unavailable.",
              },
            ],
        findings: result.findings,
        alerts: result.findings.map(
          ({ ruleId, severity, confidence, explanation, remediation, range }) => ({
            ruleId,
            severity,
            confidence,
            explanation,
            remediation,
            range,
          }),
        ),
      };
    }),
  );
  return {
    reportType: "observational-analysis",
    purpose: manifest.purpose,
    caseCount: cases.length,
    cases,
    notice:
      "No independent labels are supplied. Findings are analyzer output, not verified true/false positives; no accuracy metrics are computed.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createRealWorldReport().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  });
}
