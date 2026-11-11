<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Permission } from "../shared/wire.ts";
import { questionsFor, questionAnswers, type Answer } from "./questions.ts";
import Icon from "./Icon.vue";
const props = defineProps<{ permission: Permission; busy: boolean }>();
const emit = defineEmits<{ respond: [response: Record<string, unknown>] }>();
const questions = computed(() => questionsFor(props.permission));
const answers = ref<Answer[]>([]);
const json = ref("");
const action = ref("");
const error = ref("");
watch(() => JSON.stringify(props.permission.input), () => {
  answers.value = (questions.value ?? []).map(() => ({ selected: [], text: "" }));
  json.value = ""; error.value = "";
}, { immediate: true });
function choose(index: number, label: string, multiple: boolean) {
  const answer = answers.value[index];
  if (multiple) answer.selected = answer.selected.includes(label) ? answer.selected.filter(x => x !== label) : [...answer.selected, label];
  else { answer.selected = [label]; answer.text = ""; }
}
function submit(allow: boolean) {
  error.value = "";
  try {
    const response: Record<string, unknown> = { behavior: allow ? "allow" : "deny" };
    if (action.value) response.selectedActionId = action.value;
    if (allow && props.permission.kind === "question") {
      if (questions.value) response.updatedInput = questionAnswers(questions.value, answers.value);
      else {
        const input = JSON.parse(json.value);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Enter a JSON object for the answer.");
        response.updatedInput = input;
      }
    }
    emit("respond", response);
  } catch (e) { error.value = e instanceof SyntaxError ? "Enter a valid JSON object for the answer." : (e as Error).message; }
}
</script>
<template>
  <form class="permission" @submit.prevent="submit(true)">
    <div class="permission-head">
      <span class="permission-icon"><Icon name="shield" :size="16" /></span>
      <div class="grow">
        <div class="row-title">{{ permission.title || permission.name }}</div>
        <div class="row-sub">{{ permission.kind === 'question' ? 'Question' : 'Permission request' }} · {{ permission.name }}</div>
      </div>
    </div>
    <details class="permission-details"><summary>Request details</summary><pre>{{ JSON.stringify(permission.input, null, 2) }}</pre></details>
    <label v-if="permission.actions?.length" class="field">
      <span>Action</span><select v-model="action"><option value="">Default</option><option v-for="a in permission.actions" :key="a.id" :value="a.id">{{ a.label || a.id }}</option></select>
    </label>
    <template v-if="questions">
      <fieldset v-for="(q, index) in questions" :key="q.header" class="question-field" :disabled="busy">
        <legend>{{ q.header }}{{ q.required ? ' *' : '' }}: {{ q.question }}</legend>
        <label v-for="option in q.options" :key="option.label" class="question-option">
          <input :type="q.multiple ? 'checkbox' : 'radio'" :name="permission.id + ':' + index" :checked="answers[index]?.selected.includes(option.label) && (q.multiple || !answers[index]?.text)" @change="choose(index, option.label, q.multiple)" />
          <span>{{ option.label }}<small v-if="option.description" class="row-sub"> — {{ option.description }}</small></span>
        </label>
        <label v-if="q.other" class="field">
          <span>{{ q.options.length ? 'Other answer' : 'Your answer' }}</span>
          <input v-model="answers[index]!.text" :type="q.secret ? 'password' : 'text'" :aria-label="q.header + ': ' + (q.options.length ? 'Other answer' : 'Your answer')" autocomplete="off" />
        </label>
      </fieldset>
    </template>
    <label v-else-if="permission.kind === 'question'" class="field">
      <span>This question format needs a JSON answer.</span><textarea v-model="json" aria-label="Answer (JSON)" rows="3" placeholder='{"answers": {}}'></textarea>
    </label>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="permission-actions">
      <button type="button" class="btn btn-outline" :disabled="busy" @click="submit(false)">Deny</button>
      <button class="btn btn-primary" :disabled="busy">Allow / submit</button>
    </div>
  </form>
</template>
<style scoped>
.question-field { border: 0; padding: 12px 0; margin: 0; min-width: 0; }
.question-field legend { font-weight: 600; padding: 0; }
.question-option { display: flex; align-items: center; gap: 10px; min-height: 44px; cursor: pointer; }
.question-option input { width: auto; flex: 0 0 auto; }
</style>
