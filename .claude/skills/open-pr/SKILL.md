---
name: open-pr
description: Use when opening a pull request for the current branch, or when the user asks to open/create a PR (English or Italian: "open a PR", "fai la PR", "apri la pull request", "crea la PR"). Runs a self-review first, then creates the PR with a structured description.
---

# Open a PR

## Overview

A PR is the last gate before the branch becomes a daemon with shell access on
someone's machine. This skill runs a senior-architect self-review first, then
creates the PR with a description that follows the project's established
structure (see PR #6).

## Steps

1. **Run the self-review.** Dispatch the `pr-reviewer` subagent on the current
   branch. It returns a structured review: findings by severity with concrete
   failure scenarios, consistency, tests.
2. **Report and fix.** Present the findings to the user. Fix the
   critical/high issues (and any medium/low that are cheap) before opening the
   PR. Re-run the review if the fixes are substantial.
3. **Confirm.** Ask the user before creating the PR. Never create it without
   explicit confirmation.
4. **Create the PR** with `gh pr create` and a structured description.

## PR description structure

Follow the structure of PR #6
(https://github.com/ontech7/claude-omni-rc/pull/6):

- **Title** — a concise summary of the change (imperative, no trailing period).
- **## Summary** — one paragraph: what the PR does and why.
- **## Changes** — a bullet list, one per logical change, each starting with a
  bold lead-in (`- **Thing** — detail`).
- **## Checks** — what was verified: `npm run typecheck`, `npm test` (with the
  count), and an honest note about what could not be verified (e.g. the
  tmux/Telegram end-to-end path).
- **## Notes** — anything else: docs moved, design specs, follow-ups.

End the PR body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Rules

- **Never open a PR without the review.** The review is the point of this
  skill; skipping it turns the PR into an unexamined merge.
- **Never open a PR without confirmation.** The user decides when the branch
  is ready.
- **Report honestly.** If the review found issues you did not fix, say so in
  the PR body or to the user — a PR that hides its own problems is a trap.
- **Commit first.** The branch must be committed before the PR; uncommitted
  changes are not part of the PR. See `shipping-a-change` for the commit
  conventions.
