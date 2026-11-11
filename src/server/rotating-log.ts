import { appendFileSync, chmodSync, existsSync, renameSync, rmSync, statSync, openSync, readSync, writeSync, ftruncateSync, closeSync } from "node:fs";

/** One writer (the supervisor); bounded active file plus numbered archives. */
export class RotatingLog {
  private size: number;
  private path: string;
  private maxBytes: number;
  private archives: number;
  constructor(path: string, maxBytes = 5 * 1024 * 1024, archives = 3) {
    this.path = path; this.maxBytes = maxBytes; this.archives = archives;
    if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 100 * 1024 * 1024 || !Number.isInteger(archives) || archives < 1 || archives > 20)
      throw new Error("Invalid log limits: bytes must be 1024..104857600, archives must be 1..20.");
    for (let i = 1; i <= 20; i++) {
      if (i > archives) rmSync(`${path}.${i}`, { force: true });
      else this.boundFile(`${path}.${i}`);
    }
    this.boundFile(path);
    this.size = existsSync(path) ? statSync(path).size : 0;
  }
  private boundFile(path: string) {
    if (!existsSync(path)) return;
    chmodSync(path, 0o600);
    const size = statSync(path).size;
    if (size <= this.maxBytes) return;
    const fd = openSync(path, "r+");
    try {
      const tail = Buffer.alloc(this.maxBytes);
      const read = readSync(fd, tail, 0, tail.length, size - tail.length);
      ftruncateSync(fd, 0);
      writeSync(fd, tail.subarray(0, read), 0, read, 0);
    } finally { closeSync(fd); }
  }
  write(data: string | Buffer) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;
    while (offset < bytes.length) {
      if (this.size >= this.maxBytes) this.rotate();
      const count = Math.min(bytes.length - offset, this.maxBytes - this.size);
      appendFileSync(this.path, bytes.subarray(offset, offset + count), { mode: 0o600 });
      chmodSync(this.path, 0o600);
      this.size += count;
      offset += count;
    }
  }
  private rotate() {
    rmSync(`${this.path}.${this.archives}`, { force: true });
    for (let i = this.archives - 1; i >= 1; i--)
      if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
    this.size = 0;
  }
}
