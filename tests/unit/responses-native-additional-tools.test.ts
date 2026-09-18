import test from "node:test";
import assert from "node:assert/strict";
import { stampNativeResponsesPassthroughBody } from "../../open-sse/handlers/chatCore/passthroughHelpers.ts";
import { normalizeCodexResponsesInput } from "../../open-sse/utils/responsesInputNormalization.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";

const tool = (name: string) => ({ type: "function", name, parameters: { type: "object" } });
const message = { type: "message", role: "user", content: "hello" };

test("same-format Responses translation promotes declarations for generic providers", () => {
  const body = {
    input: [{ type: "additional_tools", tools: [tool("terminal")] }, message],
  };
  const result = translateRequest("openai-responses", "openai-responses", "test-model", body);
  assert.deepEqual(result.input, [message]);
  assert.deepEqual(result.tools, [
    {
      ...tool("terminal"),
      parameters: { type: "object", properties: {}, additionalProperties: true },
    },
  ]);
});

for (const mode of ["codex", "xai", "openai-compatible"] as const) {
  test(`${mode} native Responses promotes tools without mutating replay history`, () => {
    const body = {
      tools: [tool("existing")],
      input: [{ type: "additional_tools", tools: [tool("terminal")] }, message],
    };
    const original = structuredClone(body);
    const result = stampNativeResponsesPassthroughBody(body, mode);
    assert.deepEqual(result.input, [message]);
    assert.deepEqual(result.tools, [tool("existing"), tool("terminal")]);
    assert.deepEqual(body, original);
  });
}

test("Codex direct normalization promotes a singleton additional_tools item", () => {
  const body: Record<string, unknown> = {
    input: { type: "additional_tools", tools: [tool("terminal")] },
  };
  normalizeCodexResponsesInput(body);
  assert.deepEqual(body.input, []);
  assert.deepEqual(body.tools, [tool("terminal")]);
});

test("native tools use existing top-level precedence and merge namespace members", () => {
  const root = { ...tool("terminal"), description: "explicit definition" };
  const body = {
    tools: [root, { type: "namespace", name: "mcp", tools: [tool("read")] }],
    input: [
      {
        type: "additional_tools",
        tools: [tool("terminal"), { type: "namespace", name: "mcp", tools: [tool("write")] }],
      },
      { type: "additional_tools", tools: [tool("extra")] },
      message,
    ],
  };
  const result = stampNativeResponsesPassthroughBody(body, "xai");
  assert.deepEqual(result.input, [message]);
  assert.deepEqual(result.tools, [
    root,
    { type: "namespace", name: "mcp", tools: [tool("read"), tool("write")] },
    tool("extra"),
  ]);
});

test("native normalization preserves opaque history and is idempotent", () => {
  const history = [
    { type: "reasoning", encrypted_content: "opaque" },
    { type: "function_call", call_id: "c1", name: "terminal", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "ok" },
  ];
  const body = { input: [{ type: "additional_tools", tools: [tool("terminal")] }, ...history] };
  const once = stampNativeResponsesPassthroughBody(body, "codex");
  assert.deepEqual(once.input, history);
  assert.deepEqual(stampNativeResponsesPassthroughBody(once, "codex"), once);
});

test("requests without tool declarations and malformed declarations remain intact", () => {
  for (const input of [
    [message],
    [{ type: "additional_tools", tools: "invalid" }],
    "hello",
    null,
  ]) {
    const body = { input };
    const result = stampNativeResponsesPassthroughBody(body, "xai");
    assert.deepEqual(result.input, input);
    assert.equal(Object.hasOwn(result, "tools"), false);
  }
});
