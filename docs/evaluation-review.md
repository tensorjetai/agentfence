# Analyzer evaluation review

## Real-world corpus

The corpus at `packages/analyzer/test/real-world/` separates four conventional CI/release control examples from four agentic workflow examples. The agentic cases are complete, unchanged files from official Anthropic, OpenAI, Google, and GitHub repositories; their source and fixture hashes match. The conventional controls are explicitly identified as condensed excerpts, not agentic examples. `manifest.json` pins each upstream commit and source path, links to the immutable source URL, records the source-file SHA-256 and repository license, and records each checked-in fixture's SHA-256. No workflow is executed and no provider is contacted.

Run from the repository root with:

```sh
pnpm --filter @agentfence/analyzer exec tsx test/real-world/runner.ts
pnpm --filter @agentfence/analyzer exec vitest run test/real-world/real-world.test.ts
```

The runner uses reusable-workflow resolution and composite preparation for YAML files, with dependencies available only from full files in the corpus at the same repository and commit. Missing dependencies are incomplete, not assumed safe. Adapted control excerpts are also marked incomplete because their full context is absent. It reports per-case findings, diagnostics, completeness, and alerts alongside each case's category and source-file status. This is observational output, not a human assessment. It intentionally does not calculate precision, recall, or accuracy. The fixture set is neither representative nor independently labeled.

## Reviewer checklist

- [ ] Confirm the pinned source URL, commit, source hash, fixture hash, and license before redistributing or changing an excerpt.
- [ ] Read the full pinned workflow and relevant repository context; an excerpt can omit important safeguards or threat context.
- [ ] Assess each alert against the actual data flow, trust boundary, permission scope, and reachable execution conditions.
- [ ] Record false alarms, missed issues, and uncertainty with rationale; distinguish “not applicable” from “safe.”
- [ ] If producing labels, review the source before opening analyzer output. Use a copied `reviewer-label-template.json`; keep reviewer labels separate from analyzer output and record reviewer identity, date, and adjudication process externally.
- [ ] Do not call labels independent, human-reviewed, or ground truth unless that process has actually been completed and documented.

## Blind-label template

`packages/analyzer/test/real-world/reviewer-label-template.json` is an empty template only. Its neutral case IDs do not encode expected outcomes. It contains no labels and is not consumed by the runner. After blinded review and a documented adjudication process, a separately maintained labeled dataset may be used to evaluate accuracy; until then, no accuracy metric is warranted.
