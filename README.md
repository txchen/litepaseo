# LitePaseo

A functional preview of a Vue + Hono console for existing Paseo daemons, built with Vite+. The intended deployment is a private-network server running macOS or Linux. Browser ingress and Cloudflare Tunnel setup are user-managed.

## Run from source

Requires Node 24.11+ and npm. Node 24.11 emits an experimental warning for built-in SQLite.

```sh
npm ci
npm run build
node dist/server/cli.mjs start
node dist/server/cli.mjs token
```

Open the address printed by `start`, enter the token, and add an existing daemon through **Hosts**. Use a connection URL, pairing offer, or SSH target accepted by the official Paseo SDK. No daemon is automatically discovered or modified. Adding a host establishes a connection; starting sessions, sending messages, stopping turns and responding to approvals are explicit actions in the UI.

Other commands: `serve` (foreground), `status`, `stop`, `restart`, `logs`, `token`. Set `LITEPASEO_PORT` (default 8787), `LITEPASEO_BIND` (default 127.0.0.1), and optionally `LITEPASEO_HOME` before starting. All of LitePaseo's own data lives in one directory, `~/.litepaseo` by default (like Paseo's `~/.paseo`, and separate from it): `litepaseo.sqlite` (hosts and their connection strings, the Plan board, authenticator and push keys, signed-in devices, push subscriptions), `token`, rotating `service.log` files, `service-lock.sqlite` and `control.sock`. The directory is owner-only (0700, files 0600); treat it as secret. `LITEPASEO_DATA_DIR` is still accepted. Data from the earlier platform location (`~/.local/share/litepaseo` or `~/Library/Application Support/LitePaseo`) moves over automatically once that instance is stopped. Conversations stay on the daemons. Browsers sign in once and keep an HttpOnly session cookie; daemon credentials stay on the BFF.

For development, run the built BFF with `serve` and `npm run dev` in another terminal; the development proxy targets port 8787.

## Local npm installation

The package is private while feasibility is being validated. It has not been published.

```sh
npm run build
npm pack
npm install --global ./litepaseo-0.0.1.tgz
litepaseo start
litepaseo token
```

The tarball includes prebuilt frontend assets. Runtime installation does not require Vite+ or a frontend build.

## What works in this preview

- Independent official SDK connections, host management and a unified agent list.
- Projected timeline pages, message send with explicit steer/interrupt behavior, stop, and permission responses. Structured questions support single/multiple choices and text answers; unknown formats retain a JSON fallback.
- Persistent Todo/Doing/Done cards, optionally linked to a conversation, with optimistic concurrency protection.
- Background start/status/stop/restart, a private local control socket, and an authenticated browser API.

Live updates are incremental end to end. The BFF holds one directory subscription per daemon and resumes it from the daemon's directory-sync cursor after reconnects. Browsers receive only the agents that changed since their own cursor, over a server-sent event stream. An open conversation streams row-level upsert/append operations, and older history is paged in on demand. A hidden tab closes its streams and resumes from its cursor when shown again. Conversation bodies use a small built-in Markdown renderer. Streaming rows flush about every 500 ms. History navigation keeps at most 150 message rows mounted, with earlier/newer pages and a return-to-latest action. Persistent status/spinner animations advance on a two-step-per-second clock that stops while hidden or when reduced motion is requested. Drafts and uncertain sends survive reload in browser-local storage. Different tabs preserve separate drafts, sign-out clears saved composer state, and storage failures show a warning. Uncertain sends are checked automatically against exact user-message IDs in daemon history; unconfirmed messages remain saved. There is no automatic replay.

## Validation and limitations

```sh
npm run check
node tests/package.mjs
```

Browser tests require Playwright Chromium (`npx playwright install chromium` if absent). Tests use temporary data directories and stop their servers afterward. Browser fixtures simulate daemon responses; they do not prove live protocol interoperability.

Linux validation passed for TypeScript, production builds, API tests with two simulated hosts, background lifecycle, browser interactions and isolated tarball installation. The research SDK imports also passed on Node 24.11 and 26.12.1. A subsequent Linux run against a real 0.15.0 daemon validated creation, messages, timeline streaming and client reconnect; real tool approvals, active interruption, two-host isolation and macOS remain unverified; a real Codex question/answer round trip has also passed. Start live integration with **one existing daemon**; a second host is useful later for routing/failure-isolation acceptance, not a prerequisite to starting.

Background start runs a supervisor that restarts crashed workers with backoff. Autostart is opt-in through systemd/launchd; see below for login and reboot behavior. Stale control sockets are recovered only under the runtime lock after a refused connection; live, changed, inaccessible or unresponsive endpoints are left alone. There are no CPU/energy results.

## Design and research

- [Current implementation status](docs/implementation-status.md)
- [Technical design](docs/technical-design.md)
- [SDK review](docs/sdk-api-review.md) and [protocol detail](docs/protocol-integration-detail.md)
- [Toolchain validation](docs/toolchain-validation.md)
- [Lifecycle and storage research](docs/lifecycle-storage-detail.md)
- [Markdown rendering research](docs/rendering-detail.md)
- [Markstream published-package investigation and browser results](docs/markstream-integration-research.md)
- [Performance experiment plan](docs/performance-plan.md)

Research fixtures are under `research/`. Earlier design documents describe the target architecture, not every feature already implemented.

## Phone app and notifications

Open the console over HTTPS (for example your Cloudflare tunnel address); browsers only allow installation and push notifications on secure origins.

1. **Sign in once.** The browser receives an HttpOnly session cookie (30 days, extended while in use). Review or revoke devices under **Settings → Signed-in devices**.
2. **Optional: authenticator sign-in.** **Settings → Authenticator code → Set up** shows a QR code for any TOTP app; afterwards the sign-in page asks for a 6-digit code. Codes are single-use, and guessing is limited server-wide with a lockout that doubles up to 24 hours. The access token always remains a working fallback, and it is not affected by that lockout. Putting Cloudflare Access in front is still the strongest option.
3. **Install.** Android/desktop Chrome: **Settings → Install**, or the browser's install menu. iPhone/iPad: Safari → Share → **Add to Home Screen**, then open LitePaseo from the Home Screen. On iOS, push only works in the Home Screen app (iOS 16.4+).
4. **Turn on notifications** in **Settings → Notifications**: one push when an agent needs your input (permission or question), and one when a turn finishes or fails. A push is not sent to the signed-in device currently viewing that conversation; other subscribed devices still receive it. Tapping it opens that session. The app icon shows how many sessions are waiting.

Notifications are sent by this server, which is always connected to your daemons, through the browser vendor's push service (outbound HTTPS). Set `LITEPASEO_PUSH_SUBJECT=mailto:you@example.com` to your own contact address; Apple's push service requires a `mailto:` or `https:` subject.

Recovery from the server shell: `litepaseo totp-reset` turns authenticator sign-in off, and `litepaseo signout-all` revokes every browser and its notifications.


## Backups and upgrades

The database now has a schema version. Existing unversioned databases are migrated transactionally;
a private `pre-migration-v0-<id>.sqlite` snapshot is saved in the data directory first.
A newer, unsupported schema is refused instead of being modified.

Create a full backup, including the token, hosts, board, authenticator and push keys, sessions and subscriptions:

```sh
litepaseo backup /absolute/path/to/new-backup-directory
```

The destination must not exist. Backups can run while the server is running: SQLite's snapshot
includes committed WAL data. The backup directory is 0700 and files are 0600. Keep it private;
it contains working credentials. Conversation history remains on your daemons and browser drafts
remain in browser storage, so neither is included.

Restore into a **new, empty home**, leaving the original available for rollback:

```sh
LITEPASEO_HOME=/absolute/path/to/restored-home litepaseo restore /absolute/path/to/new-backup-directory
# Stop the old instance before starting the replacement on the same port.
LITEPASEO_HOME=/absolute/path/to/restored-home litepaseo start
```

Restore checks the manifest checksums, schema and database integrity, uses the service's exclusive
control socket to block concurrent startup, and rejects nonempty destinations. An interrupted
publish leaves a marker that prevents startup; restore the backup into another empty home.
Only the current backup format/schema is supported by restore.

## Connection diagnostics

Hosts shows the last successful connection, retry attempt/time and a classified failure with
suggested checks. SDK connection errors are classified without echoing remote text, connection
URLs or credentials into the browser or logs. Unexpected API failures include a reference ID
that can be matched to the `api_operation_failed` log entry.


## Supervision, autostart and logs

`start` launches a detached supervisor; `serve` runs it in the foreground. `status` reports the
supervisor PID, worker PID, readiness and restart count. The supervisor keeps the control socket
available while restarting a crashed worker, with delays from 250 ms up to 30 seconds. A worker
exits when its supervisor disconnects. A separate SQLite runtime lock is released by the kernel
even after SIGKILL, so a later supervisor can safely recover its dead control socket.

Install autostart explicitly (the implementation does not install a service just by being built):

```sh
litepaseo service print        # inspect the generated configuration and path
litepaseo stop                 # stop a manually launched instance before handing over
litepaseo service install      # install and start systemd user unit / launchd LaunchAgent
litepaseo service status
litepaseo service restart      # preserve OS supervision when restarting
litepaseo service stop
litepaseo service start
litepaseo service uninstall    # stop and remove autostart; preserve application data
```

Services are named per data directory, use the current absolute Node/CLI paths, and capture
PATH plus LitePaseo bind/port/push/log settings. Reinstall after changing installation paths or
those settings. Linux uses a systemd **user** unit: startup before login and survival after logout
require user lingering (`loginctl enable-linger <username>`, subject to host policy). macOS uses
a LaunchAgent and starts at login, not before login. macOS configuration generation is tested,
but actual launchd operation still needs a Mac. Linux systemd process restart was tested with
an isolated transient user unit. No persistent service was installed during development tests.

The supervisor rotates worker stdout/stderr into `service.log`, with a default maximum of 5 MiB
per file and three archives (`service.log.1` is the newest archive). Set `LITEPASEO_LOG_BYTES`
(1024–104857600 bytes) and `LITEPASEO_LOG_ARCHIVES` (1–20) before starting/installing to change these limits.
`logs` prints the tail of the current file. Files are owner-only.

## Delivery checks and attachments

Unknown sends are checked every 15 seconds while their conversation is open in a visible tab,
and can be checked manually. Only an exact user-message `clientMessageId` (or legacy `messageId`)
confirms delivery; identical text is not evidence. Each check examines at most five 200-row history
pages. If the message was rewound away or lies outside that window, it stays uncertain. Confirmation
clears only a draft restored from that failed send, preserving newer edits. No check resends a message.

Use **Attach files**, paste images, or drop files on the composer. Up to four files per message,
8 MiB each and 24 MiB staged per signed-in device are supported. The panel shows previews, upload
state, cancellation/removal and retry. Attachments may be sent with an empty text message.
PNG/JPEG/WebP/GIF use native image input for known Codex/Claude/Pi adapters; the selected model must
support vision. Other files require an agent advertising tool invocation support and are uploaded
to the daemon for it to read. Unsupported agents are disabled with an explanation.

Selected files/previews remain in the current tab, not browser draft storage. BFF staging is memory-only,
bounded to 64 MiB total and expires after 20 minutes; cancelling removes staged data, and server restart
requires re-upload. Ordinary files reach the daemon only when Send is pressed. Once submitted (or when
submission is uncertain), daemon-side uploads and provider-materialized images follow the daemon's
retention policy; LitePaseo does not delete files that an agent may still need. Unknown-send records
retain attachment names/IDs, not file bytes. A lost response is never retried automatically.

Opt-in integration checks:

```sh
LITEPASEO_TEST_SYSTEMD=1 node tests/systemd.mjs
LITEPASEO_TEST_HOST=127.0.0.1:6767 LITEPASEO_TEST_CREDENTIAL_FILE=/path/to/local-credential LITEPASEO_TEST_ATTACHMENTS=1 node tests/live-daemon.mjs
```

The second check creates a disposable agent, verifies an uploaded random file marker and a red image,
archives the agent and deletes its test upload. It consumes provider quota.
