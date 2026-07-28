import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  type Component,
  type Focusable,
  type KeyId,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface InterviewOption {
  label: string;
  description?: string;
  recommended: boolean;
}

interface InterviewQuestion {
  id: string;
  label: string;
  prompt: string;
  options: InterviewOption[];
}

type InterviewAnswer =
  | {
      id: string;
      label: string;
      prompt: string;
      kind: "option";
      value: string;
      optionIndex: number;
    }
  | {
      id: string;
      label: string;
      prompt: string;
      kind: "custom";
      value: string;
    };

type InterviewStatus = "submitted" | "cancelled" | "chat_requested" | "unavailable";

interface InterviewResult {
  status: InterviewStatus;
  questions: InterviewQuestion[];
  answers: InterviewAnswer[];
  chatQuestionId?: string;
}

type DisplayOption =
  | { kind: "option"; option: InterviewOption; optionIndex: number }
  | { kind: "custom"; label: string; description: string }
  | { kind: "chat"; label: string; description: string };

const OptionSchema = Type.Object({
  label: Type.String({
    minLength: 1,
    maxLength: 80,
    description: "Concise option label",
  }),
  description: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 240,
      description: "One-line consequence or trade-off for this option",
    }),
  ),
  recommended: Type.Optional(
    Type.Boolean({ description: "Mark at most one option as the evidence-based recommendation" }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    maxLength: 64,
    description: "Stable unique identifier, for example scope or compatibility",
  }),
  label: Type.String({
    minLength: 1,
    maxLength: 48,
    description: "Short tab label, for example Scope, API, or Testing",
  }),
  prompt: Type.String({
    minLength: 1,
    maxLength: 500,
    description: "Focused question about one consequential ambiguity",
  }),
  options: Type.Array(OptionSchema, {
    minItems: 2,
    maxItems: 6,
    description: "Two to six mutually exclusive choices",
  }),
});

const PlanInterviewParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: 4,
    description: "One to four independent questions that cannot be answered from repository evidence",
  }),
});

function cleanInline(value: string): string {
  return value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
}

function cleanAnswer(value: string): string {
  return value.replace(/\p{C}/gu, (character) => (character === "\n" ? "\n" : "")).trim();
}

function normalizeQuestions(rawQuestions: Array<{
  id: string;
  label: string;
  prompt: string;
  options: Array<{ label: string; description?: string; recommended?: boolean }>;
}>): InterviewQuestion[] {
  if (rawQuestions.length < 1 || rawQuestions.length > 4) {
    throw new Error("plan_interview requires between one and four questions");
  }

  const seenIds = new Set<string>();
  return rawQuestions.map((rawQuestion, questionIndex) => {
    const id = cleanInline(rawQuestion.id);
    const label = cleanInline(rawQuestion.label);
    const prompt = cleanInline(rawQuestion.prompt);
    if (!id || !label || !prompt) {
      throw new Error(`Question ${questionIndex + 1} has an empty id, label, or prompt`);
    }
    if (seenIds.has(id)) throw new Error(`Duplicate question id: ${id}`);
    seenIds.add(id);

    if (rawQuestion.options.length < 2 || rawQuestion.options.length > 6) {
      throw new Error(`Question "${id}" requires between two and six options`);
    }

    const seenLabels = new Set<string>();
    let recommendedCount = 0;
    const options = rawQuestion.options.map((rawOption, optionIndex) => {
      const optionLabel = cleanInline(rawOption.label);
      const description = rawOption.description ? cleanInline(rawOption.description) : undefined;
      if (!optionLabel) throw new Error(`Question "${id}" option ${optionIndex + 1} has an empty label`);
      const comparableLabel = optionLabel.toLocaleLowerCase();
      if (seenLabels.has(comparableLabel)) {
        throw new Error(`Question "${id}" has duplicate option label: ${optionLabel}`);
      }
      seenLabels.add(comparableLabel);
      if (rawOption.recommended) recommendedCount++;
      return {
        label: optionLabel,
        description: description || undefined,
        recommended: rawOption.recommended === true,
      };
    });

    if (recommendedCount > 1) {
      throw new Error(`Question "${id}" marks more than one option as recommended`);
    }

    return { id, label, prompt, options };
  });
}

function orderedAnswers(questions: InterviewQuestion[], answers: Map<string, InterviewAnswer>): InterviewAnswer[] {
  return questions.flatMap((question) => {
    const answer = answers.get(question.id);
    return answer ? [answer] : [];
  });
}

function answerSummary(answer: InterviewAnswer): string {
  return answer.kind === "custom"
    ? `${answer.label} [${answer.id}]: user wrote: ${answer.value}`
    : `${answer.label} [${answer.id}]: user selected ${answer.optionIndex + 1}. ${answer.value}`;
}

function toolResult(result: InterviewResult): {
  content: Array<{ type: "text"; text: string }>;
  details: InterviewResult;
} {
  const answered = result.answers.map((answer) => `- ${answerSummary(answer)}`).join("\n");
  const partial = answered ? `\n\nAnswers collected so far:\n${answered}` : "";

  if (result.status === "cancelled") {
    return {
      content: [
        {
          type: "text",
          text: `The user cancelled the plan interview. Do not invent answers or finalize a plan that depends on them.${partial}`,
        },
      ],
      details: result,
    };
  }

  if (result.status === "chat_requested") {
    const question = result.questions.find((candidate) => candidate.id === result.chatQuestionId);
    return {
      content: [
        {
          type: "text",
          text: `The user selected "Chat about this" for ${question?.label ?? result.chatQuestionId}: ${question?.prompt ?? "unknown question"}. Discuss that ambiguity in normal conversation and wait for the user's reply; do not finalize the plan yet.${partial}`,
        },
      ],
      details: result,
    };
  }

  if (result.status === "unavailable") {
    const questions = result.questions.map((question) => `- ${question.label}: ${question.prompt}`).join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Interactive interview UI is unavailable in this Pi mode. Ask these questions as concise plain text and wait for the user's reply:\n${questions}`,
        },
      ],
      details: result,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: `Plan interview completed. Treat these answers as user requirements:\n${answered}`,
      },
    ],
    details: result,
  };
}

async function runDialogFallback(
  ctx: ExtensionContext,
  questions: InterviewQuestion[],
  signal: AbortSignal | undefined,
): Promise<InterviewResult> {
  const answers = new Map<string, InterviewAnswer>();

  for (const question of questions) {
    if (signal?.aborted) {
      return { status: "cancelled", questions, answers: orderedAnswers(questions, answers) };
    }

    const renderedOptions = question.options.map((option, index) => {
      const recommendation = option.recommended ? " (Recommended)" : "";
      const description = option.description ? ` — ${option.description}` : "";
      return `${index + 1}. ${option.label}${recommendation}${description}`;
    });
    const customOption = `${question.options.length + 1}. Type something`;
    const chatOption = `${question.options.length + 2}. Chat about this`;
    const selected = await ctx.ui.select(
      question.prompt,
      [...renderedOptions, customOption, chatOption],
      signal ? { signal } : undefined,
    );

    if (!selected) {
      return { status: "cancelled", questions, answers: orderedAnswers(questions, answers) };
    }
    if (selected === chatOption) {
      return {
        status: "chat_requested",
        questions,
        answers: orderedAnswers(questions, answers),
        chatQuestionId: question.id,
      };
    }
    if (selected === customOption) {
      let value = "";
      while (!value) {
        const custom = await ctx.ui.input(
          `${question.label}: your answer`,
          "Type a concise answer",
          signal ? { signal } : undefined,
        );
        if (custom === undefined) {
          return { status: "cancelled", questions, answers: orderedAnswers(questions, answers) };
        }
        value = cleanAnswer(custom);
        if (!value) ctx.ui.notify("Enter a non-empty answer or cancel the dialog", "warning");
      }
      answers.set(question.id, {
        id: question.id,
        label: question.label,
        prompt: question.prompt,
        kind: "custom",
        value,
      });
      continue;
    }

    const optionIndex = renderedOptions.indexOf(selected);
    if (optionIndex < 0) {
      return { status: "cancelled", questions, answers: orderedAnswers(questions, answers) };
    }
    answers.set(question.id, {
      id: question.id,
      label: question.label,
      prompt: question.prompt,
      kind: "option",
      value: question.options[optionIndex].label,
      optionIndex,
    });
  }

  return { status: "submitted", questions, answers: orderedAnswers(questions, answers) };
}

export default function planInterviewExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "plan_interview",
    label: "Plan Interview",
    description:
      "Ask the user a compact, tabbed series of clarifying questions during plan mode. Use only after repository inspection leaves consequential ambiguities. Provide evidence-based choices with descriptions, and mark at most one recommended option per question.",
    parameters: PlanInterviewParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = normalizeQuestions(params.questions);
      if (signal?.aborted) {
        return toolResult({ status: "cancelled", questions, answers: [] });
      }

      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          return toolResult(await runDialogFallback(ctx, questions, signal));
        }
        return toolResult({ status: "unavailable", questions, answers: [] });
      }

      const result = await ctx.ui.custom<InterviewResult>((tui, theme, keybindings, done) => {
        const answers = new Map<string, InterviewAnswer>();
        const isMulti = questions.length > 1;
        const submitTab = questions.length;
        const totalTabs = questions.length + 1;
        let currentTab = 0;
        let optionIndex = 0;
        let inputMode = false;
        let inputError = "";
        let cachedLines: string[] | undefined;
        let cachedWidth: number | undefined;
        let focused = false;
        let completed = false;

        const editorTheme: EditorTheme = {
          borderColor: (text) => theme.fg("accent", text),
          selectList: {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          },
        };
        const editor = new Editor(tui, editorTheme);

        function refresh(): void {
          cachedLines = undefined;
          cachedWidth = undefined;
          tui.requestRender();
        }

        function currentQuestion(): InterviewQuestion | undefined {
          return questions[currentTab];
        }

        function currentOptions(): DisplayOption[] {
          const question = currentQuestion();
          if (!question) return [];
          return [
            ...question.options.map(
              (option, index): DisplayOption => ({ kind: "option", option, optionIndex: index }),
            ),
            {
              kind: "custom",
              label: "Type something",
              description: "Write a different answer in your own words.",
            },
            {
              kind: "chat",
              label: "Chat about this",
              description: "Discuss this point with the agent before deciding.",
            },
          ];
        }

        function allAnswered(): boolean {
          return questions.every((question) => answers.has(question.id));
        }

        function finish(status: InterviewStatus, chatQuestionId?: string): void {
          if (completed) return;
          completed = true;
          done({
            status,
            questions,
            answers: orderedAnswers(questions, answers),
            chatQuestionId,
          });
        }

        function restoreOptionIndex(): void {
          const question = currentQuestion();
          if (!question) {
            optionIndex = 0;
            return;
          }
          const answer = answers.get(question.id);
          optionIndex = answer?.kind === "option" ? answer.optionIndex : answer?.kind === "custom" ? question.options.length : 0;
        }

        function selectTab(tab: number): void {
          inputMode = false;
          inputError = "";
          editor.focused = false;
          currentTab = (tab + totalTabs) % totalTabs;
          restoreOptionIndex();
          refresh();
        }

        function advanceAfterAnswer(): void {
          if (!isMulti) {
            finish("submitted");
            return;
          }
          const nextUnanswered = questions.findIndex(
            (question, index) => index > currentTab && !answers.has(question.id),
          );
          selectTab(nextUnanswered >= 0 ? nextUnanswered : submitTab);
        }

        function beginCustomAnswer(): void {
          const question = currentQuestion();
          if (!question) return;
          const previous = answers.get(question.id);
          editor.setText(previous?.kind === "custom" ? previous.value : "");
          editor.focused = focused;
          inputMode = true;
          inputError = "";
          refresh();
        }

        function chooseOption(index: number): void {
          const question = currentQuestion();
          const options = currentOptions();
          const selected = options[index];
          if (!question || !selected) return;

          optionIndex = index;
          if (selected.kind === "custom") {
            beginCustomAnswer();
            return;
          }
          if (selected.kind === "chat") {
            answers.delete(question.id);
            finish("chat_requested", question.id);
            return;
          }

          answers.set(question.id, {
            id: question.id,
            label: question.label,
            prompt: question.prompt,
            kind: "option",
            value: selected.option.label,
            optionIndex: selected.optionIndex,
          });
          advanceAfterAnswer();
        }

        editor.onChange = () => {
          inputError = "";
          refresh();
        };
        editor.onSubmit = (rawValue) => {
          const question = currentQuestion();
          const value = cleanAnswer(rawValue);
          if (!question) return;
          if (!value) {
            inputError = "Enter a non-empty answer or press Esc to go back.";
            refresh();
            return;
          }
          answers.set(question.id, {
            id: question.id,
            label: question.label,
            prompt: question.prompt,
            kind: "custom",
            value,
          });
          inputMode = false;
          editor.focused = false;
          advanceAfterAnswer();
        };

        function handleInput(data: string): void {
          if (inputMode) {
            if (keybindings.matches(data, "tui.select.cancel")) {
              inputMode = false;
              inputError = "";
              editor.focused = false;
              refresh();
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          if (isMulti && keybindings.matches(data, "tui.input.tab")) {
            selectTab(currentTab + 1);
            return;
          }
          if (isMulti && matchesKey(data, Key.shift("tab"))) {
            selectTab(currentTab - 1);
            return;
          }
          if (isMulti && matchesKey(data, Key.right)) {
            selectTab(currentTab + 1);
            return;
          }
          if (isMulti && matchesKey(data, Key.left)) {
            selectTab(currentTab - 1);
            return;
          }

          if (currentTab === submitTab) {
            if (keybindings.matches(data, "tui.select.confirm") && allAnswered()) {
              finish("submitted");
            } else if (keybindings.matches(data, "tui.select.cancel")) {
              selectTab(questions.length - 1);
            }
            return;
          }

          const options = currentOptions();
          if (keybindings.matches(data, "tui.select.up")) {
            optionIndex = (optionIndex - 1 + options.length) % options.length;
            refresh();
            return;
          }
          if (keybindings.matches(data, "tui.select.down")) {
            optionIndex = (optionIndex + 1) % options.length;
            refresh();
            return;
          }
          if (keybindings.matches(data, "tui.select.confirm")) {
            chooseOption(optionIndex);
            return;
          }

          for (let index = 0; index < options.length && index < 9; index++) {
            if (matchesKey(data, String(index + 1) as KeyId)) {
              chooseOption(index);
              return;
            }
          }

          if (keybindings.matches(data, "tui.select.cancel")) finish("cancelled");
        }

        function render(width: number): string[] {
          if (cachedLines && cachedWidth === width) return cachedLines;
          const renderWidth = Math.max(1, width);
          const lines: string[] = [];
          const question = currentQuestion();
          const options = currentOptions();

          function addWrapped(text: string): void {
            lines.push(...wrapTextWithAnsi(text, renderWidth));
          }

          function addWrappedWithPrefix(prefix: string, text: string): void {
            const prefixWidth = visibleWidth(prefix);
            if (prefixWidth >= renderWidth) {
              addWrapped(prefix + text);
              return;
            }
            const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
            const continuation = " ".repeat(prefixWidth);
            wrapped.forEach((line, index) => lines.push(`${index === 0 ? prefix : continuation}${line}`));
          }

          lines.push(theme.fg("accent", "─".repeat(renderWidth)));

          if (isMulti) {
            const tabs: string[] = [theme.fg("dim", "← ")];
            questions.forEach((candidate, index) => {
              const answered = answers.has(candidate.id);
              const marker = answered ? "■" : "□";
              const text = ` ${marker} ${candidate.label} `;
              tabs.push(
                index === currentTab
                  ? theme.bg("selectedBg", theme.fg("text", text))
                  : theme.fg(answered ? "success" : "muted", text),
              );
              tabs.push(" ");
            });
            const submitText = " ✓ Submit ";
            tabs.push(
              currentTab === submitTab
                ? theme.bg("selectedBg", theme.fg("text", submitText))
                : theme.fg(allAnswered() ? "success" : "dim", submitText),
            );
            tabs.push(theme.fg("dim", " →"));
            addWrappedWithPrefix(" ", tabs.join(""));
            lines.push("");
          }

          if (currentTab === submitTab) {
            addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Review your answers")));
            lines.push("");
            questions.forEach((candidate) => {
              const answer = answers.get(candidate.id);
              const value = answer
                ? `${answer.kind === "custom" ? "(wrote) " : ""}${answer.value}`
                : theme.fg("warning", "Not answered");
              addWrappedWithPrefix(" ", `${theme.fg("muted", `${candidate.label}: `)}${value}`);
            });
            lines.push("");
            addWrappedWithPrefix(
              " ",
              allAnswered()
                ? theme.fg("success", "Press Enter to submit")
                : theme.fg("warning", "Answer every tab before submitting"),
            );
          } else if (question) {
            addWrappedWithPrefix(" ", theme.fg("text", question.prompt));
            lines.push("");

            options.forEach((displayOption, index) => {
              const selected = index === optionIndex;
              const answer = answers.get(question.id);
              const isAnswered =
                (displayOption.kind === "option" &&
                  answer?.kind === "option" &&
                  answer.optionIndex === displayOption.optionIndex) ||
                (displayOption.kind === "custom" && answer?.kind === "custom");
              const prefix = selected ? theme.fg("accent", "> ") : isAnswered ? theme.fg("success", "✓ ") : "  ";
              const label =
                displayOption.kind === "option" ? displayOption.option.label : displayOption.label;
              const recommendation =
                displayOption.kind === "option" && displayOption.option.recommended
                  ? theme.fg("success", " (Recommended)")
                  : "";
              const styledLabel = theme.fg(selected ? "accent" : "text", `${index + 1}. ${label}`);
              addWrappedWithPrefix(prefix, styledLabel + recommendation);

              const description =
                displayOption.kind === "option" ? displayOption.option.description : displayOption.description;
              if (description) addWrappedWithPrefix("     ", theme.fg("muted", description));
            });

            if (inputMode) {
              lines.push("");
              addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
              editor.render(Math.max(1, renderWidth - 2)).forEach((line) => lines.push(` ${line}`));
              if (inputError) addWrappedWithPrefix(" ", theme.fg("warning", inputError));
            }
          }

          lines.push("");
          const help = inputMode
            ? "Enter submit • Esc go back"
            : isMulti
              ? "Tab/←→ questions • ↑↓ select • 1-8 choose • Enter confirm • Esc cancel"
              : "↑↓ select • 1-8 choose • Enter confirm • Esc cancel";
          addWrappedWithPrefix(" ", theme.fg("dim", help));
          lines.push(theme.fg("accent", "─".repeat(renderWidth)));
          cachedLines = lines;
          cachedWidth = width;
          return lines;
        }

        const abort = () => finish("cancelled");
        signal?.addEventListener("abort", abort, { once: true });

        const component: Component & Focusable & { dispose(): void } = {
          get focused() {
            return focused;
          },
          set focused(value: boolean) {
            focused = value;
            editor.focused = value && inputMode;
          },
          render,
          handleInput,
          invalidate() {
            cachedLines = undefined;
            cachedWidth = undefined;
            editor.invalidate();
          },
          dispose() {
            signal?.removeEventListener("abort", abort);
          },
        };
        return component;
      });

      return toolResult(result);
    },

    renderCall(args, theme, _context) {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      const labels = questions
        .map((question: { label?: string; id?: string }) => question.label || question.id)
        .filter(Boolean)
        .join(", ");
      let text = theme.fg("toolTitle", theme.bold("plan interview "));
      text += theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`);
      if (labels) text += theme.fg("dim", ` (${labels})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as InterviewResult | undefined;
      if (!details) {
        const block = result.content[0];
        return new Text(block?.type === "text" ? block.text : "", 0, 0);
      }
      if (details.status === "cancelled") return new Text(theme.fg("warning", "Interview cancelled"), 0, 0);
      if (details.status === "chat_requested") {
        const question = details.questions.find((candidate) => candidate.id === details.chatQuestionId);
        return new Text(theme.fg("accent", `Chat requested: ${question?.label ?? details.chatQuestionId}`), 0, 0);
      }
      if (details.status === "unavailable") {
        return new Text(theme.fg("warning", "Interactive interview unavailable"), 0, 0);
      }
      const lines = details.answers.map(
        (answer) =>
          `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label)}: ${answer.kind === "custom" ? theme.fg("muted", "(wrote) ") : ""}${answer.value}`,
      );
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
