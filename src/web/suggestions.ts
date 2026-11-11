import type { InjectionKey } from "vue";

/** What a next-input suggestion row may do in the open conversation. */
export interface SuggestionContext {
  predict(token: string): Promise<{ status: string; text: string }>;
  /** Put the text in the composer for editing. */
  use(text: string): void;
  /** Send it as the next message. */
  send(text: string): void;
  /** A ready suggestion; the newest one becomes the composer's Tab completion. */
  offer(seqStart: number, text: string): void;
}

export const SUGGESTIONS: InjectionKey<SuggestionContext> = Symbol("litepaseo-suggestions");
