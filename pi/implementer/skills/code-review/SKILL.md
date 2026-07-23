---
name: code-review
description: Review the changes since a fixed point along independent Standards and Spec axes using isolated Pi subagents.
metadata:
  upstream: mattpocock/skills
  upstream-path: skills/engineering/code-review/SKILL.md
  upstream-commit: ed37663cc5fbef691ddfecd080dff42f7e7e350d
---

# Code Review

This is a Pi runtime adapter for Matt Pocock's two-axis code-review skill. It
preserves the review model while binding its subagent orchestration, fixed
point, and lifecycle rules to this harness.

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue, PRD, or spec?

Keep the axes independent so one cannot mask the other.

## 1. Pin the fixed point

For a harness-dispatched implementation, use the fixed base SHA from the parent dispatch. Otherwise use the fixed point supplied by the user.

Capture and verify:

```bash
git rev-parse <fixed-point>
git rev-parse HEAD
git diff <fixed-point>...HEAD
git log <fixed-point>..HEAD --oneline
```

The intended implementation commit must exist before review. Stop if the fixed point is invalid or the three-dot diff is empty.

## 2. Identify the spec and standards

Find the spec in this order:

1. The GitHub issue fetched by the parent implementer.
2. Issue references in commit messages.
3. A user-supplied path.
4. A matching file under `docs/`, `specs/`, or `.scratch/`.

For a harness-dispatched implementation, stop if its GitHub issue cannot be
loaded. Outside the harness, skip the Spec reviewer and report
`no spec available` when no spec exists.

Read repository standards such as `AGENTS.md`, `CLAUDE.md`, `CODING_STANDARDS.md`, `CONTRIBUTING.md`, and relevant ADRs.

The Standards axis also checks these Fowler smells as non-blocking judgement calls unless a documented repository rule makes one mandatory:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

Repository rules override this smell baseline. Skip findings already enforced by tooling.

## 3. Run isolated Pi reviewers

When both axes are available, use the `subagent` tool exactly once with two
tasks. Outside the harness, use one Standards task when no spec exists.

```text
subagent({
  agentScope: "user",
  context: "fresh",
  concurrency: 2,
  timeoutMs: 900000,
  artifacts: false,
  tasks: [
    {
      agent: "harness-reviewer",
      task: "<Standards prompt>"
    },
    {
      agent: "harness-reviewer",
      task: "<Spec prompt>"
    }
  ]
})
```

Do not use project agents or a fallback reviewer. If `harness-reviewer` cannot be resolved in user scope, stop and report that the required internal review could not run.

Every child prompt must begin:

> Return the review report only to the parent. Do not call Orca or send worker_done, heartbeat, escalation, or decision-gate messages.

Do not pass the controller handle, terminal handle, `taskId`, `dispatchId`, lifecycle preamble, or lifecycle commands.

The Standards prompt includes the fixed point, HEAD, diff command, commit list, standards paths, and the full smell baseline. Ask for documented violations and smell judgement calls separately, with concrete file/hunk evidence, under 400 words.

The Spec prompt includes the same Git evidence and the spec contents. Ask separately for missing or partial requirements, incorrect implementation, and scope creep, with quoted requirements, under 400 words.

## 4. Aggregate

Present the reports under `## Standards` and `## Spec`, verbatim or lightly cleaned. Do not merge or rerank findings.

Address actionable findings, rerun affected validation, and commit the fixes. Only the parent implementer may send `worker_done` after review, commits, validation, and tracked cleanliness are complete.
