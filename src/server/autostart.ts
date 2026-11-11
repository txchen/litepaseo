import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface ServiceOptions { platform: string; home: string; directory: string; node: string; cli: string; env: NodeJS.ProcessEnv; uid: number }
const checked = (value: string) => { if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Service configuration cannot contain control characters."); return value; };
const quote = (value: string) => '"' + checked(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';
const xml = (value: string) => checked(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export function serviceDefinition(options: ServiceOptions) {
  const id = "litepaseo-" + createHash("sha256").update(options.directory).digest("hex").slice(0, 12);
  const env: Record<string, string> = { LITEPASEO_HOME: options.directory };
  for (const key of ["PATH", "LITEPASEO_PORT", "LITEPASEO_BIND", "LITEPASEO_PUSH_SUBJECT", "LITEPASEO_LOG_BYTES", "LITEPASEO_LOG_ARCHIVES"])
    if (options.env[key] !== undefined) env[key] = options.env[key]!;
  if (options.platform === "linux") {
    const name = id + ".service";
    return { name, path: join(options.env.XDG_CONFIG_HOME ?? join(options.home, ".config"), "systemd/user", name), content: [
      "[Unit]", "Description=LitePaseo console", "After=network.target", "StartLimitIntervalSec=0", "",
      "[Service]", "Type=simple", `ExecStart=${[options.node, options.cli, "serve"].map(v => quote(v).replace(/\$/g, "$$$$")).join(" ")}`,
      ...Object.entries(env).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`),
      "Restart=on-failure", "RestartSec=3", "TimeoutStopSec=15", "UMask=0077", "", "[Install]", "WantedBy=default.target", "",
    ].join("\n") };
  }
  if (options.platform === "darwin") {
    const name = "com.litepaseo." + id;
    return { name, path: join(options.home, "Library/LaunchAgents", name + ".plist"), content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(name)}</string>
<key>ProgramArguments</key><array>${[options.node, options.cli, "serve"].map(v => `<string>${xml(v)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>3</integer><key>ExitTimeOut</key><integer>15</integer>
<key>Umask</key><integer>63</integer>
</dict></plist>\n` };
  }
  throw new Error("Autostart supports Linux systemd and macOS launchd.");
}
export function manageService(action: string, options: ServiceOptions,
  run: (file: string, args: string[]) => string = (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) {
  const definition = serviceDefinition(options);
  if (action === "print") return definition.path + "\n" + definition.content;
  if (action === "status") return options.platform === "linux"
    ? run("systemctl", ["--user", "status", definition.name]) : run("launchctl", ["print", `gui/${options.uid}/${definition.name}`]);
  if (["start", "stop", "restart"].includes(action)) {
    if (!existsSync(definition.path)) throw new Error("Autostart is not installed for this home.");
    if (options.platform === "linux") run("systemctl", ["--user", action, definition.name]);
    else if (action === "stop") run("launchctl", ["bootout", `gui/${options.uid}`, definition.path]);
    else {
      let loaded = false;
      try { run("launchctl", ["print", `gui/${options.uid}/${definition.name}`]); loaded = true; } catch {}
      if (!loaded) run("launchctl", ["bootstrap", `gui/${options.uid}`, definition.path]);
      else run("launchctl", ["kickstart", ...(action === "restart" ? ["-k"] : []), `gui/${options.uid}/${definition.name}`]);
    }
    return `Service ${action} requested.`;
  }
  if (action === "install") {
    mkdirSync(dirname(definition.path), { recursive: true, mode: 0o700 });
    if (existsSync(definition.path)) {
      if (readFileSync(definition.path, "utf8") !== definition.content) throw new Error("Service configuration already exists with different settings. Uninstall it first.");
    } else writeFileSync(definition.path, definition.content, { mode: 0o600, flag: "wx" });
    if (options.platform === "linux") {
      run("systemctl", ["--user", "daemon-reload"]);
      run("systemctl", ["--user", "enable", "--now", definition.name]);
    } else run("launchctl", ["bootstrap", `gui/${options.uid}`, definition.path]);
    return `Installed ${definition.path}. Linux user services require linger for startup before login; macOS LaunchAgents start at login.`;
  }
  if (action === "uninstall") {
    if (!existsSync(definition.path)) return "Service is not installed.";
    if (options.platform === "linux") run("systemctl", ["--user", "disable", "--now", definition.name]);
    else run("launchctl", ["bootout", `gui/${options.uid}`, definition.path]);
    unlinkSync(definition.path);
    if (options.platform === "linux") run("systemctl", ["--user", "daemon-reload"]);
    return "Autostart removed; application data is preserved.";
  }
  throw new Error("Usage: litepaseo service print|install|uninstall|status|start|stop|restart");
}
