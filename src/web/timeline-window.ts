import { shallowRef } from "vue";
import type { TimelinePage } from "../shared/wire.ts";
import type { RowRef } from "./timeline-store.ts";

export const RENDER_WINDOW = 150;
export const PAGE_STEP = 100;

/** Overlap adjacent pages, without accumulating all visited history in memory. */
export function pageHistory(current: RowRef[], page: TimelinePage, direction: "before" | "after") {
  const before = direction === "before";
  const boundary = before ? current[0]?.seqStart : current.at(-1)?.seqStart;
  const candidates = page.rows.filter(row => boundary === undefined ||
    (before ? row.seqStart < boundary : row.seqStart > boundary));
  // wholeTurns can return more than the requested limit. Keep the nearest rows;
  // the next request uses the displayed boundary, so the remainder is still reachable.
  const added = (before ? candidates.slice(-PAGE_STEP) : candidates.slice(0, PAGE_STEP))
    .map(row => ({ seqStart: row.seqStart, row: shallowRef(row) }));
  const combined = before ? [...added, ...current] : [...current, ...added];
  return {
    rows: before ? combined.slice(0, RENDER_WINDOW) : combined.slice(-RENDER_WINDOW),
    hasOlder: before ? page.hasOlder || candidates.length > PAGE_STEP : true,
    added: added.length,
  };
}
