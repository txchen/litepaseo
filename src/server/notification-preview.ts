/** A bounded timeline read; never use the user's prompt or a previous turn as the preview. */
export async function notificationPreview(
  driver: { fetchAgentTimeline(agent: string, options: any): Promise<{ entries: {
    timestamp: string; item: { type: string; text?: string };
  }[] }> },
  agent: string,
  startedAt?: number | null,
  endedAt?: number,
): Promise<string | null> {
  const page = await driver.fetchAgentTimeline(agent, { direction: "tail", limit: 200, projection: "projected" });
  for (let i = page.entries.length - 1; i >= 0; i--) {
    const entry = page.entries[i];
    const at = Date.parse(entry.timestamp);
    if (endedAt && at > endedAt) continue;
    if (startedAt && at < startedAt) return null;
    if (entry.item.type === "user_message") return null;
    if (entry.item.type !== "assistant_message") continue;
    const text = entry.item.text?.replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 240);
  }
  return null;
}
