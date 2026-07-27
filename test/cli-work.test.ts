import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("CLI help exposes the unified work entrypoint", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), "help"],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /harness work \[--config path\] \[--repo OWNER\/REPO\] \[--once\] \[--dry-run\] \[--max-cycles N\]/,
  );
});
