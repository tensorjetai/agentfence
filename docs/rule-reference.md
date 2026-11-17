# Rule reference

| Rule  | Severity    | Blocks by default | Condition                                                                                                                                           | Primary remediation                                                  |
| ----- | ----------- | ----------------: | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| AF001 | Critical    |               Yes | Untrusted event/repository data reaches privileged agent prompt                                                                                     | Add trust gate; split read/write jobs                                |
| AF002 | Critical    |               Yes | Recognized agent output reaches shell execution                                                                                                     | Validate strict structured output; map allowlisted commands          |
| AF003 | Critical    |               Yes | Contributor-controlled checkout enters privileged job                                                                                               | Analyze base revision in unprivileged job                            |
| AF004 | High        |                No | Public trigger starts agent without fail-closed `author_association`, `github.actor`, or verified write-actor gate                                  | Add fail-closed trust predicate                                      |
| AF005 | High        |                No | Agent job receives broad write permissions                                                                                                          | Default to `permissions: {}` and grant minimal job scopes            |
| AF006 | Critical    |               Yes | Secret (`secrets.*` or `toJSON(secrets)`) is available where untrusted data influences agent behavior                                               | Move credential use to separate approved stage                       |
| AF007 | Medium/High |                No | MCP/agent config runs unpinned runners (`npx`/`uvx`/`bunx`/`pnpm dlx`/`docker`), cleartext `http://`, embedded credentials, or broad tool approvals | Pin reviewed packages/images, use HTTPS + env vars, narrow approvals |

Every finding includes stable fingerprint, severity, confidence, source, sink, privilege context, trace, source range, completeness, explanation, and remediation. Suggested diffs are emitted only for unambiguous permission reduction.

Suppressions require rule, non-empty reason, optional path, and optional expiry. Expired suppressions warn. Parser failures and partial analysis cannot be suppressed.
