---
name: verify
description: Drive harness CLI changes through a temporary target config and capture state before and after.
---

# Verify github-agent-harness

Use the public CLI surface; do not import internal functions.

For Picker changes:

1. Create a temporary config that points at a real read-only target repository and its Orca repo ID. Do not edit `config/harness.yaml` just for verification.
2. Run `pnpm harness status` and require no active job.
3. Snapshot the relevant GitHub issue fields, `data/harness.sqlite` stat, and normalized `orca worktree list --json` output.
4. Run `pnpm harness doctor --config <temp-config>` and `pnpm harness pick --dry-run --config <temp-config> --repo OWNER/REPO`.
5. Snapshot the same state again and compare it byte-for-byte. Report the CLI winner/skips and whether GitHub, ledger, and worktrees stayed unchanged.
6. Delete temporary files.

Do not use `run-once` against a real repository to probe a negative case: a regression could claim and dispatch the issue being protected.
