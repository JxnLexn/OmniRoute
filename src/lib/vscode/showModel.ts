import { getCanonicalModelMetadata } from "@/lib/modelMetadataRegistry";
import {
  buildReasoningConfigSchema,
  buildSupportedReasoningEfforts,
  getDefaultReasoningEffort,
  getReasoningEffortValues,
  inferSelectedReasoningEffort,
  type VscodeCatalogModel,
} from "./reasoningMetadata";
import { parseVscodeServiceTierVariantModelId } from "./serviceTierVariants";
import {
  getFamilyFirstModelCandidates,
  getFamilyFirstPublishedModelId,
} from "./familyFirstModelIds";

export type OpenAiCatalogModel = {
  id?: string;
  name?: string;
  root?: string;
  parent?: string | null;
  owned_by?: string;
  type?: string;
  api_format?: string;
  context_length?: number;
  max_output_tokens?: number;
  capabilities?: Record<string, boolean>;
  input_modalities?: string[];
  output_modalities?: string[];
  supported_endpoints?: string[];
};

function getCatalogModelId(model: OpenAiCatalogModel) {
  return model.id || model.name || model.root || "unknown";
}

function normalizeArchitectureKey(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "model";
}

function normalizeArchitectureSource(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "cx") return "codex";
  if (normalized === "gh") return "github";
  return value;
}

export function getRequestedModelName(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const candidate = record.name ?? record.model;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

function getOllamaModelFamily(model: OpenAiCatalogModel, canonicalFamily?: string | null) {
  const rawModelId = getCatalogModelId(model).trim();
  const { baseModelId } = parseVscodeServiceTierVariantModelId(rawModelId);
  const modelFamily = baseModelId.includes("/")
    ? baseModelId.split("/").slice(1).join("/")
    : baseModelId;

  if (modelFamily) {
    return modelFamily;
  }

  if (canonicalFamily && canonicalFamily.trim().length > 0) {
    return canonicalFamily.trim();
  }

  return typeof model.owned_by === "string" && model.owned_by.trim().length > 0
    ? model.owned_by.trim()
    : "omniroute";
}

export function matchesRequestedModel(model: OpenAiCatalogModel, requestedName: string): boolean {
  const canonicalMetadata = getCanonicalModelMetadata({
    provider: model.owned_by || null,
    model: model.root || model.id || model.name || null,
  });
  const family = getOllamaModelFamily(model, canonicalMetadata?.metadata.family || null);
  const actualModelId = getCatalogModelId(model);

  return [
    model.id,
    model.name,
    model.root,
    canonicalMetadata?.qualifiedId,
    canonicalMetadata?.model,
    ...getFamilyFirstModelCandidates(actualModelId, family),
  ].some((value) => value === requestedName);
}

function buildCapabilities(model: OpenAiCatalogModel): string[] {
  const capabilities = ["completion"];
  if (model.capabilities?.vision) capabilities.push("vision");
  if (model.capabilities?.tool_calling) capabilities.push("tools");
  if (model.capabilities?.reasoning || model.capabilities?.thinking) capabilities.push("thinking");
  return capabilities;
}

export function buildShowPayload(
  model: OpenAiCatalogModel,
  displayName: string,
  responseModelId?: string
) {
  const actualModelId = getCatalogModelId(model);
  const canonicalMetadata = getCanonicalModelMetadata({
    provider: model.owned_by || null,
    model: model.root || model.id || model.name || null,
  });
  const family = getOllamaModelFamily(model, canonicalMetadata?.metadata.family || null);
  const modelId = responseModelId || getFamilyFirstPublishedModelId(actualModelId, family);
  const architectureSource = normalizeArchitectureSource(
    canonicalMetadata?.providerAlias ||
      canonicalMetadata?.provider ||
      model.owned_by ||
      family ||
      "model"
  );
  const architecture = normalizeArchitectureKey(architectureSource);
  const reasoningEffortValues = getReasoningEffortValues(model as VscodeCatalogModel);
  const selectedReasoningEffort = reasoningEffortValues
    ? inferSelectedReasoningEffort(model as VscodeCatalogModel, reasoningEffortValues) || "none"
    : undefined;
  const defaultReasoningEffort = reasoningEffortValues
    ? getDefaultReasoningEffort(model as VscodeCatalogModel, reasoningEffortValues)
    : undefined;
  const supportedReasoningEfforts =
    reasoningEffortValues && reasoningEffortValues.length > 0
      ? buildSupportedReasoningEfforts(reasoningEffortValues)
      : undefined;
  const configSchema =
    reasoningEffortValues && defaultReasoningEffort
      ? buildReasoningConfigSchema(reasoningEffortValues, defaultReasoningEffort)
      : undefined;
  let modelCapabilities = model.capabilities ? { ...model.capabilities } : undefined;

  if (reasoningEffortValues) {
    modelCapabilities = modelCapabilities || {};
    Object.assign(modelCapabilities, {
      reasoning: true,
      thinking: true,
      supports_reasoning_effort: reasoningEffortValues,
      supportsReasoningEffort: reasoningEffortValues,
      supportedReasoningEfforts,
      defaultReasoningEffort,
      selected_reasoning_effort: selectedReasoningEffort,
      selectedReasoningEffort: selectedReasoningEffort,
      ...(configSchema ? { configurationSchema: configSchema } : {}),
      ...(configSchema ? { configSchema } : {}),
    });
  }

  return {
    model: modelId,
    remote_model: displayName,
    ...(reasoningEffortValues
      ? {
          supports_reasoning_effort: reasoningEffortValues,
          supportsReasoningEffort: reasoningEffortValues,
          supportedReasoningEfforts,
          defaultReasoningEffort,
          selected_reasoning_effort: selectedReasoningEffort,
          selectedReasoningEffort: selectedReasoningEffort,
          ...(configSchema ? { configurationSchema: configSchema } : {}),
          ...(configSchema ? { configSchema } : {}),
        }
      : {}),
    license: "proprietary",
    modelfile: `FROM ${modelId}`,
    parameters: "",
    template: "",
    details: {
      parent_model: model.root || actualModelId || "",
      format: "openai",
      family,
      families: [family],
      parameter_size: "unknown",
      quantization_level: "dynamic",
      ...(reasoningEffortValues
        ? {
            supports_reasoning_effort: reasoningEffortValues,
            supportsReasoningEffort: reasoningEffortValues,
            supportedReasoningEfforts,
            defaultReasoningEffort,
            selected_reasoning_effort: selectedReasoningEffort,
            selectedReasoningEffort: selectedReasoningEffort,
            ...(configSchema ? { configurationSchema: configSchema } : {}),
            ...(configSchema ? { configSchema } : {}),
          }
        : {}),
    },
    model_info: {
      "general.architecture": architecture,
      "general.basename": displayName,
      ...(typeof model.context_length === "number" ? { context_length: model.context_length } : {}),
      ...(typeof model.context_length === "number"
        ? { [`${architecture}.context_length`]: model.context_length }
        : {}),
      ...(typeof model.max_output_tokens === "number"
        ? { max_output_tokens: model.max_output_tokens }
        : {}),
      ...(Array.isArray(model.input_modalities)
        ? { input_modalities: model.input_modalities }
        : {}),
      ...(Array.isArray(model.output_modalities)
        ? { output_modalities: model.output_modalities }
        : {}),
      ...(Array.isArray(model.supported_endpoints)
        ? { supported_endpoints: model.supported_endpoints }
        : {}),
      ...(modelCapabilities ? { capabilities: modelCapabilities } : {}),
      ...(reasoningEffortValues
        ? {
            supports_reasoning_effort: reasoningEffortValues,
            supportsReasoningEffort: reasoningEffortValues,
            supportedReasoningEfforts,
            defaultReasoningEffort,
            selected_reasoning_effort: selectedReasoningEffort,
            selectedReasoningEffort: selectedReasoningEffort,
            ...(configSchema ? { configurationSchema: configSchema } : {}),
            ...(configSchema ? { configSchema } : {}),
          }
        : {}),
    },
    capabilities: buildCapabilities(model),
  };
}
