import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPushFailure,
  isRetryablePushFailure,
  parsePushFailure,
  recordPushFailure,
} from "../src/push-failure.js";

test("classifies only explicit transport failures as transient", () => {
  for (const error of [
    "fatal: unable to access repo: Could not resolve host: github.com",
    "ssh: Could not resolve hostname github.com: nodename nor servname provided",
    "ssh: connect to host github.com port 22: Connection timed out",
    "RPC failed; curl 56 Recv failure: Connection reset by peer",
    "The requested URL returned error: 502",
    "RPC failed; HTTP 503 curl 22 The requested URL returned error: 503",
  ]) {
    assert.equal(classifyPushFailure(error), "transient", error);
  }
});

test("classifies authorization, rejection, and unknown failures as permanent", () => {
  for (const error of [
    "remote: Permission to owner/repo.git denied to bot.",
    "fatal: Authentication failed for 'https://github.com/owner/repo.git/'",
    "! [rejected] HEAD -> main (non-fast-forward)",
    "remote: Repository not found.",
    "an unrecognized git failure",
  ]) {
    assert.equal(classifyPushFailure(error), "permanent", error);
  }
});

test("bounds transient push failures at three attempts", () => {
  const first = recordPushFailure("Could not resolve host: github.com", null);
  assert.equal(first.retryable, true);
  assert.equal(first.attempt, 1);

  const second = recordPushFailure("Connection timed out", first.error);
  assert.equal(second.retryable, true);
  assert.equal(second.attempt, 2);

  const third = recordPushFailure("Connection reset by peer", second.error);
  assert.equal(third.retryable, false);
  assert.equal(third.attempt, 3);
  assert.equal(isRetryablePushFailure(third.error), false);
});

test("legacy push failures are classified before recovery", () => {
  assert.equal(
    isRetryablePushFailure(
      "git push failed: fatal: unable to access repo: Could not resolve host: github.com",
    ),
    true,
  );
  assert.equal(
    isRetryablePushFailure(
      "git push failed: remote: Permission to owner/repo.git denied to bot.",
    ),
    false,
  );
  assert.equal(parsePushFailure("some other failure"), null);
});
