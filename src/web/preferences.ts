import { reactive, watch } from "vue";
import { safeGetItem, safeSetItem } from "./safe-storage.ts";

export type ContentWidthPreset = "default" | "wide" | "full";
export type FontSizePreset = "small" | "default" | "large";
export type SendShortcutMode = "enter" | "mod-enter";
export type DefaultDeliveryPref = "auto" | "steer" | "queue" | "interrupt";
export type ChatDensityMode = "full" | "collapse-tools" | "collapse-turns";

export interface UserPreferences {
  contentWidth: ContentWidthPreset;
  fontSize: FontSizePreset;
  sendShortcut: SendShortcutMode;
  defaultDeliveryMode: DefaultDeliveryPref;
  autoExpandReasoning: boolean;
  chatDensity: ChatDensityMode;
  showChatOutline: boolean;
}

const KEY = "litepaseo-prefs-v1";

const DEFAULTS: UserPreferences = {
  contentWidth: "default",
  fontSize: "default",
  sendShortcut: "enter",
  defaultDeliveryMode: "auto",
  autoExpandReasoning: false,
  chatDensity: "full",
  showChatOutline: true,
};

function load(): UserPreferences {
  try {
    const raw = safeGetItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    return {
      contentWidth: parsed.contentWidth === "wide" || parsed.contentWidth === "full" ? parsed.contentWidth : "default",
      fontSize: parsed.fontSize === "small" || parsed.fontSize === "large" ? parsed.fontSize : "default",
      sendShortcut: parsed.sendShortcut === "mod-enter" ? "mod-enter" : "enter",
      defaultDeliveryMode:
        parsed.defaultDeliveryMode === "steer" ||
        parsed.defaultDeliveryMode === "queue" ||
        parsed.defaultDeliveryMode === "interrupt"
          ? parsed.defaultDeliveryMode
          : "auto",
      autoExpandReasoning: parsed.autoExpandReasoning === true,
      chatDensity:
        parsed.chatDensity === "collapse-tools" || parsed.chatDensity === "collapse-turns"
          ? parsed.chatDensity
          : "full",
      showChatOutline: parsed.showChatOutline !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export const prefs = reactive<UserPreferences>(load());

const WIDTH_VALUES: Record<ContentWidthPreset, { chat: string; dock: string }> = {
  default: { chat: "780px", dock: "732px" },
  wide: { chat: "1060px", dock: "1012px" },
  full: { chat: "100%", dock: "100%" },
};
const FONT_VALUES: Record<FontSizePreset, { body: string; code: string }> = {
  small: { body: "13px", code: "12px" },
  default: { body: "14.5px", code: "13px" },
  large: { body: "16px", code: "14.5px" },
};

export function applyPreferences(p: UserPreferences = prefs) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--chat-max-width", WIDTH_VALUES[p.contentWidth].chat);
  root.style.setProperty("--dock-max-width", WIDTH_VALUES[p.contentWidth].dock);
  root.style.setProperty("--chat-font-size", FONT_VALUES[p.fontSize].body);
  root.style.setProperty("--code-font-size", FONT_VALUES[p.fontSize].code);
  root.dataset.chatWidth = p.contentWidth;
  root.dataset.chatDensity = p.chatDensity;
}

applyPreferences(prefs);

watch(
  prefs,
  (next) => {
    applyPreferences(next);
    safeSetItem(KEY, JSON.stringify(next));
  },
  { deep: true },
);
