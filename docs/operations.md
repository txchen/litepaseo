# Operating LitePaseo

This guide covers deployment, notifications, backups and service management.
For installation and first use, see the [README](../README.md).

## Data and access

LitePaseo stores its own data in `~/.litepaseo`, separately from Paseo's
`~/.paseo`. Set `LITEPASEO_HOME` to use another directory;
`LITEPASEO_DATA_DIR` is also accepted for compatibility.

The directory contains SQLite metadata, daemon connection strings, the access
token, authenticator and push keys, signed-in devices, subscriptions, rotating
logs, the runtime lock and the local control socket. It is owner-only (0700,
files 0600). Treat the directory and its backups as credentials.
Conversation history stays on the daemons; drafts stay in browser storage.

Browsers sign in with an access token plus an authenticator code when TOTP is enabled and receive
an HttpOnly session cookie. Daemon credentials stay on the server. Bind and port
are controlled by `LITEPASEO_BIND` (default `127.0.0.1`) and `LITEPASEO_PORT`
(default `8787`). HTTPS ingress and tunnel configuration are managed separately.

Data from the earlier platform location (`~/.local/share/litepaseo` or
`~/Library/Application Support/LitePaseo`) moves over automatically once that
instance is stopped.

## Phone app and notifications

Open the console over HTTPS (for example your Cloudflare tunnel address); browsers only allow installation and push notifications on secure origins.

1. **Sign in once.** The browser receives an HttpOnly session cookie (30 days, extended while in use). Review or revoke devices under **Settings → Signed-in devices**.
2. **Optional: two-factor sign-in.** **Settings → Authenticator code → Set up** shows a QR code for a TOTP app. Once enabled, new logins require **both the access token and a 6-digit code**. Codes alone, tokens alone and bare Bearer API tokens cannot bypass this requirement. Code guesses are checked only after the token is valid, are single-use, and have per-client limits plus a persistent server-wide lockout that doubles up to 24 hours. Enabling TOTP signs out other browsers; upgrading from the old code-only implementation signs out existing browsers once. Re-enable notifications on devices after signing in again. Lost authenticator access must be recovered from the server shell with `litepaseo totp-reset`.
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
