import type { Store } from "./store.ts";

/**
 * Settings that used to need an environment variable on every start. `litepaseo config set`
 * saves them with the rest of LitePaseo's data (so backups carry them); an environment
 * variable, when present, still wins for that run.
 */
export const CONFIG_KEYS = {
  port: {
    env: "LITEPASEO_PORT",
    fallback: "8787",
    summary: "Port the web console listens on",
    check: (value: string) =>
      /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? null : "Use a port number from 1 to 65535.",
  },
  bind: {
    env: "LITEPASEO_BIND",
    fallback: "127.0.0.1",
    summary: "Address to listen on (keep 127.0.0.1 behind a tunnel)",
    check: (value: string) => (/^[^\s/]{1,255}$/.test(value) ? null : "Use an IP address or host name, such as 127.0.0.1."),
  },
  "push-subject": {
    env: "LITEPASEO_PUSH_SUBJECT",
    fallback: "mailto:litepaseo@example.com",
    summary: "Contact sent to push services (mailto: or https: URL)",
    check: (value: string) => {
      if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
      try {
        if (new URL(value).protocol === "https:") return null;
      } catch {}
      return "Use mailto:you@example.com or an https:// address you control.";
    },
  },
} as const;
export type ConfigKey = keyof typeof CONFIG_KEYS;
export const configKeys = Object.keys(CONFIG_KEYS) as ConfigKey[];
export const isConfigKey = (key: string): key is ConfigKey => Object.hasOwn(CONFIG_KEYS, key);

const settingName = (key: ConfigKey) => `config.${key}`;

export function setConfig(store: Store, key: ConfigKey, value: string | null) {
  if (value !== null) {
    const problem = CONFIG_KEYS[key].check(value);
    if (problem) throw new Error(problem);
  }
  store.setSetting(settingName(key), value);
}

export type ConfigEntry = { key: ConfigKey; value: string; source: "environment" | "saved" | "default"; saved: string | null };

/** The value in effect for each key: environment, then saved configuration, then the default. */
export function effectiveConfig(store: Store, env: NodeJS.ProcessEnv): Record<ConfigKey, ConfigEntry> {
  const entries = configKeys.map((key): ConfigEntry => {
    const { env: name, fallback } = CONFIG_KEYS[key];
    const saved = store.setting(settingName(key));
    const fromEnv = env[name];
    if (fromEnv !== undefined && fromEnv !== "") return { key, value: fromEnv, source: "environment", saved };
    if (saved !== null) return { key, value: saved, source: "saved", saved };
    return { key, value: fallback, source: "default", saved };
  });
  return Object.fromEntries(entries.map((entry) => [entry.key, entry])) as Record<ConfigKey, ConfigEntry>;
}
