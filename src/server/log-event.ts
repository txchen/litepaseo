/**
 * One diagnostic event as a JSON line in the service log, with the time it happened: the log
 * has no timestamps of its own, and events are only useful when they can be lined up.
 */
export function logEvent(event: string, fields: Record<string, unknown>, sink: (line: string) => void = console.warn) {
  sink(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
