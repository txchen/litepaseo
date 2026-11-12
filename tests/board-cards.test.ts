import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";

test("task edits and comments apply per card, without overwriting other edits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-board-"));
  const store = new Store(directory);
  const app = createApp(store, new Hosts(), "test-token", directory);
  const request = (path: string, method = "GET", body?: unknown) =>
    app.request("/api" + path, {
      method,
      headers: { authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const id = randomUUID(), other = randomUUID();
    // Cards from before 0.4.1 have no description or comments; they still load and save.
    const cards = [
      { id, title: "Task", column: "Todo", hostId: null, agentId: null },
      { id: other, title: "Other", column: "Todo", hostId: null, agentId: null },
    ];
    assert.equal((await request("/board", "PUT", { revision: 0, cards })).status, 200);

    // Two tabs at the same (old) revision: their per-card edits both land.
    let board = await (await request(`/board/cards/${id}`, "PATCH", { description: "Some **notes**" })).json();
    board = await (await request(`/board/cards/${other}`, "PATCH", { title: "  Renamed  ", column: "Doing" })).json();
    const byId = (b: any, key: string) => b.cards.find((c: any) => c.id === key);
    assert.equal(byId(board, id).description, "Some **notes**");
    assert.deepEqual([byId(board, other).title, byId(board, other).column], ["Renamed", "Doing"]);
    assert.ok(byId(board, other).updatedAt > 0);
    assert.equal(board.revision, 3);

    board = await (await request(`/board/cards/${id}`, "PATCH", { link: { hostId: "h", agentId: "a" } })).json();
    assert.deepEqual([byId(board, id).hostId, byId(board, id).agentId], ["h", "a"]);
    board = await (await request(`/board/cards/${id}`, "PATCH", { link: null })).json();
    assert.deepEqual([byId(board, id).hostId, byId(board, id).agentId], [null, null]);

    const added = await request(`/board/cards/${id}/comments`, "POST", { text: "  first  " });
    assert.equal(added.status, 201);
    board = await (await request(`/board/cards/${id}/comments`, "POST", { text: "second" })).json();
    const comments = byId(board, id).comments;
    assert.deepEqual(comments.map((m: any) => m.text), ["first", "second"]);
    board = await (await request(`/board/cards/${id}/comments/${comments[0].id}`, "DELETE")).json();
    assert.deepEqual(byId(board, id).comments.map((m: any) => m.text), ["second"]);

    // A whole-board save keeps descriptions and comments (the client sends them back).
    const current = await (await request("/board")).json();
    assert.equal((await request("/board", "PUT", current)).status, 200);
    assert.equal(byId(store.board(), id).description, "Some **notes**");

    assert.equal((await request(`/board/cards/${id}/comments`, "POST", { text: "   " })).status, 400);
    assert.equal((await request(`/board/cards/${id}`, "PATCH", { title: "" })).status, 400);
    assert.equal((await request(`/board/cards/${id}`, "PATCH", { column: "Later" })).status, 400);
    assert.equal((await request(`/board/cards/${id}`, "PATCH", { description: "x".repeat(20_001) })).status, 400);
    assert.equal((await request(`/board/cards/${randomUUID()}`, "PATCH", { title: "x" })).status, 404);
    assert.equal((await request(`/board/cards/${randomUUID()}/comments`, "POST", { text: "x" })).status, 404);
    // Cookie writes still need the CSRF header; a bearer request is not a cookie session.
    assert.equal((await app.request(`/api/board/cards/${id}`, { method: "PATCH", body: "{}" })).status, 401);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
