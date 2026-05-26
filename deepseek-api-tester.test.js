const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  extractTemplateVariables,
  parseVariableAssignments,
  applyTemplateVariables,
  createDefaultStore,
  createExperimentRun,
  createWorkflowRun,
  normalizeStore,
  readStore,
  writeStore,
  buildChatBody,
  buildChatUrl,
  normalizeModelBaseUrl,
  runModelConfigTest,
  postJsonDirect,
  postJsonWithCurl
} = require("./deepseek-api-tester");

test("extractTemplateVariables finds unique variables from prompts", () => {
  const variables = extractTemplateVariables("你好 {{viewpoint}}", "请按 {{role}} 和 {{viewpoint}} 回答");

  assert.deepEqual(variables, ["viewpoint", "role"]);
});

test("parseVariableAssignments matches batch values by variable name", () => {
  const values = parseVariableAssignments("viewpoint: 环保很重要\nrole=产品经理\n{{unused}} 不应填入", ["viewpoint", "role"]);

  assert.deepEqual(values, {
    viewpoint: "环保很重要",
    role: "产品经理"
  });
});

test("applyTemplateVariables replaces prompt variables before sending", () => {
  const text = applyTemplateVariables("请基于{{viewpoint}}，用{{role}}的口吻回答。", {
    viewpoint: "环保很重要",
    role: "产品经理"
  });

  assert.equal(text, "请基于环保很重要，用产品经理的口吻回答。");
});

test("buildChatUrl appends chat completions path once", () => {
  assert.equal(buildChatUrl("https://api.deepseek.com///"), "https://api.deepseek.com/chat/completions");
  assert.equal(buildChatUrl("https://ark.cn-beijing.volces.com/api/v3/chat/completions"), "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
  assert.equal(normalizeModelBaseUrl("https://ark.cn-beijing.volces.com/api/v3/chat/completions/"), "https://ark.cn-beijing.volces.com/api/v3");
});

test("buildChatBody applies DeepSeek and Ark thinking switches", () => {
  assert.deepEqual(buildChatBody({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    thinkingMode: "enabled"
  }, [{ role: "user", content: "hi" }], { temperature: 0.7 }), {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled" }
  });

  assert.deepEqual(buildChatBody({
    provider: "volcengine-ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2-0-lite-260428",
    thinkingMode: "disabled"
  }, [{ role: "user", content: "hi" }], { temperature: 0.7 }), {
    model: "doubao-seed-2-0-lite-260428",
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "disabled" }
  });
});

test("postJsonDirect posts to the target without using proxy environment variables", async () => {
  let receivedBody = "";
  let receivedAuthorization = "";
  const mockApi = http.createServer((request, response) => {
    receivedAuthorization = request.headers.authorization;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      receivedBody += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });

  await new Promise((resolve) => mockApi.listen(0, "127.0.0.1", resolve));
  const { port } = mockApi.address();
  const previousHttpProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = "http://127.0.0.1:1";

  try {
    const response = await postJsonDirect(
      `http://127.0.0.1:${port}/chat/completions`,
      { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] },
      { Authorization: "Bearer test-key" }
    );

    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.equal(receivedAuthorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(receivedBody), {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hi" }]
    });
  } finally {
    if (previousHttpProxy === undefined) {
      delete process.env.HTTP_PROXY;
    } else {
      process.env.HTTP_PROXY = previousHttpProxy;
    }
    await new Promise((resolve, reject) => mockApi.close((error) => error ? reject(error) : resolve()));
  }
});

test("postJsonWithCurl posts with the operating system TLS client fallback", async () => {
  let receivedBody = "";
  let receivedAuthorization = "";
  const mockApi = http.createServer((request, response) => {
    receivedAuthorization = request.headers.authorization;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      receivedBody += chunk;
    });
    request.on("end", () => {
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ echoed: JSON.parse(receivedBody) }));
    });
  });

  await new Promise((resolve) => mockApi.listen(0, "127.0.0.1", resolve));
  const { port } = mockApi.address();

  try {
    const response = await postJsonWithCurl(
      `http://127.0.0.1:${port}/chat/completions`,
      { model: "deepseek-chat", messages: [{ role: "user", content: "中文 ok" }] },
      { Authorization: "Bearer test-key" }
    );

    assert.equal(response.ok, true);
    assert.equal(response.status, 201);
    assert.equal(receivedAuthorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(receivedBody), {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "中文 ok" }]
    });
  } finally {
    await new Promise((resolve, reject) => mockApi.close((error) => error ? reject(error) : resolve()));
  }
});

test("writeStore persists project prompts and model secrets outside memory", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-lab-store-"));
  const filePath = path.join(dir, "data.json");
  const store = createDefaultStore();
  store.models.push({
    id: "model_test",
    name: "豆包",
    apiKey: "secret-key",
    baseUrl: "https://example.test",
    model: "doubao-test",
    apiType: "openai-text"
  });
  store.projects[0].variableSamples.push({
    id: "sample_test",
    name: "会议样例",
    variableValues: { recordText: "正文", domain: "会议" }
  });

  await writeStore(store, filePath);
  const restored = await readStore(filePath);

  assert.equal(restored.projects.length, 1);
  assert.equal(restored.projects[0].promptVersions.length, 1);
  assert.deepEqual(restored.projects[0].variableSamples[0].variableValues, { recordText: "正文", domain: "会议" });
  assert.equal(restored.models[0].apiKey, "secret-key");
});

test("runModelConfigTest sends a short live-compatible request without experiment state", async () => {
  const result = await runModelConfigTest({
    id: "model_test",
    name: "测试模型",
    apiKey: "secret-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    apiType: "openai-text",
    provider: "custom"
  }, async (url, body, headers) => {
    assert.equal(url, "https://example.test/v1/chat/completions");
    assert.deepEqual(body.messages, [{ role: "user", content: "请只回复 OK。" }]);
    assert.equal(body.max_tokens, 8);
    assert.equal(headers.Authorization, "Bearer secret-key");
    return {
      ok: true,
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: "OK" } }] })
    };
  });

  assert.equal(result.status, "success");
  assert.equal(result.answer, "OK");
  assert.equal(result.requestPreview.headers.Authorization, "Bearer ***");
});

test("normalizeStore drops the retired draft main input field", () => {
  const normalized = normalizeStore({
    projects: [{
      id: "project_legacy",
      name: "旧项目",
      promptVersions: [{
        id: "prompt_legacy",
        name: "V1",
        systemPrompt: "",
        userPrompt: "{{input}}"
      }],
      draft: {
        input: "旧主输入",
        variableValues: { input: "变量输入" },
        selectedPromptVersionIds: ["prompt_legacy"],
        selectedModelConfigIds: []
      }
    }]
  });

  assert.equal(Object.prototype.hasOwnProperty.call(normalized.projects[0].draft, "input"), false);
  assert.equal(normalized.projects[0].draft.variableValues.input, "变量输入");
});

test("normalizeStore backfills workflow collections for legacy data", () => {
  const normalized = normalizeStore({
    projects: [{
      id: "project_legacy",
      name: "旧项目",
      promptVersions: [{ id: "prompt_legacy", name: "V1", userPrompt: "{{input}}" }]
    }]
  });

  assert.deepEqual(normalized.workflows, []);
  assert.deepEqual(normalized.workflowRuns, []);
});

test("createExperimentRun saves a prompt by model matrix with snapshots and isolated failures", async () => {
  const store = createDefaultStore();
  const project = store.projects[0];
  const firstPrompt = project.promptVersions[0];
  firstPrompt.name = "V1";
  firstPrompt.systemPrompt = "语气：{{tone}}";
  firstPrompt.userPrompt = "处理：{{input}}";
  const secondPrompt = {
    ...firstPrompt,
    id: "prompt_v2",
    name: "V2",
    systemPrompt: "面向{{audience}}",
    userPrompt: "重写{{input}}"
  };
  project.promptVersions.push(secondPrompt);
  store.models = [
    {
      id: "model_ok",
      name: "成功模型",
      apiKey: "ok-key",
      baseUrl: "https://ok.example",
      model: "ok-model",
      apiType: "openai-text"
    },
    {
      id: "model_bad",
      name: "失败模型",
      apiKey: "bad-key",
      baseUrl: "https://bad.example",
      model: "bad-model",
      apiType: "openai-text"
    }
  ];

  const run = await createExperimentRun(store, {
    projectId: project.id,
    promptVersionIds: [firstPrompt.id, secondPrompt.id],
    modelConfigIds: ["model_ok", "model_bad"],
    variableValues: { input: "原始输入", tone: "简洁", audience: "产品经理" }
  }, async (url, body) => {
    if (url.includes("bad.example")) {
      return {
        ok: false,
        status: 503,
        text: JSON.stringify({ error: { message: "busy" } })
      };
    }
    return {
      ok: true,
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: `${body.model}:${body.messages.at(-1).content}` }, finish_reason: "stop" }],
        usage: { total_tokens: 12 }
      })
    };
  });

  assert.equal(run.cells.length, 4);
  assert.equal(run.cells.filter((cell) => cell.status === "success").length, 2);
  assert.equal(run.cells.filter((cell) => cell.status === "error").length, 2);
  assert.equal(run.promptSnapshots[0].finalSystemPrompt, "语气：简洁");
  assert.equal(run.promptSnapshots[0].finalUserPrompt, "处理：原始输入");
  assert.equal(run.promptSnapshots[1].finalSystemPrompt, "面向产品经理");
  assert.equal(run.cells[0].requestPreview.headers.Authorization, "Bearer ***");

  firstPrompt.systemPrompt = "已经修改";
  store.models[0].name = "已经改名";
  assert.equal(run.promptSnapshots[0].systemPrompt, "语气：{{tone}}");
  assert.equal(run.modelSnapshots[0].name, "成功模型");
  assert.equal(store.runs[0].id, run.id);
});

test("createWorkflowRun passes step output through the run context", async () => {
  const store = createDefaultStore();
  const project = store.projects[0];
  const extractPrompt = project.promptVersions[0];
  extractPrompt.id = "prompt_extract";
  extractPrompt.name = "提取";
  extractPrompt.systemPrompt = "";
  extractPrompt.userPrompt = "提取：{{input}}";
  project.promptVersions.push({
    id: "prompt_write",
    name: "撰写",
    systemPrompt: "",
    userPrompt: "撰写：{{summary}} / {{steps.1.answer}} / {{steps.summary.answer}}"
  });
  store.models = [{
    id: "model_ok",
    name: "成功模型",
    apiKey: "ok-key",
    baseUrl: "https://ok.example",
    model: "ok-model",
    apiType: "openai-text"
  }];
  store.workflows.push({
    id: "workflow_test",
    projectId: project.id,
    name: "测试链路",
    steps: [
      { id: "step_extract", name: "提取", promptVersionId: "prompt_extract", modelConfigId: "model_ok", outputVariable: "summary", stopOnError: true },
      { id: "step_write", name: "撰写", promptVersionId: "prompt_write", modelConfigId: "model_ok", outputVariable: "draft", stopOnError: true }
    ],
    draft: { initialValues: {} }
  });

  const run = await createWorkflowRun(store, {
    projectId: project.id,
    workflowId: "workflow_test",
    initialValues: { input: "原始材料" }
  }, async (url, body) => {
    const content = body.messages.at(-1).content;
    return {
      ok: true,
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: content.startsWith("提取") ? "摘要结果" : `终稿：${content}` }, finish_reason: "stop" }],
        usage: { total_tokens: 10 }
      })
    };
  });

  assert.equal(run.status, "success");
  assert.equal(run.stepTraces.length, 2);
  assert.equal(run.stepTraces[1].inputValues.summary, "摘要结果");
  assert.equal(run.stepTraces[1].promptSnapshot.finalUserPrompt, "撰写：摘要结果 / 摘要结果 / 摘要结果");
  assert.equal(run.finalContext.summary, "摘要结果");
  assert.equal(run.finalContext.draft.startsWith("终稿：撰写：摘要结果"), true);
  assert.equal(store.workflowRuns[0].id, run.id);

  store.workflows[0].name = "已经改名";
  assert.equal(run.workflowSnapshot.name, "测试链路");
});

test("createWorkflowRun stops on failed step by default", async () => {
  const store = createDefaultStore();
  const project = store.projects[0];
  project.promptVersions[0].id = "prompt_one";
  project.promptVersions[0].userPrompt = "第一步 {{input}}";
  project.promptVersions.push({ id: "prompt_two", name: "第二步", systemPrompt: "", userPrompt: "第二步" });
  store.models = [{ id: "model_bad", name: "失败模型", apiKey: "bad-key", baseUrl: "https://bad.example", model: "bad-model", apiType: "openai-text" }];
  store.workflows.push({
    id: "workflow_stop",
    projectId: project.id,
    name: "停止链路",
    steps: [
      { id: "step_one", name: "第一步", promptVersionId: "prompt_one", modelConfigId: "model_bad", outputVariable: "one" },
      { id: "step_two", name: "第二步", promptVersionId: "prompt_two", modelConfigId: "model_bad", outputVariable: "two" }
    ],
    draft: { initialValues: {} }
  });

  const run = await createWorkflowRun(store, {
    projectId: project.id,
    workflowId: "workflow_stop",
    initialValues: { input: "输入" }
  }, async () => ({
    ok: false,
    status: 503,
    text: JSON.stringify({ error: { message: "busy" } })
  }));

  assert.equal(run.status, "error");
  assert.equal(run.stepTraces.length, 1);
  assert.equal(run.stepTraces[0].error, "busy");
});

test("createWorkflowRun continues after failed step when configured", async () => {
  const store = createDefaultStore();
  const project = store.projects[0];
  project.promptVersions[0].id = "prompt_one";
  project.promptVersions[0].userPrompt = "第一步";
  project.promptVersions.push({ id: "prompt_two", name: "第二步", systemPrompt: "", userPrompt: "第二步 {{input}}" });
  store.models = [{ id: "model_mix", name: "混合模型", apiKey: "mix-key", baseUrl: "https://mix.example", model: "mix-model", apiType: "openai-text" }];
  store.workflows.push({
    id: "workflow_continue",
    projectId: project.id,
    name: "继续链路",
    steps: [
      { id: "step_one", name: "第一步", promptVersionId: "prompt_one", modelConfigId: "model_mix", outputVariable: "one", stopOnError: false },
      { id: "step_two", name: "第二步", promptVersionId: "prompt_two", modelConfigId: "model_mix", outputVariable: "two", stopOnError: true }
    ],
    draft: { initialValues: {} }
  });
  let count = 0;

  const run = await createWorkflowRun(store, {
    projectId: project.id,
    workflowId: "workflow_continue",
    initialValues: { input: "输入" }
  }, async () => {
    count += 1;
    if (count === 1) return { ok: false, status: 500, text: JSON.stringify({ error: { message: "first failed" } }) };
    return {
      ok: true,
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: "第二步成功" }, finish_reason: "stop" }] })
    };
  });

  assert.equal(run.status, "error");
  assert.equal(run.stepTraces.length, 2);
  assert.equal(run.stepTraces[0].status, "error");
  assert.equal(run.stepTraces[1].status, "success");
  assert.equal(run.finalContext.two, "第二步成功");
});
