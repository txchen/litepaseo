import test from "node:test";
import assert from "node:assert/strict";
import { AttachmentStore } from "../src/web/attachment-store.ts";
import { safeGetItem, safeRemoveItem, safeSetItem } from "../src/web/safe-storage.ts";

type Pending = { resolve: (r: Response) => void; reject: (e: unknown) => void; url: string };

function stubFetch() {
  const calls: Pending[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    if (init?.method === "DELETE") return resolve(new Response("{}"));
    calls.push({ resolve, reject, url });
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const caps = { images: true, files: true, maxBytes: 8 * 1024 * 1024 };

test("an aborted upload cannot clobber the retry that replaced it", async () => {
  const fetches = stubFetch();
  try {
    const store = new AttachmentStore();
    await store.add("k", "/api/x", [new File(["hello"], "a.txt", { type: "text/plain" })], caps);
    const entry = store.get("k")[0]!;
    assert.equal(fetches.calls.length, 1);
    store.forgetRemote("Sign in again, then retry the upload.");
    void store.upload(entry); // the retry starts before the first attempt has settled
    assert.equal(fetches.calls.length, 2);
    await settle();
    assert.equal(entry.uploading, true, "the aborted attempt leaves the retry's state alone");
    assert.equal(entry.error, "");
    fetches.calls[1]!.resolve(Response.json({ id: "b" }));
    await settle();
    assert.equal(entry.id, "b");
    assert.equal(entry.uploading, false);
  } finally { fetches.restore(); }
});

test("an upload rejected by a proxy with an HTML page reports the status", async () => {
  const fetches = stubFetch();
  try {
    const store = new AttachmentStore();
    await store.add("k", "/api/x", [new File(["hello"], "a.txt", { type: "text/plain" })], caps);
    const entry = store.get("k")[0]!;
    fetches.calls[0]!.resolve(new Response("<html>Bad Gateway</html>", { status: 502 }));
    await settle(); await settle();
    assert.equal(entry.error, "Upload failed (502)");
    assert.equal(entry.uploading, false);
  } finally { fetches.restore(); }
});

test("safe storage reads as empty and ignores writes where localStorage is unavailable", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
  try {
    assert.equal(safeGetItem("x"), null);
    assert.equal(safeSetItem("x", "1"), false);
    safeRemoveItem("x");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  const values = new Map<string, string>();
  const full = { getItem: (k: string) => values.get(k) ?? null, setItem: () => { throw new DOMException("full", "QuotaExceededError"); }, removeItem: (k: string) => values.delete(k) };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: full });
  try {
    values.set("y", "kept");
    assert.equal(safeGetItem("y"), "kept");
    assert.equal(safeSetItem("y", "2"), false, "a full quota is reported, not thrown");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
