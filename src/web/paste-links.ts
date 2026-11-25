/**
 * Rich-text hyperlink paste helper & blockquote one-tap copy helper.
 * Pure DOM helpers with zero external dependencies.
 */

const SAFE_LINK = /^(https?:|mailto:)/i;
const BLOCK_TAGS = new Set(["P", "DIV", "LI", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE"]);

/**
 * Converts pasted HTML containing hyperlinks into plain text with Markdown `[label](url)` links.
 * Returns `null` when the HTML contains no meaningful hyperlinks (so the browser's native plain-text
 * paste runs untouched).
 */
export function htmlToMarkdownWithLinks(html: string): string | null {
  if (!html || !/<a\b/i.test(html) || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const anchors = doc.body.querySelectorAll("a[href]");
  if (!anchors.length) return null;

  let convertedLinks = 0;
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return "";
    if (tag === "BR") return "\n";
    if (tag === "A") {
      const href = (el.getAttribute("href") ?? "").trim();
      const label = Array.from(el.childNodes).map(walk).join("").replace(/\s+/g, " ").trim();
      if (!href || !SAFE_LINK.test(href) || !label) return label || href;
      if (label === href || label === href.replace(/^mailto:/i, "")) return label;
      convertedLinks++;
      const escapedLabel = label.replace(/([[\]])/g, "\\$1");
      const escapedHref = href.replace(/\(/g, "%28").replace(/\)/g, "%29");
      return `[${escapedLabel}](${escapedHref})`;
    }
    const inner = Array.from(el.childNodes).map(walk).join("");
    if (tag === "LI") return `- ${inner.trim()}\n`;
    if (BLOCK_TAGS.has(tag)) return inner ? `${inner}\n` : "";
    return inner;
  };

  const out = Array.from(doc.body.childNodes)
    .map(walk)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return convertedLinks > 0 && out ? out : null;
}

/** Extracts clean text from a blockquote element, excluding injected copy controls. */
export function extractQuoteBody(blockquote: HTMLElement): string {
  const clone = blockquote.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".quote-copy-btn").forEach((el) => el.remove());
  // Preserve paragraph / list boundaries cleanly without leaving trailing whitespace.
  const lines: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? "";
      if (lines.length === 0) lines.push(t);
      else lines[lines.length - 1] += t;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === "BR") {
      lines.push("");
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock && lines.length && lines[lines.length - 1] !== "") lines.push("");
    if (tag === "LI") lines[lines.length - 1] = `${lines[lines.length - 1] ?? ""}- `;
    for (const child of Array.from(el.childNodes)) walk(child);
    if (isBlock && lines.length && lines[lines.length - 1] !== "") lines.push("");
  };
  walk(clone);
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Attaches a one-tap Copy button to every top-level `<blockquote>` inside `container`.
 * Safe to call repeatedly as streamed markdown updates.
 */
export function attachQuoteCopyButtons(container: HTMLElement | null): void {
  if (!container) return;
  const quotes = Array.from(container.querySelectorAll<HTMLElement>("blockquote"));
  for (const quote of quotes) {
    // Only decorate top-level blockquotes inside the prose container (not nested ones).
    if (quote.parentElement?.closest("blockquote")) continue;
    if (quote.querySelector(":scope > .quote-copy-btn")) continue;
    quote.classList.add("has-quote-copy");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quote-copy-btn";
    btn.setAttribute("aria-label", "Copy quote");
    btn.title = "Copy quote";
    btn.textContent = "Copy";
    let timer: ReturnType<typeof setTimeout> | undefined;
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const body = extractQuoteBody(quote);
      if (!body) return;
      try {
        await navigator.clipboard.writeText(body);
        btn.textContent = "Copied";
        btn.classList.add("is-copied");
        clearTimeout(timer);
        timer = setTimeout(() => {
          btn.textContent = "Copy";
          btn.classList.remove("is-copied");
        }, 1500);
      } catch {
        /* clipboard denied */
      }
    });
    quote.prepend(btn);
  }
}
