import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, base32Decode, base32Encode, matchTotp, totp, SESSION_TTL_MS } from "../src/server/auth.ts";
import { Store } from "../src/server/store.ts";

function withStore(fn: (store: Store) => void) {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-auth-"));
  const store = new Store(directory);
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("TOTP matches the RFC 6238 SHA-1 test vectors (last six digits)", () => {
  const secret = Buffer.from("12345678901234567890");
  for (const [seconds, code] of [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ] as const)
    assert.equal(totp(secret, Math.floor(seconds / 30)), code, `t=${seconds}`);
  assert.equal(base32Decode(base32Encode(secret)).toString(), "12345678901234567890");
  assert.equal(base32Encode(secret), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(matchTotp(secret, "287082", 59_000), 1);
  assert.equal(matchTotp(secret, "287082", 59_000 + 95_000), null, "codes expire after one step of drift");
  assert.equal(matchTotp(secret, "28708", 59_000), null);
});

test("token login issues a revocable, sliding session; failures are rate limited", () => {
  withStore((store) => {
    const auth = new Auth(store, "secret-token");
    let now = 1_000_000;
    const ok = auth.login({ token: "secret-token" }, "1.2.3.4", "iOS · Safari", now);
    assert.ok(ok.ok);
    const session = auth.verify(ok.secret, now)!;
    assert.equal(session.label, "iOS · Safari");
    assert.equal(store.sessions().length, 1);
    assert.notEqual(store.sessions()[0].secretHash, ok.secret, "only a hash of the secret is stored");
    // Sliding expiry: use within the window extends it.
    now += SESSION_TTL_MS - 1000;
    assert.ok(auth.verify(ok.secret, now));
    now += SESSION_TTL_MS - 1000;
    assert.ok(auth.verify(ok.secret, now), "an active session keeps itself alive");
    auth.revoke(session.id);
    assert.equal(auth.verify(ok.secret, now), null);
    assert.equal(auth.stillValid(session.id, now), false);

    for (let i = 0; i < 10; i++) assert.deepEqual(auth.login({ token: "nope" }, "9.9.9.9", "x", now), { ok: false, status: 401 });
    const limited = auth.login({ token: "secret-token" }, "9.9.9.9", "x", now);
    assert.ok(!limited.ok && limited.status === 429 && limited.retryAfter! > 0, "a client guessing tokens waits");
    assert.ok(auth.login({ token: "secret-token" }, "5.5.5.5", "x", now).ok, "other clients are unaffected");
    assert.ok(auth.login({ token: "secret-token" }, "9.9.9.9", "x", now + 16 * 60_000).ok, "the lockout expires");
  });
});

test("authenticator enrollment, single-use codes and disabling", () => {
  withStore((store) => {
    const auth = new Auth(store, "t");
    const t0 = 1_700_000_000_000;
    const owner = auth.login({ token: "t" }, "a", "x", t0);
    assert.ok(owner.ok);
    const { secret, uri } = auth.beginTotp(owner.session.id, t0);
    assert.match(uri, /^otpauth:\/\/totp\/LitePaseo\?secret=[A-Z2-7]+&issuer=LitePaseo/);
    const key = base32Decode(secret);
    const step = Math.floor(t0 / 30_000);
    assert.equal(auth.confirmTotp("someone-else", totp(key, step), t0), false, "only the session that began setup confirms");
    assert.equal(auth.confirmTotp(owner.session.id, "000000", t0), false);
    assert.equal(auth.confirmTotp(owner.session.id, totp(key, step), t0), true);
    assert.ok(auth.totpEnabled());

    assert.equal(auth.login({ code: totp(key, step) }, "b", "x", t0).ok, false, "the enrollment code cannot be replayed");
    const t1 = t0 + 30_000;
    assert.ok(auth.login({ code: totp(key, step + 1) }, "b", "x", t1).ok);
    assert.equal(auth.login({ code: totp(key, step + 1) }, "c", "x", t1).ok, false, "each code signs in once");
    assert.equal(auth.disableTotp(totp(key, step + 1), t1), false);
    assert.ok(auth.disableTotp(totp(key, step + 2), t1 + 30_000));
    assert.equal(auth.totpEnabled(), false);
  });
});

test("code guessing hits a doubling global lockout that never blocks the token", () => {
  withStore((store) => {
    const auth = new Auth(store, "t");
    let now = 1_700_000_000_000;
    const owner = auth.login({ token: "t" }, "owner", "x", now);
    assert.ok(owner.ok);
    const key = base32Decode(auth.beginTotp(owner.session.id, now).secret);
    assert.ok(auth.confirmTotp(owner.session.id, totp(key, Math.floor(now / 30_000)), now));
    const lockFor = () => {
      // 20 wrong codes from rotating addresses exhaust the global budget.
      for (let i = 0; i < 20; i++) auth.login({ code: "000000" }, "attacker-" + i, "x", now);
      const blocked = auth.login({ code: "000000" }, "fresh", "x", now);
      assert.ok(!blocked.ok && blocked.status === 429);
      return blocked.retryAfter!;
    };
    const first = lockFor();
    assert.ok(Math.abs(first - 15 * 60) <= 1, "first lock: 15 minutes");
    assert.ok(auth.login({ token: "t" }, "owner", "x", now).ok, "the owner still signs in with the token");
    now += first * 1000 + 1;
    const second = lockFor();
    assert.ok(Math.abs(second - 30 * 60) <= 1, "second lock doubles");
    now += second * 1000 + 1;
    for (let i = 0; i < 8; i++) {
      const next = lockFor();
      now += next * 1000 + 1;
      assert.ok(next <= 24 * 3600);
    }
    assert.equal(lockFor(), 24 * 3600, "capped at a day");
  });
});
