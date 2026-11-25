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

/** A formatted metric badge reported by the daemon (turn timing, tokens, cache, cost). */
export interface AgentMetric {
  label: string;
  value: string;
  tone?: "default" | "ok" | "warning" | "danger";
}

/** The subset of a daemon agent snapshot the console renders. */
export interface AgentSummary {
  key: string;
  hostId: string;
  id: string;
  /** The workspace (Paseo "thread") this agent belongs to. */
  workspaceId: string | null;
  title: string | null;
  status: string;
  turnActive?: boolean;
  provider: string;
  /** Delivery options verified for the Paseo adapter; missing means no verified steering. */
  deliveryModes?: MessageDeliveryMode[];
  cwd: string;
  /** Display name of the daemon's project placement (falls back to the cwd folder). */
  project: string;
  projectKey: string | null;
  /** Milliseconds: when the session's latest turn ended (held while a turn runs). Sort key. */
  activityAt: number;
  /** Milliseconds (daemon clock): when the running turn started; null when idle or unknown. */
  turnStartedAt?: number | null;
  /** Current model id, effective thinking option and mode, as the composer shows them. */
  model?: string | null;
  thinking?: string | null;
  modeId?: string | null;
  /** Context window use from the latest turn (tokens), when the provider reports it. */
  contextUsed?: number | null;
  contextMax?: number | null;
  /** Session-level metrics (timing, tokens, cache, cost) when reported by the provider. */
  sessionMetrics?: AgentMetric[];
  /** Needs the user's input: a pending permission or question (drives push and the badge). */
  attention: boolean;
  state: AgentState;
  /** A settled turn the user has not looked at yet (Paseo's requiresAttention). */
  unread: boolean;
  lastError: string | null;
  pendingPermissions: Permission[];
  /** How this agent's provider can rewind to an earlier message; empty when it cannot. */
  rewind?: RewindMode[];
  /** The agent that delegated this one through Paseo (same host), when it is a subagent. */
  parentAgentId?: string;
}

export type MessageDeliveryMode = "queue" | "steer" | "interrupt";

/** Rewind the conversation, the tracked files, or both, to just before a user message. */
export type RewindMode = "conversation" | "files" | "both";

/** One user prompt of a conversation, for the outline rail. */
export interface PromptMarker {
  seq: number;
  preview: string;
}
export interface PromptIndex {
  epoch: string;
  prompts: PromptMarker[];
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
  /** The daemon's project id: what project removal addresses. */
  projectId: string;
  /** The user's name override for the project (null: the name is derived). */
  projectCustomName: string | null;
  /** Identifies a custom project icon; null while the icon is automatic. */
  projectIconRevision: string | null;
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
  /** Workspace labels assigned on the daemon, when present. */
  labels?: string[];
  /** Uncommitted/branch diff line counts, when reported by the daemon. */
  diffStat?: { additions: number; deletions: number } | null;
}

/** A project with zero active workspaces, kept in the sidebar after its last thread is archived. */
export interface EmptyProjectSummary {
  key: string;
  hostId: string;
  projectId: string;
  projectKey: string | null;
  name: string;
  customName: string | null;
  iconRevision: string | null;
  rootPath: string;
  kind: string;
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
  /** The daemon accepts custom project icons (Paseo 0.2+). */
  customIcons?: boolean;
  /** The daemon runs on this server's machine, so images Paseo saved outside the workspace load. */
  local?: boolean;
}

export interface Change<T> {
  key: string;
  value: T | null;
}

export type DirectoryMessage =
  | { type: "project-pins"; pins: Record<string, number> }
  | { type: "snapshot"; generation: string; seq: number; agents: AgentSummary[] }
  | { type: "changes"; generation: string; seq: number; changes: Change<AgentSummary>[] }
  | { type: "workspaces-snapshot"; generation: string; seq: number; workspaces: WorkspaceSummary[] }
  | { type: "workspaces-changes"; generation: string; seq: number; changes: Change<WorkspaceSummary>[] }
  | { type: "empty-projects-snapshot"; generation: string; seq: number; projects: EmptyProjectSummary[] }
  | { type: "empty-projects-changes"; generation: string; seq: number; changes: Change<EmptyProjectSummary>[] }
  /** `version`: the server's LitePaseo version; a page built for another one offers a reload. */
  | { type: "hosts"; hosts: HostState[]; instanceName?: string; version?: string };

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
  /** Per-turn timing, token, cache, and cost metrics attached to the turn's final row. */
  turnMetrics?: AgentMetric[];
}

export type TimelineOp =
  | {
      type: "reset";
      epoch: string;
      rows: TimelineRow[];
      hasOlder: boolean;
      startCursor: TimelineCursor | null;
      /** The latest change the rows include, for resuming after a reconnect (servers before 0.9). */
      seq?: number;
    }
  | { type: "upsert"; row: TimelineRow; seq?: number }
  | { type: "append"; seqStart: number; seqEnd: number; timestamp: string; text: string }
  | { type: "error"; message: string };

/** A conversation as it is now (GET …/timeline/latest): the reset its stream would send. */
export type TimelineSnapshot = Extract<TimelineOp, { type: "reset" }>;

export interface TimelineMessage {
  type: "ops";
  ops: TimelineOp[];
}

/** A subagent the provider runs inside an agent (Claude Task, Codex, pi-subagents…). */
export interface ProviderSubagent {
  id: string;
  parentSubagentId: string | null;
  provider: string;
  title: string | null;
  description: string | null;
  subtitle: string | null;
  status: "running" | "completed" | "failed" | "canceled";
  createdAt: string;
  updatedAt: string;
  /** The parent's tool call that started it, when the provider reports one. */
  toolCallId: string | null;
}

/** The agent's provider subagents, oldest first; sent whenever the list changes. */
export interface SubagentsMessage {
  type: "subagents";
  subagents: ProviderSubagent[];
}

/** A running background task or heartbeat owned by an agent. */
export interface AgentBackgroundWorkItem {
  id: string;
  kind: string;
  description: string | null;
  command?: string;
  startedAt: string;
  canStop?: boolean;
  stopToken?: string;
}

/** The agent's current background tasks and heartbeats; sent whenever the list changes. */
export interface BackgroundWorkMessage {
  type: "background-work";
  items: AgentBackgroundWorkItem[];
}

/** What a conversation's timeline stream carries. */
export type TimelineStreamMessage = TimelineMessage | SubagentsMessage | BackgroundWorkMessage;

/** A provider slash command or skill returned for `/` composer autocomplete. */
export interface SlashCommandOption {
  name: string;
  description: string;
  argumentHint: string;
  kind: "command" | "skill";
}

/** An archived workspace / agent history entry that can be inspected or restored. */
export interface ArchivedWorkspaceSummary {
  hostId: string;
  id: string;
  workspaceId: string | null;
  name: string;
  project: string;
  cwd: string;
  branch: string | null;
  archivedAt: string;
  provider: string;
  status: string;
}

/** An existing git worktree on a host repository. */
export interface CheckoutWorktreeOption {
  path: string;
  branchName: string | null;
  head: string | null;
  createdAt: string;
  containsCwd: boolean;
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

/** Every provider a host knows, for its settings page: enabled or not, with catalogue freshness. */
export interface HostProviderInfo extends ProviderOption {
  description?: string;
  docsUrl?: string;
  source: "builtin" | "custom";
  enabled: boolean;
  /** When the daemon last fetched this provider's model catalogue; null before the first fetch. */
  fetchedAt: string | null;
}

/** Provider installation inspection returned on demand from host settings. */
export interface ProviderInstallationInfo {
  provider: string;
  installedVersion: string | null;
  installUrl?: string | null;
  docsUrl?: string | null;
  canCheckUpdates: boolean;
  canUpdate: boolean;
  status?: string;
  error?: string | null;
}

export interface ProviderUpdateCheckResult {
  provider: string;
  status: "current" | "available" | "unknown" | "error" | "unsupported";
  versions?: string[];
  message?: string;
}

export interface ProviderUpdateResult {
  provider: string;
  status: "running" | "succeeded" | "failed";
  id?: string;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  output?: { type: "stdout" | "stderr" | "message"; text: string }[];
}

/** A provider feature the composer can switch (Paseo's AgentFeature: toggle or select). */
export type AgentFeatureOption =
  | { type: "toggle"; id: string; label: string; tooltip?: string; value: boolean }
  | { type: "select"; id: string; label: string; tooltip?: string; value: string | null; options: { id: string; label: string }[] };

/** What the composer can change on a running agent: loaded on demand, not streamed. */
export interface AgentConfigOptions {
  models: { id: string; label: string; thinking: { id: string; label: string }[]; defaultThinkingId: string | null }[];
  modes: { id: string; label: string; description?: string }[];
  features: AgentFeatureOption[];
}

export interface AgentConfigChange {
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  feature?: { id: string; value: string | boolean };
}

export interface ProjectOption {
  key: string;
  name: string;
  rootPath: string;
  kind: string;
}

/** A project's paseo.json as the daemon reads it; revision guards concurrent edits. */
export interface ProjectConfigState {
  rootPath: string;
  /** null when the project has no paseo.json yet. */
  config: Record<string, unknown> | null;
  revision: { mtimeMs: number; size: number } | null;
  /** Setup changes not yet committed: new worktrees are created from the committed file. */
  uncommittedSetup?: boolean;
}

export interface ForkContextAttachment {
  id?: string;
  filename: string;
  mimeType: "text/plain";
  title?: string | null;
  text: string;
}

export interface ForkContextResult {
  attachment: ForkContextAttachment | null;
  itemCount: number;
}

export interface WorkspaceScriptInfo {
  scriptName: string;
  type: "script" | "service";
  port: number | null;
  proxyUrl: string | null;
  lifecycle: string;
  health: string | null;
  exitCode: number | null;
  terminalId: string | null;
}

export type WorkspaceLabelColor = "violet" | "sky" | "emerald" | "orange" | "pink" | "indigo" | "teal" | "red" | "amber" | "blue";

export interface WorkspaceLabelDef {
  name: string;
  color: WorkspaceLabelColor;
}

export type WorktreeCreateSpec =
  | { mode: "branch-off"; newBranch: string; base?: string }
  | { mode: "checkout-branch"; branch: string }
  | { mode: "checkout-pr"; prNumber: number };

export interface ImportableSessionEntry {
  providerId: string;
  providerLabel: string;
  providerHandleId: string;
  cwd: string;
  title: string | null;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
  lastActivityAt: string;
}

export interface ImportableSessionsResponse {
  entries: ImportableSessionEntry[];
  filteredAlreadyImportedCount?: number;
  providerErrors?: { provider: string; message: string }[];
}

export interface PluginRegistryListing {
  id: string;
  name: string;
  description: string;
  categories: string[];
  author: { github: string; name?: string };
  repositoryUrl: string;
  license?: string;
  installs?: number;
  updatedAt: string;
  version?: string;
}

export interface PluginRegistryIndex {
  registryName: string;
  registryUrl: string;
  categories: { slug: string; label: string; description?: string }[];
  featured: string[];
  plugins: PluginRegistryListing[];
}

export interface PluginRegistryDetail extends PluginRegistryListing {
  readme: string;
}

export interface CreateSessionRequest {
  idempotencyKey: string;
  cwd: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  prompt?: string;
  /** Start in a new git worktree on this new branch (legacy shorthand). */
  worktreeBranch?: string;
  /** Create a git worktree from a new branch, existing branch, or GitHub PR. */
  worktree?: WorktreeCreateSpec;
  /** Attach the new agent to an existing workspace instead of creating a new one. */
  workspaceId?: string;
  /** Optional text attachments (e.g. forked conversation context). */
  attachments?: ForkContextAttachment[];
}

/** A task on the board. Description and comments are Markdown; optional on older cards. */
export interface BoardCard {
  id: string;
  title: string;
  column: string;
  hostId: string | null;
  agentId: string | null;
  description?: string;
  comments?: CardComment[];
  createdAt?: number;
  updatedAt?: number;
}
export interface CardComment {
  id: string;
  text: string;
  /** Milliseconds. */
  at: number;
}
/** PATCH /api/board/cards/:id: only the fields present change. */
export interface CardPatch {
  title?: string;
  column?: string;
  description?: string;
  link?: { hostId: string; agentId: string } | null;
}

export interface ServerQueuedMessage {
  id: string; host: string; agent: string; text: string; attachmentNames: string[];
  error?: string; sending?: boolean; paused?: boolean;
}
