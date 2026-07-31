import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CheckpointStore, defaultCheckpointRoot, type WorkspaceSnapshot } from "./checkpoint-store.ts";

const ENTRY_PRE = "deepseek-checkpoint-pre";
const ENTRY_POST = "deepseek-checkpoint-post";
const MUTATION_TOOLS = new Set(["bash", "edit", "write"]);

interface PreCheckpoint {
  promptId: string;
  promptText: string;
  preTree: string;
  createdAt: number;
}

interface PostCheckpoint {
  promptId: string;
  preTree: string;
  postTree: string;
  responseLeafId: string;
  paths: string[];
  usedBash: boolean;
  externalEffectsUnknown?: boolean;
  createdAt: number;
}

interface ActiveTransaction {
  promptId: string;
  promptText: string;
  pre?: WorkspaceSnapshot;
  failed?: string;
  usedBash: boolean;
}

interface RedoRecord {
  promptId: string;
  promptText: string;
  preTree: string;
  postTree: string;
  responseLeafId: string;
  paths: string[];
  usedBash: boolean;
  externalEffectsUnknown?: boolean;
}

type EntryLike = {
  id?: string;
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: unknown };
};

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function latestUser(entries: readonly EntryLike[]): { id: string; text: string } | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "message" && entry.id && entry.message?.role === "user") {
      return { id: entry.id, text: messageText(entry.message.content) };
    }
  }
  return undefined;
}

function checkpointForPrompt(entries: readonly EntryLike[], promptId: string): PostCheckpoint | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== ENTRY_POST) continue;
    const data = entry.data as PostCheckpoint | undefined;
    if (data?.promptId === promptId) return data;
  }
  return undefined;
}

function preCheckpointForPrompt(entries: readonly EntryLike[], promptId: string): PreCheckpoint | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== ENTRY_PRE) continue;
    const data = entry.data as PreCheckpoint | undefined;
    if (data?.promptId === promptId) return data;
  }
  return undefined;
}

function hasPreCheckpoint(entries: readonly EntryLike[], promptId: string): boolean {
  return preCheckpointForPrompt(entries, promptId) !== undefined;
}

function storePath(ctx: ExtensionContext): string {
  const key = `${resolve(ctx.cwd)}\0${ctx.sessionManager.getSessionId()}`;
  return resolve(defaultCheckpointRoot(), createHash("sha256").update(key).digest("hex"));
}

export default function deepseekCheckpoints(pi: ExtensionAPI): void {
  let store: CheckpointStore | undefined;
  let active: ActiveTransaction | undefined;
  let redoStack: RedoRecord[] = [];
  let internalNavigation = false;

  function getStore(ctx: ExtensionContext): CheckpointStore {
    const expected = storePath(ctx);
    if (!store || store.gitDir !== expected) store = new CheckpointStore(pi.exec.bind(pi), ctx.cwd, expected);
    return store;
  }

  pi.on("before_agent_start", async (event, ctx) => {
    redoStack = [];
    const user = latestUser(ctx.sessionManager.getBranch() as EntryLike[]);
    if (!user) return;
    if (active?.promptId === user.id || hasPreCheckpoint(ctx.sessionManager.getEntries() as EntryLike[], user.id)) return;

    active = { promptId: user.id, promptText: event.prompt, usedBash: false };
    try {
      const pre = await getStore(ctx).snapshot(`${user.id}/pre`, ctx.signal);
      active.pre = pre;
      pi.appendEntry(ENTRY_PRE, {
        promptId: user.id,
        promptText: event.prompt.slice(0, 20_000),
        preTree: pre.tree,
        createdAt: Date.now(),
      } satisfies PreCheckpoint);
    } catch (error) {
      active.failed = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Workspace checkpoint failed; this turn is read-only: ${active.failed}`, "error");
      return {
        message: {
          customType: "deepseek-checkpoint-failed",
          content: `Workspace checkpoint creation failed. Do not use bash, edit, or write in this turn. Report this limitation to the user. Error: ${active.failed}`,
          display: false,
        },
      };
    }
  });

  pi.on("tool_call", (event) => {
    if (active && event.toolName === "bash") active.usedBash = true;
    if (active?.failed && MUTATION_TOOLS.has(event.toolName)) {
      return { block: true, reason: `Mutation blocked because the pre-prompt checkpoint failed: ${active.failed}` };
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const transaction = active;
    active = undefined;
    if (!transaction?.pre || transaction.failed) return;
    try {
      const responseLeafId = ctx.sessionManager.getLeafId();
      if (!responseLeafId) return;
      const post = await getStore(ctx).snapshot(`${transaction.promptId}/post`, ctx.signal);
      const paths = await getStore(ctx).changedPaths(transaction.pre.tree, post.tree);
      pi.appendEntry(ENTRY_POST, {
        promptId: transaction.promptId,
        preTree: transaction.pre.tree,
        postTree: post.tree,
        responseLeafId,
        paths,
        usedBash: transaction.usedBash,
        createdAt: Date.now(),
      } satisfies PostCheckpoint);
    } catch (error) {
      ctx.ui.notify(`Could not finalize workspace checkpoint: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  async function confirmDrift(force: boolean, ctx: ExtensionCommandContext, operation: string): Promise<boolean> {
    if (force) return true;
    if (!ctx.hasUI) {
      ctx.ui.notify(`Workspace drift detected. Use /${operation} --force in non-interactive mode.`, "warning");
      return false;
    }
    return ctx.ui.confirm(
      "Workspace changed since the checkpoint",
      `Some paths touched by this prompt were modified afterward. ${operation} will overwrite those paths. Continue?`,
    );
  }

  async function navigateInternally(ctx: ExtensionCommandContext, targetId: string) {
    internalNavigation = true;
    try {
      return await ctx.navigateTree(targetId, { summarize: false });
    } finally {
      internalNavigation = false;
    }
  }

  async function moveWorkspace(
    ctx: ExtensionCommandContext,
    record: RedoRecord,
    direction: "undo" | "redo",
    force: boolean,
  ): Promise<boolean> {
    const checkpointStore = getStore(ctx);
    const expected = direction === "undo" ? record.postTree : record.preTree;
    const target = direction === "undo" ? record.preTree : record.postTree;
    const current = await checkpointStore.snapshot(`temporary/${randomUUID()}`);
    if (await checkpointStore.hasDrift(expected, current.tree, record.paths)) {
      if (!(await confirmDrift(force, ctx, direction,))) return false;
    }

    const navigationTarget = direction === "undo" ? record.promptId : record.responseLeafId;
    const previousTarget = direction === "undo" ? record.responseLeafId : record.promptId;
    const navigation = await navigateInternally(ctx, navigationTarget);
    if (navigation.cancelled) return false;

    try {
      await checkpointStore.restore(target, record.paths);
      const verified = await checkpointStore.snapshot(`temporary/${randomUUID()}`);
      if (await checkpointStore.hasDrift(target, verified.tree, record.paths)) {
        throw new Error("restored workspace does not match the target checkpoint");
      }
      return true;
    } catch (error) {
      let compensation = "";
      try {
        await checkpointStore.restore(current.tree, record.paths);
        await navigateInternally(ctx, previousTarget);
      } catch (compensationError) {
        compensation = ` Compensation also failed: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`;
      }
      ctx.ui.notify(`Checkpoint ${direction} failed: ${error instanceof Error ? error.message : String(error)}.${compensation}`, "error");
      return false;
    }
  }

  pi.registerCommand("undo", {
    description: "Undo the last user prompt, including its versionable workspace changes",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const user = latestUser(ctx.sessionManager.getBranch() as EntryLike[]);
      if (!user) {
        ctx.ui.notify("No user prompt to undo in this branch", "warning");
        return;
      }
      const allEntries = ctx.sessionManager.getEntries() as EntryLike[];
      let checkpoint = checkpointForPrompt(allEntries, user.id);
      if (!checkpoint) {
        const pre = preCheckpointForPrompt(allEntries, user.id);
        if (!pre) {
          ctx.ui.notify("This prompt predates workspace checkpoints; conversation was not rewound", "warning");
          return;
        }
        try {
          const current = await getStore(ctx).snapshot(`recovered/${randomUUID()}`);
          checkpoint = {
            promptId: user.id,
            preTree: pre.preTree,
            postTree: current.tree,
            responseLeafId: ctx.sessionManager.getLeafId() ?? user.id,
            paths: await getStore(ctx).changedPaths(pre.preTree, current.tree),
            usedBash: false,
            externalEffectsUnknown: true,
            createdAt: Date.now(),
          };
          ctx.ui.notify("Recovered an unfinished prompt checkpoint from its pre-run snapshot", "warning");
        } catch (error) {
          ctx.ui.notify(`Could not recover the unfinished checkpoint: ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
      }
      const record: RedoRecord = { ...checkpoint, promptText: user.text };
      if (!(await moveWorkspace(ctx, record, "undo", /^(?:--force|-f)$/i.test(args.trim())))) return;
      redoStack.push(record);
      if (checkpoint.externalEffectsUnknown) {
        ctx.ui.notify("Undo complete. The interrupted turn's external effects could not be determined.", "warning");
      } else if (checkpoint.usedBash) {
        ctx.ui.notify("Undo complete. Ignored files or external effects produced by Bash may remain.", "warning");
      } else {
        ctx.ui.notify("Undo complete", "info");
      }
    },
  });

  pi.registerCommand("redo", {
    description: "Redo the most recently undone prompt and workspace changes",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const record = redoStack.at(-1);
      if (!record) {
        ctx.ui.notify("Nothing to redo (a new prompt invalidates redo)", "warning");
        return;
      }
      if (!(await moveWorkspace(ctx, record, "redo", /^(?:--force|-f)$/i.test(args.trim())))) return;
      redoStack.pop();
      ctx.ui.notify("Redo complete", "info");
    },
  });

  pi.on("session_start", () => {
    store = undefined;
    active = undefined;
    redoStack = [];
  });
  pi.on("session_tree", () => {
    active = undefined;
    if (!internalNavigation) redoStack = [];
  });
}
