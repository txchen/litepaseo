/**
 * Turns an "image or website URL" into icon bytes, as Paseo's project edit sheet does
 * (packages/app import-project-icon, Apache-2.0). Paseo fetches from the app; a browser cannot
 * (CORS), so LitePaseo fetches here and hands the daemon the same upload payload a picked file
 * produces. The daemon still validates the bytes (format, square, size).
 */

export const MAX_ICON_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_CANDIDATES = 8;
const FETCH_TIMEOUT_MS = 10_000;

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid website or image URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("URL must use HTTP or HTTPS without credentials");
  return url;
}

async function fetchOk(fetchIcon: Fetch, url: URL): Promise<Response> {
  let response: Response;
  try {
    response = await fetchIcon(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "image/*,text/html;q=0.9,*/*;q=0.5" } });
  } catch (error) {
    throw new Error((error as Error).name === "TimeoutError" ? "Download timed out" : "Download failed");
  }
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  return response;
}

/** Reads at most maxBytes, stopping the download as soon as it is exceeded. */
async function readBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Icon must be 512 KB or smaller");
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("Icon must be 512 KB or smaller");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1]?.trim() || null;
}

/** The page's declared raster icons, then /favicon.ico. SVG is not a supported icon format. */
export function iconCandidates(html: string, page: URL): URL[] {
  const candidates: URL[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attribute(tag, "rel")?.toLowerCase() ?? "";
    const href = attribute(tag, "href");
    const type = attribute(tag, "type")?.toLowerCase() ?? "";
    if (!href || !rel.includes("icon") || type.includes("svg") || href.endsWith(".svg")) continue;
    try {
      candidates.push(new URL(href, page));
    } catch {
      // Try the next declared icon, then the conventional fallback.
    }
  }
  candidates.push(new URL("/favicon.ico", page));
  return candidates.filter((u) => u.protocol === "http:" || u.protocol === "https:").slice(0, MAX_CANDIDATES);
}

/** Base64 icon bytes from an image URL, or from the icons a web page declares. */
export async function importProjectIcon(value: string, fetchIcon: Fetch = fetch): Promise<string> {
  const url = parseHttpUrl(value.trim());
  const response = await fetchOk(fetchIcon, url);
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.includes("text/html")) return (await readBytes(response, MAX_ICON_BYTES)).toString("base64");

  const html = (await readBytes(response, MAX_HTML_BYTES)).toString("utf8");
  let lastError: unknown = new Error("Website does not expose a supported icon");
  for (const candidate of iconCandidates(html, new URL(response.url || url.href))) {
    try {
      return (await readBytes(await fetchOk(fetchIcon, candidate), MAX_ICON_BYTES)).toString("base64");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
