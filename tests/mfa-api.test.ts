import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";
import { base32Decode, totp } from "../src/server/auth.ts";

test("HTTP login enforces both factors, revokes weaker sessions and denies bearer bypass", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-mfa-"));
  const store = new Store(directory);
  const hosts = new Hosts();
  const app = createApp(store, hosts, "test-token", directory, { pushSender: { async send() {} } });
  const call = (path: string, body?: object, cookie?: string, bearer?: string) => app.request(`/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-litepaseo": "1", "x-forwarded-proto": "https",
      ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0];
  try {
    const owner = cookieOf(await call("/login", { token: "test-token" }));
    const old = cookieOf(await call("/login", { token: "test-token" }));
    const bearerStream = await call("/stream", undefined, undefined, "test-token");
    assert.equal(app.openStreams(), 1);
    const enrollment = await (await call("/totp/setup", {}, owner)).json();
    const key = base32Decode(enrollment.secret);
    const step = Math.floor(Date.now() / 30_000);
    assert.equal((await call("/totp/confirm", { code: totp(key, step) }, owner)).status, 200);
    t.mock.timers.tick(30_000);
    assert.equal(app.openStreams(), 0, "enabling TOTP closes existing token-only streams");
    await bearerStream.body!.cancel();
    assert.equal((await call("/health", undefined, owner)).status, 200);
    assert.equal((await call("/health", undefined, old)).status, 401);
    assert.equal((await call("/health", undefined, undefined, "test-token")).status, 401);
    assert.equal((await call("/totp/setup", {}, owner)).status, 409, "an enrolled factor cannot be overwritten");
    const code = totp(key, step + 1);
    for (const body of [{ code }, { token: "wrong", code }, { token: "test-token" }]) {
      const denied = await call("/login", body);
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get("set-cookie"), null);
    }
    const accepted = await call("/login", { token: "test-token", code });
    assert.equal(accepted.status, 200);
    assert.match(accepted.headers.get("set-cookie")!, /Secure/i);
    assert.equal((await call("/health", undefined, cookieOf(accepted))).status, 200);
    assert.equal((await call("/login", { token: "test-token", code })).status, 401, "a code is single use");
  } finally {
    await hosts.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
