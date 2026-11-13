# AgentFence

> Deterministic static security analyzer for AI coding agents, MCP configs, and GitHub Actions workflows by **TensorJetAI**.

AgentFence parses GitHub Actions workflows (`.github/workflows/*.yml`), GitHub Agentic Workflow Markdown (`gh-aw`), and committed agent/MCP configurations (`.mcp.json`, `.claude/settings.json`, `.gemini/settings.json`), traces untrusted input flows across `env:` and step outputs, and emits actionable SARIF 2.1.0, JSON, or terminal findings (`AF001`–`AF007`).

[![npm version](https://img.shields.io/npm/v/agentfence-cli.svg)](https://www.npmjs.com/package/agentfence-cli)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

> **Official npm packages:** **`agentfence-cli`** ([npm](https://www.npmjs.com/package/agentfence-cli)) and **`@tensorjetai/agentfence`** ([npm](https://www.npmjs.com/package/@tensorjetai/agentfence)). Unscoped `agentfence` on npm belongs to an unrelated third-party project.

---

## Quick Start (CLI)

Requirements: Node.js 22.12+ (Node.js 24 LTS recommended). Zero source code leaves your terminal or CI runner.

```bash
# Run human-readable static analysis across the repository
npx agentfence-cli --format text .

# Or use the scoped TensorJetAI package
npx @tensorjetai/agentfence --format text .

# Generate SARIF 2.1.0 for GitHub Code Scanning
npx agentfence-cli --format sarif .github/workflows/review.yml > agentfence.sarif

# Emit structured JSON
npx agentfence-cli --format json .
```

Exit codes: `0` for completed analysis with no unsuppressed findings, `1` for unsuppressed findings of any severity, and `2` for invalid arguments or incomplete analysis. See [local scanner and Action usage](docs/local-scanner.md) and the [rule reference](docs/rule-reference.md).

---

## Why Naive Workflow Scans Miss Agent Risks

- **`env:` & Step-Output Indirection (`AF001`, `AF002`):** Untrusted event fields (`issue.body`, `pull_request.body`, comments) pass through intermediate `env:` bindings or `steps.<id>.outputs.*` before hitting an agent prompt or shell `run:` step.
- **Untrusted Checkouts in Privileged Jobs (`AF003`):** Checking out a contributor PR head ref inside a job with write `permissions` or repository secrets exposes privileged execution to PR-controlled files.
- **Implicit Event Context (`AF001`):** No-prompt interactive modes on `anthropics/claude-code-action@v1` and triage flows on `google-github-actions/run-gemini-cli` ingest issue/PR text even without an explicit `prompt:` expression.
- **Risky Committed MCP Server Configs (`AF007`):** `.mcp.json`, `.claude/settings.json`, and `.gemini/settings.json` can invoke unpinned `npx`/`npm exec` packages or grant broad `trust: true` / `mcp__*` approvals without executing any workflow.

---

## Rule Catalog (`AF001`–`AF007`)

| Rule    | Severity          | Blocks by default | Condition                                                                                                                                | Primary Remediation                                                   |
| :------ | :---------------- | :---------------- | :--------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------- |
| `AF001` | **Critical**      | Yes               | Untrusted event or repository data reaches a privileged agent prompt.                                                                    | Add a fail-closed trust gate or split read/write jobs.                |
| `AF002` | **Critical**      | Yes               | Recognized AI agent output flows into shell execution (`run:`).                                                                          | Validate strict structured outputs and map to allowlisted commands.   |
| `AF003` | **Critical**      | Yes               | Contributor-controlled `actions/checkout` ref enters a job with write permissions or secrets.                                            | Analyze untrusted PR revisions in a separate unprivileged job.        |
| `AF004` | **High**          | No                | Public event trigger starts an agent without an actor, `author_association`, label, approval, or environment gate.                       | Enforce a fail-closed trust condition on job/step execution.          |
| `AF005` | **High**          | No                | Agent job holds broad write `permissions` (emits suggested YAML diff).                                                                   | Default to `permissions: {}` and grant minimal job scopes.            |
| `AF006` | **Critical**      | Yes               | Repository secret is exposed in an agent context influenced by untrusted input.                                                          | Move credential access to a separate maintainer-approved stage.       |
| `AF007` | **Medium / High** | No                | `.mcp.json` or `.{claude,gemini}/settings.json` invokes unpinned `npx`/`npm exec` packages or grants `trust: true` / `mcp__*` wildcards. | Pin exact reviewed package versions and narrow server/tool approvals. |

---

## Configuration (`.agentfence.yml`) & Inline Suppressions

Configure blocking thresholds, active providers, reusable workflow depth (`1`–`5`), and time-bounded suppressions in `.agentfence.yml`:

```yaml
version: 1
blockingSeverity: critical
providers:
  enabled:
    - github-agentic-workflows
    - claude
    - codex
    - gemini
    - actions-ai-inference
limits:
  reusableWorkflowDepth: 5
suppressions:
  - rule: AF004
    path: .github/workflows/triage.yml
    reason: Approved maintainer-only triage workflow
    expires: "2026-12-31"
```

Or suppress reviewed exceptions inline (requires complete analysis and a non-empty reason):

```yaml
# agentfence-ignore: AF004 -- Gated via repository environment approval
```

---

## Local Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
```

Run the CLI directly from source:

```bash
pnpm --silent scan --format text .
pnpm --silent scan --format sarif .github/workflows/review.yml > agentfence.sarif
```

Verify synthetic benchmarks and pinned public-source observations:

```bash
pnpm --silent benchmark:accuracy
pnpm --silent evaluate:real-world
```

---

## Coverage and Limits

AgentFence models supported GitHub expression flows and provider profiles (`anthropics/claude-code-action`, `anthropics/claude-code-base-action`, `openai/codex-action`, `google-github-actions/run-gemini-cli`, `actions/ai-inference`, and `github/gh-aw`); it does not execute workflows, LLMs, or MCP servers or prove runtime safety. `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `.github/agents/*.md` are recognized as instruction context, not executable workflows, and their prose is not currently analyzed.

Local scans preserve supported caller input/default/environment references, secret availability, permissions, trigger context, and output bridges across local reusable workflows and composite actions. `AF007` audits `.mcp.json`, `.claude/settings.json`, and `.gemini/settings.json` statically without executing MCP servers. Unsupported expression syntax and unresolved external references remain explicit `partial` diagnostics rather than being silently ignored. See [local scanner and Action usage](docs/local-scanner.md), [rule reference](docs/rule-reference.md), and [evaluation review protocol](docs/evaluation-review.md).

---

## License

Apache License 2.0 (`Apache-2.0`). See [LICENSE](LICENSE).
