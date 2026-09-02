import {
  getVertexModelTargetFormat,
  normalizeVertexModelId,
} from "@omniroute/open-sse/config/vertexModels.ts";

interface VertexPublisherModel {
  name?: string;
  id?: string;
  displayName?: string;
  description?: string;
  supportedActions?: Record<string, unknown>;
}

export interface VertexPublisherDiscoveryModel {
  id: string;
  name: string;
  supportedEndpoints: ["chat"];
  targetFormat: "claude" | "openai";
  owned_by: string;
  description?: string;
}

/** Parse one Model Garden publisher-list envelope into model ids accepted by Vertex inference. */
export function parseVertexPublisherModels(
  data: unknown,
  publisher: string
): VertexPublisherDiscoveryModel[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const record = data as { models?: unknown[]; publisherModels?: unknown[] };
  const models = Array.isArray(record.publisherModels)
    ? record.publisherModels
    : Array.isArray(record.models)
      ? record.models
      : [];

  return models.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const model = candidate as VertexPublisherModel;
    const rawId =
      (typeof model.name === "string" && model.name) ||
      (typeof model.id === "string" && model.id) ||
      "";
    if (!rawId) return [];
    const actions = model.supportedActions;
    if (
      actions &&
      !actions.viewRestApi &&
      !actions.openGenerationAiStudio &&
      !actions.openGenie &&
      !actions.requestAccess
    ) {
      return [];
    }
    const routableId = rawId.includes("/") ? rawId : `publishers/${publisher}/models/${rawId}`;
    const id = normalizeVertexModelId(routableId);
    const targetFormat = getVertexModelTargetFormat(routableId);
    if (!id || !targetFormat || /(?:^|[-/])ocr(?:-|$)/i.test(id)) return [];

    return [
      {
        id,
        name: (typeof model.displayName === "string" && model.displayName) || id,
        supportedEndpoints: ["chat"] as ["chat"],
        targetFormat,
        owned_by: publisher,
        ...(typeof model.description === "string" ? { description: model.description } : {}),
      },
    ];
  });
}
