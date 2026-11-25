// Writes .br and .gz next to each compressible built web asset; the server serves them
// precompressed, so no request pays for compression and phones download a quarter of the bytes.
import { brotliCompress, constants, gzip } from "node:zlib";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const root = process.argv[2] ?? "dist/web";
const compressible = /\.(js|mjs|css|html|svg|json|webmanifest|txt)$/;

async function collect(dir, files = []) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isDirectory()) await collect(path, files);
    else if (compressible.test(name) && info.size >= 1024) files.push(path);
  }
  return files;
}

const files = await collect(root);
await Promise.all(
  files.map(async (path) => {
    const bytes = await readFile(path);
    const [br, gz] = await Promise.all([
      brotliAsync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
      }),
      gzipAsync(bytes, { level: 9 }),
    ]);
    await Promise.all([writeFile(path + ".br", br), writeFile(path + ".gz", gz)]);
  }),
);
