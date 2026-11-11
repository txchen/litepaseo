/** BFF ↔ browser wire types. Shared by server and web builds. */

export interface Permission {
  id: string;
  title?: string;
  name: string;
  kind: string;
  input?: unknown;
  actions?: { id: string; label?: string }[];
}

/** The subset of a daemon agent snapshot the console renders. */
export interface AgentSummary {
  key: string;
  hostId: string;
  id: string;
  title: string | null;
  status: string;
  provider: string;
  cwd: string;
  /** Display name of the daemon's project placement (falls back to the cwd folder). */
  project: string;
  projectKey: string | null;
  /** Milliseconds: when the session's latest turn ended (held while a turn runs). Sort key. */
  activityAt: number;
  attention: boolean;
  pendingPermissions: Permission[];
}

export interface HostState {
  id: string;
  label: string;
  state: string;
}

export interface Change<T> {
  key: string;
  value: T | null;
}

export type DirectoryMessage =
  | { type: "snapshot"; generation: string; seq: number; agents: AgentSummary[] }
  | { type: "changes"; generation: string; seq: number; changes: Change<AgentSummary>[] }
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
