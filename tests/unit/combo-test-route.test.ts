import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-test-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-test-route-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const runtimePorts = await import("../../src/lib/runtime/ports.ts");
const route = await import("../../src/app/api/combos/test/route.ts");

const originalFetch = globalThis.fetch;

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function createTestCombo(models = ["openrouter/openai/gpt-5.4"]) {
  return combosDb.createCombo({
    name: "strict-live-test",
    models,
    strategy: "priority",
  });
}

function makeRequest(comboName = "strict-live-test") {
  return new Request("http://localhost/api/combos/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ comboName }),
  });
}

function expectedInternalUrl(pathname: string): string {
  return `http://127.0.0.1:${runtimePorts.getRuntimePorts().apiPort}${pathname}`;
}

test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await resetStorage();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("combo test route validates request payloads and combo existence", async () => {
  const invalidJsonResponse = await route.POST(
    new Request("http://localhost/api/combos/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })
  );

  assert.equal(invalidJsonResponse.status, 400);
  assert.deepEqual(await invalidJsonResponse.json(), {
    error: {
      message: "Invalid request",
      details: [{ field: "body", message: "Invalid JSON body" }],
    },
  });

  const invalidBodyResponse = await route.POST(
    new Request("http://localhost/api/combos/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comboName: "" }),
    })
  );
  const invalidBody = (await invalidBodyResponse.json()) as any;
  assert.equal(invalidBodyResponse.status, 400);
  assert.equal(invalidBody.error.message, "Invalid request");

  const missingResponse = await route.POST(makeRequest("missing-combo"));
  const missingBody = (await missingResponse.json()) as any;
  assert.equal(missingResponse.status, 404);
  assert.equal(missingBody.error, "Combo not found");
});

test("combo test route marks a model healthy only when it returns assistant text", async () => {
  await createTestCombo();

  const fetchCalls = [];
  const originalRandom = Math.random;
  let callCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "OK",
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  let response;
  try {
    Math.random = () => {
      callCount += 1;
      return callCount === 1 ? 0.4680222223 : 0.2677;
    };
    response = await route.POST(makeRequest());
  } finally {
    Math.random = originalRandom;
  }
  const body = (await response.json()) as any;
  const forwardedBody = JSON.parse(fetchCalls[0].init.body);

  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, expectedInternalUrl("/v1/chat/completions"));
  assert.equal(fetchCalls[0].init.headers["X-Internal-Test"], "combo-health-check");
  assert.equal(fetchCalls[0].init.headers["X-OmniRoute-No-Cache"], "true");
  assert.match(fetchCalls[0].init.headers["X-Request-Id"], /^combo-test-/);
  assert.equal(forwardedBody.model, "openrouter/openai/gpt-5.4");
  assert.equal(
    forwardedBody.messages[0].content,
    "Calculate 52122+34093, and reply with the result only."
  );
  assert.equal(forwardedBody.max_tokens, 64);
  assert.equal(forwardedBody.stream, true);
  assert.equal(fetchCalls[0].init.headers["X-OmniRoute-Compression"], "off");
  assert.equal(body.testMode, "parallel-health-check");
  assert.equal("temperature" in forwardedBody, false);
  assert.equal(body.resolvedBy, "openrouter/openai/gpt-5.4");
  assert.equal(body.results[0].status, "ok");
  assert.equal(body.results[0].responseText, "OK");
});

test("combo test route treats empty successful responses as failures", async () => {
  await createTestCombo();

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

  const response = await route.POST(makeRequest());
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.resolvedBy, null);
  assert.equal(body.results[0].status, "error");
  assert.equal(body.results[0].statusCode, 200);
  assert.match(body.results[0].error, /no text content/i);
});

test("combo test route accepts reasoning-only completions as healthy smoke-test responses", async () => {
  await createTestCombo();

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "length",
            message: {
              role: "assistant",
              content: "",
            },
          },
        ],
        usage: {
          prompt_tokens: 6,
          completion_tokens: 12,
          total_tokens: 18,
          completion_tokens_details: {
            reasoning_tokens: 12,
          },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

  const response = await route.POST(makeRequest());
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.resolvedBy, "openrouter/openai/gpt-5.4");
  assert.equal(body.results[0].status, "ok");
  assert.equal(body.results[0].responseText, "[reasoning-only completion]");
});

test("combo test route surfaces provider errors instead of downgrading them to reachability", async () => {
  await createTestCombo();

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "Upstream rejected this request shape",
        },
      }),
      {
        status: 422,
        headers: { "content-type": "application/json" },
      }
    );

  const response = await route.POST(makeRequest());
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.resolvedBy, null);
  assert.equal(body.results[0].status, "error");
  assert.equal(body.results[0].statusCode, 422);
  assert.equal(body.results[0].error, "Upstream rejected this request shape");
  assert.equal("probeMethod" in body.results[0], false);
});

test("combo test route launches model probes concurrently while preserving combo order", async () => {
  await createTestCombo(["provider/first", "provider/second", "provider/third"]);

  const fetchCalls = [];
  const resolvers = [];
  globalThis.fetch = (url, init = {}) =>
    new Promise((resolve) => {
      fetchCalls.push({ url: String(url), init });
      resolvers.push(resolve);
    });

  const responsePromise = route.POST(makeRequest());
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fetchCalls.length, 3);
  assert.deepEqual(
    fetchCalls.map(({ init }) => JSON.parse(init.body).model),
    ["provider/first", "provider/second", "provider/third"]
  );

  resolvers[2](
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "THIRD" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
  resolvers[1](
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "SECOND" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
  resolvers[0](
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "FIRST" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );

  const response = await responsePromise;
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.resolvedBy, "provider/first");
  assert.deepEqual(
    body.results.map((result) => ({
      model: result.model,
      status: result.status,
      responseText: result.responseText,
    })),
    [
      { model: "provider/first", status: "ok", responseText: "FIRST" },
      { model: "provider/second", status: "ok", responseText: "SECOND" },
      { model: "provider/third", status: "ok", responseText: "THIRD" },
    ]
  );
});

test("combo test route preserves structured step metadata for repeated model/account targets", async () => {
  await createTestCombo([
    {
      kind: "model",
      providerId: "openai",
      model: "openai/gpt-4o-mini",
      connectionId: "conn-openai-a",
      label: "Account A",
    },
    {
      kind: "model",
      providerId: "openai",
      model: "openai/gpt-4o-mini",
      connectionId: "conn-openai-b",
      label: "Account B",
    },
  ]);

  const fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    const body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: `OK:${body.model}`,
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  const response = await route.POST(makeRequest());
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(
    fetchCalls.map(({ init }) => JSON.parse(init.body).model),
    ["openai/gpt-4o-mini", "openai/gpt-4o-mini"]
  );
  assert.equal(fetchCalls[0].init.headers["X-OmniRoute-Connection"], "conn-openai-a");
  assert.equal(fetchCalls[1].init.headers["X-OmniRoute-Connection"], "conn-openai-b");
  assert.equal(body.results[0].connectionId, "conn-openai-a");
  assert.equal(body.results[0].label, "Account A");
  assert.equal(body.results[1].connectionId, "conn-openai-b");
  assert.equal(body.results[1].label, "Account B");
  assert.notEqual(body.results[0].executionKey, body.results[1].executionKey);
  assert.equal(body.resolvedByExecutionKey, body.results[0].executionKey);
  assert.equal(body.resolvedByTarget.connectionId, "conn-openai-a");
});

test("combo test route rejects empty combos and ignores forwarded origins for internal probes", async () => {
  await createTestCombo([]);

  const emptyResponse = await route.POST(makeRequest());
  const emptyBody = (await emptyResponse.json()) as any;
  assert.equal(emptyResponse.status, 400);
  assert.equal(emptyBody.error, "Combo has no models");

  await resetStorage();
  await createTestCombo(["provider/forwarded"]);
  const internalKey = await apiKeysDb.createApiKey("combo-internal", "machine-combo-internal");

  const fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "FORWARDED" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  const forwardedResponse = await route.POST(
    new Request("http://localhost/api/combos/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": "attacker.example.com",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ comboName: "strict-live-test" }),
    })
  );

  assert.equal(forwardedResponse.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, expectedInternalUrl("/v1/chat/completions"));
  assert.equal(fetchCalls[0].init.headers.Authorization, `Bearer ${internalKey.key}`);
  assert.equal(new URL(fetchCalls[0].url).hostname, "127.0.0.1");
  assert.notEqual(new URL(fetchCalls[0].url).hostname, "attacker.example.com");
});

test("combo test route handles upstream timeouts and non-JSON error bodies", async () => {
  await createTestCombo(["provider/timeout", "provider/error"]);

  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return new Response("bad gateway", {
      status: 502,
      statusText: "Bad Gateway",
    });
  };

  const response = await route.POST(makeRequest());
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.resolvedBy, null);
  assert.deepEqual(
    body.results.map((result) => ({
      model: result.model,
      status: result.status,
      error: result.error,
      statusCode: result.statusCode ?? null,
    })),
    [
      {
        model: "provider/timeout",
        status: "error",
        error: "Model test aborted",
        statusCode: null,
      },
      {
        model: "provider/error",
        status: "error",
        error: "Bad Gateway",
        statusCode: 502,
      },
    ]
  );
});

test("combo probes consume SSE text and preserve errors inside HTTP 200 streams", async () => {
  await createTestCombo(["vertex/gemini-3.8-flash", "provider/error"]);
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model;
    const event = model.startsWith("vertex/")
      ? { choices: [{ delta: { content: "OK" } }] }
      : { error: { message: "Local execution deadline exceeded (18000ms)", code: 504 } };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const response = await route.POST(makeRequest());
  const body = await response.json();
  assert.equal(body.results[0].responseText, "OK");
  assert.equal(body.results[0].status, "ok");
  assert.equal(body.results[1].status, "error");
  assert.equal(body.results[1].statusCode, 504);
  assert.match(body.results[1].error, /18000ms/);
});

test("combo test deadline covers stream consumption and rejects timed-out partial output", async (t) => {
  await createTestCombo(["vertex/gemini-3.8-flash"]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
          );
          signal?.addEventListener("abort", () => controller.error(signal?.reason), { once: true });
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
  };
  const pending = route.POST(makeRequest());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(signal);
  t.mock.timers.tick(29_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  const body = await (await pending).json();
  assert.equal(body.results[0].status, "error");
  assert.equal(body.results[0].statusCode, 504);
  assert.equal(body.results[0].isTimeout, true);
  assert.equal(body.results[0].error, "No model output within 30s");
  assert.equal(body.resolvedBy, null);
});

test("combo probes retain JSON embeddings and sanitize upstream error details", async () => {
  await createTestCombo(["openai/text-embedding-3-small", "provider/failure"]);
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    if (payload.model.includes("embedding")) {
      assert.equal(payload.input, "Hello World");
      assert.equal(payload.stream, undefined);
      return Response.json({ data: [{ embedding: [0.1, 0.2] }] });
    }
    return Response.json(
      { error: { message: "Failed\n    at /private/server/credentials.ts:42:1" } },
      { status: 502 }
    );
  };
  const body = await (await route.POST(makeRequest())).json();
  assert.equal(body.results[0].status, "ok");
  assert.equal(body.results[1].statusCode, 502);
  assert.equal(body.results[1].error.includes("at /"), false);
});
