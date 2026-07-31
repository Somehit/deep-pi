#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CheckpointStore } from "../extensions/checkpoint-store.ts";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "pi-checkpoint-test-"));
const workspace = join(root, "workspace");
const storePath = join(root, "store.git");
await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));

const runner = async (command, args, options = {}) => {
  try {
    const result = await execFileAsync(command, args, { cwd: options.cwd, timeout: options.timeout, signal: options.signal, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
  } catch (error) {
    return { stdout: error.stdout || "", stderr: error.stderr || error.message, code: typeof error.code === "number" ? error.code : 1, killed: Boolean(error.killed) };
  }
};

try {
  await writeFile(join(workspace, ".gitignore"), "ignored/\n");
  await writeFile(join(workspace, "alpha.txt"), "before\n");
  await writeFile(join(workspace, "delete me.txt"), "present\n");
  await writeFile(join(workspace, "unicodé.txt"), "avant\n");
  await symlink("alpha.txt", join(workspace, "link"));
  const store = new CheckpointStore(runner, workspace, storePath);
  const pre = await store.snapshot("test/pre");

  await writeFile(join(workspace, "alpha.txt"), "after\n");
  await rm(join(workspace, "delete me.txt"));
  await writeFile(join(workspace, "new file.txt"), "new\n");
  await writeFile(join(workspace, "unicodé.txt"), "après\n");
  const post = await store.snapshot("test/post");
  const paths = await store.changedPaths(pre.tree, post.tree);
  for (const expected of ["alpha.txt", "delete me.txt", "new file.txt", "unicodé.txt"]) {
    if (!paths.includes(expected)) throw new Error(`Missing changed path: ${expected}`);
  }
  if (paths.some((path) => path.includes(".env") || path.includes(".ssh"))) throw new Error("Sensitive path entered snapshot");

  await store.restore(pre.tree, paths);
  if ((await readFile(join(workspace, "alpha.txt"), "utf8")) !== "before\n") throw new Error("Modified file not undone");
  if ((await readFile(join(workspace, "delete me.txt"), "utf8")) !== "present\n") throw new Error("Deleted file not restored");
  await readFile(join(workspace, "new file.txt")).then(() => { throw new Error("Created file not removed"); }, () => undefined);

  await store.restore(post.tree, paths);
  if ((await readFile(join(workspace, "alpha.txt"), "utf8")) !== "after\n") throw new Error("Redo failed");
  console.log("Checkpoint workflow: OK");
} finally {
  await rm(root, { recursive: true, force: true });
}
