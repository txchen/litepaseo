import { computed, reactive, ref, watch, type Ref } from "vue";
import { safeGetItem, safeRemoveItem, safeSetItem } from "./safe-storage.ts";
import type { FileLink, FileViewState, LineRange } from "./timeline-display.ts";

/** The side panel next to a conversation; the file tree stays there, files and terminals open in the center. */
export type Panel = "files" | "changes" | "search" | "subagents";
/** A line to show in a file tab; `seq` makes a second click on the same line scroll again. */
type FileJump = LineRange & { path: string; seq: number };

/**
 * A thread's workspace tabs (Paseo's): files and a terminal next to the conversation, kept per
 * `owner` (the open thread, else agent) while the page lives, plus the side panel beside them.
 * `compact` layouts show one thing at a time, so opening a tab closes the panel there.
 */
export function useWorkspaceTabs(owner: Readonly<Ref<string>>, compact: MediaQueryList) {
  const panel = ref<Panel | null>(safeGetItem("litepaseo-panel") === "files" ? "files" : null);
  watch(panel, (p) => (p ? safeSetItem("litepaseo-panel", p) : safeRemoveItem("litepaseo-panel")));
  const togglePanel = (p: Panel) => (panel.value = panel.value === p ? null : p);

  const terminalTabs = reactive(new Map<string, boolean>());
  const terminalOpen = computed(() => terminalTabs.has(owner.value));
  const terminalActive = computed(() => terminalTabs.get(owner.value) === true);
  function openTerminal() {
    terminalTabs.set(owner.value, true);
    activeFile.value = null;
    if (compact.matches) panel.value = null;
  }
  function closeTerminal() {
    terminalTabs.delete(owner.value);
  }
  function showConversation() {
    terminalTabs.has(owner.value) && terminalTabs.set(owner.value, false);
    activeFile.value = null;
  }

  // Files opened as tabs, per thread (at most a dozen per thread).
  const fileTabs = reactive(new Map<string, { paths: string[]; active: string | null; jump?: FileJump }>());
  const openFiles = computed(() => fileTabs.get(owner.value)?.paths ?? []);
  const activeFile = computed({
    get: () => fileTabs.get(owner.value)?.active ?? null,
    set: (path: string | null) => {
      const entry = fileTabs.get(owner.value);
      if (entry) entry.active = path;
      if (path && terminalTabs.has(owner.value)) terminalTabs.set(owner.value, false);
    },
  });
  let jumpSeq = 0;
  const activeJump = computed(() => {
    const entry = fileTabs.get(owner.value);
    return entry?.jump && entry.jump.path === entry.active ? entry.jump : undefined;
  });
  function openFile(path: string, range?: Partial<LineRange>) {
    const key = owner.value;
    if (!key) return;
    const entry = fileTabs.get(key) ?? { paths: [], active: null };
    if (!entry.paths.includes(path)) {
      const nextPaths = [...entry.paths, path];
      if (nextPaths.length > 12) {
        const evicted = nextPaths.splice(0, nextPaths.length - 12);
        for (const old of evicted) fileViews.delete(fileViewKey(key, old));
      }
      entry.paths = nextPaths;
    }
    entry.active = path;
    entry.jump = range?.line ? { path, line: range.line, end: range.end, seq: ++jumpSeq } : undefined;
    if (terminalTabs.has(key)) terminalTabs.set(key, false);
    fileTabs.set(key, entry);
    if (compact.matches) panel.value = null; // phones: show the file, not the tree on top of it
  }
  function closeFile(path: string) {
    const entry = fileTabs.get(owner.value);
    if (!entry) return;
    fileViews.delete(fileViewKey(owner.value, path));
    const index = entry.paths.indexOf(path);
    entry.paths = entry.paths.filter((p) => p !== path);
    if (entry.active === path) entry.active = entry.paths[Math.min(index, entry.paths.length - 1)] ?? null;
  }

  /** Each open tab's scroll position and view, per thread; closing the tab forgets it. */
  const fileViews = new Map<string, FileViewState>();
  const fileViewKey = (key: string, path: string) => `${key}\n${path}`;
  /** Sent as a tab is left; a tab that was closed (not just switched away from) stays forgotten. */
  function saveFileView(key: string, state: FileViewState) {
    const split = key.indexOf("\n");
    if (fileTabs.get(key.slice(0, split))?.paths.includes(key.slice(split + 1))) fileViews.set(key, state);
  }

  /** A directory a link pointed at, shown in the Files panel (per thread; `seq` reveals again). */
  const reveal = ref<{ owner: string; path: string; seq: number } | null>(null);
  function revealDirectory(path: string) {
    reveal.value = { owner: owner.value, path, seq: ++jumpSeq };
    panel.value = "files";
  }
  /** Follows a local link rewritten by rewriteFileLinks (never a copy link). */
  function openLocalLink(link: Exclude<FileLink, { kind: "copy" }>) {
    if (link.kind === "reveal") revealDirectory(link.path);
    else openFile(link.path, link);
  }

  /** Signing out: nothing from the account stays in memory for the next person at this computer. */
  function clear() {
    fileTabs.clear();
    fileViews.clear();
    terminalTabs.clear();
  }

  return {
    panel, togglePanel,
    terminalOpen, terminalActive, openTerminal, closeTerminal, showConversation,
    openFiles, activeFile, activeJump, openFile, closeFile,
    fileViews, fileViewKey, saveFileView,
    reveal, revealDirectory, openLocalLink,
    clear,
  };
}

export type WorkspaceTabs = ReturnType<typeof useWorkspaceTabs>;
