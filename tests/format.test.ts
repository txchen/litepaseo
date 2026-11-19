import test from "node:test";
import assert from "node:assert/strict";
import { tildeHome } from "../src/web/format.ts";

test("tildeHome shortens Linux and macOS home directories only", () => {
  assert.equal(tildeHome("/home/me/code/app"), "~/code/app");
  assert.equal(tildeHome("/Users/me"), "~");
  assert.equal(tildeHome("/home/me-else/x"), "~/x");
  assert.equal(tildeHome("/homework/me/x"), "/homework/me/x");
  assert.equal(tildeHome("/srv/home/me"), "/srv/home/me");
  assert.equal(tildeHome("/root/app"), "/root/app");
});
