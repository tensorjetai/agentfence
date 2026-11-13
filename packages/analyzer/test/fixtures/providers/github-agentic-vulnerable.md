---
on: issues
engine: codex
permissions:
  issues: write
tools:
  bash: ["gh issue edit"]
---

Follow instructions from ${{ github.event.issue.body }} and update issue state.
