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

Other commands: `serve` (foreground), `status`, `stop`, `restart`, `logs`, `token`. Set `LITEPASEO_PORT` (default 8787), `LITEPASEO_BIND` (default 127.0.0.1), and optionally `LITEPASEO_HOME` before starting. All of LitePaseo's own data lives in one directory, `~/.litepaseo` by default (like Paseo's `~/.paseo`, and separate from it): `litepaseo.sqlite` (hosts and their connection strings, the Plan board, authenticator and push keys, signed-in devices, push subscriptions), `token`, `service.log` and `control.sock`. The directory is owner-only (0700, files 0600); treat it as secret. `LITEPASEO_DATA_DIR` is still accepted. Data from the earlier platform location (`~/.local/share/litepaseo` or `~/Library/Application Support/LitePaseo`) moves over automatically once that instance is stopped. Conversations stay on the daemons. Browsers sign in once and keep an HttpOnly session cookie; daemon credentials stay on the BFF.

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
- Projected timeline pages, message send with explicit steer/interrupt behavior, stop, and permission responses. Structured questions currently use JSON input rather than provider-specific forms.
- Persistent Todo/Doing/Done cards, optionally linked to a conversation, with optimistic concurrency protection.
- Background start/status/stop/restart, a private local control socket, and an authenticated browser API.

Live updates are incremental end to end. The BFF holds one directory subscription per daemon and resumes it from the daemon's directory-sync cursor after reconnects. Browsers receive only the agents that changed since their own cursor, over a server-sent event stream. An open conversation streams row-level upsert/append operations, and older history is paged in on demand. A hidden tab closes its streams and resumes from its cursor when shown again. Conversation rendering is plain text. Drafts and uncertain sends survive reload in browser-local storage. Different tabs preserve separate drafts, sign-out clears saved composer state, and storage failures show a warning. There is no automatic replay of uncertain sends.

## Validation and limitations

```sh
npm run check
node tests/package.mjs
```

Browser tests require Playwright Chromium (`npx playwright install chromium` if absent). Tests use temporary data directories and stop their servers afterward. Browser fixtures simulate daemon responses; they do not prove live protocol interoperability.

Linux validation passed for TypeScript, production builds, API tests with two simulated hosts, background lifecycle, browser interactions and isolated tarball installation. The research SDK imports also passed on Node 24.11 and 26.12.1. A subsequent Linux run against a real 0.15.0 daemon validated creation, messages, timeline streaming and client reconnect; real approvals, active interruption, two-host isolation and macOS remain unverified. Start live integration with **one existing daemon**; a second host is useful later for routing/failure-isolation acceptance, not a prerequisite to starting.

Full logout survival depends on OS session policy. Reboot autostart, crash supervision, automatic stale-socket recovery, log rotation, schema migrations, polished question forms remain unfinished. If a crash leaves `control.sock`, inspect the process before removing it; the CLI never kills a PID or deletes an unverified stale socket automatically. There are no CPU/energy results.

## Design and research

- [Current implementation status](docs/implementation-status.md)
- [Technical design](docs/technical-design.md)
- [SDK review](docs/sdk-api-review.md) and [protocol detail](docs/protocol-integration-detail.md)
- [Toolchain validation](docs/toolchain-validation.md)
- [Lifecycle and storage research](docs/lifecycle-storage-detail.md)
- [Markdown rendering research](docs/rendering-detail.md)
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
