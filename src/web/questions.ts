import type { Permission } from "../shared/wire.ts";
export interface Question {
  header: string; question: string;
  options: { label: string; description?: string }[];
  multiple: boolean; other: boolean; secret: boolean; required: boolean;
}
export interface Answer { selected: string[]; text: string }
export function questionsFor(permission: Permission): Question[] | null {
  const input = permission.input as { questions?: unknown } | undefined;
  if (permission.kind !== "question" || !Array.isArray(input?.questions) || !input.questions.length) return null;
  const questions: Question[] = [];
  const headers = new Set<string>();
  for (const raw of input.questions) {
    if (!raw || typeof raw !== "object" || typeof raw.header !== "string" || !raw.header.trim() || typeof raw.question !== "string" || !raw.question.trim() || headers.has(raw.header)) return null;
    if (raw.options !== undefined && !Array.isArray(raw.options)) return null;
    const options = raw.options ?? [];
    if (options.some((o: any) => !o || typeof o.label !== "string" || !o.label.trim() || (o.description !== undefined && typeof o.description !== "string"))) return null;
    if (new Set(options.map((o: any) => o.label)).size !== options.length) return null;
    headers.add(raw.header);
    questions.push({ header: raw.header, question: raw.question, options,
      multiple: raw.multiSelect === true, other: raw.isOther === true || permission.name === "AskUserQuestion" || !options.length,
      secret: raw.isSecret === true, required: raw.required !== false });
  }
  return questions;
}
export function questionAnswers(questions: Question[], answers: Answer[]) {
  const entries = questions.map((q, i) => {
    const answer = answers[i] ?? { selected: [], text: "" };
    const selected = answer.selected.filter(value => q.options.some(o => o.label === value));
    const free = q.other ? answer.text.trim() : "";
    const text = q.multiple ? [...selected, ...(free ? [free] : [])].join(", ") : free || selected[0] || "";
    if (q.required && !text) throw new Error(`Answer ${q.header} before submitting.`);
    return [q.header, text];
  });
  return { answers: Object.fromEntries(entries) as Record<string, string> };
}
