import test from "node:test";
import assert from "node:assert/strict";

import { getModelTargetFormat } from "../../open-sse/config/providerModels.ts";
import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import { isVertexXaiModel, normalizeVertexModelId } from "../../open-sse/config/vertexModels.ts";
import { parseVertexXaiModels } from "../../src/lib/providerModels/vertexXaiModelsParser.ts";

test("normalizeVertexModelId accepts Model Garden resource names and request names", () => {
  const cases = [
    "grok-4.6",
    "xai/grok-4.6",
    "xai/models/grok-4.6",
    "publishers/xai/models/grok-4.6",
    "projects/demo/locations/global/publishers/xai/models/grok-4.6",
  ];

  for (const modelId of cases) {
    assert.equal(normalizeVertexModelId(modelId), "grok-4.6", modelId);
    assert.equal(isVertexXaiModel(modelId), true, modelId);
  }

  assert.equal(normalizeVertexModelId("gemini-3.1-pro-preview"), "gemini-3.1-pro-preview");
  assert.equal(isVertexXaiModel("gemini-3.1-pro-preview"), false);
});

test("parseVertexXaiModels maps the Model Garden publisher envelope to routable models", () => {
  const models = parseVertexXaiModels({
    publisherModels: [
      {
        name: "publishers/xai/models/grok-4.6",
        displayName: "Grok 4.6",
        description: "xAI partner model",
      },
      {
        name: "projects/demo/locations/global/publishers/xai/models/grok-4.20-reasoning",
      },
    ],
  });

  assert.deepEqual(models, [
    {
      id: "grok-4.6",
      name: "Grok 4.6",
      supportedEndpoints: ["chat"],
      targetFormat: "openai",
      description: "xAI partner model",
      owned_by: "xai",
    },
    {
      id: "grok-4.20-reasoning",
      name: "grok-4.20-reasoning",
      supportedEndpoints: ["chat"],
      targetFormat: "openai",
      owned_by: "xai",
    },
  ]);
});

test("Vertex xAI models always resolve to the OpenAI wire format", () => {
  const ids = ["grok-4.6", "xai/grok-4.6", "xai/models/grok-4.6", "publishers/xai/models/grok-4.6"];

  for (const provider of ["vertex", "vertex-partner", "vp"]) {
    for (const modelId of ids) {
      assert.equal(getModelTargetFormat(provider, modelId), "openai", `${provider}/${modelId}`);
    }
  }
});

test("Vertex registries contain the documented xAI MaaS models as partial live catalogs", () => {
  for (const provider of ["vertex", "vertex-partner"]) {
    const entry = getRegistryEntry(provider);
    assert.ok(entry, provider);
    assert.equal(entry.liveCatalogAuthoritative, false, provider);

    const grok = entry.models.find((model) => model.id === "grok-4.6");
    assert.ok(grok, `${provider} must expose grok-4.6`);
    assert.equal(grok.targetFormat, "openai");
    assert.equal(grok.supportsVision, true);
    assert.equal(grok.contextLength, 524288);
  }
});
