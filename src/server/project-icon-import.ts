import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Turns an "image or website URL" into icon bytes, as Paseo's project edit sheet does
 * (packages/app import-project-icon, Apache-2.0). Paseo fetches from the app; a browser cannot
 * (CORS), so LitePaseo fetches here and hands the daemon the same upload payload a picked file
 * produces. The daemon still validates the bytes (format, square, size).
 *
 * The server fetches on the browser's behalf, so every URL (including each redirect hop and
 * each icon a page declares) must resolve only to public addresses: never this machine, the
 * LAN, link-local cloud metadata services, or other internal ranges.
 */

export const MAX_ICON_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_CANDIDATES = 8;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 10_000;

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
/** Every address a hostname resolves to; replaced in tests. */
export type Lookup = (hostname: string) => Promise<string[]>;

const resolveAll: Lookup = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const internal = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network", unspecified
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) internal.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["64:ff9b:1::", 48], // local-use NAT64
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) internal.addSubnet(network, prefix, "ipv6");

/** True for an address that is not on the public internet. ::ffff:a.b.c.d is checked as a.b.c.d. */
export function isInternalAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return internal.check(bare, "ipv4");
  if (family !== 6) return true;
  // Normalize (URL compresses and lowercases) so the mapped form is recognised however written.
  const normalized = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
    return internal.check(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, "ipv4");
  }
  return internal.check(normalized, "ipv6");
}

function parseHttpUrl(value: string | URL, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error("Enter a valid website or image URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("URL must use HTTP or HTTPS without credentials");
  return url;
}

const BLOCKED = "URL must point to a public website, not a local or private network address";

/** Rejects URLs whose host is, or resolves to, an internal address. */
async function assertPublic(url: URL, lookup: Lookup): Promise<void> {
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error(BLOCKED);
  if (isIP(host.replace(/^\[|\]$/g, ""))) {
    if (isInternalAddress(host)) throw new Error(BLOCKED);
    return;
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new Error("Download failed: the website address could not be found");
  }
  if (!addresses.length || addresses.some(isInternalAddress)) throw new Error(BLOCKED);
}

/** Follows redirects by hand so every hop passes the same checks as the first URL. */
async function fetchOk(fetchIcon: Fetch, lookup: Lookup, start: URL): Promise<{ response: Response; url: URL }> {
  let url = start;
  for (let hop = 0; ; hop++) {
    await assertPublic(url, lookup);
    let response: Response;
    try {
      response = await fetchIcon(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "image/*,text/html;q=0.9,*/*;q=0.5" } });
    } catch (error) {
      throw new Error((error as Error).name === "TimeoutError" ? "Download timed out" : "Download failed");
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new Error("Download failed: too many redirects");
      url = parseHttpUrl(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    return { response, url };
  }
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
      candidates.push(parseHttpUrl(href, page));
    } catch {
      // Try the next declared icon, then the conventional fallback.
    }
  }
  candidates.push(new URL("/favicon.ico", page));
  return candidates.slice(0, MAX_CANDIDATES);
}

/** Base64 icon bytes from an image URL, or from the icons a web page declares. */
export async function importProjectIcon(value: string, fetchIcon: Fetch = fetch, lookup: Lookup = resolveAll): Promise<string> {
  const { response, url } = await fetchOk(fetchIcon, lookup, parseHttpUrl(value.trim()));
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.includes("text/html")) return (await readBytes(response, MAX_ICON_BYTES)).toString("base64");

  const html = (await readBytes(response, MAX_HTML_BYTES)).toString("utf8");
  let lastError: unknown = new Error("Website does not expose a supported icon");
  for (const candidate of iconCandidates(html, url)) {
    try {
      return (await readBytes((await fetchOk(fetchIcon, lookup, candidate)).response, MAX_ICON_BYTES)).toString("base64");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
