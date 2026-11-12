import test from "node:test";
import assert from "node:assert/strict";
import { BRAVE_PUSH_HINT, PUSH_SERVICE_HINT, explainPushError, isBrave } from "../src/web/push-errors.ts";

const pushServiceError = () => new DOMException("Registration failed - push service error", "AbortError");

test("a push service failure says what to do, with Brave's setting on Brave", () => {
  const onBrave = explainPushError(pushServiceError(), true);
  assert.equal(onBrave.message, BRAVE_PUSH_HINT);
  assert.match(onBrave.message, /brave:\/\/settings\/privacy/);
  assert.equal((onBrave.cause as DOMException).name, "AbortError", "the original error is kept");
  assert.equal(explainPushError(pushServiceError(), false).message, PUSH_SERVICE_HINT);
  assert.equal(explainPushError(new Error("Registration failed - push service error"), false).message, PUSH_SERVICE_HINT);
});

test("other subscription errors pass through unchanged", () => {
  const invalidKey = new DOMException("The provided applicationServerKey is not valid.", "InvalidAccessError");
  assert.equal(explainPushError(invalidKey, true), invalidKey);
  assert.equal(explainPushError("odd", false).message, "odd");
});

test("Brave is recognized only through navigator.brave.isBrave()", async () => {
  assert.equal(await isBrave({ brave: { isBrave: async () => true } }), true);
  assert.equal(await isBrave({ brave: { isBrave: async () => { throw new Error("no"); } } }), false);
  assert.equal(await isBrave({}), false);
  assert.equal(await isBrave(undefined), false);
});
