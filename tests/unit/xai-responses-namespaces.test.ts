import test from "node:test";
import assert from "node:assert/strict";
import { normalizeXaiResponsesNamespaces } from "../../open-sse/handlers/chatCore/xaiResponsesNamespaces.ts";

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
