# Changelog

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
