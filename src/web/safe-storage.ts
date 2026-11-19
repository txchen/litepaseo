/**
 * localStorage that never throws. Restricted contexts (blocked site data, some private modes)
 * throw on access to `localStorage` itself, and a full quota throws on writes; preferences are
 * conveniences, so a failure reads as "nothing stored" and a lost write is ignored.
 */
function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function safeGetItem(key: string): string | null {
  try { return storage()?.getItem(key) ?? null; } catch { return null; }
}

/** True when the value was stored. */
export function safeSetItem(key: string, value: string): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch { return false; }
}

export function safeRemoveItem(key: string): void {
  try { storage()?.removeItem(key); } catch { /* nothing stored, nothing to remove */ }
}

/** The page's localStorage when accessible (e.g. to compare with `StorageEvent.storageArea`). */
export function localStorageOrNull(): Storage | null {
  return storage();
}
