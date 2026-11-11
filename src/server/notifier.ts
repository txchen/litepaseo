import webpush from "web-push";
import type { AgentSummary } from "../shared/wire.ts";
import type { PushPrefs, PushSubscriptionRecord, Store } from "./store.ts";

export type NotificationKind = "attention" | "turn-done" | "turn-failed";

export interface PushMessage {
  title: string;
  body: string;
  /** Replaces an earlier notification for the same session on the device. */
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

/**
 * Turns directory transitions into push notifications: a session starting to need the user
 * (a permission or question appears) and a turn finishing or failing. Detection is per
 * transition, O(1); delivery fans out to the (few) subscribed devices.
 */
export class Notifier {
  private readonly store: Store;
  private readonly sender: PushSender;
  private readonly isViewing: (key: string) => boolean;
  private readonly hostLabel: (hostId: string) => string;
  private readonly waiting = new Set<string>();
  private readonly recent = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: {
    store: Store;
    sender: PushSender;
    isViewing: (key: string) => boolean;
    hostLabel: (hostId: string) => string;
    now?: () => number;
  }) {
    this.store = options.store;
    this.sender = options.sender;
    this.isViewing = options.isViewing;
    this.hostLabel = options.hostLabel;
    this.now = options.now ?? Date.now;
  }

  get waitingCount() {
    return this.waiting.size;
  }

  /** Feed every summary transition here (HostDirectory → Hosts.onTransition). */
  transition(previous: AgentSummary | null, next: AgentSummary | null) {
    const key = next?.key ?? previous!.key;
    if (next?.attention) this.waiting.add(key);
    else this.waiting.delete(key);
    // First sight is a baseline, not an event: nothing changed while we were watching.
    if (!previous || !next) return;
    const newPermission = next.pendingPermissions.some(
      (p) => !previous.pendingPermissions.some((q) => q.id === p.id),
    );
    if ((next.attention && !previous.attention) || newPermission) {
      const permission = next.pendingPermissions[0];
      const what = permission
        ? permission.kind === "question"
          ? `asks: ${permission.title || permission.name}`
          : `wants to ${permission.title || permission.name}`
        : "is waiting for you";
      this.emit("attention", next, `${next.project} · needs your input`, `${next.title || "Session"} ${what}`);
    } else if (previous.status === "running" && next.status !== "running") {
      if (this.now() - next.activityAt > STALE_MS) return;
      const failed = next.status === "error";
      this.emit(
        failed ? "turn-failed" : "turn-done",
        next,
        `${next.project} · ${failed ? "turn failed" : "turn finished"}`,
        next.title || "Session",
      );
    }
  }

  async test(sessionId: string) {
    const subs = this.store.pushSubscriptions().filter((s) => s.sessionId === sessionId);
    await Promise.all(
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
    return subs.length;
  }

  private emit(kind: NotificationKind, agent: AgentSummary, title: string, body: string) {
    if (this.isViewing(agent.key)) return; // the user is looking at it already
    const dedupeKey = `${kind}:${agent.key}`;
    const now = this.now();
    if (now - (this.recent.get(dedupeKey) ?? -Infinity) < DEDUPE_MS) return;
    this.recent.set(dedupeKey, now);
    if (this.recent.size > 5000) this.recent.clear();
    const message: PushMessage = {
      title,
      body: `${body} — ${this.hostLabel(agent.hostId)}`.slice(0, 240),
      tag: agent.key,
      url: `/?session=${encodeURIComponent(agent.key)}`,
      kind,
      badge: this.waiting.size,
    };
    const pref: keyof PushPrefs = kind === "attention" ? "attention" : "turns";
    for (const subscription of this.store.pushSubscriptions())
      if (subscription.prefs[pref]) void this.deliver(subscription, message);
  }

  private async deliver(subscription: PushSubscriptionRecord, message: PushMessage) {
    try {
      await this.sender.send(subscription, JSON.stringify(message));
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      // The device unsubscribed or the subscription expired: forget it.
      if (status === 404 || status === 410) this.store.removePushSubscription(subscription.endpoint);
    }
  }
}
