# AgentFence Analyzer

Deterministic static security analyzer for AI agents, MCP servers, and GitHub Actions workflows by **TensorJetAI**.

> **Official npm packages:** Use **`agentfence-cli`** (`npx agentfence-cli`) or **`@tensorjetai/agentfence`** (`npx @tensorjetai/agentfence`). The unscoped `agentfence` package on npm belongs to an unrelated third-party project.

AgentFence parses GitHub Actions workflows (`.github/workflows/*.yml`), GitHub Agentic Workflow Markdown (`gh-aw`), and repository agent configurations (`.mcp.json`, `.claude/settings.json`, `.gemini/settings.json`), traces untrusted input flows across `env:` and step outputs, and reports actionable source-to-sink findings (`AF001`–`AF007`).

## Quick Start

Run instantly with `npx` (zero install needed):

```bash
npx agentfence-cli --format text .
```

Or using the scoped TensorJetAI package:

```bash
npx @tensorjetai/agentfence --format text .
```

Scan a specific workflow directory or file:

```bash
npx agentfence-cli --format text .github/workflows
```

Output as SARIF 2.1.0 (compatible with GitHub Code Scanning / Security tab):

```bash
npx agentfence-cli --format sarif . > results.sarif
```

Output as structured JSON:

```bash
npx agentfence-cli --format json .
```

Or install globally to use the `agentfence` command directly:

```bash
npm install -g agentfence-cli
agentfence --format text .
```

## Features

- **100% Runner-Local:** Zero source code, workflows, or prompts leave your environment.
- **Deterministic Static Taint Analysis:** Detects prompt-injection sinks (`AF001`), prompt-to-script (`P2S`) execution (`AF002`), excessive write permissions (`AF003`), unpinned agent actions (`AF004`), broad secret exposure (`AF005`), dangerous pull request triggers (`AF006`), and risky MCP server configurations (`AF007`).
- **Catches `env:` Intermediary Bypasses:** Traces untrusted GitHub event fields (`issue.body`, `pull_request.body`, comments) through intermediate `env:` variables into `anthropics/claude-code-action`, `anthropics/claude-code-base-action`, `openai/codex-action`, `google-github-actions/run-gemini-cli`, `actions/ai-inference`, and `gh-aw`.
- **Inline YAML Suppressions:** Suppress reviewed exceptions in place with `# agentfence-ignore: AF001 -- <reason>`.
- **SARIF 2.1.0 Support:** Direct integration with GitHub Code Scanning alerts.
- **Zero Runtime Dependencies:** Packaged as a single standalone executable bundle.

## License

[Apache-2.0](LICENSE) - Copyright (c) 2026 TensorJetAI
