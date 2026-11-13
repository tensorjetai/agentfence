# AgentFence

> Deterministic static security analyzer for AI coding agents, MCP configs, and GitHub Actions workflows.

AgentFence parses GitHub Actions workflows (`.github/workflows/*.yml`), GitHub Agentic Workflow Markdown (`gh-aw`), and committed agent/MCP configurations (`.mcp.json`, `.claude/settings.json`, `.gemini/settings.json`), traces untrusted input flows across `env:` and step outputs, and emits actionable SARIF 2.1.0, JSON, or terminal findings (`AF001`–`AF007`).

[![npm version](https://img.shields.io/npm/v/agentfence-cli.svg)](https://www.npmjs.com/package/agentfence-cli)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> **Official npm packages:** **`agentfence-cli`** ([npm](https://www.npmjs.com/package/agentfence-cli)) and **`@tensorjetai/agentfence`** ([npm](https://www.npmjs.com/package/@tensorjetai/agentfence)). Unscoped `agentfence` on npm belongs to an unrelated third-party project.

---

## Quick Start

Scan any repository locally with `npx` (requires Node.js 22+, zero source code leaves your terminal or CI runner):

```bash
# Scan .github/workflows, .mcp.json, and agent configs with human-readable output
npx agentfence-cli --format text .

# Or use the scoped TensorJetAI package
npx @tensorjetai/agentfence --format text .

# Scan a specific workflow file or directory
npx agentfence-cli --format text .github/workflows/review.yml

# Emit structured JSON
npx agentfence-cli --format json .

# Export SARIF 2.1.0 for GitHub Code Scanning (Security tab)
npx agentfence-cli --format sarif . > agentfence.sarif
```

Or install globally to run `agentfence` / `agentfence-cli` directly:

```bash
npm install -g agentfence-cli
agentfence --format text .
```

---

## The Problem: Why Naive Regex Workflow Scans Miss Agent Exploits

Teams often assume checking for `pull_request_target` or direct `${{ github.event.issue.body }}` inside a `prompt:` input catches prompt injection in CI. In practice, real workflows break naive linters in several ways:

1. **`env:` & Step-Output Indirection (`AF001`, `AF002`)**: Untrusted PR/issue fields flow through intermediate job/step `env:` variables or `steps.<id>.outputs.*` values before reaching an agent prompt or downstream shell `run:` step (Prompt-to-Script).
2. **Untrusted Checkouts in Privileged Jobs (`AF003`)**: Checking out a contributor PR head ref (`github.event.pull_request.head.*` / `github.head_ref`) inside a job with write scopes or repository secrets lets repository files/configs influence privileged execution.
3. **Implicit Event Ingestion (`AF001`)**: Documented no-prompt interactive triggers on `anthropics/claude-code-action@v1` and triage flows on `google-github-actions/run-gemini-cli` ingest issue/PR/comment text even when no explicit `prompt:` string mentions `github.event`.
4. **Risky Committed MCP Server Configs (`AF007`)**: `.mcp.json`, `.claude/settings.json`, and `.gemini/settings.json` can invoke unpinned `npx` / `npm exec` packages or grant broad `trust: true` / wildcard `mcp__*` approvals without running any workflow at all.

---

## Features

- **100% Runner-Local & Deterministic:** Zero source code, workflows, prompts, or reports leave your machine; zero network egress during analysis.
- **Cross-Step Dataflow & Context Tracking:** Traces untrusted GitHub event fields through `env:`, step outputs, local reusable workflows (`workflow_call`), and local composite actions (`action.yml`).
- **7 Security Rules (`AF001`–`AF007`):** Covers prompt injection (`AF001`), prompt-to-script execution (`AF002`), untrusted PR checkout (`AF003`), missing trust gates (`AF004`), broad write permissions (`AF005`), secret exposure under untrusted input (`AF006`), and unpinned/over-broad MCP configs (`AF007`).
- **Fail-Closed Completeness:** Unsupported expression syntax, invalid policies, oversized inputs, and unresolved external references stay explicit `partial` diagnostics (exit code `2`) and prevent inline suppressions from hiding incomplete scans.
- **Policy & Inline Suppressions:** Versioned `.agentfence.yml` rules (with optional `expires` dates) and in-file `# agentfence-ignore: AF001 -- <reason>` comments.
- **CI-Ready Outputs:** SARIF 2.1.0 with stable SHA-256 fingerprints for GitHub Code Scanning, structured JSON, and terminal text; packaged with zero runtime dependencies.

---

## CLI Usage & Exit Codes

```text
Usage: agentfence [--format json|sarif|text] [path ...]
Defaults to discovering workflows under .github/workflows.
```

| Flag                           | Default | Description                                                                                             |
| :----------------------------- | :------ | :------------------------------------------------------------------------------------------------------ |
| `--format <json\|sarif\|text>` | `json`  | Output format (`text` for terminal review, `json` for automation, `sarif` for GitHub Code Scanning).    |
| `[path ...]`                   | `.`     | Repository root, `.github/workflows` directory, or individual `.yml` / `.yaml` / `.md` / `.json` files. |
| `--version`                    | —       | Print analyzer CLI version and exit `0`.                                                                |
| `--help`                       | —       | Print CLI usage and exit `0`.                                                                           |

### Exit Codes

- `0` — Completed analysis with no unsuppressed findings.
- `1` — Completed analysis with one or more unsuppressed findings (of any severity).
- `2` — Invalid CLI arguments/policy or incomplete (`partial`) analysis.

---

## Configuration (`.agentfence.yml`) & Inline Suppressions

Place an optional `.agentfence.yml` policy file in your repository root:

```yaml
version: 1
blockingSeverity: critical # critical | high | medium | low
providers:
  enabled:
    - github-agentic-workflows
    - claude
    - codex
    - gemini
    - actions-ai-inference
limits:
  reusableWorkflowDepth: 5 # integer 1..5
suppressions:
  - rule: AF004
    path: .github/workflows/triage.yml
    reason: Approved maintainer-only triage bot guarded by org workflow settings
    expires: "2026-12-31"
```

You can also suppress reviewed findings inline inside workflow YAML files when analysis completeness is `complete`:

```yaml
# agentfence-ignore: AF004 -- Gated via repository environment approval
```

Every suppression requires a non-empty reason. Expired `.agentfence.yml` suppressions emit explicit warnings, and incomplete (`partial`) analysis cannot be suppressed.

---

## Rule Catalog (`AF001`–`AF007`)

| Rule    | Severity          | Blocks by default | Condition                                                                                                                                | Primary Remediation                                                     |
| :------ | :---------------- | :---------------- | :--------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------- |
| `AF001` | **Critical**      | Yes               | Untrusted event or repository data reaches a privileged agent prompt.                                                                    | Add a fail-closed trust gate or split read/write jobs.                  |
| `AF002` | **Critical**      | Yes               | Recognized AI agent output flows into shell execution (`run:`).                                                                          | Validate strict structured outputs and map to allowlisted commands.     |
| `AF003` | **Critical**      | Yes               | Contributor-controlled `actions/checkout` ref enters a job with write permissions or secrets.                                            | Check out or analyze untrusted PR code in an isolated unprivileged job. |
| `AF004` | **High**          | No                | Public event trigger starts an agent without an actor, `author_association`, label, approval, or environment gate.                       | Enforce a fail-closed trust condition on job/step execution.            |
| `AF005` | **High**          | No                | Agent job holds broad write `permissions` (emits suggested YAML diff).                                                                   | Default to `permissions: {}` and grant minimal job scopes.              |
| `AF006` | **Critical**      | Yes               | Repository secret is exposed in an agent context influenced by untrusted input.                                                          | Move credential access to a separate maintainer-approved stage.         |
| `AF007` | **Medium / High** | No                | `.mcp.json` or `.{claude,gemini}/settings.json` invokes unpinned `npx`/`npm exec` packages or grants `trust: true` / `mcp__*` wildcards. | Pin exact reviewed package versions and narrow server/tool approvals.   |

---

## Supported Providers & Target Files

- **Modeled Agent Providers:** `anthropics/claude-code-action`, `anthropics/claude-code-base-action`, `openai/codex-action`, `google-github-actions/run-gemini-cli`, `actions/ai-inference`, and `github/gh-aw`.
- **Analyzed Files:** `.github/workflows/*.yml` / `*.yaml`, local reusable workflows, local composite `action.yml` dependencies, `gh-aw` workflow Markdown, `.mcp.json`, `.claude/settings.json`, and `.gemini/settings.json`.
- **Instruction Files:** `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `.github/agents/*.md` are inventoried as context; their prose is not executed or parsed for prompt safety.

---

## CI/CD Pipeline Integration (GitHub Actions)

Run AgentFence in pull request CI and upload SARIF directly to GitHub Code Scanning:

```yaml
name: AgentFence Security Scan

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write

jobs:
  agentfence:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Run AgentFence scan
        id: scan
        continue-on-error: true
        run: npx --yes agentfence-cli --format sarif . > agentfence.sarif

      - name: Upload SARIF to GitHub Code Scanning
        uses: github/codeql-action/upload-sarif@v3
        if: always() && hashFiles('agentfence.sarif') != ''
        with:
          sarif_file: agentfence.sarif

      - name: Fail on unsuppressed findings or incomplete scan
        if: steps.scan.outcome != 'success'
        run: exit 1
```

---

## Security Boundaries & Limitations

- **Static Evidence Only:** AgentFence verifies workflow/config structure deterministically without executing workflows, LLMs, or MCP servers; passing a scan does not guarantee runtime model behavior is safe.
- **Boundary Scope:** Remote reusable workflows (`owner/repo/.github/workflows/...`) and local JavaScript/Docker action internals are not resolved across network or container boundaries and are surfaced as `partial` completeness diagnostics.
- **Exact Pinning vs Supply Chain:** Pinning an exact MCP npm version or action ref prevents silent floating-tag changes; it does not audit the third-party package contents themselves.

---

## Links & Ecosystem

- **Homepage:** [agentfence.tensorjetai.com](https://agentfence.tensorjetai.com)
- **Organization:** [TensorJetAI](https://www.tensorjetai.com)
- **GitHub Repository:** [github.com/tensorjetai/agentfence](https://github.com/tensorjetai/agentfence)
- **Issues & Support:** [github.com/tensorjetai/agentfence/issues](https://github.com/tensorjetai/agentfence/issues)
- **npm Packages:** [`agentfence-cli`](https://www.npmjs.com/package/agentfence-cli) · [`@tensorjetai/agentfence`](https://www.npmjs.com/package/@tensorjetai/agentfence)

---

## License

[Apache-2.0](LICENSE) © 2026 TensorJetAI
