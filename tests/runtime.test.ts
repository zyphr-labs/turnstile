import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endpointAuthorization } from "../src/endpoint";
import { normalizeEndpointAction } from "../src/runtime";
import { requestSchema } from "../src/schema";

test("harness mappings use native argument names and preserve content", () => {
  const base = { sessionId: "s", cwd: "/workspace", userGoal: "Edit note" };
  const pi = normalizeEndpointAction({
    ...base,
    harness: "pi",
    tool: "edit",
    arguments: { path: "note.txt", oldText: "old", newText: "new" },
  });
  const oc = normalizeEndpointAction({
    ...base,
    harness: "opencode",
    tool: "edit",
    arguments: { filePath: "note.txt", oldString: "old", newString: "new" },
  });
  for (const action of [pi, oc]) {
    expect(action.tool).toBe("Edit");
    expect(action.arguments.file_path).toBe("/workspace/note.txt");
    expect(action.arguments.old_string).toBe("old");
    expect(action.arguments.new_string).toBe("new");
  }
});
test("unsupported tools and argument aliases cannot inherit another host's permission", () => {
  const base = { harness: "pi" as const, sessionId: "s", cwd: "/workspace", userGoal: "Read note" };
  expect(
    normalizeEndpointAction({ ...base, tool: "Read", arguments: { file_path: "note" } }).tool,
  ).toBe("pi:Read");
  expect(
    normalizeEndpointAction({ ...base, tool: "read", arguments: { file_path: "note" } }).arguments
      .file_path,
  ).toBeUndefined();
});

test("Pi batched edits preserve every replacement and reject malformed batches without fallback", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "turnstile-batch-")));
  const base = {
    harness: "pi" as const,
    sessionId: "s",
    cwd: root,
    userGoal: "Edit the note",
    tool: "edit",
  };
  const authorize = endpointAuthorization(root);
  try {
    const action = normalizeEndpointAction({
      ...base,
      arguments: {
        path: "note.txt",
        edits: [
          { oldText: "one", newText: "first" },
          { oldText: "two", newText: "second" },
        ],
      },
    });
    expect(action.arguments.edits).toEqual([
      { old_string: "one", new_string: "first" },
      { old_string: "two", new_string: "second" },
    ]);
    expect((await authorize(requestSchema.parse(action))).verdict).toBe("allow");
    for (const edits of [null, [], [{ oldText: "old" }], [{ oldText: 1, newText: "new" }]]) {
      const invalid = normalizeEndpointAction({
        ...base,
        arguments: { path: "note.txt", edits, oldText: "old", newText: "new" },
      });
      expect((await authorize(requestSchema.parse(invalid))).verdict).toBe("deny");
    }
    const otherHost = normalizeEndpointAction({
      ...base,
      harness: "opencode",
      arguments: {
        filePath: "note.txt",
        edits: [{ old_string: "one", new_string: "first" }],
      },
    });
    expect((await authorize(requestSchema.parse(otherHost))).verdict).toBe("deny");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired prompt cleanup preserves live sessions, unrelated files and symlinks", async () => {
  const { mkdtemp, readFile, readdir, rm, symlink, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { hash } = await import("../src/guard");
  const { saveGoal, readGoal } = await import("../src/runtime");
  const root = await mkdtemp(join(tmpdir(), "turnstile-session-"));
  try {
    const config = join(root, "config.json");
    await saveGoal(config, "pi", "old", "synthetic expired prompt");
    const expired = join(root, "sessions", `${hash(["pi", "old"])}.json`);
    const value = JSON.stringify({
      goal: "synthetic expired prompt",
      updatedAt: Date.now() - 172800000,
    });
    await writeFile(expired, value);
    await writeFile(join(root, "sessions", "keep.json"), value);
    const linked = `${"a".repeat(64)}.json`;
    await symlink(join(root, "sessions", "keep.json"), join(root, "sessions", linked));
    await saveGoal(config, "pi", "live", "Read the note");
    expect(await readGoal(config, "pi", "old")).toBe("");
    expect(await readGoal(config, "pi", "live")).toBe("Read the note");
    expect(await readdir(join(root, "sessions"))).toEqual(
      expect.arrayContaining(["keep.json", linked]),
    );
    expect(await readFile(join(root, "sessions", "keep.json"), "utf8")).toBe(value);
    expect(await Bun.file(expired).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
