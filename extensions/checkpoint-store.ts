import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

export type ExecRunner = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export interface WorkspaceSnapshot {
  tree: string;
  ref: string;
}

const PRIVATE_EXCLUDES = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".ssh/",
  "**/.ssh/",
].join("\n");

export function defaultCheckpointRoot(): string {
  const dataHome = process.env.XDG_DATA_HOME || resolve(homedir(), ".local", "share");
  return resolve(dataHome, "pi-deepseek-harness", "checkpoints");
}

export function isProtectedSnapshotPath(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment === ".env" || segment.startsWith(".env.") || segment === ".ssh");
}

function splitNull(text: string): string[] {
  return text.split("\0").filter(Boolean);
}

function batches<T>(values: readonly T[], size = 200): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size) as T[]);
  return result;
}

export class CheckpointStore {
  readonly cwd: string;
  readonly gitDir: string;
  private readonly exec: ExecRunner;
  private initialized = false;

  constructor(exec: ExecRunner, cwd: string, storagePath: string) {
    this.exec = exec;
    this.cwd = resolve(cwd);
    this.gitDir = resolve(storagePath);
  }

  private async run(args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.exec("git", ["--git-dir", this.gitDir, "--work-tree", this.cwd, ...args], {
      cwd: this.cwd,
      timeout: 120_000,
      ...options,
    });
    if (result.code !== 0) {
      throw new Error(`checkpoint git ${args[0]} failed (${result.code}): ${result.stderr || result.stdout}`);
    }
    return result;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.gitDir, { recursive: true, mode: 0o700 });
    await chmod(this.gitDir, 0o700).catch(() => undefined);
    const probe = await this.exec("git", ["--git-dir", this.gitDir, "rev-parse", "--is-bare-repository"], {
      cwd: this.cwd,
      timeout: 10_000,
    });
    if (probe.code !== 0) {
      const initialized = await this.exec("git", ["init", "--bare", this.gitDir], { cwd: this.cwd, timeout: 30_000 });
      if (initialized.code !== 0) throw new Error(`Cannot initialize checkpoint store: ${initialized.stderr}`);
    }
    const storageRelative = relative(this.cwd, this.gitDir).replaceAll("\\", "/");
    const storageExclude = storageRelative && !storageRelative.startsWith("../") && storageRelative !== ".."
      ? `\n/${storageRelative.replace(/([\\[\]*?!# ])/g, "\\$1")}/`
      : "";
    await writeFile(join(this.gitDir, "info", "exclude"), `${PRIVATE_EXCLUDES}${storageExclude}\n`, { encoding: "utf8", mode: 0o600 });
    await this.run(["config", "core.autocrlf", "false"]);
    this.initialized = true;
  }

  async snapshot(refSuffix: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    await this.init();
    await this.run(["add", "-A", "--", "."], { signal });
    const tree = (await this.run(["write-tree"], { signal })).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(tree)) throw new Error(`Invalid checkpoint tree id: ${tree}`);
    const safeRef = refSuffix.replace(/[^a-zA-Z0-9/_-]/g, "-").replace(/^\/+|\/+$/g, "");
    const ref = `refs/pi-checkpoints/${safeRef}`;
    await this.run(["update-ref", ref, tree], { signal });
    return { tree, ref };
  }

  async changedPaths(beforeTree: string, afterTree: string): Promise<string[]> {
    await this.init();
    const result = await this.run(["diff", "--name-only", "-z", beforeTree, afterTree]);
    return splitNull(result.stdout).filter((path) => !isProtectedSnapshotPath(path));
  }

  async hasDrift(expectedTree: string, currentTree: string, paths: readonly string[]): Promise<boolean> {
    if (paths.length === 0) return false;
    for (const batch of batches(paths)) {
      const result = await this.exec(
        "git",
        ["--git-dir", this.gitDir, "--work-tree", this.cwd, "diff", "--quiet", expectedTree, currentTree, "--", ...batch],
        { cwd: this.cwd, timeout: 120_000 },
      );
      if (result.code === 1) return true;
      if (result.code !== 0) throw new Error(`checkpoint drift check failed: ${result.stderr || result.stdout}`);
    }
    return false;
  }

  async restore(targetTree: string, paths: readonly string[]): Promise<void> {
    await this.init();
    const safePaths = [...new Set(paths)].filter((path) => !isProtectedSnapshotPath(path));
    if (safePaths.length === 0) return;

    const targetNames = new Set(splitNull((await this.run(["ls-tree", "-r", "-z", "--name-only", targetTree])).stdout));
    const existing = safePaths.filter((path) => targetNames.has(path));
    const absent = safePaths.filter((path) => !targetNames.has(path));

    for (const batch of batches(existing)) await this.run(["checkout", targetTree, "--", ...batch]);
    for (const path of absent) {
      const absolute = resolve(this.cwd, path);
      const rel = relative(this.cwd, absolute);
      if (isAbsolute(rel) || rel.startsWith("..")) throw new Error(`Unsafe checkpoint path: ${path}`);
      await rm(absolute, { recursive: true, force: true });
    }
    for (const batch of batches(absent)) await this.run(["add", "-A", "--", ...batch]);
  }
}
