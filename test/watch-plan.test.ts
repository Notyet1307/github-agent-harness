import test from "node:test";
import assert from "node:assert/strict";
import { planWatchCycle } from "../src/watch.js";

test("none → claim_and_implement", () => {
  const p = planWatchCycle({ kind: "none", reason: "idle" });
  assert.equal(p.step, "claim_and_implement");
});

test("blocked → blocked_wait (do not claim next)", () => {
  const p = planWatchCycle({ kind: "blocked", reason: "stuck" });
  assert.equal(p.step, "blocked_wait");
});

test("run_once/audit/publish/wait_merge → resume", () => {
  for (const kind of [
    "run_once",
    "audit_once",
    "publish_once",
    "wait_merge",
  ] as const) {
    const p = planWatchCycle({ kind, reason: "x" });
    assert.equal(p.step, "resume", kind);
  }
});

test("noop → noop_sleep", () => {
  const p = planWatchCycle({ kind: "noop", reason: "merged" });
  assert.equal(p.step, "noop_sleep");
});
