/** How long a browser's report lasts without a heartbeat (it sends one every 15 s). */
const LEASE_MS = 45_000;
/** Last-viewed times older than this are forgotten; held notifications never wait that long. */
const VIEWED_TTL_MS = 60 * 60_000;

/**
 * Short browser leases, independent of timeline subscriptions and push enrollment. A browser
 * reports the conversation it shows (`key`) and whether someone is using it (`active`: in the
 * foreground with recent input), so pushes can wait while the user is at another device.
 */
export class ViewingPresence {
  private entries = new Map<string, { session: string; key: string | null; active: boolean; seq: number; expires: number }>();
  /** When each conversation was last on a foreground screen, for "seen since it finished". */
  private viewed = new Map<string, number>();
  private validSession: (id: string) => boolean;
  private now: () => number;
  constructor(validSession: (id: string) => boolean, now = Date.now) {
    this.validSession = validSession;
    this.now = now;
  }
  update(session: string, tab: string, seq: number, key: string | null, active = false) {
    this.prune();
    const id = `${session}:${tab}`, previous = this.entries.get(id);
    if (previous && seq <= previous.seq) return;
    this.entries.set(id, { session, key, active: active || key !== null, seq, expires: this.now() + LEASE_MS });
    if (key) {
      this.viewed.delete(key); // Re-insert: the map stays oldest → newest for pruning.
      this.viewed.set(key, this.now());
    }
  }
  isViewing(key: string) {
    this.prune();
    return [...this.entries.values()].some(entry => entry.key === key);
  }
  /** Someone is using LitePaseo on some device right now. */
  anyActive() {
    this.prune();
    return [...this.entries.values()].some(entry => entry.active);
  }
  /** The conversation was on a foreground screen at or after `at`. */
  viewedSince(key: string, at: number) {
    if (this.isViewing(key)) return true;
    return (this.viewed.get(key) ?? -Infinity) >= at;
  }
  private prune() {
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.expires <= now || !this.validSession(entry.session)) this.entries.delete(id);
    for (const [key, at] of this.viewed) {
      if (now - at <= VIEWED_TTL_MS) break;
      this.viewed.delete(key);
    }
  }
}
