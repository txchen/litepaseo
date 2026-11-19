import { nextTick, onMounted, onUnmounted, type Ref } from "vue";

/**
 * Modal dialog keyboard behaviour, shared by every sheet: focus moves into the dialog when it opens,
 * Tab and Shift+Tab stay inside it, Escape closes it and focus returns to what opened it. Dialogs
 * stack (a confirmation over a task, a script editor over project settings): only the top one
 * answers the keyboard.
 */
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
const stack: object[] = [];

/** True while any modal dialog is open: page shortcuts stay quiet. */
export const dialogOpen = () => stack.length > 0;

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
}

type Target = Ref<HTMLElement | null> | (() => HTMLElement | null | undefined);

export function useDialog(
  root: Target,
  onEscape: () => void,
  options: { initialFocus?: () => HTMLElement | null | undefined } = {},
) {
  const token = {};
  const element = () => (typeof root === "function" ? root() : root.value) ?? null;
  const focused = () => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
  let opener = focused();

  function onKey(event: KeyboardEvent) {
    if (stack.at(-1) !== token || event.defaultPrevented || event.isComposing) return;
    const el = element();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    } else if (event.key === "Tab" && el) {
      const items = focusables(el);
      const active = document.activeElement;
      if (!items.length) {
        event.preventDefault();
        el.focus();
        return;
      }
      const first = items[0], last = items[items.length - 1];
      if (!el.contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  }

  onMounted(() => {
    stack.push(token);
    // Bubble phase: a field that handles Escape itself (and stops it) keeps it.
    document.addEventListener("keydown", onKey);
    opener ??= focused();
    void nextTick(() => {
      const el = element();
      if (!el || el.contains(document.activeElement)) return;
      (options.initialFocus?.() ?? el).focus({ preventScroll: true });
    });
  });
  onUnmounted(() => {
    const at = stack.indexOf(token);
    if (at >= 0) stack.splice(at, 1);
    document.removeEventListener("keydown", onKey);
    // Give focus back unless something else (the next screen, another dialog) has taken it.
    if (opener?.isConnected && !focused()) opener.focus({ preventScroll: true });
  });
}
