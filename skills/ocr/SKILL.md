---
name: ocr
description: Extract text from PNG, JPEG, WebP, BMP, or TIFF images with local Tesseract OCR in French and English. Use for screenshots, scanned documents, error dialogs, terminal captures, and other images containing text.
allowed-tools: ocr_image
---

# OCR local

Use the `ocr_image` tool to extract text from an image. Do not install packages in the user's workspace and do not reproduce the old inline `node -e` command.

## Arguments

The user normally provides:

1. an image path, relative to the current working directory or absolute;
2. optionally, Tesseract language codes such as `fra+eng`, `eng`, or `fra`.

Default to `fra+eng` when no language is specified.

If no image path was supplied, ask for one. Do not guess among unrelated image files.

## Procedure

1. Call `ocr_image` with the path and requested languages.
2. Preserve the extracted wording, line breaks, numbers, punctuation, and visible errors as faithfully as possible.
3. Report the confidence returned by Tesseract.
4. Clearly mark uncertain or apparently garbled fragments instead of silently rewriting them.
5. If the user asks for interpretation or correction, put the raw OCR transcription first, then provide the interpreted version separately.

The first use of a language may download its Tesseract data into the harness cache outside the project workspace.
