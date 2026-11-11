/** BFF ↔ browser wire types. Shared by server and web builds. */

export interface Permission {
  id: string;
  title?: string;
  name: string;
  kind: string;
  input?: unknown;
  actions?: { id: string; label?: string }[];
}

/**
 * Where an agent stands from the user's side, per Paseo's own `deriveAgentStateBucket`:
 * needs_input (a permission or question), running, failed, unread (a finished turn not yet
 * looked at), done. `initializing` counts as running: work in flight, not a finished task.
 */
export type AgentState = "needs_input" | "running" | "failed" | "unread" | "done";
/** Task-board lanes. Failed and unread share "review": both want a look. */
export type Lane = "needs_input" | "running" | "review" | "done";
export const LANES: Lane[] = ["needs_input", "running", "review", "done"];
export const laneOf = (state: AgentState): Lane =>
  state === "failed" || state === "unread" ? "review" : state;

/** The subset of a daemon agent snapshot the console renders. */
export interface AgentSummary {
  key: string;
  hostId: string;
  id: string;
  /** The workspace (Paseo "thread") this agent belongs to. */
  workspaceId: string | null;
  title: string | null;
  status: string;
  provider: string;
  cwd: string;
  /** Display name of the daemon's project placement (falls back to the cwd folder). */
  project: string;
  projectKey: string | null;
  /** Milliseconds: when the session's latest turn ended (held while a turn runs). Sort key. */
  activityAt: number;
  /** Needs the user's input: a pending permission or question (drives push and the badge). */
  attention: boolean;
  state: AgentState;
  /** A settled turn the user has not looked at yet (Paseo's requiresAttention). */
  unread: boolean;
  lastError: string | null;
  pendingPermissions: Permission[];
}

/** "Run npm test" → "run npm test", for use mid-sentence ("wants to run npm test"). */
export const midSentence = (text: string) =>
  /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;

/** A Paseo workspace: what the official sidebar lists as a thread. */
export interface WorkspaceSummary {
  key: string;
  hostId: string;
  id: string;
  /** Display name: the user's title if set, else derived from branch or directory. */
  name: string;
  /** The raw user title (null when the name is derived), for rename prefill and reset. */
  title: string | null;
  project: string;
  projectKey: string | null;
  rootPath: string;
  directory: string;
  kind: string;
  branch: string | null;
  /** Milliseconds; 0 when not pinned. */
  pinnedAt: number;
  activityAt: number;
  state: AgentState;
  attention: boolean;
  unread: boolean;
}

export interface HostDiagnostic {
  lastConnectedAt?: string;
  nextRetryAt?: string;
  attempt?: number;
  error?: { code: string; message: string };
}
export interface HostState {
  id: string;
  label: string;
  state: string;
  diagnostic?: HostDiagnostic;
}

export interface Change<T> {
  key: string;
  value: T | null;
}

export type DirectoryMessage =
  | { type: "snapshot"; generation: string; seq: number; agents: AgentSummary[] }
  | { type: "changes"; generation: string; seq: number; changes: Change<AgentSummary>[] }
  | { type: "workspaces-snapshot"; generation: string; seq: number; workspaces: WorkspaceSummary[] }
  | { type: "workspaces-changes"; generation: string; seq: number; changes: Change<WorkspaceSummary>[] }
  | { type: "hosts"; hosts: HostState[] };

export interface TimelineCursor {
  epoch: string;
  seq: number;
}

export interface TimelineItem {
  type: string;
  text?: string;
  message?: string;
  [key: string]: unknown;
}

export interface TimelineRow {
  seqStart: number;
  seqEnd: number;
  timestamp: string;
  provider: string;
  turnId?: string;
  item: TimelineItem;
}

export type TimelineOp =
  | {
      type: "reset";
      epoch: string;
      rows: TimelineRow[];
      hasOlder: boolean;
      startCursor: TimelineCursor | null;
    }
  | { type: "upsert"; row: TimelineRow }
  | { type: "append"; seqStart: number; seqEnd: number; timestamp: string; text: string }
  | { type: "error"; message: string };

export interface TimelineMessage {
  type: "ops";
  ops: TimelineOp[];
}

export interface TimelinePage {
  epoch: string;
  rows: TimelineRow[];
  hasOlder: boolean;
  startCursor: TimelineCursor | null;
}

/** What a host can start: enabled providers with their models, modes and thinking levels. */
export interface ProviderOption {
  id: string;
  label: string;
  status: string;
  error?: string;
  defaultModeId: string | null;
  modes: { id: string; label: string; description?: string }[];
  models: {
    id: string;
    label: string;
    description?: string;
    isDefault: boolean;
    thinking: { id: string; label: string }[];
    defaultThinkingId: string | null;
  }[];
}

export interface ProjectOption {
  key: string;
  name: string;
  rootPath: string;
  kind: string;
}

export interface CreateSessionRequest {
  idempotencyKey: string;
  cwd: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  prompt?: string;
  /** Start in a new git worktree on this new branch. */
  worktreeBranch?: string;
}
