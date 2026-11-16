/** Short browser leases, independent of timeline subscriptions and push enrollment. */
export class ViewingPresence {
  private entries = new Map<string, { session: string; key: string | null; seq: number; expires: number }>();
  private validSession: (id: string) => boolean;
  private now: () => number;
  constructor(validSession: (id: string) => boolean, now = Date.now) {
    this.validSession = validSession;
    this.now = now;
  }
  update(session: string, tab: string, seq: number, key: string | null) {
    this.prune();
    const id = `${session}:${tab}`, previous = this.entries.get(id);
    if (previous && seq <= previous.seq) return;
    this.entries.set(id, { session, key, seq, expires: this.now() + 45_000 });
  }
  isViewing(key: string) {
    this.prune();
    return [...this.entries.values()].some(entry => entry.key === key);
  }
  private prune() {
    for (const [id, entry] of this.entries) if (entry.expires <= this.now() || !this.validSession(entry.session)) this.entries.delete(id);
  }
}
