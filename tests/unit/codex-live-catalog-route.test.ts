import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-live-catalog-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../src/lib/db/core.ts");
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const { getCachedDiscoveredModels } =
  await import("../../src/lib/providerModels/modelDiscovery.ts");
const { GET } = await import("../../src/app/api/providers/[id]/models/route.ts");
const { clearCodexGithubCatalogCacheForTests } =
  await import("../../src/app/api/providers/[id]/models/discovery/codex.ts");
const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearCodexGithubCatalogCacheForTests();
});
const call = async (id: string, refresh = true) => {
  const response = await GET(
    new Request(`http://localhost/api/providers/${id}/models?refresh=${refresh}&chatOnly=true`),
    { params: { id } }
  );
  assert.equal(response.status, 200);
  return response.json();
};
const ids = (body: { models: Array<{ id: string }> }) => body.models.map((model) => model.id);
const connection = () =>
  createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "catalog test",
    isActive: true,
    accessToken: "test-token",
    providerSpecificData: { autoFetchModels: false },
  });

test("live IDs replace stale account cache without adding static or GitHub-only models", async () => {
  const c = await connection();
  let modelId = "codex-live-before";
  globalThis.fetch = async (input) =>
    Response.json({
      models: [
        {
          slug: String(input).includes("chatgpt.com") ? modelId : "github-only-model",
          visibility: "list",
          supported_in_api: true,
        },
      ],
    });
  assert.deepEqual(ids(await call(c.id)), [modelId]);
  modelId = "codex-live-after";
  assert.deepEqual(ids(await call(c.id)), [modelId]);
  assert.deepEqual(
    (await getCachedDiscoveredModels("codex", c.id)).map((m) => m.id),
    [modelId]
  );
  assert.deepEqual(ids(await call(c.id, false)), [modelId]);
  globalThis.fetch = async (input) =>
    String(input).includes("chatgpt.com")
      ? new Response("unavailable", { status: 503 })
      : Response.json({
          models: [{ slug: "github-only-model", visibility: "list", supported_in_api: true }],
        });
  const fallback = await call(c.id);
  assert.equal(fallback.source, "cache");
  assert.deepEqual(ids(fallback), [modelId]);
});

test("unsynchronized accounts retain an explicit static fallback with auto-fetch off", async () => {
  const c = await connection();
  globalThis.fetch = async () => {
    throw new Error("must not fetch");
  };
  const fallback = await call(c.id, false);
  assert.equal(fallback.source, "local_catalog");
  assert.ok(fallback.models.length > 0);
});
