import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endpointAuthorization } from "../src/endpoint";
import { createGuard } from "../src/guard";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "turnstile-path-")));
  dirs.push(dir);
  return dir;
}
test("ordinary file reads and new nested writes stay inside workspace", async () => {
  const root = await fixture();
  await writeFile(join(root, "notes.txt"), "hello");
  const authorize = endpointAuthorization(root);
  expect(
    (
      await authorize({
        userGoal: "read",
        tool: "Read",
        arguments: { file_path: join(root, "notes.txt") },
        evidence: [],
      })
    ).verdict,
  ).toBe("allow");
  expect(
    (
      await authorize({
        userGoal: "write",
        tool: "Write",
        arguments: { file_path: join(root, "new/sub/notes.txt"), content: "hello" },
        evidence: [],
      })
    ).verdict,
  ).toBe("allow");
});
test("credential paths, outside files and policy files are denied", async () => {
  const root = await fixture();
  const authorize = endpointAuthorization(root);
  for (const path of [
    join(root, ".env"),
    join(root, ".env.local"),
    join(root, ".claude/settings.json"),
    join(root, ".turnstile/config.json"),
    join(root, "../elsewhere.txt"),
  ]) {
    expect(
      (
        await authorize({
          userGoal: "read",
          tool: "Read",
          arguments: { file_path: path },
          evidence: [],
        })
      ).verdict,
    ).toBe("deny");
  }
});
test("existing symlinks are evaluated by their physical target", async () => {
  const root = await fixture();
  const outside = await fixture();
  await writeFile(join(outside, "note.txt"), "synthetic");
  await symlink(outside, join(root, "linked"));
  expect(
    (
      await endpointAuthorization(root)({
        userGoal: "read",
        tool: "Read",
        arguments: { file_path: join(root, "linked/note.txt") },
        evidence: [],
      })
    ).verdict,
  ).toBe("deny");
});
test("unresolvable paths fail closed and shell or unknown tools require review", async () => {
  const root = await fixture();
  await symlink(join(root, "missing"), join(root, "dangling"));
  const guard = createGuard({
    policy: { version: 1, tools: { Write: { effect: "allow" } } },
    authorize: endpointAuthorization(root),
  });
  expect(
    (
      await guard.check({
        userGoal: "write",
        tool: "Write",
        arguments: { file_path: join(root, "dangling"), content: "hello" },
      })
    ).verdict,
  ).toBe("deny");
  for (const tool of ["Bash", "WebFetch", "new-tool"])
    expect(
      (await endpointAuthorization(root)({ userGoal: "test", tool, arguments: {}, evidence: [] }))
        .verdict,
    ).toBe("review");
});
