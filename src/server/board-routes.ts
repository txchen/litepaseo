import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.ts";
import type { App, RouteContext } from "./route-context.ts";

export const CARD_DESCRIPTION_MAX = 20_000, CARD_COMMENT_MAX = 5_000, CARD_COMMENTS_MAX = 200;
const cardComment = z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(CARD_COMMENT_MAX), at: z.number().int().nonnegative() });
const card = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(300),
    column: z.enum(["Todo", "Doing", "Done"]),
    hostId: z.string().nullable(),
    agentId: z.string().nullable(),
    description: z.string().max(CARD_DESCRIPTION_MAX).optional(),
    comments: z.array(cardComment).max(CARD_COMMENTS_MAX).optional(),
    createdAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative().optional(),
  })
  .refine((c) => (c.hostId === null) === (c.agentId === null));
/** One card's editable fields; omitted fields are left as they are. */
const cardPatch = z
  .object({
    title: z.string().trim().min(1).max(300),
    column: z.enum(["Todo", "Doing", "Done"]),
    description: z.string().max(CARD_DESCRIPTION_MAX),
    link: z.object({ hostId: z.string(), agentId: z.string() }).nullable(),
  })
  .partial();

/** The task board: whole-board saves at a revision, and per-card edits that merge. */
export function registerBoardRoutes(app: App, { store }: RouteContext) {
  app.get("/api/board", (c) => c.json(store.board()));
  app.put("/api/board", async (c) => {
    const b = z
      .object({ revision: z.number().int().nonnegative(), cards: z.array(card).max(1000) })
      .parse(await c.req.json());
    if (new Set(b.cards.map((c) => c.id)).size !== b.cards.length)
      return c.json({ error: "Duplicate card ID" }, 400);
    if (!store.saveBoard(b.revision, b.cards))
      return c.json({ error: "Board changed. Reload before editing." }, 409);
    return c.json(store.board());
  });
  // Per-card edits apply to the board as it is now, so two tabs editing different fields
  // (or adding comments) never overwrite each other. Each returns the whole board.
  const cardEdit = (id: string, change: Parameters<Store["updateCard"]>[1]) =>
    store.updateCard(id, change) ? store.board() : null;
  app.patch("/api/board/cards/:id", async (c) => {
    const p = cardPatch.parse(await c.req.json());
    const board = cardEdit(c.req.param("id"), (card) => ({
      ...card,
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.column !== undefined ? { column: p.column } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.link !== undefined ? { hostId: p.link?.hostId ?? null, agentId: p.link?.agentId ?? null } : {}),
      updatedAt: Date.now(),
    }));
    return board ? c.json(board) : c.json({ error: "Task not found" }, 404);
  });
  app.post("/api/board/cards/:id/comments", async (c) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(CARD_COMMENT_MAX) }).parse(await c.req.json());
    let full = false;
    const board = cardEdit(c.req.param("id"), (card) => {
      const comments = card.comments ?? [];
      if (comments.length >= CARD_COMMENTS_MAX) return (full = true), null;
      return { ...card, comments: [...comments, { id: randomUUID(), text, at: Date.now() }], updatedAt: Date.now() };
    });
    if (full) return c.json({ error: `A task holds up to ${CARD_COMMENTS_MAX} comments.` }, 400);
    return board ? c.json(board, 201) : c.json({ error: "Task not found" }, 404);
  });
  app.delete("/api/board/cards/:id/comments/:comment", (c) => {
    const board = cardEdit(c.req.param("id"), (card) => ({
      ...card,
      comments: (card.comments ?? []).filter((m) => m.id !== c.req.param("comment")),
      updatedAt: Date.now(),
    }));
    return board ? c.json(board) : c.json({ error: "Task not found" }, 404);
  });
}
