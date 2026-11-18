# Changelog

## 0.8.0

- Refresh a host's model lists from its settings: the Paseo daemon caches each provider's models until asked, so a newly released model (such as a new Codex model) stayed hidden in new sessions and profiles. Providers now show how many models they report and when the list was fetched, with "Refresh models" for every provider or one at a time; the result names any new models found.
- Rework host settings. Every provider is listed, including disabled and uninstalled ones, with its status and models; its options, diagnostic and refresh open in place. Custom providers can be removed on hosts that support it.
- Agent profiles and metadata generation pick provider, model, thinking level and mode from what the host reports instead of free-text IDs. Profiles and terminal profiles collapse to one-line summaries.
- Save changes from a bar that stays in view, with Discard and Ctrl/Cmd+S. Saving is blocked, with the reason shown, while a profile lacks a name or provider or an additional model lacks an ID. Leaving the page with unsaved changes asks first.
- Fix: opening a provider's options marked the page as changed; terminal profile arguments dropped newlines while typing; diagnostics showed as escaped JSON; plain checkboxes stretched across the row; changing one relay option resent the other; "Host plugins" showed on hosts without plugin support, where saving it failed; the plugin list did not load on hosts that report plugin management but not plugins; IDs for new profiles failed on plain-http addresses.
- After a daemon restart or update completes, the page reloads what the host now reports.

## 0.7.2

- Show images agents send from anywhere on their host, not only from their working directory: a screenshot in another repository or a temp folder used to appear as a link that copied its path. LitePaseo now reads it through the host's daemon, from the image's own folder. Images Paseo saved on a remote host's machine now show too. Only raster images (PNG, JPEG, WebP, GIF, BMP, AVIF) up to 16 MB are served this way; an image that no longer exists shows "Image failed to load".

## 0.7.1

- Recover in seconds when a host's connection goes silent: after a laptop sleeps, Wi-Fi changes or a network drops the connection without closing it, a conversation could load for up to about 50 seconds with no error until the Paseo SDK noticed. When a conversation is still loading after 2 seconds, LitePaseo now pings the host and reopens the connection if it does not answer within 3 seconds. In a test with a deliberately silenced connection, opening took 8 seconds instead of 49.
- Log every slow conversation open, including a browser joining a conversation that was already loading and one that gives up waiting (for example by reloading the page), as `timeline_wait`. Hosts that stop answering are logged as `host_unresponsive`, recoveries as `host_reconnected`. Diagnostic log lines now carry the time.
- Start each live stream response at once, so a slow open shows whether the wait was in LitePaseo, the network in between, or the host.

## 0.7.0

- Show an agent's subagents in its conversation, as the official Paseo app does. A header button sums them up (for example "3 subagents", "1 working", "1 needs input") and opens a Subagents panel that lists agents it delegated through Paseo and subagents its provider runs (Claude Task, Codex, pi-subagents and others), with live status.
- Open a provider subagent's conversation in the panel, read-only and live, with earlier messages on request. A subagent tool call in the conversation also gets an Open button.
- Open a delegated agent from the panel; its header links back to the parent agent. The sidebar is unchanged.
- The subagent list travels on the conversation's existing stream, so opening a chat needs no extra connection. LitePaseo follows the daemon's subagent events only while a conversation is open, plus 30 seconds.

## 0.6.11

- Hold pushes briefly while you are using LitePaseo on another device: a finished turn waits 45 seconds, an input request or failure 20 seconds, and a conversation you open in that time is not pushed to your other devices. A browser counts as in use while it is in the foreground with keyboard, pointer or touch input in the last 2 minutes; with nobody at a device, pushes go out at once as before.
- A conversation opened only briefly, then left, also counts as seen for later pushes.

## 0.6.10

- Merge push notifications per project on the server, so iPhones benefit too: 0.6.9 merged them in the service worker, which iOS does not support. Finished turns send at most one push per project every 2 minutes; turns finishing during that time go out together when it ends (for example "repo · 3 finished", newest first). Input requests and failed turns still notify immediately, listing the project's other unseen updates too.
- Leave conversations out of later pushes once you have opened them, replied, or answered their question.

## 0.6.9

- Merge push notifications per project: one notification per project lists the latest event of each conversation (for example "repo · 3 conversations, 1 needs input"), instead of one notification per conversation.
- Alert only for a project's first event or a conversation that needs your input; later finished turns in the same project update the notification silently. Tapping it opens the conversation waiting for you, else the newest one.

## 0.6.8

- Offer a reload when the server runs a different LitePaseo version than the open page, so long-lived tabs and installed apps pick up upgrades.
- Say what a conversation still loading after 3 seconds is waiting for: the connection to LitePaseo, or the host loading it.
- Add page age and recent background time to slow-open reports, to identify stale connections after sleep or network changes.

## 0.6.7

- Send a conversation's first rows as soon as the daemon returns them, instead of after the 500 ms live-update batch.
- Log slow conversation opens (over 3 seconds) with a per-layer breakdown and no conversation content: `timeline_slow` from the server (daemon subscription, history read, retries) and `timeline_slow_client` from the browser (stream connected, rows arrived, rendering, or left before rows arrived).

## 0.6.6

- Make the sidebar count under Workspaces/Recent always the number of workspaces listed, matching the host filter chips; it previously showed the number of projects under a Workspaces label. Hovering the count shows both, e.g. "45 workspaces in 23 projects".

## 0.6.5

- Publish releases to npm automatically from GitHub Releases through npm Trusted Publishing, with provenance. No application changes.

## 0.6.4

- Open local file links in agent messages in a workspace file tab instead of a page that does not exist. Absolute, relative, `file://`, `~/` and Windows drive paths are recognized, including link text with brackets or an image; the link also works in a new tab.
- Scroll to and mark the lines a link names (`:12`, `:12:3`, `:12-20`, `#L12`, `#L12-L20`) once; returning to a file tab keeps its scroll position, rendered or source view and marked lines. Markdown files opened at a line show their numbered source.
- Show directory links in the Files panel, expanded and selected.
- Resolve relative links and images in Markdown files opened in a tab against that file. Images in messages and files load when the host can serve them; SVG and other non-raster files become links that open them, and anything else (paths outside the workspace, images Paseo saved on a remote daemon's machine) becomes a click-to-copy path instead of a broken image or link.
- Fix Copy path in file tabs for absolute paths.

## 0.6.3

- Suppress conversation push notifications across devices while a foreground browser is viewing that conversation; expire disconnected viewers automatically.

## 0.6.2

- Trigger automatic history paging from touch gestures at scroll boundaries, including short windows; reset paging intent when switching conversations.
- Bound the initial timeline fetch instead of expanding entire turns, avoiding oversized initial loads for tool-heavy conversations.

## 0.6.1

- Make message image previews scrollable so square and tall images remain fully accessible on desktop and mobile; keep a visible close button and support keyboard scrolling.

## 0.6.0

- Set an instance name in Web Settings; show it in browser tabs, the sidebar and sign-in, and synchronize it across connected clients.
- Add per-host settings for agent instructions, orchestration/browser tools, idle cleanup, restart recovery, workspaces, usage and relay, with capability checks, conflict detection and save verification.
- Manage agent and terminal profiles, and select them when creating sessions and terminals. Configure providers, additional models and metadata generation priorities.
- Manage Paseo skill selection and installed host plugins, including trusted source installation. Keep LitePaseo voice input and notifications independent.
- Show remote daemon versions and status; request remote updates and restarts, track progress across navigation, and verify the replacement worker and installed version before reporting success. Respect Desktop-managed and unsupported installations.
- Increase phone conversation text to 16px and improve form and supporting-text sizes without changing desktop typography.

## 0.5.7

- Default to Steer for supported providers and Queue otherwise; keep composer controls contained at narrow widths and increased zoom.
- Offer separate Queue, native Steer, and Interrupt modes. Reject unsupported providers without sending and preserve drafts. Explain that the existing Paseo API may interrupt if native steering is unavailable at runtime; no daemon changes are included.

## 0.5.6

- Align the pinned-project icon beside the project name, preserving a single compact row.
- Persist newly sent chat images in the BFF and show clickable thumbnails in conversation history, including queued messages and after restarts. Previously discarded images cannot be recovered.

## 0.5.5

- Compact the usage summary and apply the bottom safe-area inset only once, fixing the sidebar footer layout on iPhone home-screen apps.
- Preserve 44px touch targets for footer buttons and verify layout with a simulated iPhone safe area.

## 0.5.4

- Keep the active host filter visible when view options are collapsed. Click the host label to reopen filters, or clear it directly to show all hosts.

## 0.5.3

- Pin projects from the project menu to keep driver repositories above unpinned projects. Pinned projects retain their pin order as other projects become active.
- Project pins persist in the BFF, synchronize across devices, and survive project renames and restarts. Unpin restores normal activity ordering.

## 0.5.2

- Queue controls: pause/resume, move earlier, and confirm uncertain deliveries without resending. Sidebar badges and queue event streams replace periodic polling.
- Queue payloads are stored separately with atomic writes; legacy queues migrate automatically. Completed-message deduplication receipts are retained for 30 days.
- Read-only workspace Changes panel with expandable diffs and file-path copying.
- Full-history conversation search with paginated results and jumps to matching messages, including merged streaming replies.
- Guard concurrent queue delivery checks and ignore stale queue/search responses. Load diff contents only when expanded and clear stale diffs after failed refreshes.

## 0.5.1

- Turn-finished push notifications preview the latest agent reply instead of the thread
  title (usually the first prompt). Failed turns show their error when available.

- Queued messages and attachments are saved by the BFF and sent when the agent finishes,
  even after the browser closes or the device sleeps. Pending messages survive BFF restarts
  and are visible across signed-in devices. Edit text, remove, or interrupt from the queue.
- Uncertain deliveries pause the queue for review instead of automatically retrying.

## 0.5.0

### Sidebar

- Project rows follow Paseo: the fold chevron takes the project icon's place on hover
  (down when open, right when collapsed), and the actions on the right show only on hover.
- A project's ⋮ menu (or right-click) offers **Project settings…** and **Remove project…**.
  Removing archives the project's threads and removes it from the host's projects; files
  on disk are not touched.
- Project settings is Paseo's form for the project's `paseo.json` on its host: worktree
  setup and teardown commands, scripts (each edited in its own dialog, optionally run as a
  service) and metadata-generation instructions for branch names, commit messages and
  pull requests. Fields the form does not show are kept as they are, and saving never
  overwrites a `paseo.json` that changed on the host in the meantime.
- The pencil next to the project's name opens **Edit project**: rename it (blank returns to
  the derived name) and set its icon from an image file or an image or website URL, or go
  back to the automatic icon. The LitePaseo server downloads URL icons, since a browser
  cannot. Sidebar icons now show custom icons and refresh when one changes.

## 0.4.2

### Terminal

- Terminals open in the center as workspace tabs, alongside conversations and files.
  Switching back to the conversation keeps the terminal mounted.
- Unicode 11 character widths and WebGL rendering improve emoji, box drawing and
  Powerline symbols, with a DOM renderer fallback when WebGL is unavailable.
- Terminal code and styles load on demand; the new rendering addons add about 40 KB gzip.

### Conversation

- Thinking that is a single long line can be opened again. It showed cut off with "…" but
  did not expand, because only thinking with more than one line counted as expandable.

### Command line

- Commands such as `status`, `token`, `config` and `logs` start in about 0.06 s instead of
  0.3 s: the server code now loads only when the server itself starts.

## 0.4.1

### Task board

- A new task no longer links itself to whichever conversation was last open. Choose a
  conversation when adding the task (none by default), or link one later from the card.
- Cards name the conversation they link to, can be unlinked, and say when the conversation
  is no longer available.
- Tasks open in a detail view: rename them, write a Markdown description, add and delete
  comments, change the column or the linked conversation, or delete the task. Cards show a
  line of the description and the comment count.
- Task edits are saved per task, so two open tabs no longer overwrite each other's changes.

**Upgrading from 0.4.0:** existing tasks keep their columns and links. A task that was linked
automatically to the wrong conversation can now be unlinked from its card.

## 0.4.0

### Conversation

- Messages sent while a turn runs (the **Queue** setting, formerly Steer) wait in a list above
  the composer instead of appearing in the conversation. Each can be edited, removed, or sent at
  once with **Interrupt**; the rest go one per turn when the agent finishes. Queued messages
  stay in the open tab, which warns before closing while any are waiting.
- Code blocks and opened files are syntax highlighted (highlight.js, common languages, loaded
  on demand; very large text stays plain).
- Long conversations load earlier and newer messages as you scroll, and return to the live
  tail at the bottom, instead of asking for a click per page. Only about 150 rows stay mounted.
- Outline rail, as in Paseo: one tick per prompt along the left edge of a wide conversation.
  Resting on it previews the prompt; clicking jumps there, even far back in history.
- Rewind from a user message (hover it): rewind the conversation, the files, or both, as the
  agent's provider supports. The rewound prompt returns to an empty composer.
- Finished turns show Copy, the model, the finish time and how long the turn took, with icons,
  as in Paseo. User messages show their time and a copy button on hover.

### Settings without environment variables

- `litepaseo config` shows the port, listening address and push contact, and where each value
  comes from. `litepaseo config set <key> <value>` saves one; it applies on every start and is
  included in backups. `LITEPASEO_PORT`, `LITEPASEO_BIND` and `LITEPASEO_PUSH_SUBJECT` still
  work and override the saved value for that run.

### Notifications

- In Brave, turning notifications on no longer fails with a bare "push service error": Settings
  says to enable **Use Google services for push messaging** in `brave://settings/privacy`. Other
  browsers that cannot reach their push service get a short explanation too.

**Upgrading from 0.3.x:** no data migration; drafts, boards and settings are kept. The
outline rail needs a Paseo daemon with the prompt index (older daemons simply show no rail),
and Rewind appears only for providers that support it. The composer's **Steer** setting is
now called **Queue**: messages wait in this tab until the running turn ends.

## 0.3.1

### Faster voice input

- Voice input uploads audio while recording. Compatible services use Realtime transcription;
  file-only services transcribe phrases during pauses so earlier speech is processed before
  recording ends. Partial text appears above the composer; stopping inserts the final result.
- Cancel stops microphone capture and pending transcription. Voice sessions use one-use
  tickets, expire with sign-in sessions, and keep API credentials on the server.
- Completion logs include audio duration, first-text latency, and time from Stop to final
  text, without recording audio or transcript content.

### Sign-in hardening

- Fixed: with authenticator sign-in off, a bearer token in the `Authorization` header was checked
  without any limit on failed attempts. Bearer tokens now share the sign-in failure budget, and
  are accepted only on direct connections: never through Cloudflare Tunnel or another proxy,
  where only browser sign-in admits anyone. Upgrade if LitePaseo is reachable from the internet.
- `litepaseo token set` chooses your own access token (at least 16 characters, typed without
  echo or read from standard input); `litepaseo token rotate` replaces it with a new random one.
  Both take effect in the running server without a restart, sign out every browser, and end
  open streams that used the old token.
- New guide: [Protecting LitePaseo with Cloudflare Access](docs/cloudflare-access.md), including
  the bypass rule that keeps app install and notifications working.

**Upgrading from 0.3.0:** existing transcription settings and model selection are preserved.
Reverse proxies must allow WebSocket upgrades on `/api/dictation/stream`. Scripts that sent the
bearer token through a tunnel or proxy must sign in instead or run on the LitePaseo machine.

## 0.3.0

### Voice input, configured once in LitePaseo

- Add an OpenAI-compatible speech-to-text service once in **Settings → Voice input**: base URL,
  API key, model, the languages you speak, and vocabulary to spell correctly. The microphone
  then appears in the composer on every device and works for every host. Paseo daemons are
  no longer involved.
- `gpt-transcribe` is the default model. It receives `languages[]` and `keywords[]`. This fixes
  mixed-language dictation, such as `zh, en`, which Paseo's dictation cannot do because it
  always sends a single `language` that defaults to `en`. Whisper-style models (`whisper-1`,
  `gpt-4o(-mini)-transcribe`, Groq, local Whisper servers) receive one `language` and the
  vocabulary as a `prompt`. If a model rejects the language field, LitePaseo retries once with
  the other format.
- The API key stays on the LitePaseo server and is included in backups. Browsers see only its
  last four characters.

**Upgrading from 0.2.0:** voice input no longer uses each host's Paseo dictation settings
(`features.dictation` in `~/.paseo/config.json`). The microphone stays hidden until you set up
a transcription service in Settings → Voice input.

### Command line

- Commands in `litepaseo help` are grouped by purpose, and `litepaseo help <command>` or
  `<command> --help` describes options and examples. Unknown commands exit 2 and suggest a
  correction for typos.
- `-v`/`--version` prints the version. `litepaseo version` also shows Node.js, platform, data
  directory and the version of the running instance.
- `status` shows a readable summary (address, uptime, processes, restarts, last error). Add
  `--json` for scripts; it exits 3 when stopped. `start`, `status` and `version` warn when an
  upgrade needs a restart.
- `logs` supports `-n`/`--lines` and `-f`/`--follow`, and `--follow` continues across log
  rotation. `stop` waits until the instance has exited.

### Web

- Schedules and Hosts moved to icons in the sidebar footer. The Hosts icon shows a warning dot
  while any host is disconnected.
- On a phone, the sidebar footer and usage panel are reachable again, and schedule rows use
  the full width.
- Decorative motion advances once per second, together with the turn timer.
- The stop button in the composer has a larger glyph.

### Fixes

- The worker no longer crashes with "database is not open" when host updates arrive during
  shutdown.
