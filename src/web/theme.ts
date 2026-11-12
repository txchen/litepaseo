import { computed, ref, watch } from "vue";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "litepaseo-theme";
const read = (): ThemeChoice => {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
};

/** "system" follows prefers-color-scheme; an explicit choice pins the theme. */
export const theme = ref<ThemeChoice>(read());
const systemDark = matchMedia("(prefers-color-scheme: dark)");
const prefersDark = ref(systemDark.matches);
systemDark.addEventListener("change", event => { prefersDark.value = event.matches; });
export const isDark = computed(() => theme.value === "dark" || (theme.value === "system" && prefersDark.value));

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

// ---- Palettes ---------------------------------------------------------------------------------
/** Accent sets, each tuned for light and dark. Surfaces stay neutral; only Graphite also
 *  replaces the dark surfaces with Paseo's near-black neutrals. */
export type PaletteId = "graphite" | "indigo" | "ocean" | "ember";
type Vars = Record<string, string>;
export const PALETTES: { id: PaletteId; label: string; note: string; swatch: [string, string]; light: Vars; dark: Vars }[] = [
  {
    id: "graphite",
    label: "Graphite",
    note: "Monochrome, like Paseo",
    swatch: ["#18181b", "#e4e4e7"],
    light: { "--accent": "#18181b", "--accent-hover": "#3f3f46", "--accent-soft": "rgba(24, 24, 27, 0.07)", "--accent-fg": "#ffffff", "--accent-2": "#71717a", "--link": "#2563eb", "--unread": "#16a34a" },
    dark: {
      "--accent": "#e4e4e7", "--accent-hover": "#ffffff", "--accent-soft": "rgba(255, 255, 255, 0.08)", "--accent-fg": "#18191c", "--accent-2": "#a1a1aa", "--link": "#8ab4f8", "--unread": "#4ade80",
      "--surface-0": "#18191c", "--surface-1": "#1d1e22", "--surface-2": "#232429", "--surface-3": "#2d2e34", "--sidebar": "#141517",
      "--fg": "#e4e4e7", "--fg-muted": "#a1a1aa", "--fg-faint": "#6b6b74", "--border": "#2a2b30", "--border-strong": "#3a3b42",
      "--user-bubble": "#27282d", "--code-bg": "#141517", "--seg-track": "#141517", "--seg-thumb": "#2d2e34",
    },
  },
  {
    id: "indigo",
    label: "Indigo",
    note: "Calm blue-violet",
    swatch: ["#4f46e5", "#8b93ff"],
    light: { "--accent": "#4f46e5", "--accent-hover": "#4338ca", "--accent-soft": "rgba(79, 70, 229, 0.1)", "--accent-fg": "#ffffff", "--accent-2": "#818cf8", "--link": "#4f46e5", "--unread": "#16a34a" },
    dark: { "--accent": "#8b93ff", "--accent-hover": "#a5abff", "--accent-soft": "rgba(139, 147, 255, 0.15)", "--accent-fg": "#15172b", "--accent-2": "#c4b5fd", "--link": "#a5abff", "--unread": "#4ade80" },
  },
  {
    id: "ocean",
    label: "Ocean",
    note: "Deep teal",
    swatch: ["#0e7490", "#5cc8dc"],
    light: { "--accent": "#0e7490", "--accent-hover": "#0b5f76", "--accent-soft": "rgba(14, 116, 144, 0.1)", "--accent-fg": "#ffffff", "--accent-2": "#22a3c4", "--link": "#0e7490", "--unread": "#16a34a" },
    dark: { "--accent": "#5cc8dc", "--accent-hover": "#7fd6e6", "--accent-soft": "rgba(92, 200, 220, 0.14)", "--accent-fg": "#0f2328", "--accent-2": "#8be0ee", "--link": "#7fd6e6", "--unread": "#4ade80" },
  },
  {
    id: "ember",
    label: "Ember",
    note: "Warm terracotta",
    swatch: ["#c2410c", "#f59e5b"],
    light: { "--accent": "#c2410c", "--accent-hover": "#9a3412", "--accent-soft": "rgba(194, 65, 12, 0.09)", "--accent-fg": "#ffffff", "--accent-2": "#ea7a3c", "--link": "#b4410f", "--unread": "#16a34a" },
    dark: { "--accent": "#f59e5b", "--accent-hover": "#f8b47e", "--accent-soft": "rgba(245, 158, 91, 0.14)", "--accent-fg": "#2a1a0e", "--accent-2": "#fbc08f", "--link": "#f8b47e", "--unread": "#4ade80" },
  },
];
const PALETTE_KEY = "litepaseo-palette";
const readPalette = (): PaletteId => {
  const stored = localStorage.getItem(PALETTE_KEY);
  return PALETTES.some((p) => p.id === stored) ? (stored as PaletteId) : "ocean";
};
export const palette = ref<PaletteId>(readPalette());
let applied: string[] = [];
/** Sets the palette's variables inline on <html>: no extra stylesheet, one write per change. */
function paint() {
  const root = document.documentElement.style;
  for (const name of applied) root.removeProperty(name);
  const set = PALETTES.find((p) => p.id === palette.value) ?? PALETTES[0];
  const vars = isDark.value ? set.dark : set.light;
  for (const [name, value] of Object.entries(vars)) root.setProperty(name, value);
  applied = Object.keys(vars);
  document.documentElement.dataset.palette = set.id;
}
export function applyPalette(id: PaletteId = palette.value) {
  palette.value = id;
  localStorage.setItem(PALETTE_KEY, id);
  paint();
}
watch(isDark, paint);
