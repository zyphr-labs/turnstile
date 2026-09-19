import { expect, test } from "bun:test";
import { normalizeEndpointAction } from "../src/runtime";

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
