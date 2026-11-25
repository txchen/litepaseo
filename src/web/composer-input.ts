import { nextTick } from "vue";

/** Inserts dictated text at the textarea cursor (or end if unfocused) with natural leading spacing. */
export function insertDictatedText(
  el: HTMLTextAreaElement | null,
  current: string,
  text: string,
  setText: (value: string) => void,
  autosize: () => void,
) {
  const start = el && document.activeElement === el ? el.selectionStart : current.length;
  const end = el && document.activeElement === el ? el.selectionEnd : current.length;
  const before = current.slice(0, start);
  const after = current.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  setText(before + lead + text + after);
  void nextTick(() => {
    if (!el) return;
    el.focus();
    const at = (before + lead + text).length;
    el.setSelectionRange(at, at);
    autosize();
  });
}

/** Whether a keyboard Enter event should submit the composer given the pointer type and shortcut preference. */
export function shouldSubmitOnEnter(event: KeyboardEvent, coarsePointer: boolean, sendShortcut: string) {
  if (event.key !== "Enter" || event.isComposing) return false;
  const mod = event.metaKey || event.ctrlKey;
  const enterSends = !coarsePointer && sendShortcut === "enter" && !event.shiftKey;
  return enterSends || mod;
}
