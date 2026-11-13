# Local scanner and Action usage

AgentFence scans workflows and MCP configurations locally with zero network egress during analysis. The standalone Apache-2.0 CLI (`agentfence-cli` and `@tensorjetai/agentfence` v0.1.1) is published on npm, and this repository provides the composite GitHub Action (`action.yml`).

## CLI

Run directly from npm in any repository (Node.js 22+, zero install required):

```bash
npx agentfence-cli --format text .
npx agentfence-cli --format sarif . > agentfence.sarif
npx agentfence-cli --version
# Or via the TensorJetAI scoped package:
npx @tensorjetai/agentfence --format text .
```

Or install dependencies and run from source inside this repository:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --silent scan
pnpm --silent scan --format text
pnpm --silent scan --format sarif . > agentfence.sarif
node packages/analyzer/dist/src/cli-entry.js --version
```

Run the CLI from the repository you want to analyze. With no path, it discovers supported workflow files under `.github/workflows` and recognizes instruction documents as context. You can also pass a workflow file or workflow directory explicitly. It loads `.agentfence.yml` from the working directory. An invalid policy produces an incomplete report rather than silently applying defaults.

Exit codes are `0` for a completed scan without active findings, `1` for active findings of any severity, and `2` for incomplete analysis or invalid usage. The scanner reads local files, does not upload source or reports, and does not execute workflows, prompts, or MCP servers.

## Local GitHub Action

The root `action.yml` builds the scanner from its own checkout and produces a local SARIF file. It does not upload the report or request repository write permissions. Dependency installation uses network access; source analysis is local. When evaluating the action from a separate checkout, keep that scanner checkout pinned to a reviewed commit SHA.

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@v5
    with:
      persist-credentials: false
  # Place a reviewed AgentFence checkout at .agentfence-tool first.
  - uses: ./.agentfence-tool
    id: agentfence
    continue-on-error: true
    with:
      path: .
  # Inspect steps.agentfence.outputs.exit-code and sarif-file here.
  # Choose explicitly whether to upload SARIF or fail the job.
```

`continue-on-error` allows a later step to process a report when findings or incomplete analysis produce a failing exit code. Remove it if you want the scan step to fail the job immediately. Uploading SARIF is a separate choice and may require GitHub Code Security access for private repositories and additional workflow permissions.

## Analysis boundaries

Local reusable workflow analysis retains each invocation's context for supported input expressions, defaults, environment references, permissions, secret availability, and declared output bridges. Repeated calls are analyzed separately and findings are deduplicated. Local composite actions are expanded with scoped step references and output bridges. The parser does not rewrite workflow source to substitute caller text. Unsupported mappings and resolution failures produce diagnostics.

This is not complete interprocedural or runtime analysis. Remote workflows and local JavaScript/Docker action internals are not resolved. Unsupported expression syntax, unknown permission ceilings, and unresolved output paths remain partial. A standalone `action.yml` needs a calling workflow to establish its authority and input context; include the caller in the scan. Reusable outputs implemented through composite actions can remain partial because those boundaries are resolved in separate stages.

The documented no-prompt Claude `@v1` interactive mode and no-prompt Gemini CLI triage on issue and pull-request events contribute implicit event context to prompt analysis. Explicit non-empty Gemini prompts do not receive that implicit context. Provider modes and moving tags remain explicit coverage boundaries.

The scanner discovers `.mcp.json`, `.claude/settings.json`, and `.gemini/settings.json`. AF007 reports supported unpinned npm/npx server packages and broad server/tool approvals. Invalid or oversized configuration is incomplete. Commands are never executed; exact version pinning does not prove that a server is safe. Instruction prose, remote MCP responses, and arbitrary executable configuration are not analyzed. A parsed instruction document does not establish that its instructions are safe.

Provider authorization is separate from content trust. A provider may restrict who starts a run while still reading attacker-controlled PR or issue content. Unknown action revisions do not inherit verified guard assumptions merely because the action name matches.

## Reproducible development benchmark

```bash
pnpm --silent benchmark:accuracy
```

The benchmark reports expected-versus-observed rule presence, per-rule counts, and completeness matches on paired synthetic development fixtures. It is not an incident replay, independently labeled corpus, or real-world precision/recall estimate. The command fails when fixture expectations or completeness checks differ. A passing report validates these fixtures only.

`pnpm --silent evaluate:real-world` produces an observational report over pinned public-source cases, including full agentic workflow files and clearly marked conventional-workflow excerpts. It computes no accuracy metrics without independent labels. See [review protocol and provenance](evaluation-review.md).
