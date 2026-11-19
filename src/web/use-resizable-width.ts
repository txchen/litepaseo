import { ref, type Ref } from "vue";
import { safeGetItem, safeSetItem } from "./safe-storage.ts";

/**
 * A pane width the reader drags (sidebar, side panel), clamped and kept per browser.
 * `direction` is 1 when dragging right widens the pane, -1 when dragging left does.
 * `perFrame` applies pointer moves once per animation frame. `resizing` is shared by the panes.
 */
export function useResizableWidth(
  storageKey: string,
  { min, max, initial, direction, perFrame = false }: { min: number; max: number; initial: number; direction: 1 | -1; perFrame?: boolean },
  resizing: Ref<boolean>,
) {
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));
  const width = ref(clamp(Number(safeGetItem(storageKey)) || initial));
  function setWidth(w: number) {
    width.value = clamp(w);
    safeSetItem(storageKey, String(width.value));
  }
  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX,
      startW = width.value;
    handle.setPointerCapture(event.pointerId);
    resizing.value = true;
    let frame = 0;
    const apply = (e: PointerEvent) => (width.value = clamp(startW + direction * (e.clientX - startX)));
    const move = (e: PointerEvent) => {
      if (!perFrame) return void apply(e);
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => apply(e));
    };
    const end = () => {
      if (perFrame) cancelAnimationFrame(frame);
      resizing.value = false;
      setWidth(width.value);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  return { width, setWidth, startResize, min, max, initial };
}
