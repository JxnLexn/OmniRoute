import type { RegistryModel } from "./providers/shared.ts";

const VERTEX_PUBLISHER_RESOURCE_PATTERN =
  /^(?:(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/(?:google|anthropic|xai)\/models\/|(?:google|anthropic|xai)\/models\/)(.+)$/i;
const XAI_VERSION_NAME_PATTERN = /^xai\/(grok-.+)$/i;

/**
 * Convert Model Garden resource names to the model value accepted by Vertex inference APIs.
 * The console shows `publishers/xai/models/grok-4.6`, while the OpenAI-compatible MaaS
 * endpoint expects `grok-4.6` in the request body.
 */
export function normalizeVertexModelId(model: string): string {
  const trimmed = model.trim();
  const resourceMatch = trimmed.match(VERTEX_PUBLISHER_RESOURCE_PATTERN);
  if (resourceMatch?.[1]) return resourceMatch[1];

  const xaiVersionNameMatch = trimmed.match(XAI_VERSION_NAME_PATTERN);
  return xaiVersionNameMatch?.[1] || trimmed;
}

/** True for xAI models served through Vertex's OpenAI-compatible MaaS endpoint. */
export function isVertexXaiModel(model: string): boolean {
  return /^grok-/i.test(normalizeVertexModelId(model));
}

/**
 * Curated fallback for Vertex Express keys. Google does not expose the Model Garden LIST API to
 * API-key authentication, so Express connections need an in-product catalog for partner models.
 */
export const VERTEX_XAI_MODELS = [
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    contextLength: 524288,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
    targetFormat: "openai",
  },
  { id: "grok-4.3", name: "Grok 4.3", targetFormat: "openai" },
  {
    id: "grok-4.20-reasoning",
    name: "Grok 4.20 Reasoning",
    supportsReasoning: true,
    targetFormat: "openai",
  },
  {
    id: "grok-4.20-non-reasoning",
    name: "Grok 4.20 Non-Reasoning",
    targetFormat: "openai",
  },
  {
    id: "grok-4.1-fast-reasoning",
    name: "Grok 4.1 Fast Reasoning",
    supportsReasoning: true,
    targetFormat: "openai",
  },
  {
    id: "grok-4.1-fast-non-reasoning",
    name: "Grok 4.1 Fast Non-Reasoning",
    targetFormat: "openai",
  },
] as const satisfies readonly RegistryModel[];
