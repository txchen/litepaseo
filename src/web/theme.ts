import { ref } from "vue";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "litepaseo-theme";
const read = (): ThemeChoice => {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
};

/** "system" follows prefers-color-scheme; an explicit choice pins the theme. */
export const theme = ref<ThemeChoice>(read());

export function applyTheme(choice: ThemeChoice = theme.value) {
  theme.value = choice;
  if (choice === "system") {
    delete document.documentElement.dataset.theme;
    localStorage.removeItem(KEY);
  } else {
    document.documentElement.dataset.theme = choice;
    localStorage.setItem(KEY, choice);
  }
}

const ORDER: ThemeChoice[] = ["system", "light", "dark"];
export function cycleTheme() {
  applyTheme(ORDER[(ORDER.indexOf(theme.value) + 1) % ORDER.length]);
}
