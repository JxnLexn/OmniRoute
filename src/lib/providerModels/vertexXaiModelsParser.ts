import {
  isVertexXaiModel,
  normalizeVertexModelId,
} from "@omniroute/open-sse/config/vertexModels.ts";

interface VertexXaiPublisherModel {
  name?: string;
  id?: string;
  displayName?: string;
  description?: string;
}

export interface VertexXaiDiscoveryModel {
  id: string;
  name: string;
  supportedEndpoints: string[];
  targetFormat: "openai";
  owned_by: "xai";
  description?: string;
}

/** Parse the v1beta1 Model Garden xAI publisher list into routable MaaS model rows. */
export function parseVertexXaiModels(data: unknown): VertexXaiDiscoveryModel[] {
  if (!data || typeof data !== "object") return [];
  const record = data as { models?: unknown[]; publisherModels?: unknown[] };
  const models = Array.isArray(record.publisherModels)
    ? record.publisherModels
    : Array.isArray(record.models)
      ? record.models
      : [];

  return models.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const model = candidate as VertexXaiPublisherModel;
    const rawId =
      (typeof model.name === "string" && model.name) ||
      (typeof model.id === "string" && model.id) ||
      "";
    const id = normalizeVertexModelId(rawId);
    if (!id || !isVertexXaiModel(id)) return [];

    return [
      {
        id,
        name: (typeof model.displayName === "string" && model.displayName) || id,
        supportedEndpoints: ["chat"],
        targetFormat: "openai" as const,
        ...(typeof model.description === "string" ? { description: model.description } : {}),
        owned_by: "xai" as const,
      },
    ];
  });
}
