/**
 * Small, safe Markdown renderer for agent messages. Every character of input is escaped before
 * any markup is produced, and only http(s)/mailto links are emitted, so the output is safe for
 * v-html. Supports fenced code, headings, lists, task items, quotes, rules, tables and inline
 * code/bold/italic/strike/links. One linear pass over the text.
 */
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

function safeUrl(url: string) {
  const trimmed = url.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

function inline(text: string): string {
  // Split out code spans first so their content is never formatted.
  const parts = text.split(/(`+)([\s\S]*?[^`])\1(?!`)/);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 2) {
      out += `<code>${escape(parts[i].replace(/^ (.*) $/, "$1"))}</code>`;
      continue;
    }
    if (i % 3 === 1) continue;
    let s = escape(parts[i]);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
      const url = safeUrl(href.replace(/&amp;/g, "&"));
      return url
        ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : match;
    });
    s = s.replace(
      /(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g,
      (_m, lead: string, url: string) =>
        `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
    );
    s = s
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    out += s;
  }
  return out;
}

const isTableDivider = (line: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes("|");
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => inline(cell.trim()));

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush();
      const marker = fence[2];
      const body: string[] = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i]);
      const lang = fence[3] ? `<span class="code-lang">${escape(fence[3])}</span>` : "";
      html.push(`<pre class="code">${lang}<code>${escape(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 2, 6);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      html.push("<hr>");
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ""));
      i--;
      html.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      i--;
      html.push(
        `<div class="table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m && /\d/.test(m[2]) === ordered) {
          const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
          const nested = m[1].length >= 2 ? ' class="nested"' : "";
          items.push(
            task
              ? `<li class="task${m[1].length >= 2 ? " nested" : ""}"><span class="check${task[1] === " " ? "" : " done"}"></span>${inline(task[2])}</li>`
              : `<li${nested}>${inline(m[3])}</li>`,
          );
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, ` ${inline(lines[i].trim())}</li>`);
        } else break;
      }
      i--;
      html.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return html.join("");
}
