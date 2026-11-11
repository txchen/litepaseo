import test from "node:test";
import assert from "node:assert/strict";
import { ComposerStore } from "../src/web/composer-store.ts";

function storage() {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

test("drafts and in-flight messages survive reload; acknowledgement retains newer text", () => {
  const disk = storage();
  const first = new ComposerStore(() => disk);
  first.setText("host:a", "first message");
  first.begin("host:a", { messageId: "m1", text: "first message" });
  first.setText("host:a", "next draft");
  const reloaded = new ComposerStore(() => disk);
  assert.equal(reloaded.state("host:a").text, "next draft");
  assert.equal(reloaded.unresolved("host:a")[0].text, "first message");
  assert.equal(reloaded.unresolved("other:a").length, 0);
  reloaded.resolve("host:a", "m1");
  first.refresh();
  assert.equal(first.unresolved("host:a").length, 0);
  assert.equal(reloaded.state("host:a").text, "next draft");
});

test("concurrent tabs retain distinct drafts and restoring preserves replaced text", () => {
  const disk = storage();
  const a = new ComposerStore(() => disk);
  const b = new ComposerStore(() => disk);
  a.setText("h:a", "original");
  assert.equal(b.state("h:a").text, "original");
  a.setText("h:a", "new A");
  b.setText("h:a", "new B");
  assert.deepEqual(new Set(b.saved("h:a").map(d => d.text)), new Set(["new A", "new B"]));
  b.restore("h:a", b.saved("h:a").find(d => d.text === "new A")!.slot);
  assert.equal(b.state("h:a").text, "new A");
  assert.ok(b.saved("h:a").some(d => d.text === "new B"));
  b.clear();
  assert.equal(new ComposerStore(() => disk).saved("h:a").length, 0);
});

test("unavailable or full storage keeps in-memory drafts and exposes a warning", () => {
  const memory = new ComposerStore(() => { throw new Error("blocked"); });
  memory.setText("h:a", "unsaved");
  memory.begin("h:a", { messageId: "m", text: "sent" });
  assert.equal(memory.state("h:a").text, "unsaved");
  assert.equal(memory.unresolved("h:a").length, 1);
  assert.ok(memory.warning.value);
  const disk = storage();
  new ComposerStore(() => disk).setText("h:a", "recover me");
  const full = new ComposerStore(() => ({ ...disk, get length() { return disk.length; }, setItem() { throw new Error("quota"); } }));
  full.setText("h:a", "new edit");
  assert.equal(full.state("h:a").text, "new edit");
  assert.ok(full.warning.value);
  assert.equal(new ComposerStore(() => disk).state("h:a").text, "recover me");
});
