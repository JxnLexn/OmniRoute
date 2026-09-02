import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-vertex-model-routes-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerModelsRoute = await import("../../src/app/api/providers/[id]/models/route.ts");

const originalFetch = globalThis.fetch;

async function resetStorage(): Promise<void> {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedVertexConnection(options: {
  apiKey?: string;
  accessToken?: string;
}): Promise<{ id: string }> {
  return providersDb.createProviderConnection({
    provider: "vertex",
    authType: "apikey",
    name: `vertex-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: options.apiKey,
    accessToken: options.accessToken,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { autoFetchModels: true },
  });
}

async function callRoute(connectionId: string): Promise<Response> {
  return providerModelsRoute.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true&chatOnly=true`),
    { params: { id: connectionId } }
  );
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Vertex Express uses an intentional curated catalog without unsupported API probes", async () => {
  const connection = await seedVertexConnection({ apiKey: "vertex-express-key" });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Vertex Express model listing must not be called");
  };

  const response = await callRoute(connection.id);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.source, "local_catalog");
  assert.equal(body.intentional, true);
  assert.match(body.warning, /Vertex Express.*model-list API/i);
  assert.equal(fetchCalls, 0);
  assert.ok(
    body.models.some(
      (model: { id?: string; targetFormat?: string }) =>
        model.id === "grok-4.6" && model.targetFormat === "openai"
    )
  );
});

test("Vertex Service Account discovery merges Gemini, Anthropic, and xAI catalogs", async () => {
  const connection = await seedVertexConnection({
    accessToken: "ya29.vertex-model-discovery",
  });
  const calledUrls: string[] = [];
  globalThis.fetch = async (url) => {
    const calledUrl = String(url);
    calledUrls.push(calledUrl);
    if (calledUrl.includes("generativelanguage.googleapis.com")) {
      return Response.json({
        models: [
          {
            name: "models/gemini-3.1-pro-preview",
            displayName: "Gemini 3.1 Pro Preview",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      });
    }
    if (calledUrl.includes("/publishers/anthropic/models")) {
      return Response.json({
        publisherModels: [{ name: "publishers/anthropic/models/claude-sonnet-4-6" }],
      });
    }
    if (calledUrl.includes("/publishers/xai/models")) {
      return Response.json({
        publisherModels: [{ name: "publishers/xai/models/grok-4.6" }],
      });
    }
    return new Response("unexpected discovery URL", { status: 500 });
  };

  const response = await callRoute(connection.id);
  const body = await response.json();
  const byId = new Map(
    body.models.map((model: { id: string; targetFormat?: string }) => [model.id, model])
  );

  assert.equal(response.status, 200);
  assert.equal(body.source, "api");
  assert.ok(byId.has("gemini-3.1-pro-preview"));
  assert.equal(byId.get("claude-sonnet-4-6")?.targetFormat, "claude");
  assert.equal(byId.get("grok-4.6")?.targetFormat, "openai");
  assert.ok(calledUrls.some((url) => url.includes("/v1beta1/publishers/xai/models")));
});

test("Vertex Service Account keeps usable xAI results when Gemini listing is blocked", async () => {
  const connection = await seedVertexConnection({ accessToken: "ya29.vertex-xai-only" });
  globalThis.fetch = async (url) => {
    const calledUrl = String(url);
    if (calledUrl.includes("generativelanguage.googleapis.com")) {
      return Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 });
    }
    if (calledUrl.includes("/publishers/xai/models")) {
      return Response.json({
        publisherModels: [{ name: "publishers/xai/models/grok-4.6" }],
      });
    }
    return Response.json({ publisherModels: [] });
  };

  const response = await callRoute(connection.id);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.source, "api");
  assert.ok(body.models.some((model: { id?: string }) => model.id === "grok-4.6"));
  assert.match(body.warning, /some Vertex catalogs were unavailable/i);
});
