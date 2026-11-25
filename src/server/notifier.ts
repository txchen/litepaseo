import webpush from "web-push";
import { midSentence, type AgentSummary } from "../shared/wire.ts";
import type { PushPrefs, PushSubscriptionRecord, Store } from "./store.ts";

export type NotificationKind = "attention" | "turn-done" | "turn-failed";

export interface PushMessage {
  title: string;
  body: string;
  /** One notification per project: a newer push replaces the project's earlier one where supported. */
  tag: string;
  url: string;
  kind: NotificationKind | "test";
  /** Sessions currently waiting for the user, for the app icon badge. */
  badge: number;
}

export interface PushSender {
  send(subscription: PushSubscriptionRecord, payload: string): Promise<void>;
}

/** Repeats of the same event for the same session within this window are dropped. */
const DEDUPE_MS = 15_000;
/** Turn ends older than this (seen late, e.g. after a reconnect) are not announced. */
const STALE_MS = 10 * 60_000;
/**
 * At most one push per project in this window for finished turns; later ones wait and go out
 * together when it ends. Input requests and failed turns are never held back.
 */
export const PROJECT_COOLDOWN_MS = 2 * 60_000;
/**
 * While someone is using LitePaseo on any device, pushes wait this long first: a conversation
 * opened in the meantime is not pushed to the other devices. Finished turns wait longer than
 * input requests and failures, which hold an agent up.
 */
export const ACTIVE_GRACE_MS = { "turn-done": 45_000, attention: 20_000, "turn-failed": 20_000 } as const;
/** A project digest forgets events this old, even if the user never opened them. */
const DIGEST_TTL_MS = 60 * 60_000;
/** Lines in a merged notification; phones show about four. */
const MAX_LINES = 4;

interface DigestEntry {
  kind: NotificationKind;
  agent: AgentSummary;
  detail: string;
  at: number;
  /** Not sent before this (the active-device grace); 0 when nobody was using a device. */
  due: number;
  sent: boolean;
}

/** What a project's devices have not looked at yet; each push shows all of it. */
interface ProjectDigest {
  entries: Map<string, DigestEntry>;
  lastSent: number;
  cancel?: () => void;
}

export function vapidKeys(store: Store) {
  const saved = store.setting("vapid");
  if (saved) return JSON.parse(saved) as { publicKey: string; privateKey: string };
  const keys = webpush.generateVAPIDKeys();
  store.setSetting("vapid", JSON.stringify(keys));
  return keys;
}

/** Real delivery through the browser vendor's push service. */
export function webPushSender(store: Store, subject: string): PushSender {
  const keys = vapidKeys(store);
  return {
    async send(subscription, payload) {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        payload,
        {
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 6 * 3600,
          urgency: "high",
        },
      );
    },
  };
}

const projectTag = (agent: AgentSummary) => `project:${agent.hostId}:${agent.projectKey ?? agent.project}`;
const prefFor = (kind: NotificationKind): keyof PushPrefs => (kind === "attention" ? "attention" : "turns");
/** A turn is under way: the daemon's own flag when known, else the status. */
const turnActive = (agent: AgentSummary) => agent.turnActive ?? agent.status === "running";
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Turns directory transitions into push notifications: a session starting to need the user
 * (a permission or question appears) and a turn finishing or failing. Events are merged per
 * project on the server, so the phone gets one push per project per cooldown however many
 * conversations finish; this does not depend on the phone merging notifications by tag (iOS
 * does not). Detection is per transition, O(1); delivery fans out to the (few) subscribed devices.
 */
export class Notifier {
  private readonly store: Store;
  private readonly sender: PushSender;
  private readonly isViewing: (key: string) => boolean;
  private readonly deviceActive: () => boolean;
  private readonly viewedSince: (key: string, at: number) => boolean;
  private readonly hostLabel: (hostId: string) => string;
  private readonly waiting = new Set<string>();
  private readonly recent = new Map<string, number>();
  private readonly digests = new Map<string, ProjectDigest>();
  private readonly now: () => number;
  private readonly schedule: (run: () => void, ms: number) => () => void;
  private readonly replyPreview?: (agent: AgentSummary, previous: AgentSummary) => Promise<string | null>;
  /** Events still preparing their reply preview, per conversation; settle() and forget() call them off. */
  private readonly preparing = new Map<string, Set<{ kind: NotificationKind; cancelled: boolean }>>();
  private closed = false;

  constructor(options: {
    store: Store;
    sender: PushSender;
    isViewing: (key: string) => boolean;
    /** Someone is using LitePaseo on some device: pushes wait ACTIVE_GRACE_MS first. */
    deviceActive?: () => boolean;
    /** The conversation was on a foreground screen at or after `at`. */
    viewedSince?: (key: string, at: number) => boolean;
    hostLabel: (hostId: string) => string;
    now?: () => number;
    /** Runs `run` after `ms`; returns a cancel function. Tests drive time by hand. */
    schedule?: (run: () => void, ms: number) => () => void;
    replyPreview?: (agent: AgentSummary, previous: AgentSummary) => Promise<string | null>;
  }) {
    this.store = options.store;
    this.sender = options.sender;
    this.isViewing = options.isViewing;
    this.deviceActive = options.deviceActive ?? (() => false);
    this.viewedSince = options.viewedSince ?? ((key) => options.isViewing(key));
    this.hostLabel = options.hostLabel;
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.replyPreview = options.replyPreview;
  }

  get waitingCount() {
    return this.waiting.size;
  }

  /** Stops all pending pushes; events still in flight are dropped. Call before closing the store. */
  dispose() {
    this.closed = true;
    for (const digest of this.digests.values()) digest.cancel?.();
    this.digests.clear();
    for (const events of this.preparing.values()) for (const event of events) event.cancelled = true;
    this.preparing.clear();
  }

  /** Feed every summary transition here (HostDirectory → Hosts.onTransition). */
  transition(previous: AgentSummary | null, next: AgentSummary | null) {
    if (this.closed) return;
    const key = next?.key ?? previous!.key;
    if (next?.attention) this.waiting.add(key);
    else this.waiting.delete(key);
    // First sight is a baseline, not an event: nothing changed while we were watching.
    if (!previous || !next) {
      if (!next) this.forget(previous!);
      return;
    }
    this.settle(previous, next);
    const newPermission = next.pendingPermissions.some(
      (p) => !previous.pendingPermissions.some((q) => q.id === p.id),
    );
    if ((next.attention && !previous.attention) || newPermission) {
      const permission = next.pendingPermissions[0];
      const what = permission
        ? permission.kind === "question"
          ? `asks: ${permission.title || permission.name}`
          : `wants to ${midSentence(permission.title || permission.name)}`
        : "is waiting for you";
      this.emitSafely("attention", next, permission ? `The agent ${what}` : "The agent is waiting for your input.", permission ? undefined : previous);
    } else if (turnActive(previous) && !turnActive(next)) {
      if (this.now() - next.activityAt > STALE_MS) return;
      const failed = next.status === "error";
      // An agent that finished starting up without a turn has nothing to announce; one that failed to start does.
      if (!failed && previous.status === "initializing") return;
      this.emitSafely(
        failed ? "turn-failed" : "turn-done",
        next,
        failed ? next.lastError || "The agent could not finish this turn." : "The agent finished this turn.",
        failed ? undefined : previous,
      );
    }
  }

  async test(sessionId: string) {
    const subs = this.store.pushSubscriptions().filter((s) => s.sessionId === sessionId);
    const results = await Promise.all(
      subs.map((s) =>
        this.deliver(s, {
          title: "LitePaseo notifications work",
          body: "You'll hear from your agents when they need you or finish a turn.",
          tag: "litepaseo-test",
          url: "/",
          kind: "test",
          badge: this.waiting.size,
        }),
      ),
    );
    return results.filter(Boolean).length;
  }

  /** The user dealt with a conversation (opened it, answered, or started a new turn): drop its news. */
  private settle(previous: AgentSummary, next: AgentSummary) {
    const seen = previous.unread && !next.unread;
    const resumed = previous.status !== "running" && next.status === "running";
    const answered = previous.attention && !next.attention;
    const dealt = (kind: NotificationKind) => seen || resumed || (answered && kind === "attention");
    for (const event of this.preparing.get(next.key) ?? []) if (dealt(event.kind)) event.cancelled = true;
    const entry = this.digests.get(projectTag(next))?.entries.get(next.key);
    if (entry && dealt(entry.kind)) this.drop(next);
  }

  /** The conversation is gone (archived or deleted). */
  private forget(agent: AgentSummary) {
    for (const event of this.preparing.get(agent.key) ?? []) event.cancelled = true;
    this.drop(agent);
  }

  /** Removes a conversation's digest entry; an emptied digest is rescheduled to be let go. */
  private drop(agent: AgentSummary) {
    const tag = projectTag(agent);
    const digest = this.digests.get(tag);
    if (digest?.entries.delete(agent.key) && !digest.entries.size) this.flush(tag);
  }

  /** Notifications run detached from the transition that caused them: no failure may escape. */
  private emitSafely(kind: NotificationKind, agent: AgentSummary, body: string, previous?: AgentSummary) {
    this.emit(kind, agent, body, previous).catch((error) => {
      if (!this.closed) console.warn(JSON.stringify({ event: "push_notify_failed", message: (error as Error)?.message }));
    });
  }

  private async emit(kind: NotificationKind, agent: AgentSummary, body: string, previous?: AgentSummary) {
    if (this.closed) return;
    const dedupeKey = `${kind}:${agent.key}`;
    const now = this.now();
    if (now - (this.recent.get(dedupeKey) ?? -Infinity) < DEDUPE_MS) return;
    this.recent.set(dedupeKey, now);
    if (this.recent.size > 5000) this.recent.clear();
    const pref = prefFor(kind);
    if (this.isViewing(agent.key) || !this.store.pushSubscriptions().some((s) => s.prefs[pref])) return;
    // When the event happened, not when its preview was ready: a look meanwhile counts as seen.
    const at = this.now();
    const event = { kind, cancelled: false };
    let events = this.preparing.get(agent.key);
    if (!events) this.preparing.set(agent.key, (events = new Set()));
    events.add(event);
    if (previous && this.replyPreview) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const preview = await Promise.race([
          this.replyPreview(agent, previous),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000); timer.unref(); }),
        ]);
        if (preview?.trim()) body = preview.replace(/\s+/g, " ").trim();
      } catch { /* A missing timeline must not suppress the notification. */ }
      finally { clearTimeout(timer); }
    }
    events.delete(event);
    if (!events.size && this.preparing.get(agent.key) === events) this.preparing.delete(agent.key);
    if (this.closed || event.cancelled || this.isViewing(agent.key) || this.viewedSince(agent.key, at)) return;
    const tag = projectTag(agent);
    let digest = this.digests.get(tag);
    if (!digest) this.digests.set(tag, (digest = { entries: new Map(), lastSent: -Infinity }));
    // Re-insert so the map stays oldest → newest.
    digest.entries.delete(agent.key);
    digest.entries.set(agent.key, { kind, agent, detail: body, at, due: this.deviceActive() ? at + ACTIVE_GRACE_MS[kind] : 0, sent: false });
    this.flush(tag);
  }

  /** When an unsent entry may go out: after its grace and, for plain turn ends, the project cooldown. */
  private releaseAt(digest: ProjectDigest, entry: DigestEntry) {
    return entry.kind === "turn-done" ? Math.max(entry.due, digest.lastSent + PROJECT_COOLDOWN_MS) : entry.due;
  }

  /** Sends what is due in a project, then waits for the next unsent entry. */
  private flush(tag: string) {
    const digest = this.digests.get(tag);
    if (!digest) return;
    digest.cancel?.();
    digest.cancel = undefined;
    const now = this.now();
    for (const [key, entry] of digest.entries)
      if (now - entry.at > DIGEST_TTL_MS || this.viewedSince(key, entry.at)) digest.entries.delete(key);
    const entries = [...digest.entries.values()].reverse();
    const released = new Set(entries.filter((e) => !e.sent && this.releaseAt(digest, e) <= now));
    if (released.size) {
      // Entries still in their grace stay out: they may yet be seen on the device in use.
      const shown = entries.filter((e) => e.sent || released.has(e));
      digest.lastSent = now;
      const messages = new Map<string, PushMessage | null>();
      for (const subscription of this.store.pushSubscriptions()) {
        const prefs = `${subscription.prefs.attention}:${subscription.prefs.turns}`;
        if (!messages.has(prefs)) {
          const mine = shown.filter((e) => subscription.prefs[prefFor(e.kind)]);
          messages.set(prefs, mine.some((e) => released.has(e)) ? this.compose(tag, mine) : null);
        }
        const message = messages.get(prefs);
        if (message) void this.deliver(subscription, message).catch(() => {});
      }
      for (const entry of released) entry.sent = true;
    }
    const pending = entries.filter((e) => !e.sent);
    if (pending.length) {
      const next = Math.min(...pending.map((e) => this.releaseAt(digest, e)));
      digest.cancel = this.schedule(() => this.flush(tag), Math.max(0, next - now));
    } else if (digest.entries.size) {
      // Only sent entries are left: look again once the oldest expires, so they do not stay forever.
      const oldest = Math.min(...entries.map((e) => e.at));
      digest.cancel = this.schedule(() => this.flush(tag), Math.max(0, oldest + DIGEST_TTL_MS + 1 - now));
    } else if (now - digest.lastSent < PROJECT_COOLDOWN_MS) {
      // Empty, but its cooldown still holds the project's next finished turn back.
      digest.cancel = this.schedule(() => this.flush(tag), digest.lastSent + PROJECT_COOLDOWN_MS - now);
    } else this.digests.delete(tag);
  }

  /** One notification for a project's unseen events, newest first. */
  private compose(tag: string, entries: DigestEntry[]): PushMessage {
    const newest = entries[0];
    const { project, hostId } = newest.agent;
    const host = this.hostLabel(hostId);
    const target = entries.find((e) => e.kind === "attention") ?? newest;
    const base = { tag, url: `/?session=${encodeURIComponent(target.agent.key)}`, kind: target.kind, badge: this.waiting.size };
    if (entries.length === 1) {
      const what = newest.kind === "attention" ? "needs your input" : newest.kind === "turn-failed" ? "turn failed" : "turn finished";
      return { ...base, title: `${project} · ${what}`, body: `${newest.detail} — ${host}`.slice(0, 240) };
    }
    const count = (kind: NotificationKind) => entries.filter((e) => e.kind === kind).length;
    const waiting = count("attention"), failed = count("turn-failed"), done = count("turn-done");
    const parts = [
      waiting && `${waiting} need${waiting === 1 ? "s" : ""} input`,
      failed && `${failed} failed`,
      done && `${done} finished`,
    ].filter(Boolean);
    const label = { attention: "Needs input", "turn-failed": "Failed", "turn-done": "Done" } as const;
    const lines = entries
      .slice(0, MAX_LINES)
      .map((e) => clip(`${label[e.kind]} · ${e.agent.title ? `${e.agent.title}: ` : ""}${e.detail}`, 100));
    if (entries.length > MAX_LINES) lines.push(`+${entries.length - MAX_LINES} more`);
    return { ...base, title: `${project} · ${parts.join(", ")}`, body: `${lines.join("\n")}\n— ${host}` };
  }

  private async deliver(subscription: PushSubscriptionRecord, message: PushMessage): Promise<boolean> {
    if (this.closed) return false;
    const session = this.store.sessionById(subscription.sessionId);
    if (!session || session.expires <= this.now()) {
      this.store.removePushSubscription(subscription.endpoint, subscription.sessionId);
      return false;
    }
    try {
      await this.sender.send(subscription, JSON.stringify(message));
      return true;
    } catch (error) {
      if (this.closed) return false;
      const status = (error as { statusCode?: number }).statusCode;
      // The device unsubscribed or the subscription expired: forget it.
      if (status === 404 || status === 410) this.store.removePushSubscription(subscription.endpoint);
      return false;
    }
  }
}
