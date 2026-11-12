/**
 * Syntax highlighting for code blocks and opened files: highlight.js core with a fixed set of
 * common languages (no auto-detection, which would try every grammar on every block). Output is
 * escaped by highlight.js, so it is safe for v-html. Very large inputs stay plain text.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, lua,
  makefile, markdown, php, python, ruby, rust, scss, shell, sql, swift, typescript, xml, yaml };
for (const [name, grammar] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, grammar);
// Names agents and file extensions use that the grammars do not alias themselves.
hljs.registerAliases(["jsonc", "json5"], { languageName: "json" });
hljs.registerAliases(["vue", "svelte", "svg"], { languageName: "xml" });
hljs.registerAliases(["toml", "conf", "env"], { languageName: "ini" });
hljs.registerAliases(["mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["mts", "cts"], { languageName: "typescript" });
hljs.registerAliases(["patch"], { languageName: "diff" });
hljs.registerAliases(["fish"], { languageName: "bash" });

/** Beyond this the text renders plain: highlighting cost grows with size on every update. */
export const MAX_HIGHLIGHT = 200_000;

const EXTENSIONS: Record<string, string> = {
  h: "c", hpp: "cpp", cc: "cpp", cxx: "cpp", cs: "csharp", kt: "kotlin", kts: "kotlin", rs: "rust",
  py: "python", rb: "ruby", yml: "yaml", md: "markdown", htm: "xml", html: "xml",
  zsh: "bash", sh: "bash",
};

/** The highlight.js language for a fence tag or a file path, or null for plain text. */
export function languageFor(tagOrPath: string): string | null {
  let name = tagOrPath.trim().toLowerCase();
  const base = name.split("/").pop() ?? name;
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  if (base.includes(".")) name = base.split(".").pop()!;
  name = EXTENSIONS[name] ?? name;
  return name && hljs.getLanguage(name) ? name : null;
}

/** Highlighted HTML for the text, or null when it should render plain. */
export function highlight(code: string, language: string | null): string | null {
  if (!language || code.length > MAX_HIGHLIGHT) return null;
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
