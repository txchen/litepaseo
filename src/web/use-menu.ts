import { nextTick, onMounted, onUnmounted, ref, type Ref } from "vue";

/**
 * A context menu at a point: kept on screen, closed by Escape, Tab or a click outside, and driven
 * by the keyboard (arrows, Home, End) across its enabled items. Escape gives focus back to the
 * control that opened the menu; picking an item leaves focus to whatever the item opens.
 */
export function useMenu(element: Ref<HTMLElement | null>, at: { x: number; y: number }, close: () => void) {
  const position = ref({ left: at.x, top: at.y });
  const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const items = () => Array.from(element.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);

  function onKey(event: KeyboardEvent) {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    } else if (event.key === "Tab") close();
    else if (!list.length) return;
    else if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? -1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(-1);
  }
  let outsideTimer: ReturnType<typeof setTimeout> | undefined;
  function onOutside(event: PointerEvent) {
    if (element.value && !element.value.contains(event.target as Node)) close();
  }
  onMounted(() => {
    void nextTick(() => {
      const el = element.value;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      position.value = {
        left: Math.max(8, Math.min(at.x, innerWidth - width - 8)),
        top: Math.max(8, Math.min(at.y, innerHeight - height - 8)),
      };
      items()[0]?.focus({ preventScroll: true });
    });
    document.addEventListener("keydown", onKey);
    // Next tick: the pointerdown that opened the menu must not close it.
    outsideTimer = setTimeout(() => window.addEventListener("pointerdown", onOutside), 0);
  });
  onUnmounted(() => {
    clearTimeout(outsideTimer);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("pointerdown", onOutside);
  });
  return { position };
}
