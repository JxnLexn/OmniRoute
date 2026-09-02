import test from "node:test";
import assert from "node:assert/strict";

import { discoverVertexModelsWithApiKey } from "../../src/lib/providerModels/vertexModelDiscovery.ts";
import { parseVertexPublisherModels } from "../../src/lib/providerModels/vertexPublisherModelsParser.ts";

test("generic Vertex publisher parser produces routable IDs for every transport family", () => {
  const cases = [
    ["anthropic", "claude-sonnet-5", "claude", "claude-sonnet-5"],
    ["mistralai", "mistral-medium-3", "openai", "mistral-medium-3"],
    ["xai", "grok-4.6", "openai", "xai/grok-4.6"],
    [
      "meta",
      "llama-4-maverick-17b-128e-instruct-maas",
      "openai",
      "meta/llama-4-maverick-17b-128e-instruct-maas",
    ],
    ["deepseek-ai", "deepseek-v3.2-maas", "openai", "deepseek-ai/deepseek-v3.2-maas"],
    ["future-vendor", "future-chat-maas", "openai", "future-vendor/future-chat-maas"],
  ] as const;

  for (const [publisher, rawId, targetFormat, expectedId] of cases) {
    const models = parseVertexPublisherModels(
      {
        publisherModels: [
          {
            name: `publishers/${publisher}/models/${rawId}`,
            displayName: `Display ${rawId}`,
          },
        ],
      },
      publisher
    );

    assert.deepEqual(models, [
      {
        id: expectedId,
        name: `Display ${rawId}`,
        supportedEndpoints: ["chat"],
        targetFormat,
        owned_by: publisher,
      },
    ]);
  }
});

test("generic Vertex publisher parser accepts models and publisherModels envelopes", () => {
  assert.equal(
    parseVertexPublisherModels(
      { models: [{ id: "publishers/qwen/models/qwen3-next-80b-a3b-instruct-maas" }] },
      "qwen"
    )[0]?.id,
    "qwen/qwen3-next-80b-a3b-instruct-maas"
  );
  assert.deepEqual(parseVertexPublisherModels(null, "xai"), []);
  assert.deepEqual(parseVertexPublisherModels({ publisherModels: [null, {}] }, "xai"), []);
  assert.equal(
    parseVertexPublisherModels({ publisherModels: [{ id: "grok-4.6" }] }, "xai")[0]?.id,
    "xai/grok-4.6"
  );
  assert.deepEqual(
    parseVertexPublisherModels(
      {
        publisherModels: [
          {
            id: "self-deploy-only",
            supportedActions: { deploy: {} },
          },
        ],
      },
      "future-vendor"
    ),
    []
  );
});

test("Vertex publisher discovery follows pagination and keeps the API key out of URLs", async () => {
  const urls: string[] = [];
  const result = await discoverVertexModelsWithApiKey({
    apiKey: "authorization-key",
    fetchImpl: async (url, init) => {
      urls.push(url);
      assert.equal(new Headers(init.headers).get("x-goog-api-key"), "authorization-key");
      assert.ok(!url.includes("authorization-key"));

      if (url.includes("generativelanguage.googleapis.com")) {
        return Response.json({ models: [] });
      }
      if (url.includes("/publishers/xai/models") && !url.includes("pageToken=")) {
        return Response.json({
          publisherModels: [{ name: "publishers/xai/models/grok-4.6" }],
          nextPageToken: "next-xai",
        });
      }
      if (url.includes("/publishers/xai/models") && url.includes("pageToken=next-xai")) {
        return Response.json({
          publisherModels: [{ name: "publishers/xai/models/grok-4.3" }],
        });
      }
      return Response.json({ publisherModels: [] });
    },
  });

  assert.deepEqual(result.models.map((model) => (model as { id: string }).id).sort(), [
    "xai/grok-4.3",
    "xai/grok-4.6",
  ]);
  assert.ok(urls.some((url) => url.includes("pageToken=next-xai")));
});
