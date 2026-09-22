import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function readBounded(path: string, maxBytes = 64000): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("File exceeds limit or is not regular");
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error("File exceeds limit");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function privateWrite(path: string, value: unknown): Promise<void> {
  return privateWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function privateWriteText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.close();
    await rename(temp, path);
  } finally {
    await handle.close();
    await unlink(temp).catch(() => {});
  }
}

export const retention = {
  auditBytes: 1024 * 1024,
  auditArchives: 3,
  auditAgeMs: 7 * 24 * 60 * 60 * 1000,
  sessionAgeMs: 24 * 60 * 60 * 1000,
} as const;

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory())
    throw new Error("Storage directory must not be a symlink");
}

// Cooperating writers share this lock, including rotation and session cleanup.
// A crashed writer leaves a visible lock. Never guess that a lock is stale.
export async function withStorageLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await privateDirectory(dirname(path));
  const lock = `${path}.lock`;
  const deadline = performance.now() + 2000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || performance.now() >= deadline)
        throw new Error("Storage lock unavailable");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await operation();
  } finally {
    await rmdir(lock);
  }
}

async function regularFile(path: string) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error("Storage target must be a regular file");
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Read only the bounded suffix of a legacy log. The extra byte lets a record
// starting exactly at the size boundary retain its preceding newline.
async function readAuditTail(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Audit target must be a regular file");
    const size = Math.min(stat.size, retention.auditBytes + 1);
    const start = stat.size - size;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, start + offset);
      if (!bytesRead) throw new Error("Audit changed during migration");
      offset += bytesRead;
    }
    if (stat.size <= retention.auditBytes) return buffer.toString("utf8");
    const boundary = buffer.indexOf(10);
    if (boundary < 0 || boundary === buffer.length - 1)
      throw new Error("Legacy audit entry exceeds retention limit");
    const tail = buffer.subarray(boundary + 1).toString("utf8");
    if (!tail.endsWith("\n")) throw new Error("Legacy audit has an incomplete final record");
    return tail;
  } finally {
    await handle.close();
  }
}

export async function appendAudit(path: string, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes > retention.auditBytes) throw new Error("Audit entry exceeds limit");
  await withStorageLock(path, async () => {
    // Validate every owned path before mutation, including archive destinations.
    const files = Array.from({ length: retention.auditArchives + 1 }, (_, index) =>
      index === 0 ? path : `${path}.${index}`,
    );
    const stats = new Map(
      await Promise.all(files.map(async (file) => [file, await regularFile(file)] as const)),
    );
    // No cooperating compaction can still own these temporary files while we
    // hold this log's lock. Recover remnants left before a crashed writer renamed.
    const ownedNames = new Set(files.map((file) => basename(file)));
    for (const name of await readdir(dirname(path))) {
      const temporary = name.match(
        /^(.*)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/,
      );
      if (!temporary || !ownedNames.has(temporary[1] ?? "")) continue;
      const temporaryPath = join(dirname(path), name);
      if ((await lstat(temporaryPath)).isFile()) await unlink(temporaryPath);
    }
    const cutoff = Date.now() - retention.auditAgeMs;
    for (const file of files) {
      const stat = stats.get(file);
      if (!stat) continue;
      if (stat.mtimeMs < cutoff) {
        await unlink(file);
        stats.set(file, undefined);
        continue;
      }
      const previous = await readAuditTail(file);
      const lines = previous.split("\n").filter(Boolean);
      const retained = lines.filter((entry) => {
        const record = JSON.parse(entry);
        const timestamp =
          record && typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
        return !Number.isFinite(timestamp) || timestamp >= cutoff;
      });
      if (
        retained.length !== lines.length ||
        stat.size > retention.auditBytes ||
        (previous.length > 0 && !previous.endsWith("\n"))
      ) {
        if (retained.length) {
          const normalized = `${retained.join("\n")}\n`;
          if (Buffer.byteLength(normalized) > retention.auditBytes)
            throw new Error("Normalized audit exceeds retention limit");
          await privateWriteText(file, normalized);
          stats.set(file, await regularFile(file));
        } else {
          await unlink(file);
          stats.set(file, undefined);
        }
      }
    }
    const active = stats.get(path);
    if (active && active.size + bytes > retention.auditBytes) {
      const oldest = `${path}.${retention.auditArchives}`;
      if (stats.get(oldest)) await unlink(oldest);
      for (let index = retention.auditArchives - 1; index >= 0; index--) {
        const source = index === 0 ? path : `${path}.${index}`;
        if (stats.get(source)) await rename(source, `${path}.${index + 1}`);
      }
    }
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Audit target must be a regular file");
      await handle.chmod(0o600);
      await handle.writeFile(line);
    } finally {
      await handle.close();
    }
  });
}

// Call while holding the shared sessions lock. Ignore unrelated files and symlinks.
export async function cleanupSessions(directory: string): Promise<void> {
  await privateDirectory(directory);
  for (const name of await readdir(directory)) {
    const committed = /^[a-f0-9]{64}\.json$/.test(name);
    const temporary =
      /^[a-f0-9]{64}\.json\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(
        name,
      );
    if (!committed && !temporary) continue;
    const path = `${directory}/${name}`;
    try {
      const stat = await lstat(path);
      if (!stat.isFile()) continue;
      if (temporary) {
        if (Date.now() - stat.mtimeMs > retention.sessionAgeMs) await unlink(path);
        continue;
      }
      const value = JSON.parse(await readBounded(path));
      if (
        typeof value.goal === "string" &&
        typeof value.updatedAt === "number" &&
        Number.isFinite(value.updatedAt) &&
        Date.now() - value.updatedAt > retention.sessionAgeMs
      )
        await unlink(path);
    } catch {
      // Unrecognized or concurrently removed files are not cleanup candidates.
    }
  }
}
