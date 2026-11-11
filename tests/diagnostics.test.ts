import test from "node:test";
import assert from "node:assert/strict";
import { connectionProblem } from "../src/server/diagnostics.ts";
import { Hosts } from "../src/server/hosts.ts";

test("connection diagnostics classify failures without exposing credentials or remote text", () => {
  for (const [message, code] of [["Password required", "password_required"], ["Incorrect password", "authentication_failed"], ["ECONNREFUSED", "refused"], ["ENOTFOUND", "dns"], ["connection timeout", "timeout"], ["protocol version mismatch", "incompatible"], ["TLS certificate", "tls"], ["socket closed", "disconnected"]]) {
    const result = connectionProblem({ message: message + " https://user:SECRET@host/?token=PRIVATE prompt=CONFIDENTIAL" });
    assert.equal(result.code, code);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|CONFIDENTIAL/);
  }
});

test("host diagnostic state tracks retry and clears errors on reconnect", async () => {
  const hosts = new Hosts();
  const listeners: ((state: any) => void)[] = [];
  let state: any = { status: "idle" };
  const driver = {
    getConnectionState: () => state,
    subscribeConnectionStatus: (listener: any) => { listeners.push(listener); return () => {}; },
    getLastServerInfoMessage: () => null,
    observeAgents: () => ({ subscribe() {}, release: async () => {} }),
    close: async () => {},
  };
  hosts.attach("h", driver as never, { dispose: async () => {} } as never);
  const update = (next: any) => { state = next; for (const listener of listeners) listener(next); };
  update({ status: "disconnected", reason: "Incorrect password SECRET", nextRetryAt: "2026-12-01T00:00:00Z" });
  assert.equal(hosts.diagnostic("h")?.error?.code, "authentication_failed");
  assert.equal(hosts.diagnostic("h")?.nextRetryAt, "2026-12-01T00:00:00.000Z");
  update({ status: "connecting", attempt: 2 });
  assert.equal(hosts.diagnostic("h")?.attempt, 2);
  update({ status: "connected" });
  assert.ok(hosts.diagnostic("h")?.lastConnectedAt);
  assert.equal(hosts.diagnostic("h")?.error, undefined);
  await hosts.close();
});
