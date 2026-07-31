import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { createWorker, OEM } from "tesseract.js";
import { Type } from "typebox";

export default function deepseekOcr(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ocr_image",
    label: "OCR Image",
    description: "Extract text from a local image with Tesseract OCR. Read-only for the project; defaults to French and English.",
    parameters: Type.Object({
      path: Type.String({ description: "Image path, absolute or relative to the current working directory" }),
      languages: Type.Optional(Type.String({ description: "Tesseract language codes joined with + (default: fra+eng)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const rawPath = params.path.startsWith("@") ? params.path.slice(1) : params.path;
      const imagePath = resolve(ctx.cwd, rawPath);
      const imageStat = await stat(imagePath).catch(() => undefined);
      if (!imageStat?.isFile()) throw new Error(`OCR image not found or not a file: ${imagePath}`);
      const languages = params.languages?.trim() || "fra+eng";
      if (!/^[a-z0-9_+-]+$/i.test(languages)) throw new Error(`Invalid Tesseract language expression: ${languages}`);

      const cachePath = join(homedir(), ".cache", "pi-deepseek-harness", "tesseract");
      await mkdir(cachePath, { recursive: true });
      onUpdate?.({ content: [{ type: "text", text: `Loading OCR languages ${languages}...` }] });
      let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
      const abortWorker = () => { if (worker) void worker.terminate().catch(() => undefined); };
      signal?.addEventListener("abort", abortWorker, { once: true });
      try {
        if (signal?.aborted) throw new Error("OCR cancelled");
        worker = await createWorker(languages, OEM.LSTM_ONLY, { cachePath });
        if (signal?.aborted) throw new Error("OCR cancelled");
        const result = await worker.recognize(imagePath);
        const text = result.data.text.trimEnd();
        const confidence = Number(result.data.confidence) || 0;
        const truncation = truncateHead(text || "(no text detected)", { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
        let fullOutputPath: string | undefined;
        if (truncation.truncated) {
          const outputDir = join(tmpdir(), "pi-deepseek-harness-ocr");
          await mkdir(outputDir, { recursive: true });
          fullOutputPath = join(outputDir, `${Date.now()}-${toolCallId.replace(/[^a-z0-9_-]/gi, "_")}.txt`);
          await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath!, text, "utf8"));
        }
        const suffix = fullOutputPath ? `\n\n[OCR output truncated. Full text saved to: ${fullOutputPath}]` : "";
        return {
          content: [{ type: "text", text: `OCR text (${languages}, confidence ${confidence.toFixed(1)}%):\n\n${truncation.content}${suffix}` }],
          details: { imagePath, languages, confidence, truncated: truncation.truncated, fullOutputPath, source: basename(imagePath) },
        };
      } finally {
        signal?.removeEventListener("abort", abortWorker);
        if (worker) await worker.terminate().catch(() => undefined);
      }
    },
  });
}
