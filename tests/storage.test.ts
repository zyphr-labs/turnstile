import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendAudit, retention } from "../src/storage";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "turnstile-storage-"));
  dirs.push(root);
  return { root, path: join(root, "decisions.jsonl") };
}

test("parallel processes retain complete records across audit rotation", async () => {
  const { root, path } = await fixture();
  const module = resolve(import.meta.dir, "../src/storage.ts");
  const processes = Array.from({ length: 10 }, (_, id) =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {appendAudit} from ${JSON.stringify(module)}; await appendAudit(${JSON.stringify(path)}, {id:${id},padding:"x".repeat(180000)});`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  expect(await Promise.all(processes.map((child) => child.exited))).toEqual(Array(10).fill(0));
  const files = (await readdir(root)).filter((name) => name.startsWith("decisions.jsonl"));
  expect(files).toHaveLength(2);
  const ids: number[] = [];
  for (const file of files) {
    expect((await stat(join(root, file))).size).toBeLessThanOrEqual(retention.auditBytes);
    for (const line of (await readFile(join(root, file), "utf8")).trim().split("\n"))
      ids.push(JSON.parse(line).id);
  }
  expect(ids.sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, id) => id));
});

test("audit keeps only three archives and purges old records even with a fresh modification time", async () => {
  const { root, path } = await fixture();
  for (let id = 0; id < 6; id++) await appendAudit(path, { id, padding: "x".repeat(600000) });
  expect((await readdir(root)).sort()).toEqual([
    "decisions.jsonl",
    "decisions.jsonl.1",
    "decisions.jsonl.2",
    "decisions.jsonl.3",
  ]);
  await writeFile(
    path,
    `${JSON.stringify({ id: "expired", timestamp: new Date(Date.now() - retention.auditAgeMs - 1000).toISOString() })}\n${JSON.stringify({ id: "fresh", timestamp: new Date().toISOString() })}\n`,
  );
  await appendAudit(path, { id: "next", timestamp: new Date().toISOString() });
  const rows = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).id);
  expect(rows).toEqual(["fresh", "next"]);
});

test("rotation refuses symlink targets and preserves unrelated files", async () => {
  const { root, path } = await fixture();
  const unrelated = join(root, "keep.txt");
  await writeFile(unrelated, "keep this");
  await symlink(unrelated, `${path}.1`);
  await expect(appendAudit(path, { id: "test" })).rejects.toThrow("regular file");
  expect(await readFile(unrelated, "utf8")).toBe("keep this");
  expect((await readdir(root)).sort()).toEqual(["decisions.jsonl.1", "keep.txt"]);
});

test("appending migrates legacy oversized logs to a bounded suffix of complete records", async () => {
  const { root, path } = await fixture();
  const legacy = `${Array.from({ length: 20 }, (_, id) => JSON.stringify({ id, padding: "λ".repeat(60000) })).join("\n")}\n`;
  await writeFile(path, legacy);
  expect((await stat(path)).size).toBeGreaterThan(retention.auditBytes);
  await appendAudit(path, { id: "new" });
  const ids: (number | string)[] = [];
  for (const file of await readdir(root)) {
    expect((await stat(join(root, file))).size).toBeLessThanOrEqual(retention.auditBytes);
    for (const line of (await readFile(join(root, file), "utf8")).trim().split("\n")) {
      const row = JSON.parse(line);
      ids.push(row.id);
      if (row.padding) expect(row.padding).toBe("λ".repeat(60000));
    }
  }
  expect(ids).toEqual([12, 13, 14, 15, 16, 17, 18, 19, "new"]);
});

test("oversized legacy single records and incomplete tails fail without replacing the source", async () => {
  const { path } = await fixture();
  for (const legacy of [
    `${JSON.stringify({ padding: "x".repeat(retention.auditBytes + 10) })}\n`,
    `${JSON.stringify({ padding: "x".repeat(retention.auditBytes) })}\n{"incomplete":`,
  ]) {
    await writeFile(path, legacy);
    await expect(appendAudit(path, { id: "new" })).rejects.toThrow("Legacy audit");
    expect(await readFile(path, "utf8")).toBe(legacy);
  }
});

test("session access removes only expired owned temporary files", async () => {
  const { root } = await fixture();
  const { saveGoal } = await import("../src/runtime");
  const { utimes } = await import("node:fs/promises");
  const config = join(root, "config.json");
  await saveGoal(config, "pi", "synthetic-session", "Read note");
  const directory = join(root, "sessions");
  const suffix = ".json.12345678-1234-4123-8123-123456789012.tmp";
  const expired = join(directory, `${"a".repeat(64)}${suffix}`);
  const fresh = join(directory, `${"b".repeat(64)}${suffix}`);
  const linked = join(directory, `${"c".repeat(64)}${suffix}`);
  const unrelated = join(directory, "unrelated.tmp");
  for (const file of [expired, fresh, unrelated]) await writeFile(file, "synthetic prompt");
  const old = new Date(Date.now() - retention.sessionAgeMs - 10000);
  await utimes(expired, old, old);
  await utimes(unrelated, old, old);
  await symlink(unrelated, linked);
  await saveGoal(config, "pi", "synthetic-session", "Run tests");
  expect(await Bun.file(expired).exists()).toBe(false);
  for (const file of [fresh, linked, unrelated])
    expect(await readFile(file, "utf8")).toBe("synthetic prompt");
});
