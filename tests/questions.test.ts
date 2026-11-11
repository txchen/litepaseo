import test from "node:test";
import assert from "node:assert/strict";
import { questionsFor, questionAnswers } from "../src/web/questions.ts";
const permission = (questions: unknown[], name = "request_user_input") => ({ id: "p", kind: "question", name, input: { questions } });
test("Codex/Pi header answers encode single, multiple, free text and secrets", () => {
  const questions = questionsFor(permission([
    { header: "Plan", question: "Choose", options: [{ label: "First" }, { label: "Second" }] },
    { header: "Scope", question: "Choose several", multiSelect: true, isOther: true, options: [{ label: "Tests" }, { label: "Docs" }] },
    { header: "Token", question: "Secret", isSecret: true },
  ]))!;
  assert.equal(questions[2].secret, true);
  assert.throws(() => questionAnswers(questions, []), /Answer Plan/);
  assert.deepEqual(questionAnswers(questions, [
    { selected: ["First"], text: "ignored: other is not allowed" },
    { selected: ["Tests", "Docs"], text: "UI" },
    { selected: [], text: "secret" },
  ]), { answers: { Plan: "First", Scope: "Tests, Docs, UI", Token: "secret" } });
});
test("Claude supports an alternative answer and malformed schemas fall back intact", () => {
  const q = { header: "Choice", question: "Choose", options: [{ label: "Default" }] };
  const questions = questionsFor(permission([q], "AskUserQuestion"))!;
  assert.deepEqual(questionAnswers(questions, [{ selected: ["Default"], text: "My answer" }]), { answers: { Choice: "My answer" } });
  assert.equal(questionsFor(permission([q, q])), null);
  assert.equal(questionsFor(permission([{ ...q, options: [null] }])), null);
  assert.equal(questionsFor(permission([{ title: "Unknown schema" }])), null);
});
