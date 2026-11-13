#!/usr/bin/env node
// Runs independent commands at the same time: `node scripts/parallel.mjs "cmd a" "cmd b"`.
// Each command's output is printed as one block when it finishes, so logs do not interleave.
// Exits non-zero if any command fails; the others still finish so every failure is reported.
import { spawn } from "node:child_process";

const commands = process.argv.slice(2);
if (!commands.length) {
  console.error('Usage: node scripts/parallel.mjs "<command>" ["<command>" ...]');
  process.exit(2);
}
const started = Date.now();
const results = await Promise.all(commands.map((command) => new Promise((resolve) => {
  const begin = Date.now();
  const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "0" } });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  child.on("close", (code, signal) => {
    const seconds = ((Date.now() - begin) / 1000).toFixed(1);
    const ok = code === 0;
    process.stdout.write(`\n── ${ok ? "ok  " : "FAIL"} ${command} (${seconds}s)${ok ? "" : ` exit ${code ?? signal}`}\n${output.trimEnd()}\n`);
    resolve(ok);
  });
})));
const failed = results.filter((ok) => !ok).length;
console.log(`\n── ${failed ? `${failed} of ${commands.length} failed` : `all ${commands.length} passed`} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);
