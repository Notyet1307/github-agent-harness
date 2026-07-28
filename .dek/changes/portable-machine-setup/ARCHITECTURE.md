# Portable machine setup

## Context

The tracked config currently stores machine facts (`/Users/...` paths and Orca repo ids). Pi and `pi-subagents` also live outside the project, so a fresh computer requires manual YAML edits and user-scope package installation. Normal source updates should not repeat machine enrollment.

## Constraints

- Orca remains the only execution layer.
- GitHub credentials, Pi provider credentials, and Orca-managed extensions stay user-scoped.
- A running job keeps its immutable project snapshot; machine rebinding must not rewrite active-job provenance.
- `doctor` stays read-only. Mutations belong to an explicit setup command.
- Harness never clones target repositories, changes labels, or merges PRs.

## Scope challenge

- Existing code: `project add/setup`, Orca identity validation, `HARNESS_ROOT`, project snapshots, and doctor checks already cover most of the flow.
- Minimum viable change: make tracked config portable, resolve local bindings from Orca, add one idempotent setup entrypoint, and install Pi runtime dependencies project-locally.
- Deferred: Homebrew/App installation, credential migration, daemon installation, cloning repositories, and multi-controller coordination.
- Complexity smell: no local overlay or cache. Orca is already the source of truth for local path/id, so query it directly.

## Components

1. **Portable config loader**
   - Tracked repository entries contain `github`, `defaultBranch`, and `baseRef` only.
   - Controller and launcher paths resolve from `HARNESS_ROOT`.
2. **Runtime project resolver**
   - Queries `orca repo list` and matches canonical GitHub identity.
   - Produces the existing runtime `RepoConfig` used by picker, ledger snapshots, worktree creation, audit, and publish.
   - Fails closed on zero/multiple/invalid matches.
3. **Idempotent setup command**
   - `harness setup --repo OWNER/REPO --path /abs/repo [--dry-run]`.
   - Reuses project enrollment checks, registers the harness and target repos, sets the base ref, writes only portable repository intent, and reports the resulting doctor state.
4. **Project-local Pi runtime**
   - Pin Pi and `pi-subagents` in `package.json`.
   - Launchers resolve both from the project `node_modules` tree.
5. **Doctor**
   - Reports resolved project bindings and checks all required Orca-managed Pi extensions, including the titlebar spinner.

## File structure

- `src/types.ts`: split portable repository intent from resolved runtime binding.
- `src/config.ts`: normalize portable entries and project-relative launcher paths.
- `src/project.ts`: runtime identity resolution and idempotent setup/enrollment.
- `src/cli.ts`: setup command.
- `src/doctor.ts`: resolved-binding and complete extension checks.
- `scripts/pi-implementer`, `scripts/pi-auditor`: project-local Pi dependencies.
- `package.json`, `pnpm-lock.yaml`: pinned runtime packages.
- Existing project/profile tests: portability, idempotence, failure paths.

## Data flow

### Fresh machine

1. User clones both repositories and runs `pnpm install`.
2. `harness setup` validates the target Git checkout and GitHub identity.
3. Setup resolves or registers the harness and target in Orca.
4. Setup sets the target base ref and writes portable repository intent.
5. Doctor resolves runtime bindings from Orca and validates Pi/Orca resources.

### Normal command

1. Load portable config.
2. Query Orca repos once.
3. Match every configured GitHub identity and construct runtime repository configs.
4. Run the existing command with those resolved configs.

## Shadow paths

- Missing target checkout: setup fails before mutation.
- Orca unavailable: setup/doctor report an actionable failure.
- Missing GitHub/Pi credentials: doctor fails; setup does not write secrets.
- Duplicate Orca identity: resolver fails closed instead of picking one.
- Active job: its ledger snapshot remains authoritative; setup does not mutate it.

## Failure modes

| Failure | Trigger | User impact | Detection | Recovery | Test |
|---|---|---|---|---|---|
| No Orca binding | Fresh machine before setup | Commands cannot resolve target | Doctor failure | Run setup | Integration fixture |
| Duplicate identity | Two Orca repos claim same GitHub remote | Ambiguous worktree target | Resolver failure | Remove stale Orca registration | Unit/integration |
| Wrong Git remote | `--path` points elsewhere | Unsafe repository selection | Enrollment validation | Correct path/remote | Existing tests |
| Missing managed extension | Orca integration incomplete | Pi launcher fails | Doctor and launcher checks | Start/update Orca integration | Profile tests |
| Active-job runtime moved | Repo moved during a job | Snapshot cannot validate | Existing snapshot validation | Finish/recover on original binding | Existing snapshot tests |

## Observability

- `harness setup --dry-run` lists planned actions.
- `harness doctor` prints portable config load, resolved local path/id, and dependency checks.
- No metrics are needed for local bootstrap.

## Rollout and rollback

- Perform the cutover only with no active job; the current ledger has none.
- Existing tracked machine fields are removed in one clean cutover; users run setup once after pulling.
- Rollback is checkout of the previous revision and restoration of the previous config. Ledger snapshots are unchanged.

## Test matrix

| Scenario | Level | Command/check | Expected result |
|---|---|---|---|
| Fresh HOME/path | Integration | project enrollment test | No tracked absolute paths or Orca ids |
| Setup rerun | Integration | setup twice | Second run is unchanged |
| Missing/duplicate binding | Integration | fake Orca inventory | Fail closed with actionable message |
| Project-local Pi | Integration | profile launcher tests | Uses pinned local binaries/extensions |
| Static checks | Build | `pnpm typecheck` | Pass |
| Full regression | Test | `pnpm test` | Pass |
| Real local smoke | Manual | `pnpm harness doctor && pnpm harness pick --dry-run` | PASS and read-only pick |

## Risks

- Runtime resolution touches every command that currently assumes `config.repositories` is fully bound.
- Pi package layout under pnpm must match launcher path resolution.
- Orca identity payloads may be absent for malformed registrations; resolution must fail closed.
