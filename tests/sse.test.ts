import test from "node:test";
import assert from "node:assert/strict";
import { createBrotliDecompress, createGunzip } from "node:zlib";
import { eventStream, streamEncoding } from "../src/server/sse.ts";

/** Reads a stream response chunk by chunk, with the time each chunk arrived. */
function recorder(response: Response) {
  const chunks: { at: number; text: string }[] = [];
  const started = performance.now();
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const done = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      chunks.push({ at: performance.now() - started, text: value });
    }
  })();
  return { chunks, reader, done, text: () => chunks.map((c) => c.text).join("") };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("every burst of stream writes is followed by a tiny comment, so a proxy holding the latest bytes lets them through", async () => {
  const controller = new AbortController();
  let send!: (data: unknown) => void;
  const stream = recorder(eventStream(controller.signal, (s) => ((send = s), () => {})));
  await wait(150);
  // The opening comment is nudged too: the browser can see the stream flowing at once.
  assert.equal(stream.text(), ": open\n\n:\n\n");
  send({ n: 1 });
  send({ n: 2 });
  await wait(150);
  const nudge = stream.chunks.at(-1)!;
  assert.equal(nudge.text, ":\n\n", "the comment comes after the data, as its own write");
  assert.equal(stream.text(), ': open\n\n:\n\ndata: {"n":1}\n\ndata: {"n":2}\n\n:\n\n', "one comment per burst");
  // A later write gets its own.
  send({ n: 3 });
  await wait(150);
  assert.ok(stream.text().endsWith('data: {"n":3}\n\n:\n\n'));
  controller.abort();
  await stream.done;
});

test("a stream that closes before its nudge writes nothing more and releases its source", async () => {
  const controller = new AbortController();
  let send!: (data: unknown) => void, released = 0;
  const stream = recorder(eventStream(controller.signal, (s) => ((send = s), () => void released++)));
  send({ n: 1 });
  controller.abort();
  await stream.done;
  await wait(100);
  assert.equal(released, 1);
  assert.equal(stream.text().includes(":\n\n:"), false);
  assert.doesNotThrow(() => send({ n: 2 }), "a late write is ignored");
});

test("a cancelled stream releases what it opened", async () => {
  const controller = new AbortController();
  let released = 0;
  const response = eventStream(controller.signal, (send) => {
    send({ n: 1 });
    return () => void released++;
  });
  await response.body!.cancel();
  assert.equal(released, 1);
});

test("streamEncoding picks brotli, then gzip, from what the browser accepts", () => {
  assert.equal(streamEncoding("gzip, deflate, br", true), "br");
  assert.equal(streamEncoding("gzip, deflate", true), "gzip");
  assert.equal(streamEncoding("br;q=0, gzip;q=0.5", true), "gzip", "q=0 refuses an encoding");
  assert.equal(streamEncoding("identity", true), null);
  assert.equal(streamEncoding(undefined, true), null);
  assert.equal(streamEncoding("gzip, br", false), null, "compression off");
});

for (const encoding of ["br", "gzip"] as const) {
  test(`a ${encoding} stream flushes every write: each event decompresses as soon as it is sent`, async () => {
    const controller = new AbortController();
    let send!: (data: unknown) => void;
    const response = eventStream(controller.signal, (s) => ((send = s), () => {}), () => true, encoding);
    assert.equal(response.headers.get("content-encoding"), encoding);
    assert.equal(response.headers.get("vary"), "Accept-Encoding");
    const inflate = encoding === "br" ? createBrotliDecompress() : createGunzip();
    let text = "";
    inflate.on("data", (chunk: Buffer) => (text += chunk.toString()));
    const reader = response.body!.getReader();
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        inflate.write(value);
      }
    })();
    const arrives = async (needle: string) => {
      for (let i = 0; i < 40 && !text.includes(needle); i++) await wait(10);
      return text.includes(needle);
    };
    try {
      assert.ok(await arrives(": open\n\n"), "the opening comment is not held back");
      const big = { rows: "x".repeat(200_000) };
      send({ n: 1 });
      assert.ok(await arrives('data: {"n":1}\n\n'), "a small event is not held back");
      send(big);
      assert.ok(await arrives('"}\n\n'), "a large event arrives whole");
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
      inflate.destroy();
    }
  });
}

test("a stream whose request was already aborted opens nothing and ends at once", async () => {
  const controller = new AbortController();
  controller.abort();
  let opened = 0;
  const stream = recorder(eventStream(controller.signal, () => (opened++, () => {})));
  await stream.done;
  assert.equal(opened, 0);
  assert.equal(stream.text(), "");
});

test("a stream whose open() throws releases its heartbeat and compressor and passes the error on", () => {
  const controller = new AbortController();
  const listeners: unknown[] = [];
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: unknown) => (listeners.push(listener), add(type, listener as never))) as never;
  const removed: unknown[] = [];
  const remove = signal.removeEventListener.bind(signal);
  signal.removeEventListener = ((type: string, listener: unknown) => (removed.push(listener), remove(type, listener as never))) as never;
  assert.throws(() => eventStream(signal, () => {
    throw new Error("no host");
  }, () => true, "gzip"), /no host/);
  assert.deepEqual(removed, listeners, "the abort listener is gone with the stream");
});

test("a stream releases its source once, however it stops", async () => {
  const controller = new AbortController();
  let released = 0;
  const response = eventStream(controller.signal, () => () => void released++);
  await response.body!.cancel();
  controller.abort();
  assert.equal(released, 1);
});

test("a client that stops reading is dropped instead of buffering without bound", async () => {
  const controller = new AbortController();
  let send!: (data: unknown) => void, released = 0;
  const response = eventStream(controller.signal, (s) => ((send = s), () => void released++));
  const chunk = "x".repeat(1024 * 1024);
  for (let i = 0; i < 20; i++) send({ chunk });
  assert.equal(released, 1, "the stalled stream let go of its source");
  await assert.rejects(response.body!.getReader().read(), /not reading/);
});
