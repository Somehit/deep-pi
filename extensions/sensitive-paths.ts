import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const home = resolve(homedir());
const sshDirectory = resolve(home, ".ssh");
const pathTools = new Set(["read", "write", "edit", "grep", "find", "ls", "ocr_image"]);

export function normalizeInputPath(rawPath: string, cwd: string): string {
  let value = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  if (value === "~") value = home;
  else if (value.startsWith(`~${sep}`) || value.startsWith("~/")) value = resolve(home, value.slice(2));
  const absolute = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  if (!existsSync(absolute)) return absolute;
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function isInside(parent: string, candidate: string): boolean {
  const result = relative(parent, candidate);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

function isEnvPath(candidate: string): boolean {
  return candidate
    .split(/[\\/]+/)
    .some((segment) => segment === ".env" || segment.startsWith(".env."));
}

export function protectedReason(candidate: string): string | undefined {
  if (isInside(sshDirectory, candidate)) return "SSH files are private and unavailable to the agent";
  if (isEnvPath(candidate)) return ".env files are private and unavailable to the agent";
  return undefined;
}

export function commandTouchesSensitivePath(command: string): string | undefined {
  const normalized = command.replace(/\\\s/g, " ");
  const homeEscaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const envReference = /(?:^|[\s'"`/])\.env(?:\.[a-z0-9_-]+)?(?:$|[\s'"`/:])/i;
  const sshReference = new RegExp(
    `(?:~|\\$\\{?HOME\\}?|${homeEscaped})[\\\\/]\\.ssh(?:[\\\\/]|$)|(?:^|[\\s'\"\`])\\.ssh[\\\\/]`,
    "i",
  );
  if (envReference.test(normalized)) return "command references a protected .env file";
  if (sshReference.test(normalized)) return "command references the protected ~/.ssh directory";
  return undefined;
}

export function redactSensitiveLines(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let redacted = 0;
  let suppressSensitiveDiff = false;

  for (const line of lines) {
    if (/^diff --git\s/.test(line)) {
      suppressSensitiveDiff = /(?:^|[\\/])\.env(?:\.[^\s\\/]*)?(?=\s|[\\/]|$)|(?:^|[\\/])\.ssh(?:[\\/]|$)/i.test(line);
    }
    if (suppressSensitiveDiff) {
      redacted++;
      continue;
    }
    if (/(?:^|[\\/])\.env(?:\.[^:\s\\/]*)?(?=[:\s\\/]|$)/i.test(line) || /(?:^|[\\/])\.ssh(?:[\\/]|$)/i.test(line)) {
      redacted++;
      continue;
    }
    kept.push(line);
  }

  if (redacted > 0) kept.push(`[${redacted} result line(s) hidden by the .env/SSH privacy guard]`);
  return kept.join("\n");
}

export default function sensitivePathsExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nPrivacy boundary: never access, search, read, expose, edit, or copy .env/.env.* files or anything under ~/.ssh. Ask the user to provide a redacted value if one is required.`,
  }));

  pi.on("tool_call", (event, ctx) => {
    if (pathTools.has(event.toolName)) {
      const rawPath = typeof event.input.path === "string" ? event.input.path : undefined;
      if (rawPath) {
        const candidate = normalizeInputPath(rawPath, ctx.cwd);
        const reason = protectedReason(candidate);
        if (reason) return { block: true, reason };

        if ((event.toolName === "grep" || event.toolName === "find") && isInside(candidate, sshDirectory)) {
          return { block: true, reason: "Search scope would include the protected ~/.ssh directory" };
        }
      }

      const glob = typeof event.input.glob === "string" ? event.input.glob : "";
      const pattern = typeof event.input.pattern === "string" ? event.input.pattern : "";
      if (/\.env|\.ssh/i.test(`${glob}\n${pattern}`)) {
        return { block: true, reason: "Searches targeting .env or SSH files are blocked" };
      }
    }

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      const reason = commandTouchesSensitivePath(command);
      if (reason) return { block: true, reason };
    }
  });

  pi.on("tool_result", (event) => {
    if (!["grep", "find", "ls", "bash"].includes(event.toolName)) return;
    let changed = false;
    const content = event.content.map((block) => {
      if (block.type !== "text") return block;
      const redacted = redactSensitiveLines(block.text);
      if (redacted !== block.text) changed = true;
      return changed ? { ...block, text: redacted } : block;
    });
    return changed ? { content } : undefined;
  });
}
