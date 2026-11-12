import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, generateToken, tokenFile, tokenProblem, writeTokenFile } from "../src/server/auth.ts";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";

const STRONG = "correct-horse-battery-staple";

test("a chosen token must be long, printable and varied", () => {
  assert.equal(tokenProblem(generateToken()), null);
  assert.equal(tokenProblem(STRONG), null);
  assert.match(tokenProblem("short-token")!, /at least 16/);
  assert.match(tokenProblem("x".repeat(201))!, /at most 200/);
  assert.match(tokenProblem("has a space in it ok")!, /no spaces/);
  assert.match(tokenProblem("密码密码密码密码密码密码密码密码")!, /no spaces or other/);
  assert.match(tokenProblem("abababababababababab")!, /different characters/);
});

test("the token file is re-read when it changes, and a missing file admits nobody", () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-token-"));
  try {
    const path = join(directory, "token");
    writeTokenFile(path, STRONG);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const current = tokenFile(path);
    assert.equal(current(), STRONG);
    writeTokenFile(path, "another-token-value-1");
    assert.equal(current(), "another-token-value-1");
    rmSync(path);
    assert.equal(current(), "");
    const store = new Store(directory);
    try {
      const auth = new Auth(store, current);
      assert.equal(auth.checkToken(""), false, "an empty token never matches");
      assert.equal(auth.checkToken(STRONG), false);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bearer tokens share the sign-in failure budget", () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-bearer-"));
  const store = new Store(directory);
  try {
    const auth = new Auth(store, STRONG);
    const now = 1_000_000;
    for (let i = 0; i < 10; i++) assert.deepEqual(auth.bearer("guess-" + i, "direct", now), { ok: false, status: 401 });
    const locked = auth.bearer(STRONG, "direct", now);
    assert.equal(locked.ok, false);
    assert.equal(!locked.ok && locked.status, 429, "even the right token waits once the budget is spent");
    const login = auth.login({ token: STRONG }, "direct", "Browser", now);
    assert.equal(!login.ok && login.status, 429, "and so does browser sign-in from the same client");
    assert.deepEqual(auth.bearer(STRONG, "direct", now + 15 * 60_000 + 1), { ok: true });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP: bearer is rate limited, refused through a proxy, and follows token rotation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-bearer-http-"));
  const path = join(directory, "token");
  writeFileSync(path, STRONG);
  const store = new Store(directory);
  const hosts = new Hosts();
  const app = createApp(store, hosts, tokenFile(path), directory);
  const call = (token: string, headers: Record<string, string> = {}) =>
    app.request("/api/board", { headers: { authorization: `Bearer ${token}`, ...headers } });
  try {
    assert.equal((await call(STRONG)).status, 200);
    assert.equal((await app.request("/api/board", { headers: { authorization: STRONG } })).status, 401, "only the Bearer scheme");

    // Through Cloudflare or another proxy, a bearer token is not even checked.
    for (const header of ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "forwarded"])
      assert.equal((await call(STRONG, { [header]: "203.0.113.9" })).status, 401, header);

    // Sign-in reads the same file.
    const login = await app.request("/api/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: STRONG }),
    });
    assert.equal(login.status, 200);
    writeTokenFile(path, "rotated-token-value-2");
    assert.equal((await call(STRONG)).status, 401, "the old token stops working without a restart");
    assert.equal((await call("rotated-token-value-2")).status, 200);

    // The stale token above was one failure; proxied attempts were never checked.
    for (let i = 0; i < 9; i++) assert.equal((await call("guess-" + i)).status, 401);
    const limited = await call("rotated-token-value-2");
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  } finally {
    app.dispose();
    await hosts.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
