const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");
const { URL } = require("url");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const assetsDir = path.join(__dirname, "assets");
const experimentPage = fs.readFileSync(path.join(__dirname, "experiment-page.html"), "utf8");
const DATA_DIR = process.env.PROMPT_EXPERIMENT_DATA_DIR || path.join(os.homedir(), ".prompt-experiment-tester");
const DATA_FILE = process.env.PROMPT_EXPERIMENT_DATA_FILE || path.join(DATA_DIR, "data.json");
const RUN_CONCURRENCY = 3;
const MODEL_REQUEST_TIMEOUT_MS = 120000;
const CURL_REQUEST_TIMEOUT_SECONDS = 125;
let storeUpdateQueue = Promise.resolve();

function extractTemplateVariables(...texts) {
  const seen = new Set();
  const names = [];
  const matcher = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

  texts.forEach((text) => {
    let match;
    matcher.lastIndex = 0;
    while ((match = matcher.exec(String(text || "")))) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        names.push(match[1]);
      }
    }
  });

  return names;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseVariableAssignments(batchText, variables) {
  const result = {};
  const lines = String(batchText || "").split(/\r?\n/);

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    variables.forEach((name) => {
      const escaped = escapeRegExp(name);
      const keyed = new RegExp("^\\s*(?:\\{\\{\\s*)?" + escaped + "(?:\\s*\\}\\})?\\s*[:=：]\\s*(.+)$");
      const braced = new RegExp("^\\s*\\{\\{\\s*" + escaped + "\\s*\\}\\}\\s+(.+)$");
      const match = trimmed.match(keyed) || trimmed.match(braced);
      if (match) result[name] = match[1].trim();
    });
  });

  return result;
}

function applyTemplateVariables(text, values) {
  return String(text || "").replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (full, name) => {
    if (!Object.prototype.hasOwnProperty.call(values || {}, name)) return full;
    const value = String(values[name] || "");
    return value ? value : full;
  });
}

function createId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function defaultDraft() {
  return {
    variableValues: {},
    selectedPromptVersionIds: [],
    selectedModelConfigIds: []
  };
}

function defaultWorkflowDraft() {
  return {
    initialValues: {}
  };
}

function createPromptVersion(name = "V1") {
  return {
    id: createId("prompt"),
    name,
    systemPrompt: "你是一个简洁清楚的助手，请用中文回答。",
    userPrompt: "请基于下面的输入完成任务：\n\n{{input}}",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createProject(name = "默认项目") {
  const promptVersion = createPromptVersion();
  return {
    id: createId("project"),
    name,
    promptVersions: [promptVersion],
    variableSamples: [],
    draft: {
      ...defaultDraft(),
      selectedPromptVersionIds: [promptVersion.id]
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createWorkflow(projectId, name = "新链路") {
  const now = new Date().toISOString();
  return {
    id: createId("workflow"),
    projectId,
    name,
    steps: [],
    draft: defaultWorkflowDraft(),
    createdAt: now,
    updatedAt: now
  };
}

function createDefaultStore() {
  return {
    version: 1,
    models: [],
    projects: [createProject()],
    runs: [],
    workflows: [],
    workflowRuns: []
  };
}

function normalizeDraft(draft) {
  return {
    variableValues: draft && draft.variableValues && typeof draft.variableValues === "object" ? draft.variableValues : {},
    selectedPromptVersionIds: Array.isArray(draft && draft.selectedPromptVersionIds) ? draft.selectedPromptVersionIds : [],
    selectedModelConfigIds: Array.isArray(draft && draft.selectedModelConfigIds) ? draft.selectedModelConfigIds : []
  };
}

function normalizeProject(project) {
  const promptVersions = Array.isArray(project && project.promptVersions) && project.promptVersions.length
    ? project.promptVersions.map((prompt, index) => ({
      id: String(prompt.id || createId("prompt")),
      name: String(prompt.name || `V${index + 1}`),
      systemPrompt: String(prompt.systemPrompt || ""),
      userPrompt: String(prompt.userPrompt || ""),
      createdAt: prompt.createdAt || new Date().toISOString(),
      updatedAt: prompt.updatedAt || prompt.createdAt || new Date().toISOString()
    }))
    : [createPromptVersion()];

  return {
    id: String(project && project.id || createId("project")),
    name: String(project && project.name || "未命名项目"),
    promptVersions,
    variableSamples: Array.isArray(project && project.variableSamples) ? project.variableSamples.map(normalizeVariableSample) : [],
    draft: normalizeDraft(project && project.draft),
    createdAt: project && project.createdAt || new Date().toISOString(),
    updatedAt: project && project.updatedAt || project && project.createdAt || new Date().toISOString()
  };
}

function normalizeWorkflowStep(step, index = 0) {
  return {
    id: String(step && step.id || createId("step")),
    name: String(step && step.name || `Step ${index + 1}`),
    promptVersionId: String(step && step.promptVersionId || ""),
    modelConfigId: String(step && step.modelConfigId || ""),
    outputVariable: String(step && step.outputVariable || `step_${index + 1}_answer`),
    stopOnError: step && Object.prototype.hasOwnProperty.call(step, "stopOnError") ? Boolean(step.stopOnError) : true
  };
}

function normalizeWorkflowDraft(draft) {
  return {
    initialValues: normalizeVariableValues(draft && draft.initialValues)
  };
}

function normalizeWorkflow(workflow) {
  const now = new Date().toISOString();
  return {
    id: String(workflow && workflow.id || createId("workflow")),
    projectId: String(workflow && workflow.projectId || ""),
    name: String(workflow && workflow.name || "未命名链路"),
    steps: Array.isArray(workflow && workflow.steps) ? workflow.steps.map(normalizeWorkflowStep) : [],
    draft: normalizeWorkflowDraft(workflow && workflow.draft),
    createdAt: workflow && workflow.createdAt || now,
    updatedAt: workflow && workflow.updatedAt || workflow && workflow.createdAt || now
  };
}

function normalizeVariableValues(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [String(name), String(value || "")]));
}

function normalizeVariableSample(sample) {
  const now = new Date().toISOString();
  return {
    id: String(sample && sample.id || createId("sample")),
    name: String(sample && sample.name || "未命名样例"),
    variableValues: normalizeVariableValues(sample && sample.variableValues),
    createdAt: sample && sample.createdAt || now,
    updatedAt: sample && sample.updatedAt || sample && sample.createdAt || now
  };
}

function normalizeModel(model) {
  return {
    id: String(model && model.id || createId("model")),
    name: String(model && model.name || "未命名模型"),
    apiKey: String(model && model.apiKey || ""),
    baseUrl: String(model && model.baseUrl || ""),
    model: String(model && model.model || ""),
    apiType: String(model && model.apiType || "openai-text"),
    provider: String(model && model.provider || "custom"),
    thinkingMode: normalizeThinkingMode(model && model.thinkingMode),
    createdAt: model && model.createdAt || new Date().toISOString(),
    updatedAt: model && model.updatedAt || model && model.createdAt || new Date().toISOString()
  };
}

function normalizeThinkingMode(value) {
  return value === "enabled" || value === "disabled" ? value : "default";
}

function normalizeStore(value) {
  const raw = value && typeof value === "object" ? value : {};
  const projects = Array.isArray(raw.projects) && raw.projects.length
    ? raw.projects.map(normalizeProject)
    : [createProject()];

  return {
    version: 1,
    models: Array.isArray(raw.models) ? raw.models.map(normalizeModel) : [],
    projects,
    runs: Array.isArray(raw.runs) ? raw.runs : [],
    workflows: Array.isArray(raw.workflows) ? raw.workflows.map(normalizeWorkflow) : [],
    workflowRuns: Array.isArray(raw.workflowRuns) ? raw.workflowRuns : []
  };
}

async function writeStore(store, filePath = DATA_FILE) {
  const normalized = normalizeStore(store);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(normalized, null, 2), "utf8");
  await fs.promises.rename(tempPath, filePath);
  return normalized;
}

async function readStore(filePath = DATA_FILE) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return writeStore(createDefaultStore(), filePath);
  }
}

function updateStore(mutator, filePath = DATA_FILE) {
  const operation = storeUpdateQueue.then(async () => {
    const store = await readStore(filePath);
    const result = await mutator(store);
    await writeStore(store, filePath);
    return result;
  });
  storeUpdateQueue = operation.catch(() => {});
  return operation;
}

function snapshotModel(model) {
  return {
    id: model.id,
    name: model.name,
    baseUrl: model.baseUrl,
    model: model.model,
    apiType: model.apiType,
    provider: model.provider || "custom",
    thinkingMode: normalizeThinkingMode(model.thinkingMode)
  };
}

function snapshotPrompt(prompt, values) {
  return {
    id: prompt.id,
    name: prompt.name,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    finalSystemPrompt: applyTemplateVariables(prompt.systemPrompt, values),
    finalUserPrompt: applyTemplateVariables(prompt.userPrompt, values)
  };
}

function templateValueMap(context, stepOutputs = {}) {
  const values = { ...normalizeVariableValues(context) };
  Object.entries(stepOutputs).forEach(([key, output]) => {
    values[`steps.${key}.answer`] = output.answer || "";
    values[`steps.${key}.status`] = output.status || "";
    values[`steps.${key}.error`] = output.error || "";
  });
  return values;
}

function safeStepAlias(step, index) {
  const raw = String(step.outputVariable || step.name || `step_${index + 1}`).trim();
  const alias = raw.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return alias || `step_${index + 1}`;
}

function buildRequestPreview(model, promptSnapshot) {
  const messages = [];
  if (promptSnapshot.finalSystemPrompt) messages.push({ role: "system", content: promptSnapshot.finalSystemPrompt });
  messages.push({ role: "user", content: promptSnapshot.finalUserPrompt });
  return {
    apiType: model.apiType,
    url: buildChatUrl(model.baseUrl),
    method: "POST",
    headers: { Authorization: "Bearer ***", "Content-Type": "application/json" },
    body: buildChatBody(model, messages, { temperature: 0.7 })
  };
}

function buildModelTestRequestPreview(model) {
  return {
    apiType: model.apiType,
    url: buildChatUrl(model.baseUrl),
    method: "POST",
    headers: { Authorization: "Bearer ***", "Content-Type": "application/json" },
    body: buildChatBody(model, [{ role: "user", content: "请只回复 OK。" }], { temperature: 0, max_tokens: 8 })
  };
}

function providerSupportsThinking(model) {
  const baseUrl = String(model && model.baseUrl || "");
  return ["deepseek", "volcengine-ark"].includes(model && model.provider)
    || /api\.deepseek\.com/i.test(baseUrl)
    || /ark\.[^.]+\.volces\.com/i.test(baseUrl);
}

function buildChatBody(model, messages, options = {}) {
  const body = {
    model: model.model,
    messages,
    ...options
  };
  const thinkingMode = normalizeThinkingMode(model.thinkingMode);
  if (thinkingMode !== "default" && providerSupportsThinking(model)) {
    body.thinking = { type: thinkingMode };
    delete body.temperature;
  }
  return body;
}

function parseApiPayload(apiResponse) {
  let raw;
  try {
    raw = JSON.parse(apiResponse.text);
  } catch {
    raw = { text: apiResponse.text };
  }
  return raw;
}

function extractAnswer(raw) {
  return raw && raw.choices && raw.choices[0] && raw.choices[0].message
    ? raw.choices[0].message.content || ""
    : "";
}

function extractReasoningContent(raw) {
  return raw && raw.choices && raw.choices[0] && raw.choices[0].message
    ? raw.choices[0].message.reasoning_content || ""
    : "";
}

function createCellError(error, elapsedMs, promptSnapshot, modelSnapshot, requestPreview, raw = null) {
  return {
    promptVersionId: promptSnapshot.id,
    modelConfigId: modelSnapshot.id,
    status: "error",
    elapsedMs,
    tokens: null,
    finishReason: "",
    answer: "",
    error: error.message || String(error),
    raw,
    requestPreview,
    promptSnapshot,
    modelSnapshot
  };
}

async function runCell(model, promptSnapshot, requestFn = postJson) {
  const modelSnapshot = snapshotModel(model);
  const requestPreview = buildRequestPreview(modelSnapshot, promptSnapshot);
  const startedAt = Date.now();

  try {
    const apiResponse = await requestFn(
      requestPreview.url,
      requestPreview.body,
      { Authorization: `Bearer ${model.apiKey}` }
    );
    const raw = parseApiPayload(apiResponse);
    const elapsedMs = Date.now() - startedAt;
    if (!apiResponse.ok) {
      const message = raw.error && raw.error.message ? raw.error.message : "模型 API 请求失败。";
      return createCellError(new Error(message), elapsedMs, promptSnapshot, modelSnapshot, requestPreview, raw);
    }

    const usage = raw && raw.usage ? raw.usage : {};
    const choice = raw && raw.choices ? raw.choices[0] || {} : {};
    return {
      promptVersionId: promptSnapshot.id,
      modelConfigId: modelSnapshot.id,
      status: "success",
      elapsedMs,
      tokens: usage.total_tokens || null,
      finishReason: choice.finish_reason || "",
      answer: extractAnswer(raw),
      reasoningContent: extractReasoningContent(raw),
      error: "",
      raw,
      requestPreview,
      promptSnapshot,
      modelSnapshot
    };
  } catch (error) {
    return createCellError(error, Date.now() - startedAt, promptSnapshot, modelSnapshot, requestPreview);
  }
}

async function runModelConfigTest(model, requestFn = postJson) {
  const requestPreview = buildModelTestRequestPreview(snapshotModel(model));
  const startedAt = Date.now();

  try {
    const apiResponse = await requestFn(
      requestPreview.url,
      requestPreview.body,
      { Authorization: `Bearer ${model.apiKey}` }
    );
    const raw = parseApiPayload(apiResponse);
    const elapsedMs = Date.now() - startedAt;
    if (!apiResponse.ok) {
      return {
        status: "error",
        elapsedMs,
        httpStatus: apiResponse.status,
        answer: "",
        error: raw.error && raw.error.message ? raw.error.message : "模型配置测试失败。",
        raw,
        requestPreview
      };
    }

    return {
      status: "success",
      elapsedMs,
      httpStatus: apiResponse.status,
      answer: extractAnswer(raw),
      reasoningContent: extractReasoningContent(raw),
      error: "",
      raw,
      requestPreview
    };
  } catch (error) {
    return {
      status: "error",
      elapsedMs: Date.now() - startedAt,
      httpStatus: null,
      answer: "",
      error: error.message || String(error),
      raw: null,
      requestPreview
    };
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function takeNext() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => takeNext()));
  return results;
}

async function createExperimentRun(store, payload, requestFn = postJson) {
  const project = store.projects.find((item) => item.id === payload.projectId);
  if (!project) throw new Error("项目不存在。");

  const selectedPrompts = project.promptVersions.filter((prompt) => payload.promptVersionIds.includes(prompt.id));
  const selectedModels = store.models.filter((model) => payload.modelConfigIds.includes(model.id));
  if (!selectedPrompts.length) throw new Error("请至少选择一个 Prompt 版本。");
  if (!selectedModels.length) throw new Error("请至少选择一个模型。");

  const values = payload.variableValues && typeof payload.variableValues === "object" ? payload.variableValues : {};
  const promptSnapshots = selectedPrompts.map((prompt) => snapshotPrompt(prompt, values));
  const modelSnapshots = selectedModels.map(snapshotModel);
  const tasks = promptSnapshots.flatMap((promptSnapshot) => selectedModels.map((model) => ({ model, promptSnapshot })));
  const cells = await mapWithConcurrency(tasks, RUN_CONCURRENCY, ({ model, promptSnapshot }) => runCell(model, promptSnapshot, requestFn));
  const now = new Date().toISOString();

  const run = {
    id: createId("run"),
    projectId: project.id,
    createdAt: now,
    variableValues: values,
    promptSnapshots,
    modelSnapshots,
    cells
  };

  store.runs.unshift(run);
  project.draft = normalizeDraft({
    variableValues: payload.variableValues || {},
    selectedPromptVersionIds: selectedPrompts.map((prompt) => prompt.id),
    selectedModelConfigIds: selectedModels.map((model) => model.id)
  });
  project.updatedAt = now;
  return run;
}

async function createWorkflowRun(store, payload, requestFn = postJson) {
  const project = store.projects.find((item) => item.id === payload.projectId);
  if (!project) throw new Error("项目不存在。");
  const workflow = store.workflows.find((item) => item.id === payload.workflowId && item.projectId === project.id);
  if (!workflow) throw new Error("链路不存在。");
  if (!Array.isArray(workflow.steps) || !workflow.steps.length) throw new Error("请至少添加一个链路步骤。");

  const initialValues = normalizeVariableValues(payload.initialValues);
  const context = { ...initialValues };
  const stepOutputs = {};
  const stepTraces = [];
  const startedAt = Date.now();
  let status = "success";

  for (let index = 0; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index];
    const prompt = project.promptVersions.find((item) => item.id === step.promptVersionId);
    const model = store.models.find((item) => item.id === step.modelConfigId);
    if (!prompt) throw new Error(`步骤“${step.name}”没有可用 Prompt。`);
    if (!model) throw new Error(`步骤“${step.name}”没有可用模型。`);

    const values = templateValueMap(context, stepOutputs);
    const requiredVariables = extractTemplateVariables(prompt.systemPrompt, prompt.userPrompt);
    const inputValues = Object.fromEntries(requiredVariables.map((name) => [name, Object.prototype.hasOwnProperty.call(values, name) ? values[name] : ""]));
    const missingVariables = requiredVariables.filter((name) => !Object.prototype.hasOwnProperty.call(values, name) || !String(values[name] || ""));
    const promptSnapshot = snapshotPrompt(prompt, values);
    const cell = await runCell(model, promptSnapshot, requestFn);
    const outputVariable = String(step.outputVariable || "").trim();
    const writtenValues = {};

    if (cell.status === "success" && outputVariable) {
      context[outputVariable] = cell.answer || "";
      writtenValues[outputVariable] = cell.answer || "";
    }

    const alias = safeStepAlias(step, index);
    stepOutputs[String(index + 1)] = { status: cell.status, answer: cell.answer || "", error: cell.error || "" };
    stepOutputs[alias] = { status: cell.status, answer: cell.answer || "", error: cell.error || "" };

    stepTraces.push({
      id: createId("trace"),
      stepId: step.id,
      stepName: step.name,
      stepIndex: index + 1,
      status: cell.status,
      requiredVariables,
      inputValues,
      missingVariables,
      outputVariable,
      writtenValues,
      answer: cell.answer,
      reasoningContent: cell.reasoningContent || "",
      error: cell.error || "",
      elapsedMs: cell.elapsedMs,
      tokens: cell.tokens,
      finishReason: cell.finishReason,
      raw: cell.raw,
      requestPreview: cell.requestPreview,
      promptSnapshot: cell.promptSnapshot,
      modelSnapshot: cell.modelSnapshot,
      contextAfter: { ...context }
    });

    if (cell.status !== "success") {
      status = "error";
      if (step.stopOnError !== false) break;
    }
  }

  const now = new Date().toISOString();
  const run = {
    id: createId("workflow_run"),
    projectId: project.id,
    workflowId: workflow.id,
    workflowSnapshot: {
      id: workflow.id,
      name: workflow.name,
      steps: workflow.steps.map((step) => ({ ...step }))
    },
    createdAt: now,
    status,
    elapsedMs: Date.now() - startedAt,
    initialValues,
    finalContext: context,
    stepTraces
  };

  store.workflowRuns.unshift(run);
  workflow.draft = normalizeWorkflowDraft({ initialValues });
  workflow.updatedAt = now;
  return run;
}

const page = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DeepSeek API 测试工具</title>
  <link rel="icon" type="image/png" sizes="64x64" href="/favicon.png?v=cat-mark-final-20260521" />
  <link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon.png?v=cat-mark-final-20260521" />
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f1ec;
      --card: #ffffff;
      --ink: #1a1a1a;
      --ink-soft: #4a4a4a;
      --ink-light: #8a8a8a;
      --line: #d8d2c8;
      --line-soft: #e8e2d8;
      --accent: #c8442a;
      --accent-dark: #a8351f;
      --accent-soft: #f2e4dd;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
      background-image:
        radial-gradient(circle at 20% 10%, rgba(200, 68, 42, 0.04) 0%, transparent 40%),
        radial-gradient(circle at 80% 80%, rgba(200, 154, 42, 0.04) 0%, transparent 40%);
    }
    main { width: 100vw; height: 100vh; padding: 10px; }
    h2 { margin: 0; font-size: 17px; }
    h3 { margin: 12px 0 7px; font-size: 14px; }
    .layout { display: grid; grid-template-columns: minmax(360px, 34vw) 1fr; gap: 10px; height: 100%; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 0; padding: 14px; overflow: auto; }
    .result-card { display: flex; flex-direction: column; min-width: 0; }
    label { display: block; font-weight: 700; margin: 10px 0 5px; color: var(--ink-soft); font-size: 13px; }
    .note { margin: 4px 0 0; color: var(--ink-light); font-size: 12px; line-height: 1.5; }
    input, textarea, select { width: 100%; border: 1px solid var(--line); border-radius: 0; padding: 10px 12px; font-size: 14px; line-height: 1.5; background: #fff; color: var(--ink); }
    input:focus, textarea:focus, select:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
    textarea { min-height: 96px; resize: vertical; }
    #systemPrompt { min-height: 80px; }
    #userPrompt { min-height: 190px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    button { font-family: "Consolas", "Courier New", monospace; border: 1px solid var(--ink); border-radius: 0; background: transparent; color: var(--ink); padding: 9px 12px; cursor: pointer; font-weight: 700; font-size: 12px; letter-spacing: .04em; transition: all .16s ease; }
    button:disabled { opacity: .65; cursor: not-allowed; }
    button:hover { background: var(--ink); color: var(--bg); }
    .primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .primary:hover { background: var(--accent-dark); border-color: var(--accent-dark); }
    .secondary { background: transparent; color: var(--ink); }
    .toolbar { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 8px; }
    .badges { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 8px 0; }
    .badge { background: #fbfaf8; border: 1px solid var(--line-soft); border-radius: 0; padding: 8px; }
    .badge strong { display: block; font-size: 11px; color: var(--ink-light); margin-bottom: 4px; font-family: "Consolas", "Courier New", monospace; letter-spacing: .08em; text-transform: uppercase; }
    .badge span { font-weight: 700; }
    .status-ready { color: #0369a1; }
    .status-ok { color: #047857; }
    .status-error { color: #b91c1c; }
    .answer { white-space: pre-wrap; word-break: break-word; background: #fffdf8; border: 1px solid var(--line); border-radius: 0; padding: 14px; min-height: 260px; max-height: 40vh; overflow: auto; line-height: 1.7; font-size: 15px; }
    .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
    .details-grid details { display: flex; flex-direction: column; min-width: 0; }
    .summary-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    .summary-row summary { flex: 1; }
    .icon-btn { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; padding: 0; font-size: 16px; line-height: 1; }
    .drawer-backdrop { position: fixed; inset: 0; background: rgba(26, 26, 26, .28); opacity: 0; pointer-events: none; transition: opacity .18s ease; z-index: 20; }
    .drawer-backdrop.open { opacity: 1; pointer-events: auto; }
    .history-drawer { position: fixed; top: 0; right: 0; width: min(420px, 92vw); height: 100vh; background: var(--card); border-left: 1px solid var(--line); box-shadow: -8px 0 24px rgba(0,0,0,.16); transform: translateX(100%); transition: transform .18s ease; z-index: 21; padding: 14px; display: flex; flex-direction: column; }
    .history-drawer.open { transform: translateX(0); }
    .drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .history-list { display: grid; gap: 8px; overflow: auto; flex: 1; }
    .history-item { border: 1px solid var(--line-soft); border-radius: 0; padding: 10px; background: #fbfaf8; cursor: pointer; }
    .history-item:hover { background: var(--accent-soft); }
    .history-item strong { display: block; margin-bottom: 4px; }
    .history-meta { color: var(--ink-light); font-size: 12px; }
    .file-list { margin-top: 8px; color: var(--ink-light); font-size: 12px; line-height: 1.6; }
    .native-file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    .upload-card { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: center; border: 1px dashed var(--line); background: #fffdf8; padding: 12px; cursor: pointer; transition: border-color .16s ease, background .16s ease; }
    .upload-card:hover { border-color: var(--accent); background: var(--accent-soft); }
    .upload-icon { width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--ink); color: var(--accent); font-family: "Consolas", "Courier New", monospace; font-weight: 700; }
    .upload-title { font-weight: 700; color: var(--ink); }
    .upload-desc { color: var(--ink-light); font-size: 12px; margin-top: 2px; }
    .variable-panel { margin-top: 12px; border: 1px solid var(--line); background: #fffdf8; padding: 12px; }
    .variable-panel h3 { margin-top: 0; }
    #variableBatch { min-height: 78px; }
    .variable-list { display: grid; gap: 8px; margin-top: 8px; }
    .variable-row { display: grid; grid-template-columns: 120px 1fr; gap: 8px; align-items: center; }
    .variable-name { font-family: "Consolas", "Courier New", monospace; font-weight: 700; color: var(--accent); word-break: break-all; }
    .empty-variables { color: var(--ink-light); font-size: 12px; line-height: 1.6; }
    pre { white-space: pre-wrap; word-break: break-word; background: #111827; color: #e5e7eb; padding: 12px; border-radius: 9px; height: 230px; min-height: 230px; overflow: auto; margin: 0; }
    details { margin-top: 0; border: 1px solid var(--line); border-radius: 0; padding: 10px; background: #fff; }
    summary { cursor: pointer; font-weight: 700; color: var(--ink-soft); }
    .error { color: var(--accent); font-weight: 700; }
    @media (max-width: 980px) {
      main { height: auto; }
      .layout, .details-grid { grid-template-columns: 1fr; }
      .badges { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 560px) {
      .row, .badges { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <div class="layout">
      <section class="card">
        <h2>请求配置</h2>
        <div class="actions">
          <button class="primary" id="sendBtn">调用 API</button>
          <button class="secondary" id="sampleBtn">填入示例</button>
          <button class="secondary" id="clearBtn">清空输出</button>
        </div>

        <div class="row">
          <div>
            <label for="apiKey">API Key</label>
            <input id="apiKey" type="password" placeholder="sk-..." autocomplete="off" />
          </div>
          <div>
            <label for="baseUrl">Base URL</label>
            <input id="baseUrl" value="https://api.deepseek.com" />
          </div>
        </div>

        <label for="model">Model</label>
        <input id="model" value="deepseek-chat" />
        <p class="note">当前按 OpenAI 兼容的 Chat Completions 格式发送：/chat/completions</p>

        <label for="apiType">API 类型</label>
        <select id="apiType">
          <option value="openai-text">OpenAI 兼容文本</option>
          <option value="openai-multimodal">OpenAI 兼容多模态（预留）</option>
        </select>

        <label for="systemPrompt">System Prompt</label>
        <textarea id="systemPrompt">你是一个简洁清楚的助手，请用中文回答。</textarea>

        <label for="userPrompt">用户输入</label>
        <textarea id="userPrompt" placeholder="请输入你想测试的问题">请用一句话介绍你自己。</textarea>

        <section class="variable-panel">
          <div class="toolbar">
            <h3>变量识别与填入</h3>
            <button class="secondary" id="refreshVariablesBtn">重新识别</button>
          </div>
          <p class="note">会自动识别 System Prompt 和用户输入里的变量，例如 {{viewpoint}}。调用 API 前会替换成下方填写的值。</p>

          <label for="variableBatch">批量识别</label>
          <textarea id="variableBatch" placeholder="每行一个变量，例如：
viewpoint: 环保很重要
role=产品经理
{{tone}} 简洁清楚"></textarea>
          <div class="actions">
            <button class="secondary" id="applyBatchVariablesBtn">批量填入变量</button>
          </div>

          <label>单个变量填入</label>
          <div id="variableList" class="variable-list"></div>
        </section>

        <label for="imageInput">图片上传（预留）</label>
        <input id="imageInput" class="native-file" type="file" accept="image/*" multiple />
        <label class="upload-card" for="imageInput">
          <span class="upload-icon">IMG</span>
          <span>
            <span id="imageUploadTitle" class="upload-title">选择图片文件</span>
            <span class="upload-desc">支持 PNG / JPG / WEBP，可多选，当前仅预留入口</span>
          </span>
        </label>
        <div id="imageList" class="file-list">暂不发送图片，只用于预留多模态测试入口。</div>

        <label for="pdfInput">PDF 上传（预留）</label>
        <input id="pdfInput" class="native-file" type="file" accept="application/pdf,.pdf" />
        <label class="upload-card" for="pdfInput">
          <span class="upload-icon">PDF</span>
          <span>
            <span id="pdfUploadTitle" class="upload-title">选择 PDF 文件</span>
            <span class="upload-desc">当前仅预留入口，后续可接 PDF 文本解析</span>
          </span>
        </label>
        <div id="pdfList" class="file-list">暂不解析 PDF，只用于预留文件测试入口。</div>
      </section>

      <section class="card result-card">
        <div class="toolbar">
          <h2>观察结果</h2>
          <div class="actions" style="margin-top:0">
            <button class="secondary" id="historyBtn">历史记录</button>
            <button class="secondary" id="copyAnswerBtn">复制回复</button>
          </div>
        </div>

        <div class="badges">
          <div class="badge"><strong>状态</strong><span id="status" class="status-ready">未请求</span></div>
          <div class="badge"><strong>耗时</strong><span id="elapsed">-</span></div>
          <div class="badge"><strong>Token</strong><span id="tokens">-</span></div>
          <div class="badge"><strong>结束原因</strong><span id="finishReason">-</span></div>
        </div>

        <h3>模型回复</h3>
        <div id="answer" class="answer">等待调用...</div>

        <div class="details-grid">
          <details open>
            <div class="summary-row">
              <summary>请求预览（已隐藏 API Key）</summary>
              <button class="secondary icon-btn" id="copyRequestBtn" title="复制完整请求 JSON" aria-label="复制完整请求 JSON">⧉</button>
            </div>
            <pre id="requestPreview">等待调用...</pre>
          </details>

          <details open>
            <div class="summary-row">
              <summary>原始 JSON</summary>
            </div>
            <pre id="raw">等待调用...</pre>
          </details>
        </div>
      </section>
    </div>

    <div id="drawerBackdrop" class="drawer-backdrop"></div>
    <aside id="historyDrawer" class="history-drawer" aria-hidden="true">
      <div class="drawer-head">
        <h2>历史记录</h2>
        <button class="secondary icon-btn" id="closeHistoryBtn" title="关闭历史记录" aria-label="关闭历史记录">×</button>
      </div>
      <div class="actions">
        <button class="secondary" id="clearHistoryBtn">清空历史</button>
      </div>
      <div id="historyList" class="history-list">暂无历史记录。</div>
    </aside>
  </main>

  <script>
    ${extractTemplateVariables.toString()}
    ${escapeRegExp.toString()}
    ${parseVariableAssignments.toString()}
    ${applyTemplateVariables.toString()}

    const $ = (id) => document.getElementById(id);
    const historyKey = "deepseekApiTesterHistory";
    const variableValues = {};
    let lastRequestJson = "";

    function currentVariableNames() {
      return extractTemplateVariables($("systemPrompt").value, $("userPrompt").value);
    }

    function getVariableInputValues() {
      const values = {};
      document.querySelectorAll(".variable-value").forEach((input) => {
        values[input.dataset.variableName] = input.value;
      });
      return values;
    }

    function renderVariables(readCurrentInputs = true) {
      const names = currentVariableNames();
      if (readCurrentInputs) {
        const latestValues = getVariableInputValues();
        Object.assign(variableValues, latestValues);
      }

      Object.keys(variableValues).forEach((name) => {
        if (!names.includes(name)) delete variableValues[name];
      });

      const list = $("variableList");
      list.innerHTML = "";
      if (!names.length) {
        const empty = document.createElement("div");
        empty.className = "empty-variables";
        empty.textContent = "还没有识别到变量。请在提示词中写入类似 {{viewpoint}} 的占位符。";
        list.appendChild(empty);
        return;
      }

      names.forEach((name) => {
        const row = document.createElement("div");
        row.className = "variable-row";

        const label = document.createElement("div");
        label.className = "variable-name";
        label.textContent = "{{" + name + "}}";

        const input = document.createElement("input");
        input.className = "variable-value";
        input.dataset.variableName = name;
        input.placeholder = "填写 " + name + " 的值";
        input.value = variableValues[name] || "";
        input.addEventListener("input", () => {
          variableValues[name] = input.value;
        });

        row.appendChild(label);
        row.appendChild(input);
        list.appendChild(row);
      });
    }

    function fillVariablesFromBatch(showFeedback) {
      const parsed = parseVariableAssignments($("variableBatch").value, currentVariableNames());
      Object.assign(variableValues, parsed);
      renderVariables(false);

      if (showFeedback) {
        $("applyBatchVariablesBtn").textContent = Object.keys(parsed).length ? "已填入" : "未匹配到变量";
        setTimeout(() => { $("applyBatchVariablesBtn").textContent = "批量填入变量"; }, 1200);
      }
    }

    function collectPayload() {
      const values = getVariableInputValues();
      return {
        apiKey: $("apiKey").value.trim(),
        baseUrl: $("baseUrl").value.trim(),
        model: $("model").value.trim(),
        apiType: $("apiType").value,
        systemPrompt: applyTemplateVariables($("systemPrompt").value.trim(), values),
        userPrompt: applyTemplateVariables($("userPrompt").value.trim(), values)
      };
    }

    function buildPreview(payload) {
      const messages = [];
      if (payload.systemPrompt) messages.push({ role: "system", content: payload.systemPrompt });
      messages.push({ role: "user", content: payload.userPrompt });
      return {
        apiType: payload.apiType,
        url: payload.baseUrl.replace(/\/+$/, "") + "/chat/completions",
        method: "POST",
        headers: { Authorization: "Bearer ***", "Content-Type": "application/json" },
        body: { model: payload.model, messages, temperature: 0.7 }
      };
    }

    function setStatus(text, className) {
      $("status").textContent = text;
      $("status").className = className;
    }

    function resetResult() {
      setStatus("未请求", "status-ready");
      $("elapsed").textContent = "-";
      $("tokens").textContent = "-";
      $("finishReason").textContent = "-";
      $("answer").className = "answer";
      $("answer").textContent = "等待调用...";
      $("raw").textContent = "等待调用...";
      $("requestPreview").textContent = "等待调用...";
    }

    function explainError(message) {
      const text = String(message || "");
      if (/401|unauthorized|authentication|api key|invalid key/i.test(text)) return "API Key 可能不正确、为空，或没有权限。请检查 key 是否复制完整。";
      if (/insufficient|quota|balance|billing|payment|429/i.test(text)) return "可能是额度不足、余额不足，或请求太频繁。请检查账户余额和调用频率。";
      if (/503|service_unavailable|service is too busy|too busy/i.test(text)) return "模型平台当前服务过忙或暂时不可用。请稍后重试，或临时换一个可用的模型服务。";
      if (/model|not found|does not exist|404/i.test(text)) return "模型名称可能写错，或当前 API Key 无权调用这个模型。";
      if (/certificate|self-signed|SSL|TLS/i.test(text)) return "HTTPS 证书校验没有通过。请确认代理规则确实让模型域名直连，或在系统里正确安装并信任代理证书；工具不会跳过证书校验。";
      if (/aborted|operation timed out|请求超时/i.test(text)) return "模型平台长时间没有返回结果，本次等待已超时。请稍后重试。";
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket|timeout|network|Base URL/i.test(text)) return "Base URL 或网络可能有问题。模型请求已由本地服务直连发出；如果全局代理仍透明接管连接，请在代理软件里让模型域名走直连。";
      if (/400|invalid|messages|parameter/i.test(text)) return "请求参数可能不符合接口要求。请检查模型名、System Prompt 和用户输入。";
      return "暂未识别具体原因，请看下面的原始 JSON 或复制请求 JSON 给开发排查。";
    }

    function getHistory() {
      try { return JSON.parse(localStorage.getItem(historyKey) || "[]"); } catch { return []; }
    }

    function saveHistory(item) {
      const next = [item, ...getHistory()].slice(0, 20);
      localStorage.setItem(historyKey, JSON.stringify(next));
      renderHistory();
    }

    function renderHistory() {
      const list = getHistory();
      if (!list.length) {
        $("historyList").textContent = "暂无历史记录。";
        return;
      }
      $("historyList").innerHTML = list.map((item, index) => [
        '<div class="history-item" data-index="' + index + '">',
        '<strong>' + item.model + ' · ' + item.status + '</strong>',
        '<div>' + item.question + '</div>',
        '<div class="history-meta">' + item.elapsed + ' · token: ' + item.tokens + ' · ' + item.time + '</div>',
        '</div>'
      ].join("")).join("");
    }

    $("sampleBtn").addEventListener("click", () => {
      $("systemPrompt").value = "你是一个产品经理助手，回答要短、清楚、适合初中生理解。";
      $("userPrompt").value = "帮我写一个测试模型 API 输出效果的简单问题。";
      renderVariables();
    });

    $("clearBtn").addEventListener("click", resetResult);

    $("systemPrompt").addEventListener("input", renderVariables);
    $("userPrompt").addEventListener("input", renderVariables);
    $("refreshVariablesBtn").addEventListener("click", renderVariables);
    $("variableBatch").addEventListener("input", () => fillVariablesFromBatch(false));
    $("applyBatchVariablesBtn").addEventListener("click", () => fillVariablesFromBatch(true));

    $("imageInput").addEventListener("change", () => {
      const names = Array.from($("imageInput").files).map((file) => file.name + " (" + Math.round(file.size / 1024) + " KB)");
      $("imageUploadTitle").textContent = names.length ? "已选择 " + names.length + " 个图片" : "选择图片文件";
      $("imageList").textContent = names.length ? "已选择：" + names.join("，") + "。当前版本只预留入口，暂不发送。" : "暂不发送图片，只用于预留多模态测试入口。";
    });

    $("pdfInput").addEventListener("change", () => {
      const file = $("pdfInput").files[0];
      $("pdfUploadTitle").textContent = file ? file.name : "选择 PDF 文件";
      $("pdfList").textContent = file ? "已选择：" + file.name + " (" + Math.round(file.size / 1024) + " KB)。当前版本只预留入口，暂不解析。" : "暂不解析 PDF，只用于预留文件测试入口。";
    });

    $("copyAnswerBtn").addEventListener("click", async () => {
      await navigator.clipboard.writeText($("answer").textContent);
      $("copyAnswerBtn").textContent = "已复制";
      setTimeout(() => { $("copyAnswerBtn").textContent = "复制回复"; }, 1200);
    });

    $("copyRequestBtn").addEventListener("click", async () => {
      await navigator.clipboard.writeText(lastRequestJson || $("requestPreview").textContent);
      $("copyRequestBtn").textContent = "✓";
      setTimeout(() => { $("copyRequestBtn").textContent = "⧉"; }, 1200);
    });

    function setHistoryDrawer(open) {
      $("historyDrawer").classList.toggle("open", open);
      $("drawerBackdrop").classList.toggle("open", open);
      $("historyDrawer").setAttribute("aria-hidden", open ? "false" : "true");
    }

    $("historyBtn").addEventListener("click", () => setHistoryDrawer(true));
    $("closeHistoryBtn").addEventListener("click", () => setHistoryDrawer(false));
    $("drawerBackdrop").addEventListener("click", () => setHistoryDrawer(false));

    $("clearHistoryBtn").addEventListener("click", () => {
      localStorage.removeItem(historyKey);
      renderHistory();
    });

    $("historyList").addEventListener("click", (event) => {
      const item = event.target.closest(".history-item");
      if (!item) return;
      const record = getHistory()[Number(item.dataset.index)];
      if (!record) return;
      $("model").value = record.model;
      $("userPrompt").value = record.question;
      renderVariables();
      $("answer").className = record.status === "失败" ? "answer error" : "answer";
      $("answer").textContent = record.answer;
      $("tokens").textContent = record.tokens;
      $("elapsed").textContent = record.elapsed;
      setStatus(record.status, record.status === "失败" ? "status-error" : "status-ok");
    });

    $("sendBtn").addEventListener("click", async () => {
      const startedAt = performance.now();
      const payload = collectPayload();
      const preview = buildPreview(payload);
      lastRequestJson = JSON.stringify(preview, null, 2);

      $("sendBtn").disabled = true;
      setStatus("请求中", "status-ready");
      $("elapsed").textContent = "-";
      $("tokens").textContent = "-";
      $("finishReason").textContent = "-";
      $("answer").className = "answer";
      $("answer").textContent = "正在请求 DeepSeek API...";
      $("raw").textContent = "等待返回...";
      $("requestPreview").textContent = JSON.stringify(preview, null, 2);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        const data = await response.json();
        if (!response.ok) {
          $("raw").textContent = JSON.stringify(data.raw || data, null, 2);
          throw new Error(data.error || "请求失败，HTTP 状态码：" + response.status);
        }

        const usage = data.raw && data.raw.usage ? data.raw.usage : {};
        const choice = data.raw && data.raw.choices ? data.raw.choices[0] : {};
        setStatus("成功", "status-ok");
        $("elapsed").textContent = Math.round(performance.now() - startedAt) + " ms";
        $("tokens").textContent = usage.total_tokens || "-";
        $("finishReason").textContent = choice && choice.finish_reason ? choice.finish_reason : "-";
        $("answer").textContent = data.answer || "接口返回成功，但没有读取到模型回复。";
        $("raw").textContent = JSON.stringify(data.raw, null, 2);
        saveHistory({
          time: new Date().toLocaleString(),
          status: "成功",
          model: payload.model,
          question: payload.userPrompt.slice(0, 120),
          answer: $("answer").textContent,
          elapsed: $("elapsed").textContent,
          tokens: $("tokens").textContent
        });
      } catch (error) {
        const readable = explainError(error.message);
        setStatus("失败", "status-error");
        $("elapsed").textContent = Math.round(performance.now() - startedAt) + " ms";
        $("answer").className = "answer error";
        $("answer").textContent = readable + "\n\n原始错误：" + error.message;
        $("raw").textContent = "无可用 JSON。";
        saveHistory({
          time: new Date().toLocaleString(),
          status: "失败",
          model: payload.model || "-",
          question: payload.userPrompt.slice(0, 120),
          answer: $("answer").textContent,
          elapsed: $("elapsed").textContent,
          tokens: "-"
        });
      } finally {
        clearTimeout(timeoutId);
        $("sendBtn").disabled = false;
      }
    });

    renderVariables();
    renderHistory();
  </script>
</body>
</html>`;

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        request.destroy();
        reject(new Error("请求内容过大"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function normalizeModelBaseUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  return normalized.replace(/\/chat\/completions$/i, "");
}

function buildChatUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

function postJsonDirect(targetUrl, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!transport) {
      reject(new Error("Base URL 仅支持 http:// 或 https://。"));
      return;
    }

    const body = JSON.stringify(data);
    const request = transport.request(url, {
      method: "POST",
      agent: false,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...headers
      }
    }, (apiResponse) => {
      let rawText = "";
      apiResponse.setEncoding("utf8");
      apiResponse.on("data", (chunk) => {
        rawText += chunk;
      });
      apiResponse.on("end", () => {
        resolve({
          ok: apiResponse.statusCode >= 200 && apiResponse.statusCode < 300,
          status: apiResponse.statusCode || 500,
          text: rawText
        });
      });
    });

    request.setTimeout(MODEL_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("模型 API 请求超时。"));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function readJsonBody(request) {
  const text = await readBody(request);
  if (!text) return {};
  return JSON.parse(text);
}

function sendStoreError(response, error) {
  sendJson(response, error.statusCode || 400, { error: error.message || "请求处理失败。" });
}

function findProject(store, projectId) {
  const project = store.projects.find((item) => item.id === projectId);
  if (!project) {
    const error = new Error("项目不存在。");
    error.statusCode = 404;
    throw error;
  }
  return project;
}

function findPrompt(project, promptId) {
  const prompt = project.promptVersions.find((item) => item.id === promptId);
  if (!prompt) {
    const error = new Error("Prompt 版本不存在。");
    error.statusCode = 404;
    throw error;
  }
  return prompt;
}

function findModel(store, modelId) {
  const model = store.models.find((item) => item.id === modelId);
  if (!model) {
    const error = new Error("模型配置不存在。");
    error.statusCode = 404;
    throw error;
  }
  return model;
}

function findWorkflow(store, workflowId) {
  const workflow = store.workflows.find((item) => item.id === workflowId);
  if (!workflow) {
    const error = new Error("链路不存在。");
    error.statusCode = 404;
    throw error;
  }
  return workflow;
}

function requireText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`请填写${label}。`);
  return text;
}

function modelFromPayload(payload, previous = null) {
  const now = new Date().toISOString();
  return normalizeModel({
    ...previous,
    name: requireText(payload.name, "模型名称"),
    apiKey: requireText(payload.apiKey, "API Key"),
    baseUrl: normalizeModelBaseUrl(requireText(payload.baseUrl, "Base URL")),
    model: requireText(payload.model, "Model"),
    apiType: payload.apiType || "openai-text",
    provider: payload.provider || previous && previous.provider || "custom",
    thinkingMode: payload.thinkingMode || previous && previous.thinkingMode || "default",
    createdAt: previous && previous.createdAt || now,
    updatedAt: now
  });
}

function variableSampleFromPayload(payload, previous = null) {
  const now = new Date().toISOString();
  return normalizeVariableSample({
    ...previous,
    name: requireText(payload.name, "样例名称"),
    variableValues: normalizeVariableValues(payload.variableValues),
    createdAt: previous && previous.createdAt || now,
    updatedAt: now
  });
}

function promptFromPayload(payload, previous = null, fallbackName = "V1") {
  const now = new Date().toISOString();
  return {
    id: previous && previous.id || createId("prompt"),
    name: requireText(payload.name || fallbackName, "版本名"),
    systemPrompt: String(payload.systemPrompt || ""),
    userPrompt: requireText(payload.userPrompt, "User Prompt"),
    createdAt: previous && previous.createdAt || now,
    updatedAt: now
  };
}

function workflowFromPayload(payload, previous = null) {
  const now = new Date().toISOString();
  return normalizeWorkflow({
    ...previous,
    name: requireText(payload.name || previous && previous.name, "链路名称"),
    projectId: previous && previous.projectId || requireText(payload.projectId, "项目"),
    steps: Array.isArray(payload.steps) ? payload.steps : previous && previous.steps || [],
    draft: payload.draft && typeof payload.draft === "object" ? payload.draft : previous && previous.draft || defaultWorkflowDraft(),
    createdAt: previous && previous.createdAt || now,
    updatedAt: now
  });
}

async function handleBootstrap(response) {
  const store = await readStore();
  sendJson(response, 200, {
    models: store.models,
    projects: store.projects,
    runSummaries: store.runs.map(summarizeRun),
    workflows: store.workflows,
    workflowRunSummaries: store.workflowRuns.map(summarizeWorkflowRun)
  });
}

function summarizeRun(run) {
  const successCount = Array.isArray(run.cells) ? run.cells.filter((cell) => cell.status === "success").length : 0;
  const totalCount = Array.isArray(run.cells) ? run.cells.length : 0;
  return {
    id: run.id,
    projectId: run.projectId,
    createdAt: run.createdAt,
    variablePreview: summarizeVariables(run.variableValues),
    promptNames: Array.isArray(run.promptSnapshots) ? run.promptSnapshots.map((prompt) => prompt.name) : [],
    modelNames: Array.isArray(run.modelSnapshots) ? run.modelSnapshots.map((model) => model.name) : [],
    successCount,
    totalCount
  };
}

function summarizeVariables(values) {
  if (!values || typeof values !== "object") return "";
  return Object.entries(values)
    .slice(0, 3)
    .map(([name, value]) => `${name}: ${String(value || "").slice(0, 24)}`)
    .join("；");
}

function summarizeWorkflowRun(run) {
  const successCount = Array.isArray(run.stepTraces) ? run.stepTraces.filter((trace) => trace.status === "success").length : 0;
  const totalCount = Array.isArray(run.stepTraces) ? run.stepTraces.length : 0;
  return {
    id: run.id,
    projectId: run.projectId,
    workflowId: run.workflowId,
    workflowName: run.workflowSnapshot && run.workflowSnapshot.name || "未命名链路",
    createdAt: run.createdAt,
    status: run.status || "success",
    elapsedMs: run.elapsedMs || 0,
    variablePreview: summarizeVariables(run.initialValues),
    successCount,
    totalCount
  };
}

async function handleCreateModel(request, response) {
  try {
    const payload = await readJsonBody(request);
    const model = await updateStore((store) => {
      const next = modelFromPayload(payload);
      store.models.unshift(next);
      return next;
    });
    sendJson(response, 201, model);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleUpdateModel(request, response, modelId) {
  try {
    const payload = await readJsonBody(request);
    const model = await updateStore((store) => {
      const current = findModel(store, modelId);
      const next = modelFromPayload(payload, current);
      Object.assign(current, next);
      return current;
    });
    sendJson(response, 200, model);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleDeleteModel(response, modelId) {
  try {
    await updateStore((store) => {
      findModel(store, modelId);
      store.models = store.models.filter((model) => model.id !== modelId);
      store.projects.forEach((project) => {
        project.draft.selectedModelConfigIds = project.draft.selectedModelConfigIds.filter((id) => id !== modelId);
      });
      store.workflows.forEach((workflow) => {
        workflow.steps.forEach((step) => {
          if (step.modelConfigId === modelId) step.modelConfigId = "";
        });
      });
    });
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleTestModel(request, response) {
  try {
    const payload = await readJsonBody(request);
    const model = modelFromPayload(payload);
    sendJson(response, 200, await runModelConfigTest(model));
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleCreateProject(request, response) {
  try {
    const payload = await readJsonBody(request);
    const project = await updateStore((store) => {
      const next = createProject(requireText(payload.name, "项目名称"));
      store.projects.unshift(next);
      return next;
    });
    sendJson(response, 201, project);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleUpdateProject(request, response, projectId) {
  try {
    const payload = await readJsonBody(request);
    const project = await updateStore((store) => {
      const current = findProject(store, projectId);
      if (Object.prototype.hasOwnProperty.call(payload, "name")) current.name = requireText(payload.name, "项目名称");
      if (payload.draft && typeof payload.draft === "object") current.draft = normalizeDraft(payload.draft);
      current.updatedAt = new Date().toISOString();
      return current;
    });
    sendJson(response, 200, project);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleDeleteProject(response, projectId) {
  try {
    const result = await updateStore((store) => {
      findProject(store, projectId);
      if (store.projects.length === 1) throw new Error("至少保留一个项目。");
      store.projects = store.projects.filter((project) => project.id !== projectId);
      store.runs = store.runs.filter((run) => run.projectId !== projectId);
      store.workflows = store.workflows.filter((workflow) => workflow.projectId !== projectId);
      store.workflowRuns = store.workflowRuns.filter((run) => run.projectId !== projectId);
      return { ok: true };
    });
    sendJson(response, 200, result);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleCreatePrompt(request, response, projectId) {
  try {
    const payload = await readJsonBody(request);
    const prompt = await updateStore((store) => {
      const project = findProject(store, projectId);
      const next = promptFromPayload(payload, null, `V${project.promptVersions.length + 1}`);
      project.promptVersions.push(next);
      project.draft.selectedPromptVersionIds = [...new Set([...project.draft.selectedPromptVersionIds, next.id])];
      project.updatedAt = new Date().toISOString();
      return next;
    });
    sendJson(response, 201, prompt);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleUpdatePrompt(request, response, projectId, promptId) {
  try {
    const payload = await readJsonBody(request);
    const prompt = await updateStore((store) => {
      const project = findProject(store, projectId);
      const current = findPrompt(project, promptId);
      const next = promptFromPayload(payload, current);
      Object.assign(current, next);
      project.updatedAt = current.updatedAt;
      return current;
    });
    sendJson(response, 200, prompt);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleDeletePrompt(response, projectId, promptId) {
  try {
    await updateStore((store) => {
      const project = findProject(store, projectId);
      findPrompt(project, promptId);
      if (project.promptVersions.length === 1) throw new Error("至少保留一个 Prompt 版本。");
      project.promptVersions = project.promptVersions.filter((prompt) => prompt.id !== promptId);
      project.draft.selectedPromptVersionIds = project.draft.selectedPromptVersionIds.filter((id) => id !== promptId);
      store.workflows
        .filter((workflow) => workflow.projectId === project.id)
        .forEach((workflow) => {
          workflow.steps.forEach((step) => {
            if (step.promptVersionId === promptId) step.promptVersionId = "";
          });
        });
      project.updatedAt = new Date().toISOString();
    });
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleVariableSampleList(response, projectId) {
  try {
    const store = await readStore();
    const project = findProject(store, projectId);
    sendJson(response, 200, project.variableSamples);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleCreateVariableSample(request, response, projectId) {
  try {
    const payload = await readJsonBody(request);
    const sample = await updateStore((store) => {
      const project = findProject(store, projectId);
      const next = variableSampleFromPayload(payload);
      project.variableSamples.unshift(next);
      project.updatedAt = next.updatedAt;
      return next;
    });
    sendJson(response, 201, sample);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleDeleteVariableSample(response, projectId, sampleId) {
  try {
    await updateStore((store) => {
      const project = findProject(store, projectId);
      if (!project.variableSamples.some((sample) => sample.id === sampleId)) {
        const error = new Error("变量样例不存在。");
        error.statusCode = 404;
        throw error;
      }
      project.variableSamples = project.variableSamples.filter((sample) => sample.id !== sampleId);
      project.updatedAt = new Date().toISOString();
    });
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleCreateRun(request, response) {
  try {
    const payload = await readJsonBody(request);
    const run = await updateStore((store) => createExperimentRun(store, {
      projectId: requireText(payload.projectId, "项目"),
      promptVersionIds: Array.isArray(payload.promptVersionIds) ? payload.promptVersionIds : [],
      modelConfigIds: Array.isArray(payload.modelConfigIds) ? payload.modelConfigIds : [],
      variableValues: payload.variableValues && typeof payload.variableValues === "object" ? payload.variableValues : {}
    }));
    sendJson(response, 201, run);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleRunList(response, projectId) {
  try {
    const store = await readStore();
    findProject(store, projectId);
    sendJson(response, 200, store.runs.filter((run) => run.projectId === projectId).map(summarizeRun));
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleRunDetail(response, runId) {
  try {
    const store = await readStore();
    const run = store.runs.find((item) => item.id === runId);
    if (!run) {
      const error = new Error("实验历史不存在。");
      error.statusCode = 404;
      throw error;
    }
    sendJson(response, 200, run);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleCreateWorkflow(request, response, projectId) {
  try {
    const payload = await readJsonBody(request);
    const workflow = await updateStore((store) => {
      const project = findProject(store, projectId);
      const next = workflowFromPayload({
        projectId: project.id,
        name: payload.name || "新链路",
        steps: payload.steps || [],
        draft: payload.draft || defaultWorkflowDraft()
      });
      store.workflows.unshift(next);
      return next;
    });
    sendJson(response, 201, workflow);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleUpdateWorkflow(request, response, workflowId) {
  try {
    const payload = await readJsonBody(request);
    const workflow = await updateStore((store) => {
      const current = findWorkflow(store, workflowId);
      const next = workflowFromPayload(payload, current);
      Object.assign(current, next);
      return current;
    });
    sendJson(response, 200, workflow);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleDeleteWorkflow(response, workflowId) {
  try {
    await updateStore((store) => {
      findWorkflow(store, workflowId);
      store.workflows = store.workflows.filter((workflow) => workflow.id !== workflowId);
      store.workflowRuns = store.workflowRuns.filter((run) => run.workflowId !== workflowId);
    });
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleCreateWorkflowRun(request, response) {
  try {
    const payload = await readJsonBody(request);
    const run = await updateStore((store) => createWorkflowRun(store, {
      projectId: requireText(payload.projectId, "项目"),
      workflowId: requireText(payload.workflowId, "链路"),
      initialValues: payload.initialValues && typeof payload.initialValues === "object" ? payload.initialValues : {}
    }));
    sendJson(response, 201, run);
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleWorkflowRunList(response, projectId) {
  try {
    const store = await readStore();
    findProject(store, projectId);
    sendJson(response, 200, store.workflowRuns
      .filter((run) => run.projectId === projectId)
      .map(summarizeWorkflowRun));
  } catch (error) {
    sendStoreError(response, error);
  }
}

async function handleWorkflowRunDetail(response, runId) {
  try {
    const store = await readStore();
    const run = store.workflowRuns.find((item) => item.id === runId);
    if (!run) {
      const error = new Error("链路历史不存在。");
      error.statusCode = 404;
      throw error;
    }
    sendJson(response, 200, run);
  } catch (error) {
    sendStoreError(response, error);
  }
}

function quoteCurlConfigValue(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function buildCurlConfig(targetUrl, data, headers = {}) {
  const requestHeaders = {
    "Content-Type": "application/json",
    ...headers
  };

  return [
    "silent",
    "show-error",
    'request = "POST"',
    `url = "${quoteCurlConfigValue(targetUrl)}"`,
    ...Object.entries(requestHeaders).map(([name, value]) => `header = "${quoteCurlConfigValue(`${name}: ${value}`)}"`),
    `data-binary = "${quoteCurlConfigValue(JSON.stringify(data))}"`,
    'write-out = "\\n__HTTP_STATUS__:%{http_code}"'
  ].join("\n");
}

function postJsonWithCurl(targetUrl, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const marker = "\n__HTTP_STATUS__:";
    const request = spawn("curl", [
      "--http1.1",
      "--connect-timeout",
      "10",
      "--max-time",
      String(CURL_REQUEST_TIMEOUT_SECONDS),
      "--config",
      "-"
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    request.stdout.setEncoding("utf8");
    request.stderr.setEncoding("utf8");
    request.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    request.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    request.on("error", (error) => {
      reject(new Error(`系统 curl 不可用：${error.message}`));
    });
    request.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `系统 curl 请求失败，退出码 ${code}。`));
        return;
      }

      const markerIndex = stdout.lastIndexOf(marker);
      const status = Number(stdout.slice(markerIndex + marker.length).trim());
      if (markerIndex < 0 || !Number.isInteger(status) || status < 100) {
        reject(new Error("系统 curl 未返回可用的 HTTP 状态码。"));
        return;
      }

      resolve({
        ok: status >= 200 && status < 300,
        status,
        text: stdout.slice(0, markerIndex)
      });
    });

    request.stdin.end(buildCurlConfig(targetUrl, data, headers));
  });
}

function shouldRetryWithCurl(error) {
  return /certificate|self-signed|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT/i.test(String(error && error.message));
}

async function postJson(targetUrl, data, headers = {}) {
  try {
    return await postJsonDirect(targetUrl, data, headers);
  } catch (error) {
    if (!shouldRetryWithCurl(error)) throw error;
    return postJsonWithCurl(targetUrl, data, headers);
  }
}

function sendFile(request, response, filePath, contentType) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not Found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400"
    });
    response.end(request.method === "HEAD" ? undefined : data);
  });
}

async function handleChat(request, response) {
  try {
    const body = JSON.parse(await readBody(request));
    const { apiKey, baseUrl, model, systemPrompt, userPrompt } = body;

    if (!apiKey) return sendJson(response, 400, { error: "请先填写 API Key。" });
    if (!baseUrl) return sendJson(response, 400, { error: "请先填写 Base URL。" });
    if (!model) return sendJson(response, 400, { error: "请先填写模型名称。" });
    if (!userPrompt) return sendJson(response, 400, { error: "请先填写用户输入。" });

    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: userPrompt });

    const apiResponse = await postJson(
      buildChatUrl(baseUrl),
      { model, messages, temperature: 0.7 },
      { Authorization: `Bearer ${apiKey}` }
    );

    const rawText = apiResponse.text;
    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch {
      raw = { text: rawText };
    }

    if (!apiResponse.ok) {
      const message = raw.error && raw.error.message ? raw.error.message : "DeepSeek API 请求失败。";
      return sendJson(response, apiResponse.status, { error: message, raw });
    }

    const answer = raw.choices && raw.choices[0] && raw.choices[0].message
      ? raw.choices[0].message.content
      : "";
    sendJson(response, 200, { answer, raw });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "本地服务处理失败。" });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const modelMatch = url.pathname.match(/^\/api\/models\/([^/]+)$/);
  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  const promptMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/prompts\/([^/]+)$/);
  const promptCollectionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/prompts$/);
  const sampleMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/variable-samples\/([^/]+)$/);
  const sampleCollectionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/variable-samples$/);
  const runListMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runs$/);
  const runDetailMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  const workflowCollectionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/workflows$/);
  const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
  const workflowRunListMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/workflow-runs$/);
  const workflowRunDetailMatch = url.pathname.match(/^\/api\/workflow-runs\/([^/]+)$/);

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return response.end(experimentPage);
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/favicon.png") {
    return sendFile(request, response, path.join(assetsDir, "favicon.png"), "image/png");
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/assets/apple-touch-icon.png") {
    return sendFile(request, response, path.join(assetsDir, "apple-touch-icon.png"), "image/png");
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    return handleChat(request, response);
  }

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    return handleBootstrap(response);
  }

  if (request.method === "POST" && url.pathname === "/api/models") {
    return handleCreateModel(request, response);
  }

  if (request.method === "POST" && url.pathname === "/api/models/test") {
    return handleTestModel(request, response);
  }

  if (modelMatch && request.method === "PUT") {
    return handleUpdateModel(request, response, modelMatch[1]);
  }

  if (modelMatch && request.method === "DELETE") {
    return handleDeleteModel(response, modelMatch[1]);
  }

  if (request.method === "POST" && url.pathname === "/api/projects") {
    return handleCreateProject(request, response);
  }

  if (projectMatch && request.method === "PUT") {
    return handleUpdateProject(request, response, projectMatch[1]);
  }

  if (projectMatch && request.method === "DELETE") {
    return handleDeleteProject(response, projectMatch[1]);
  }

  if (promptCollectionMatch && request.method === "POST") {
    return handleCreatePrompt(request, response, promptCollectionMatch[1]);
  }

  if (promptMatch && request.method === "PUT") {
    return handleUpdatePrompt(request, response, promptMatch[1], promptMatch[2]);
  }

  if (promptMatch && request.method === "DELETE") {
    return handleDeletePrompt(response, promptMatch[1], promptMatch[2]);
  }

  if (sampleCollectionMatch && request.method === "GET") {
    return handleVariableSampleList(response, sampleCollectionMatch[1]);
  }

  if (sampleCollectionMatch && request.method === "POST") {
    return handleCreateVariableSample(request, response, sampleCollectionMatch[1]);
  }

  if (sampleMatch && request.method === "DELETE") {
    return handleDeleteVariableSample(response, sampleMatch[1], sampleMatch[2]);
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    return handleCreateRun(request, response);
  }

  if (runListMatch && request.method === "GET") {
    return handleRunList(response, runListMatch[1]);
  }

  if (runDetailMatch && request.method === "GET") {
    return handleRunDetail(response, runDetailMatch[1]);
  }

  if (workflowCollectionMatch && request.method === "POST") {
    return handleCreateWorkflow(request, response, workflowCollectionMatch[1]);
  }

  if (workflowMatch && request.method === "PUT") {
    return handleUpdateWorkflow(request, response, workflowMatch[1]);
  }

  if (workflowMatch && request.method === "DELETE") {
    return handleDeleteWorkflow(response, workflowMatch[1]);
  }

  if (request.method === "POST" && url.pathname === "/api/workflow-runs") {
    return handleCreateWorkflowRun(request, response);
  }

  if (workflowRunListMatch && request.method === "GET") {
    return handleWorkflowRunList(response, workflowRunListMatch[1]);
  }

  if (workflowRunDetailMatch && request.method === "GET") {
    return handleWorkflowRunDetail(response, workflowRunDetailMatch[1]);
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not Found");
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Prompt 实验台已启动：http://${HOST}:${PORT}`);
    console.log("停止服务：在终端按 Ctrl + C");
  });
}

module.exports = {
  extractTemplateVariables,
  parseVariableAssignments,
  applyTemplateVariables,
  createDefaultStore,
  readStore,
  writeStore,
  normalizeStore,
  createExperimentRun,
  createWorkflow,
  createWorkflowRun,
  buildRequestPreview,
  buildChatBody,
  buildChatUrl,
  normalizeModelBaseUrl,
  runModelConfigTest,
  postJsonDirect,
  postJsonWithCurl,
  server
};
