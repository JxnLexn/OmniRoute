import test from "node:test";
import assert from "node:assert/strict";
import { normalizeXaiResponsesNamespaces } from "../../open-sse/handlers/chatCore/xaiResponsesNamespaces.ts";
import { restoreXaiCustomToolStream } from "../../open-sse/handlers/chatCore/xaiResponsesCustomTools.ts";

test("root custom tools and replay use a JSON input wrapper", () => {
  const body: Record<string, unknown> = {
    tools: [{ type: "custom", name: "exec", format: { type: "text" } }],
    tool_choice: { type: "custom", name: "exec" },
    input: [
      { type: "custom_tool_call", name: "exec", call_id: "c", input: "hello\nworld" },
      { type: "custom_tool_call_output", call_id: "c", output: "ok" },
    ],
  };
  const names = normalizeXaiResponsesNamespaces(body, "grok-cli", "openai-responses");
  assert.ok(names.has("exec"));
  assert.equal((body.tools as Array<Record<string, unknown>>)[0].type, "function");
  assert.deepEqual(body.tool_choice, { type: "function", name: "exec" });
  assert.deepEqual(body.input, [
    {
      type: "function_call",
      name: "exec",
      call_id: "c",
      arguments: JSON.stringify({ input: "hello\nworld" }),
    },
    { type: "function_call_output", call_id: "c", output: "ok" },
  ]);
});

test("custom SSE conversion handles split UTF-8 frames and preserves free text", async () => {
  const args = JSON.stringify({ input: 'ä\n\\quoted"' });
  const frames = [
    {
      type: "response.output_item.added",
      item: { id: "i", type: "function_call", name: "exec", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: "i", delta: args.slice(0, 8) },
    { type: "response.function_call_arguments.delta", item_id: "i", delta: args.slice(8) },
    { type: "response.function_call_arguments.done", item_id: "i", arguments: args },
  ];
  const bytes = new TextEncoder().encode(
    frames.map((f) => `data: ${JSON.stringify(f)}\r\n\r\n`).join("")
  );
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
      c.close();
    },
  });
  const result = await restoreXaiCustomToolStream(
    new Response(stream),
    new Set(["exec"]),
    null
  ).text();
  const events = result
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
  assert.equal(events[0].item.type, "custom_tool_call");
  assert.equal(events[1].type, "response.custom_tool_call_input.delta");
  assert.equal(events[1].delta, 'ä\n\\quoted"');
  assert.equal(events[2].type, "response.custom_tool_call_input.done");
  assert.equal(events[2].input, 'ä\n\\quoted"');
});

test("namespace names cannot collide with explicit functions or other namespaces", () => {
  const body: Record<string, unknown> = {
    tools: [
      { type: "function", name: "files__read" },
      { type: "namespace", name: "files", tools: [{ name: "read" }] },
      { type: "namespace", name: "other", tools: [{ name: "files__read" }] },
      { type: "web_search" },
    ],
  };
  normalizeXaiResponsesNamespaces(body, "grok-cli", "openai-responses");
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.equal(new Set(tools.slice(0, 3).map((t) => t.name)).size, 3);
  assert.equal(tools[0].name, "files__read");
  assert.equal(tools[1].type, "function");
  assert.deepEqual(tools[3], { type: "web_search" });
  assert.equal(JSON.stringify(body).includes("_namespaceToolIdentityMap"), false);
});

test("namespace normalization preserves opaque history and maps allowed tool selection", () => {
  const opaque = { type: "reasoning", encrypted_content: "opaque" };
  const body: Record<string, unknown> = {
    tools: [{ type: "namespace", name: "files", tools: [{ name: "read" }] }],
    input: [opaque, { type: "function_call_output", call_id: "c", output: "ok" }],
    tool_choice: {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", namespace: "files", name: "read" }],
    },
  };
  normalizeXaiResponsesNamespaces(body, "xai", "openai-responses");
  assert.equal((body.input as unknown[])[0], opaque);
  assert.deepEqual(body.tool_choice, {
    type: "allowed_tools",
    mode: "required",
    tools: [{ type: "function", name: "files__read" }],
  });
});

test("Codex and unrelated transports keep native namespace definitions", () => {
  for (const [provider, format] of [
    ["codex", "openai-responses"],
    ["openai-compatible-test", "openai-responses"],
    ["grok-cli", "openai"],
  ]) {
    const body = { tools: [{ type: "namespace", name: "files", tools: [{ name: "read" }] }] };
    const snapshot = structuredClone(body);
    normalizeXaiResponsesNamespaces(body, provider, format);
    assert.deepEqual(body, snapshot);
  }
});

test("requests without namespaces remain untouched", () => {
  const body = { input: "hello" };
  normalizeXaiResponsesNamespaces(body, "grok-cli", "openai-responses");
  assert.deepEqual(body, { input: "hello" });
});
