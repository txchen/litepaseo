# Changelog

## Unreleased

### Settings without environment variables

- `litepaseo config` shows the port, listening address and push contact, and where each value
  comes from. `litepaseo config set <key> <value>` saves one; it applies on every start and is
  included in backups. `LITEPASEO_PORT`, `LITEPASEO_BIND` and `LITEPASEO_PUSH_SUBJECT` still
  work and override the saved value for that run.

### Notifications

- In Brave, turning notifications on no longer fails with a bare "push service error": Settings
  says to enable **Use Google services for push messaging** in `brave://settings/privacy`. Other
  browsers that cannot reach their push service get a short explanation too.

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
