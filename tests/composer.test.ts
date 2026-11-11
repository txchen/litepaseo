import test from "node:test";
import assert from "node:assert/strict";
import { ComposerStore } from "../src/web/composer-store.ts";

function storage() {
  const data = new Map<string, string>();
  return {
    data,
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

/** Tabs sharing one localStorage: like a browser, a write fires storage events in the other tabs. */
function tabs(disk = storage()) {
  const stores: ComposerStore[] = [];
  const view = (self: () => ComposerStore) => ({
    get length() { return disk.length; },
    key: disk.key,
    getItem: disk.getItem,
    setItem: (key: string, value: string) => { disk.setItem(key, value); for (const s of stores) if (s !== self()) s.onStorage(key, value); },
    removeItem: (key: string) => { disk.removeItem(key); for (const s of stores) if (s !== self()) s.onStorage(key, null); },
  });
  return {
    disk,
    open() { let store!: ComposerStore; store = new ComposerStore(() => view(() => store)); stores.push(store); return store; },
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
  first.refresh(); // no storage events in this double: an explicit re-read
  assert.equal(first.unresolved("host:a").length, 0);
  assert.equal(reloaded.state("host:a").text, "next draft");
});

test("concurrent tabs retain distinct drafts and restoring preserves replaced text", () => {
  const browser = tabs(), disk = browser.disk;
  const a = browser.open();
  const b = browser.open();
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

test("automatic confirmation clears only the draft restored from that failed send", () => {
  const disk = storage(), original = new ComposerStore(() => disk);
  const message = { messageId: "sent", text: "old text" };
  original.begin("h:a", message); original.restoreFailed("h:a", message);
  const reloaded = new ComposerStore(() => disk);
  reloaded.confirm("h:a", "sent");
  assert.equal(reloaded.state("h:a").text, "");
  original.setText("h:b", "new text");
  original.begin("h:b", message); original.restoreFailed("h:b", message);
  original.confirm("h:b", "sent");
  assert.equal(original.state("h:b").text, "new text");
});

test("old drafts expire and each conversation keeps a bounded number of recovery choices", () => {
  const disk = storage(), now = Date.now();
  const put = (owner: string, key: string, text: string, updated: number) =>
    disk.setItem(`litepaseo-composer-v1:draft:${owner}:${encodeURIComponent(key)}`, JSON.stringify({ key, text, updated }));
  put("old", "h:a", "stale", now - 31 * 24 * 3600_000);
  for (let i = 0; i < 12; i++) put("t" + i, "h:b", "draft " + i, now - i * 1000);
  disk.setItem("litepaseo-composer-v1:message:m", JSON.stringify({ key: "h:a", messageId: "m", text: "kept" }));
  const store = new ComposerStore(() => disk, now);
  assert.equal(store.saved("h:a").length, 0);
  assert.equal(disk.getItem("litepaseo-composer-v1:draft:old:h%3Aa"), null);
  assert.deepEqual(store.saved("h:b").map(d => d.text), Array.from({ length: 8 }, (_, i) => "draft " + i));
  assert.equal(store.unresolved("h:a")[0].text, "kept", "unconfirmed messages never expire");
});

test("storage events update other tabs incrementally; unrelated keys cost nothing", () => {
  const browser = tabs();
  const a = browser.open(), b = browser.open();
  a.setText("h:x", "from A");
  assert.deepEqual(b.saved("h:x").map(d => d.text), ["from A"]);
  a.begin("h:x", { messageId: "q", text: "sent" });
  assert.equal(b.unresolved("h:x").length, 1);
  a.resolve("h:x", "q");
  assert.equal(b.unresolved("h:x").length, 0);
  // Typing never rescans storage: reads stay constant with many unrelated drafts.
  const disk = browser.disk;
  for (let i = 0; i < 500; i++) disk.setItem(`litepaseo-composer-v1:draft:o${i}:h%3Ao${i}`, JSON.stringify({ key: "h:o" + i, text: "x", updated: Date.now() }));
  const store = new ComposerStore(() => disk);
  let keys = 0;
  const key = disk.key;
  disk.key = (i: number) => { keys++; return key(i); };
  for (let i = 0; i < 50; i++) { store.setText("h:x", "t" + i); store.saved("h:x"); store.unresolved("h:x"); store.onStorage("litepaseo-theme", "dark"); }
  assert.equal(keys, 0);
});
