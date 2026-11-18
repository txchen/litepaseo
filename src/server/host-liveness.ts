import { logEvent } from "./log-event.ts";

/** The DaemonClient surface the check needs; narrow so tests can supply a double. */
export interface LivenessDriver {
  getConnectionState(): { status: string };
  ping(options: { timeoutMs: number }): Promise<unknown>;
}

const PING_TIMEOUT_MS = 3000;
/** One check per host at most this often: a struggling host is not pinged in a loop. */
const MIN_INTERVAL_MS = 10_000;

/**
 * A daemon connection can stay open while nothing reaches the daemon any more (a laptop that
 * slept, a Wi-Fi change, a NAT that dropped the connection). The SDK only notices after two
 * failed heartbeats, up to about 50 seconds, and until then a conversation open waits with no
 * error. When a viewer waits, this asks the daemon to answer at once and, if it stays silent,
 * reopens the connection right away.
 */
export class HostLiveness {
  private checking: Promise<boolean> | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;
  private readonly driver: LivenessDriver;
  private readonly hostId: string;
  private readonly reconnect: () => void;
  private readonly now: () => number;

  constructor(driver: LivenessDriver, hostId: string, reconnect: () => void, now: () => number = Date.now) {
    this.driver = driver;
    this.hostId = hostId;
    this.reconnect = reconnect;
    this.now = now;
  }

  /** Resolves false when the daemon did not answer and the connection is being reopened. */
  check(reason: string): Promise<boolean> {
    if (this.checking) return this.checking;
    if (this.driver.getConnectionState().status !== "connected") return Promise.resolve(true);
    if (this.now() - this.lastAt < MIN_INTERVAL_MS) return Promise.resolve(true);
    this.lastAt = this.now();
    const started = this.now();
    this.checking = this.driver
      .ping({ timeoutMs: PING_TIMEOUT_MS })
      .then(
        () => true,
        () => {
          // Already reconnecting (or closed): nothing to force.
          if (this.driver.getConnectionState().status !== "connected") return false;
          logEvent("host_unresponsive", { hostId: this.hostId, reason, waitedMs: this.now() - started });
          this.reconnect();
          return false;
        },
      )
      .finally(() => (this.checking = null));
    return this.checking;
  }
}

/**
 * Reopens a DaemonClient connection through the SDK's own liveness-timeout path, so its
 * subscriptions restore as after any reconnect. The SDK has no public call for this yet.
 */
export function forceReconnect(driver: unknown) {
  const d = driver as { recordLivenessFailure?: (error: Error) => void; getConnectionState(): { status: string } };
  if (typeof d.recordLivenessFailure !== "function") return;
  const error = new Error("Host stopped responding");
  // Two consecutive failures reconnect; an earlier failed heartbeat may already count as one.
  for (let i = 0; i < 2 && d.getConnectionState().status === "connected"; i++) d.recordLivenessFailure(error);
}
