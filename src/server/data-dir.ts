import { cpSync, existsSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";

/** Locations before ~/.litepaseo: the platform data directories. */
export function legacyDirectory(env: NodeJS.ProcessEnv, home: string, platform: string) {
  return platform === "darwin"
    ? join(home, "Library/Application Support/LitePaseo")
    : join(env.XDG_DATA_HOME ?? join(home, ".local/share"), "litepaseo");
}

/** Whether a LitePaseo process answers on this control socket. */
export function socketIsLive(path: string, timeoutMs = 500) {
  return new Promise<boolean>((done) => {
    if (!existsSync(path)) return done(false);
    const s = connect(path);
    const finish = (live: boolean) => {
      s.destroy();
      done(live);
    };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
  });
}

/**
 * LitePaseo keeps everything in one directory, like Paseo's ~/.paseo: ~/.litepaseo, or
 * LITEPASEO_HOME (LITEPASEO_DATA_DIR still works). Data from the old platform location moves
 * over once, but never out from under a running instance: that one keeps its directory until
 * it is stopped.
 */
export async function resolveDataDirectory(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: string,
  isLive: (socket: string) => Promise<boolean> = socketIsLive,
): Promise<{ directory: string; notice?: string }> {
  const configured = env.LITEPASEO_HOME || env.LITEPASEO_DATA_DIR;
  if (configured) return { directory: resolve(configured) };
  const target = join(home, ".litepaseo");
  const legacy = legacyDirectory(env, home, platform);
  if (!existsSync(legacy) || existsSync(target)) return { directory: target };
  if (await isLive(join(legacy, "control.sock")))
    return {
      directory: legacy,
      notice: `LitePaseo is running from ${legacy}. Run "litepaseo stop", then start it again to move its data to ${target}.`,
    };
  try {
    renameSync(legacy, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // Different filesystems: copy, then remove the original.
    cpSync(legacy, target, { recursive: true, preserveTimestamps: true });
    rmSync(legacy, { recursive: true, force: true });
  }
  // The socket was verified dead above; a leftover file would block the instance lock.
  const socket = join(target, "control.sock");
  if (existsSync(socket)) unlinkSync(socket);
  return { directory: target, notice: `Moved LitePaseo data from ${legacy} to ${target}.` };
}
