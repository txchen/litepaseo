import type { MessageDeliveryMode } from "../shared/wire.ts";

// Native adapter implementations verified against Paseo 0.15.3.
// Runtime rejection can still trigger upstream interruption; see the research note.
const nativeSteering = new Set(["claude", "codex", "opencode", "pi", "omp"]);
export function messageDeliveryModes(provider: string): MessageDeliveryMode[] {
  return nativeSteering.has(provider) ? ["queue", "steer", "interrupt"] : ["queue", "interrupt"];
}
