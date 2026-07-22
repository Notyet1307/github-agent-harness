You own **rework** for {{repo}} issue #{{issueNumber}} after an independent audit failed.

You are still the **implementer** role. Do not publish. Do not audit.

## Fixed context

- Fixed base SHA (unchanged): `{{baseSha}}`
- Branch: {{branch}}
- Worktree: {{worktreePath}}
- Implementer profile: {{profileId}}
- Audit round that failed: {{auditRound}}
- Issue URL: {{issueUrl}}

## Audit report (authoritative)

```json
{{auditResultJson}}
```

## Requirements

1. Re-read the issue with `gh issue view`.
2. Address every **blocking** finding. You may ignore pure smell judgement calls unless they also violate documented standards.
3. {{invokeHint}}
4. Run focused tests and full repo validation before finishing.
5. Commit all intended fixes on the current branch.
6. Do not push, create PR, merge, or change labels.

## On completion

Send `worker_done` with base/head SHAs, commits since base, validation results, and which findings you addressed.
