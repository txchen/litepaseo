import type { Store } from "./store.ts";
import type { TimelineItem } from "../shared/wire.ts";

type Image = { data: string; mimeType: string };
const key = (host: string, agent: string, id: string) => `message-images:${JSON.stringify([host, agent, id])}`;
/** Keep image bytes in the backed-up database; timeline payloads contain only URLs. */
export function saveMessageImages(store: Store, host: string, agent: string, id: string, images: Image[]) {
  if (!images.length) return;
  const prefix = key(host, agent, id);
  // A message ID is immutable, including when a send is retried after uncertain delivery.
  if (store.setting(prefix) !== null) return;
  store.db.exec("SAVEPOINT message_images");
  try {
    images.forEach((image, index) => store.setSetting(`${prefix}:${index}`, JSON.stringify(image)));
    store.setSetting(prefix, String(images.length));
    store.db.exec("RELEASE message_images");
  } catch (error) {
    store.db.exec("ROLLBACK TO message_images; RELEASE message_images");
    throw error;
  }
}
export function messageImage(store: Store, host: string, agent: string, id: string, index: number): Image | null {
  const raw = store.setting(`${key(host, agent, id)}:${index}`);
  return raw ? JSON.parse(raw) : null;
}
export function withMessageImages(store: Store, host: string, agent: string, item: TimelineItem): TimelineItem {
  if (item.type !== "user_message") return item;
  for (const id of [item.clientMessageId, item.messageId]) {
    if (typeof id !== "string") continue;
    const count = Number(store.setting(key(host, agent, id)) ?? 0);
    if (count) return { ...item, imageUrls: Array.from({ length: count }, (_, index) =>
      `/api/hosts/${encodeURIComponent(host)}/agents/${encodeURIComponent(agent)}/message-images/${encodeURIComponent(id)}/${index}`) };
  }
  return item;
}
