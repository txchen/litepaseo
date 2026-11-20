import { computed, ref, shallowRef, watch, type Ref } from "vue";
import type { WorkspaceSummary } from "../shared/wire.ts";
import { confirmAction } from "./confirm.ts";
import type { DirectoryStore, ProjectGroup } from "./directory-store.ts";
import { threadPath, type Api } from "./use-api.ts";

/** A project row of the sidebar; it may group more than one daemon project of the same name. */
export type ProjectTarget = { name: string; hostId: string; rootPath: string; projectIds: string[]; threadKeys: string[] };

/**
 * The sidebar's thread and project actions, as in Paseo: thread rename, pin, unread/read and
 * archive; project pins, settings (paseo.json) and removal from its host. Viewing an unread
 * thread marks it read.
 */
export function useThreadActions({ api, action, directory, selectedThread, selectedKey, activeThread, readyKey, hostLabels, closeDetail }: {
  api: Api;
  action: (fn: () => Promise<void>) => Promise<void>;
  directory: DirectoryStore<WorkspaceSummary>;
  selectedThread: Ref<string | null>;
  selectedKey: Ref<string | null>;
  activeThread: Readonly<Ref<WorkspaceSummary | null>>;
  /** The conversation whose first rows arrived. */
  readyKey: Readonly<Ref<string | null>>;
  hostLabels: Readonly<Ref<Map<string, string>>>;
  closeDetail: () => void;
}) {
  // ---- Threads: the daemon operations Paseo's sidebar uses ---------------------------------------
  const menu = shallowRef<{ thread: WorkspaceSummary; x: number; y: number } | null>(null);
  const renaming = shallowRef<WorkspaceSummary | null>(null);
  function openMenu(thread: WorkspaceSummary, x: number, y: number) {
    menu.value = { thread, x, y };
  }
  function openHeaderMenu(event: MouseEvent) {
    const thread = activeThread.value;
    if (!thread) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(thread, rect.right - 200, rect.bottom + 6);
  }
  async function renameThread(title: string | null) {
    const thread = renaming.value;
    if (!thread) return;
    await action(async () => {
      await api(threadPath(thread) + "/title", "POST", { title });
      renaming.value = null;
    });
  }
  async function pinThread(thread: WorkspaceSummary, pinned: boolean) {
    await action(async () => void (await api(threadPath(thread) + "/pin", "POST", { pinned })));
  }
  async function markThreadUnread(thread: WorkspaceSummary) {
    await action(async () => {
      await api(threadPath(thread) + "/unread", "POST", {});
      // Leave it so viewing does not mark it read again right away.
      if (selectedThread.value === thread.key) {
        selectedThread.value = selectedKey.value = null;
        closeDetail();
      }
    });
  }
  async function markThreadRead(thread: WorkspaceSummary) {
    await action(async () => void (await api(threadPath(thread) + "/read", "POST", {})));
  }
  async function archiveThread(thread: WorkspaceSummary) {
    if (!(await confirmAction({ title: `Archive “${thread.name}”?`, message: "It leaves the sidebar; the host keeps its history.", confirmLabel: "Archive" }))) return;
    await action(async () => {
      await api(threadPath(thread) + "/archive", "POST", {});
      if (selectedThread.value === thread.key) selectedThread.value = selectedKey.value = null;
    });
  }
  // Viewing an unread thread marks it read (the agent-level read is the app's).
  let threadReadSent = "";
  watch(
    () => (activeThread.value?.unread && !!selectedKey.value && readyKey.value === selectedKey.value ? activeThread.value : null),
    (w) => {
      if (!w || document.hidden) return;
      const marker = `${w.key}@${w.activityAt}`;
      if (threadReadSent === marker) return;
      threadReadSent = marker;
      void api(threadPath(w) + "/read", "POST", {}).catch(() => (threadReadSent = ""));
    },
  );

  // ---- Projects (Paseo's project menu): pin, edit paseo.json, remove from the host ---------------
  const projectPins = ref<Record<string, number>>({});
  function projectPinned(target: ProjectTarget) { return target.projectIds.some(id => !!projectPins.value[JSON.stringify([target.hostId, id])]); }
  let projectPinsRevision = 0;
  /** The pins as the directory stream reports them. */
  function applyProjectPins(pins: Record<string, number>) { projectPinsRevision++; projectPins.value = pins; directory.setProjectPins(pins); }
  async function pinProject(target: ProjectTarget) {
    const pinned = !projectPinned(target);
    const revision = projectPinsRevision;
    await action(async () => {
      const pins = await api('/project-pins', 'POST', {hostId: target.hostId, projectIds: target.projectIds, pinned});
      if (revision === projectPinsRevision) applyProjectPins(pins);
    });
  }
  const projectMenu = shallowRef<{ project: ProjectTarget; x: number; y: number } | null>(null);
  const projectSettings = shallowRef<ProjectTarget | null>(null);
  /** The open settings follow the live directory, so a rename or new icon shows at once. */
  const settingsProject = computed(() => {
    directory.version.value;
    const target = projectSettings.value;
    if (!target) return null;
    const thread = target.threadKeys.map((key) => directory.get(key)).find(Boolean);
    if (thread) {
      return {
        projectId: thread.projectId ?? target.projectIds[0] ?? "",
        name: thread.project ?? target.name,
        customName: thread.projectCustomName ?? null,
        iconRevision: thread.projectIconRevision ?? null,
      };
    }
    const empty = target.projectIds.map((id) => directory.getEmptyProject(`${target.hostId}:${id}`)).find(Boolean);
    return {
      projectId: empty?.projectId ?? target.projectIds[0] ?? "",
      name: empty?.name ?? target.name,
      customName: empty?.customName ?? null,
      iconRevision: empty?.iconRevision ?? null,
    };
  });
  function openProjectMenu(group: ProjectGroup<WorkspaceSummary>, x: number, y: number) {
    const items = group.items.range(0, group.items.size);
    const empties = group.emptyProjects ? [...group.emptyProjects.values()] : [];
    const first = items[0];
    const firstEmpty = empties[0];
    if (!first && !firstEmpty) return;
    projectMenu.value = {
      project: {
        name: group.name,
        hostId: first?.hostId ?? firstEmpty!.hostId,
        rootPath: first?.rootPath ?? firstEmpty!.rootPath,
        // A row groups by name, so it may hold more than one daemon project; removal covers them all.
        projectIds: [...new Set([...items.map((t) => t.projectId), ...empties.map((p) => p.projectId)].filter(Boolean))],
        threadKeys: items.map((t) => t.key),
      },
      x,
      y,
    };
  }
  async function removeProject(project: ProjectTarget) {
    const host = hostLabels.value.get(project.hostId) ?? "its host";
    const threads = project.threadKeys.length;
    const ok = await confirmAction({
      title: `Remove “${project.name}” from ${host}?`,
      message:
        (threads
          ? `Its ${threads === 1 ? "thread is" : `${threads} threads are`} archived and the project leaves the sidebar. `
          : "The project leaves the sidebar. ") +
        "Files on disk are not touched; the host keeps the history.",
      confirmLabel: "Remove project",
      danger: true,
    });
    if (!ok) return;
    await action(async () => {
      if (!project.projectIds.length) throw new Error("This host did not report a project id; update Paseo on it.");
      for (const id of project.projectIds)
        await api(`/hosts/${encodeURIComponent(project.hostId)}/projects/${encodeURIComponent(id)}`, "DELETE", undefined, 60000);
      if (selectedThread.value && project.threadKeys.includes(selectedThread.value))
        selectedThread.value = selectedKey.value = null;
    });
  }

  return {
    menu, renaming, openMenu, openHeaderMenu, renameThread, pinThread, markThreadUnread, markThreadRead, archiveThread,
    projectPinned, applyProjectPins, pinProject, projectMenu, projectSettings, settingsProject, openProjectMenu, removeProject,
  };
}
