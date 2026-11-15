# Provider message delivery

Investigated 2026-11-15. Litepaseo pins `@getpaseo/client` and `@getpaseo/protocol` 0.15.3. The matrix below is based on the public **Paseo v0.15.3 source**, cross-checked against the locally installed server 0.15.4. This is source verification, not a live integration test of every provider binary. A connected host can run a different daemon or CLI version.

## Findings

Queue is a Litepaseo BFF feature: messages wait until the observed agent turn becomes idle. It does not require native provider steering. See [send-queue.ts](../src/server/send-queue.ts).

Paseo's `steer` request is **best effort with interrupt-and-replace fallback**, not a strict promise to preserve the running turn. `steerOrReplaceActiveTurn` tries the optional session method, records accepted input, and replaces the foreground turn when steering is unavailable. The fallback also applies to providers that implement steering but reject a particular input or state. A turn identity change is checked to avoid replacing a different turn. See [`AgentManager.steerOrReplaceActiveTurn`](https://github.com/getpaseo/paseo/blob/v0.15.3/packages/server/src/server/agent/agent-manager.ts) and [prompt dispatch](https://github.com/getpaseo/paseo/blob/v0.15.3/packages/server/src/server/agent/agent-prompt.ts).

| Paseo provider / adapter | Litepaseo Queue | Native steering path | Interrupt path |
| --- | --- | --- | --- |
| `claude` | Yes | Yes, pushes into the live SDK input with next priority; unavailable for slash commands, compaction, missing stream, or stale turn | Yes |
| `codex` | Yes | Yes, app-server `turn/steer` with expected native turn ID; unavailable for slash commands, missing/stale turn, or definitive rejection | Yes |
| `opencode` | Yes | Yes, legacy `session.promptAsync`; newer runtime uses session prompt with `delivery: steer` | Yes |
| `pi` | Yes | Yes, Pi RPC `steer`; slash commands and older binaries rejecting that RPC are unavailable | Yes |
| `omp` | Yes | Yes, OMP RPC `steer`; slash commands and definitive rejection are unavailable | Yes |
| `copilot`, `cursor`, generic ACP providers | Yes | **No** in Paseo's ACP adapter; a `steer` request falls back to replacement | Yes, ACP `session/cancel` |
| Plugin providers and custom aliases | Yes | Unknown without resolving the actual adapter/session contract | Contract requires interrupt, but implementation must be verified before claiming support |

Provider source: [Claude](https://github.com/getpaseo/paseo/blob/v0.15.3/packages/server/src/server/agent/providers/claude/agent.ts), [Codex](https://github.com/getpaseo/paseo/blob/v0.15.3/packages/server/src/server/agent/providers/codex-app-server-agent.ts), [OpenCode legacy](https://github.com/getpaseo/paseo/blob/v0.15.3/packages/server/src/server/agent/providers/opencode-agent.ts), [OpenCode v2](https://github.com/getpaseo/paseo/blob/v0.15.3/packages/server/src/server/agent/providers/opencode/v2/turns.ts), [Pi](https://github.com/getpaseo/paseo/blob/v0.15.3/packages/server/src/server/agent/providers/pi/agent.ts), [OMP](https://github.com/getpaseo/paseo/blob/v0.15.3/packages/server/src/server/agent/providers/omp/agent.ts), [ACP](https://github.com/getpaseo/paseo/blob/v0.15.3/packages/server/src/server/agent/providers/acp-agent.ts). See each adapter's `steerActiveTurn` and `interrupt` methods. ACP has no `steerActiveTurn` implementation.

The registry maps `copilot` and `cursor` to ACP adapters. Custom providers may extend a native provider or `acp`; the display ID alone does not identify their implementation. Plugin registrations can also supply provider implementations. See [provider registry](https://github.com/getpaseo/paseo/blob/v0.15.3/packages/server/src/server/agent/provider-registry.ts). Current documentation likewise distinguishes native adapters and the ACP catalog, but does not publish a steering capability matrix: [Providers](https://paseo.sh/docs/providers.md).

## Capability and API limitations

`AgentSession.steerActiveTurn` is optional while `interrupt` is required by the server interface. `AgentCapabilityFlags` has no standardized `supportsSteering` or `supportsInterrupt` member in protocol 0.15.3. Its extensible boolean map does not make invented flag names a documented contract. See [session interface](https://github.com/getpaseo/paseo/blob/v0.15.3/packages/server/src/server/agent/agent-sdk-types.ts) and [protocol flags](https://github.com/getpaseo/paseo/blob/v0.15.3/packages/protocol/src/agent-types.ts).

The current `main` branch still has the optional session steering method, interrupt fallback, and no standardized steering flag in the inspected interfaces: [manager](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/agent/agent-manager.ts), [server interface](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/agent/agent-sdk-types.ts), [protocol flags](https://github.com/getpaseo/paseo/blob/main/packages/protocol/src/agent-types.ts). These branch links are moving references; the matrix above is version-scoped.

## Litepaseo-only implementation

All shipped changes belong to Litepaseo. Native Claude, Codex, OpenCode, Pi and OMP adapters expose Steer; ACP and unknown adapters expose Queue and Interrupt only. The BFF rejects known unsupported steering before dispatch, and rejects an explicit Steer when the agent is idle, initializing, or has no known active turn. It uses existing directory state without additional probes. When idle, the composer sends a normal new message regardless of its previous active-turn mode. Definite local rejections retain the draft and attachments; uncertain upstream outcomes are not automatically retried.

Native steering uses Paseo's existing API. Runtime unavailability can still cause interruption inside Paseo. Litepaseo cannot intercept or suppress that fallback once the request is dispatched, so its UI explains this limitation rather than promising strict non-interruption. There is no daemon patch in this implementation.
