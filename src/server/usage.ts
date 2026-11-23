import type { Hosts } from "./hosts.ts";

/** Paseo's daemon caches usage for 5 minutes; reading more often only re-reads its copy. */
const FRESH_MS = 5 * 60_000;
const FAILED_RETRY_MS = 60_000;

export interface UsageWindow {
  id: string;
  label: string;
  shortLabel: string | null;
  remainingPct: number | null;
  resetsAt: string | null;
  durationSeconds?: number | null;
  runsOutAt?: string | null;
  shortfallPct?: number | null;
  summary?: boolean;
  tone: string | null;
}
export interface UsageBalance {
  id: string;
  label: string;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  unit: "usd" | "credits" | "requests" | "tokens";
  resetsAt: string | null;
  tone: string | null;
}
export interface UsageAccount {
  /** Same provider, plan and reset times on several hosts is one account. */
  key: string;
  providerId: string;
  name: string;
  plan: string | null;
  source: string | null;
  status: string;
  error: string | null;
  windows: UsageWindow[];
  balances?: UsageBalance[];
  hosts: string[];
}
export interface UsageReport {
  fetchedAt: string | null;
  accounts: UsageAccount[];
  unavailableHosts: { hostId: string; label: string; error: string }[];
}

type HostUsage = { at: number; ok: boolean; providers: any[]; error?: string };

/**
 * Usage across every connected host. Each host is read at most once per freshness window and
 * only when someone asks (nothing polls while no screen shows usage); concurrent requests share
 * one in-flight read per host.
 */
export class UsageService {
  private readonly hosts: Hosts;
  private readonly cache = new Map<string, HostUsage>();
  private readonly inflight = new Map<string, Promise<HostUsage>>();
  private readonly now: () => number;

  constructor(hosts: Hosts, now: () => number = Date.now) {
    this.hosts = hosts;
    this.now = now;
  }

  async report(force = false): Promise<UsageReport> {
    // Removed hosts never come back under the same ID: their readings go.
    for (const id of this.cache.keys()) if (!this.hosts.clients.has(id)) this.cache.delete(id);
    const ids = [...this.hosts.clients.keys()].filter((id) => this.hosts.state(id) === "connected");
    const results = await Promise.all(ids.map(async (id) => [id, await this.read(id, force)] as const));
    const accounts = new Map<string, UsageAccount>();
    const unavailableHosts: UsageReport["unavailableHosts"] = [];
    let newest = 0;
    for (const [hostId, usage] of results) {
      const label = this.hosts.label(hostId) || hostId;
      if (!usage.ok) {
        unavailableHosts.push({ hostId, label, error: usage.error ?? "Usage unavailable" });
        continue;
      }
      newest = Math.max(newest, usage.at);
      for (const p of usage.providers) {
        const windows: UsageWindow[] = (p.windows ?? []).map((w: any) => ({
          id: String(w.id),
          label: String(w.label),
          shortLabel: w.shortLabel ?? null,
          remainingPct:
            typeof w.remainingPct === "number"
              ? w.remainingPct
              : typeof w.usedPct === "number"
                ? Math.max(0, 100 - w.usedPct)
                : null,
          resetsAt: w.resetsAt ?? null,
          ...(typeof w.durationSeconds === "number" ? { durationSeconds: w.durationSeconds } : {}),
          ...(typeof w.runsOutAt === "string" ? { runsOutAt: w.runsOutAt } : {}),
          ...(typeof w.shortfallPct === "number" ? { shortfallPct: w.shortfallPct } : {}),
          ...(typeof w.summary === "boolean" ? { summary: w.summary } : {}),
          tone: w.tone ?? null,
        }));
        const balances: UsageBalance[] = (p.balances ?? []).map((b: any) => ({
          id: String(b.id),
          label: String(b.label),
          used: typeof b.used === "number" ? b.used : null,
          remaining: typeof b.remaining === "number" ? b.remaining : null,
          limit: typeof b.limit === "number" ? b.limit : null,
          unit: (b.unit === "usd" || b.unit === "credits" || b.unit === "requests" || b.unit === "tokens") ? b.unit : "credits",
          resetsAt: b.resetsAt ?? null,
          tone: b.tone ?? null,
        }));
        if (!windows.length && !balances.length && p.status === "unavailable") continue; // provider not signed in there
        const key = [
          p.providerId,
          p.planLabel ?? "",
          p.sourceLabel ?? "",
          ...windows.map((w) => `${w.id}@${w.resetsAt ?? ""}`),
          ...balances.map((b) => `b:${b.id}@${b.resetsAt ?? ""}`),
        ].join("|");
        const existing = accounts.get(key);
        if (existing) existing.hosts.push(label);
        else
          accounts.set(key, {
            key,
            providerId: String(p.providerId),
            name: String(p.displayName ?? p.providerId),
            plan: p.planLabel ?? null,
            source: p.sourceLabel ?? null,
            status: String(p.status),
            error: p.error ?? null,
            windows,
            ...(balances.length ? { balances } : {}),
            hosts: [label],
          });
      }
    }
    return {
      fetchedAt: newest ? new Date(newest).toISOString() : null,
      accounts: [...accounts.values()].sort(
        (a, b) => a.name.localeCompare(b.name) || (a.plan ?? "").localeCompare(b.plan ?? "") || a.key.localeCompare(b.key),
      ),
      unavailableHosts,
    };
  }

  private read(hostId: string, force: boolean): Promise<HostUsage> {
    const cached = this.cache.get(hostId);
    const age = cached ? this.now() - cached.at : Infinity;
    if (cached && age < (cached.ok ? FRESH_MS : FAILED_RETRY_MS) && !(force && age > 30_000))
      return Promise.resolve(cached);
    const pending = this.inflight.get(hostId);
    if (pending) return pending;
    const request = (async (): Promise<HostUsage> => {
      try {
        const result = await this.hosts.get(hostId).api.providers.listUsage();
        return { at: this.now(), ok: true, providers: (result as any).providers ?? [] };
      } catch (error) {
        return { at: this.now(), ok: false, providers: [], error: (error as Error).message || "Usage unavailable" };
      }
    })().then((usage) => {
      // A host removed while its read was in flight is not cached again.
      if (this.hosts.clients.has(hostId)) this.cache.set(hostId, usage);
      this.inflight.delete(hostId);
      return usage;
    });
    this.inflight.set(hostId, request);
    return request;
  }
}
