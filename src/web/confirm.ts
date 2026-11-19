import { shallowRef } from "vue";

/** A themed, keyboard-friendly replacement for window.confirm(), shown by ConfirmDialog in App. */
export type ConfirmOptions = {
  title: string;
  message?: string;
  /** The confirming button's label, a verb: "Archive", "Delete". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: the button is red and Cancel has the initial focus. */
  danger?: boolean;
};
export type ConfirmRequest = ConfirmOptions & { id: number; answer: (ok: boolean) => void };

export const confirmRequest = shallowRef<ConfirmRequest | null>(null);
let ids = 0;

/** Resolves true when confirmed, false when cancelled. A newer request cancels the open one. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  confirmRequest.value?.answer(false);
  return new Promise((resolve) => {
    const request: ConfirmRequest = {
      ...options,
      id: ++ids,
      answer(ok) {
        if (confirmRequest.value === request) confirmRequest.value = null;
        resolve(ok);
      },
    };
    confirmRequest.value = request;
  });
}

/** Shared by the board and the task dialog. */
export const confirmDeleteTask = (title: string) =>
  confirmAction({ title: `Delete “${title}”?`, message: "Its description and comments are deleted too.", confirmLabel: "Delete task", danger: true });
