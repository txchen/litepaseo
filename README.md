# LitePaseo

**A resource-conscious web console for your Paseo agents.**

Keep track of coding agents across machines, read their output, send messages,
and respond when they need your input—from a desktop browser or your phone.
LitePaseo connects to existing Paseo daemons through the official SDK.

## Why LitePaseo?

An agent dashboard often stays open for hours. Its job is to keep you informed
while leaving CPU and memory available for your agents and the rest of your work.
That is the reason for LitePaseo: a console designed around doing less work when
there is less to show.

Resource use shapes how it works:

- **Send changes, not entire conversations.** The server shares daemon subscriptions
  and sends incremental updates to browsers.
- **Batch streaming output every 500 ms.** Messages remain live without rendering
  every arriving token. Persistent status animations advance twice per second.
- **Keep rendering bounded.** The sidebar is windowed, and conversation history
  mounts at most 150 message rows, even after paging through older messages.
- **Pause hidden tabs.** Browser streams close while a tab is hidden and resume
  from their cursors when it becomes visible.
- **Reuse rendered content.** Markstream retains settled Markdown blocks while the
  message tail grows, with smooth streaming and typewriter effects disabled.
- **Load the heavy parts later.** Markstream (about 700 KB) loads after sign-in, while
  the browser is idle; until then messages use a small built-in renderer. Built assets
  are served precompressed (Brotli/gzip) and cached permanently by content hash.

These are concrete design choices, not a claim of lower resource use in every
workload. Very large single code blocks can still be expensive. See the
[rendering measurements and limitations](docs/markstream-integration-validation.md).

## What you can do

- Manage conversations across multiple Paseo hosts in one place.
- Create sessions, choose a provider/model, send messages, stop turns, and answer
  permission requests or structured questions.
- Attach files and images, with previews and upload status.
- Keep a Todo / Doing / Done board linked to conversations.
- Receive notifications when an agent needs input or finishes, and install the
  console as a phone or desktop web app.
- Keep drafts across reloads and check uncertain message delivery without
  automatically resending.

## Install and start

You need **Node.js 24.11 or newer**, npm, and at least one existing Paseo daemon.
The server targets Linux and macOS; live validation has primarily been on Linux.

```sh
npm install --global litepaseo
litepaseo start
litepaseo token
```

1. Open **http://127.0.0.1:8787** on the machine running LitePaseo.
2. Sign in with the access token printed by `litepaseo token`.
3. Open **Hosts** and add your daemon using a connection URL, pairing offer, or
   SSH target supported by the Paseo SDK.
4. Open an existing conversation or create a new session.

The npm package includes the built web interface; installation requires no
frontend build. `start` runs LitePaseo in the background with crash recovery and
rotating logs. It does not install or start Paseo daemons for you.

For access from another device, put LitePaseo behind your HTTPS reverse proxy or
tunnel. The default listener is local to the server. HTTPS also enables web-app
installation and push notifications.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `litepaseo start` | Start in the background |
| `litepaseo status` | Check readiness and process status |
| `litepaseo stop` | Stop the background service |
| `litepaseo restart` | Restart a manually launched instance |
| `litepaseo logs` | Show recent logs |
| `litepaseo token` | Print the sign-in token |
| `litepaseo serve` | Run in the foreground |
| `litepaseo --help` | List commands |

For automatic startup, install a systemd user service on Linux or a LaunchAgent
on macOS:

```sh
litepaseo service print
litepaseo stop
litepaseo service install
```

Use `litepaseo service restart` for an OS-managed installation. Linux startup
before login requires user lingering; macOS starts the service at login.
See the [operations guide](docs/operations.md#supervision-autostart-and-logs)
for configuration and lifecycle details.

### Configuration

Set these variables before starting LitePaseo:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LITEPASEO_PORT` | `8787` | HTTP port |
| `LITEPASEO_BIND` | `127.0.0.1` | Listening address |
| `LITEPASEO_HOME` | `~/.litepaseo` | Application data directory |
| `LITEPASEO_PUSH_SUBJECT` | — | Contact URL or `mailto:` address for push services |

For example:

```sh
LITEPASEO_PORT=9000 litepaseo start
```

LitePaseo's data directory contains credentials and settings. Conversation
history stays on your daemons, and drafts stay in browser storage.

## How it fits together

```text
Browser / installed web app
  Vue 3 + Markstream
           │
           │ HTTP actions + Server-Sent Events
           ▼
LitePaseo server
  Node.js + Hono + SQLite
           │
           │ Official Paseo SDK
           ├── Paseo daemon · machine A
           └── Paseo daemon · machine B
```

The **browser** renders the interface and keeps local drafts. It receives only
the changes it needs to display.

The **server** owns daemon connections, authentication, shared subscriptions,
notifications and bounded timeline updates. SQLite stores LitePaseo's metadata,
including hosts, the board and signed-in devices. Daemon credentials stay here.

The **daemons** run the agents and own their conversation history. LitePaseo is
a client of those daemons; no daemon plugin is required.

Everything ships as one npm package: a Node service and prebuilt browser assets.
There is no separate database service to deploy.

## Run from source

From a checkout of this repository:

```sh
npm ci
npm run build
node dist/server/cli.mjs start
node dist/server/cli.mjs token
```

For frontend development, run `node dist/server/cli.mjs serve` and `npm run dev`
in separate terminals. The development proxy targets port 8787.

To test a local npm installation:

```sh
npm run build
npm pack
npm install --global ./litepaseo-0.1.0.tgz
litepaseo start
```

Use the tarball filename printed by `npm pack` if the version has changed.

Validation:

```sh
npx playwright install chromium
npm run check
node tests/package.mjs
```

## Further reading

- [Operations guide](docs/operations.md): phone setup, notifications, backups,
  service management, diagnostics and attachment limits.
- [Markstream integration and measurements](docs/markstream-integration-validation.md).
- [Performance measurements](docs/performance-plan.md) and the
  [benchmark harness](benchmarks/README.md).

## License

[MIT](LICENSE).
