// Writes .br and .gz next to each compressible built web asset; the server serves them
// precompressed, so no request pays for compression and phones download a quarter of the bytes.
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "dist/web";
const compressible = /\.(js|mjs|css|html|svg|json|webmanifest|txt)$/;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (compressible.test(name) && statSync(path).size >= 1024) {
      const bytes = readFileSync(path);
      writeFileSync(path + ".br", brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
      }));
      writeFileSync(path + ".gz", gzipSync(bytes, { level: 9 }));
    }
  }
}
walk(root);
