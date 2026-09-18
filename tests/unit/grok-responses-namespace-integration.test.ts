import test from "node:test";
import assert from "node:assert/strict";
import { handleChatCore } from "../../open-sse/handlers/chatCore.ts";
import { __resetRateLimitManagerForTests } from "../../open-sse/services/rateLimitManager.ts";
import { clearInflight } from "../../open-sse/services/requestDedup.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { resetAll as resetAccountSemaphores } from "../../open-sse/services/accountSemaphore.ts";

test.after(async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  resetAccountSemaphores();
  await __resetRateLimitManagerForTests();
  clearInflight();
  resetDbInstance();
});

type Item = Record<string, unknown>;
const originalFetch = globalThis.fetch;

for (const provider of ["grok-cli", "xai"]) {
  for (const stream of [false, true]) {
    test(`${provider} namespace tools round-trip through native Responses (stream=${stream})`, async () => {
      const tools = [
        {
          type: "namespace",
          name: "files",
          tools: [
            { type: "function", name: "read", parameters: { type: "object", properties: {} } },
          ],
        },
        {
          type: "namespace",
          name: "other",
          tools: [
            { type: "function", name: "read", parameters: { type: "object", properties: {} } },
          ],
        },
      ];
      const body = {
        model: "grok-4.6",
        stream,
        tools,
        tool_choice: { type: "function", namespace: "files", name: "read" },
        input: [
          {
            type: "function_call",
            namespace: "files",
            name: "read",
            call_id: "old_call",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "old_call", output: "ok" },
          { type: "message", role: "user", content: "read again" },
        ],
      };
      const snapshot = structuredClone(body);
      let sent: Item | undefined;
      globalThis.fetch = async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        const sentTools = sent!.tools as Item[];
        if (sentTools.some((t) => t.type === "namespace")) {
          return new Response(JSON.stringify({ error: { message: "unknown variant namespace" } }), {
            status: 422,
          });
        }
        const call = {
          id: "fc_new",
          type: "function_call",
          call_id: "call_new",
          name: "files__read",
          arguments: "{}",
          status: "completed",
        };
        const response = {
          id: "resp_test",
          object: "response",
          status: "completed",
          model: "grok-4.6",
          output: [call],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
        const frames = [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...call, status: "in_progress", arguments: "" },
          },
          { type: "response.output_item.done", output_index: 0, item: call },
          { type: "response.completed", response },
        ];
        return new Response(
          stream
            ? frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join("")
            : JSON.stringify(response),
          { headers: { "content-type": stream ? "text/event-stream" : "application/json" } }
        );
      };
      try {
        const result = await handleChatCore({
          body: structuredClone(body),
          modelInfo: { provider, model: "grok-4.6" },
          credentials: { apiKey: "test-key", accessToken: "test-token", providerSpecificData: {} },
          log: { debug() {}, info() {}, warn() {}, error() {} },
          clientRawRequest: {
            endpoint: "/v1/responses",
            body: structuredClone(body),
            headers: new Headers(),
          },
          userAgent: "namespace-regression-test",
        } as never);
        assert.equal(result.success, true);
        assert.deepEqual(
          (sent!.tools as Item[]).map((t) => t.name),
          ["files__read", "other__read"]
        );
        assert.deepEqual(sent!.tool_choice, { type: "function", name: "files__read" });
        assert.equal((sent!.input as Item[])[0].name, "files__read");
        assert.equal((sent!.input as Item[])[0].namespace, undefined);
        assert.equal(JSON.stringify(sent).includes("_namespaceToolIdentityMap"), false);
        const raw = await result.response.text();
        const outputs: Item[] = stream
          ? raw
              .split("\n")
              .filter((l) => l.startsWith("data: {"))
              .map((l) => JSON.parse(l.slice(6)))
              .flatMap((f) => (f.item ? [f.item] : (f.response?.output ?? [])))
          : JSON.parse(raw).output;
        assert.ok(outputs.length >= (stream ? 3 : 1));
        for (const output of outputs) {
          assert.equal(output.namespace, "files");
          assert.equal(output.name, "read");
          assert.equal(output.call_id, "call_new");
        }
        assert.deepEqual(body, snapshot);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
}
