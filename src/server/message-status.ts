interface TimelineReader {
  fetchAgentTimeline(agentId: string, options: any): Promise<{
    entries: { item: { type: string; messageId?: string; clientMessageId?: string } }[];
    hasOlder: boolean; startCursor: { epoch: string; seq: number } | null;
  }>;
}

/** Positive evidence only. Missing, rewound, or out-of-window messages remain uncertain. */
export async function confirmedMessages(driver: TimelineReader, agentId: string, ids: string[], maxPages = 5) {
  const wanted = new Set(ids), confirmed = new Set<string>();
  let cursor: { epoch: string; seq: number } | null = null;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < maxPages && confirmed.size < wanted.size; pageNumber++) {
    const page = await driver.fetchAgentTimeline(agentId, {
      direction: cursor ? "before" : "tail", ...(cursor ? { cursor } : {}), limit: 200, projection: "projected",
    });
    for (const entry of page.entries) {
      const item = entry.item;
      if (item.type !== "user_message") continue;
      const id = item.clientMessageId ?? item.messageId;
      if (typeof id === "string" && wanted.has(id)) confirmed.add(id);
    }
    if (!page.hasOlder || !page.startCursor) break;
    const key = JSON.stringify(page.startCursor);
    if (seen.has(key)) break;
    seen.add(key); cursor = page.startCursor;
  }
  return [...confirmed];
}
