import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { effectiveConfig, setConfig } from "../src/server/config.ts";

function withStore(fn: (store: Store) => void) {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-config-"));
  const store = new Store(directory);
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("saved settings apply unless an environment variable overrides them", () => {
  withStore((store) => {
    assert.deepEqual(
      Object.values(effectiveConfig(store, {})).map((e) => [e.key, e.value, e.source]),
      [["port", "8787", "default"], ["bind", "127.0.0.1", "default"], ["push-subject", "mailto:litepaseo@example.com", "default"], ["compression", "on", "default"]],
    );
    setConfig(store, "push-subject", "mailto:me@example.org");
    setConfig(store, "port", "9001");
    assert.equal(effectiveConfig(store, {})["push-subject"].value, "mailto:me@example.org");
    assert.equal(effectiveConfig(store, {}).port.source, "saved");
    const overridden = effectiveConfig(store, { LITEPASEO_PORT: "9100" }).port;
    assert.deepEqual([overridden.value, overridden.source, overridden.saved], ["9100", "environment", "9001"]);
    assert.equal(effectiveConfig(store, { LITEPASEO_PORT: "" }).port.value, "9001", "an empty variable does not override");
    setConfig(store, "port", null);
    assert.equal(effectiveConfig(store, {}).port.source, "default");
  });
});

test("settings are validated before they are saved", () => {
  withStore((store) => {
    for (const port of ["0", "65536", "80a", ""]) assert.throws(() => setConfig(store, "port", port), /1 to 65535/);
    assert.throws(() => setConfig(store, "bind", "0.0.0.0 x"), /IP address or host name/);
    for (const value of ["yes", "true", "", "OFF"]) assert.throws(() => setConfig(store, "compression", value), /on or off/);
    for (const subject of ["me@example.org", "mailto:me", "http://example.org", "https//x"])
      assert.throws(() => setConfig(store, "push-subject", subject), /mailto:/, subject);
    setConfig(store, "push-subject", "https://litepaseo.example.org");
    setConfig(store, "bind", "::1");
    assert.equal(effectiveConfig(store, {}).bind.value, "::1");
  });
});

test("an invalid environment override is refused with the variable named", () => {
  withStore((store) => {
    assert.throws(() => effectiveConfig(store, { LITEPASEO_PORT: "80a" }), /LITEPASEO_PORT="80a" is not valid\. Use a port number from 1 to 65535\./);
    assert.throws(() => effectiveConfig(store, { LITEPASEO_COMPRESSION: "yes" }), /LITEPASEO_COMPRESSION.*on or off/);
    assert.equal(effectiveConfig(store, { LITEPASEO_BIND: "0.0.0.0" }).bind.value, "0.0.0.0");
  });
});
