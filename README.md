# AgentFence

Deterministic static security analyzer for AI agents, MCP server configs, and GitHub Actions workflows by **TensorJetAI**.

AgentFence parses GitHub Actions workflows (`.github/workflows/*.yml`), GitHub Agentic Workflow Markdown (`gh-aw`), and committed agent/MCP configs (`.mcp.json`, `.claude/settings.json`, `.gemini/settings.json`), traces untrusted input flows across `env:` and step outputs, and emits actionable SARIF 2.1.0, JSON, or human-readable findings (`AF001`–`AF007`).

> **Official npm packages:** **`agentfence-cli`** (`npx agentfence-cli`) and **`@tensorjetai/agentfence`** (`npx @tensorjetai/agentfence`). Unscoped `agentfence` on npm belongs to an unrelated third-party project.

## Quick start (CLI)

Requirements: Node.js 22.12+ (Node.js 24 LTS recommended). Zero source code leaves your runner or terminal.

```bash
npx agentfence-cli --format text .
npx agentfence-cli --format sarif .github/workflows/review.yml > agentfence.sarif
# Or using the scoped TensorJetAI package:
npx @tensorjetai/agentfence --format text .
```

Exit codes: `0` for completed analysis with no unsuppressed findings, `1` for unsuppressed findings of any severity, and `2` for invalid arguments or incomplete analysis. See [local scanner and Action usage](docs/local-scanner.md) and the [rule reference](docs/rule-reference.md).

## Local development

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

## Coverage and limits

AgentFence models supported GitHub expression flows and provider profiles (`anthropics/claude-code-action`, `anthropics/claude-code-base-action`, `openai/codex-action`, `google-github-actions/run-gemini-cli`, `actions/ai-inference`, and `github/gh-aw`); it does not enforce runtime behavior or prove that an agent is safe. `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `.github/agents/*.md` are recognized as instruction context, not executable workflows, and their prose is not currently analyzed.

Local scans preserve supported caller input/default/environment references, secret availability, permissions, trigger context, and output bridges across local reusable workflows and composite actions. AF007 audits `.mcp.json`, `.claude/settings.json`, and `.gemini/settings.json` statically without executing MCP servers. Unsupported expression syntax and unresolved external references remain explicit diagnostics (`partial` completeness) rather than being silently ignored. See [local scanner coverage](docs/local-scanner.md) and [evaluation review protocol](docs/evaluation-review.md).

## License

Apache License 2.0 (`Apache-2.0`). See [LICENSE](LICENSE).
