import { createHash } from "node:crypto";
import { flattenNamespaceToolName } from "../../translator/request/openai-responses/namespaceFlatten.ts";
import type { NamespaceIdentity } from "./requestToolIdentity.ts";

type RecordValue = Record<string, unknown>;
const XAI_RESPONSES_PROVIDERS = new Set(["grok-cli", "gc", "xai", "xai-oauth", "xao"]);
const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};

/** xAI Responses accepts functions but not OpenAI namespace tool containers. */
export function normalizeXaiResponsesNamespaces(
  body: RecordValue,
  provider: string,
  targetFormat: string
): Set<string> {
  const customNames = new Set<string>();
  if (targetFormat !== "openai-responses" || !XAI_RESPONSES_PROVIDERS.has(provider))
    return customNames;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const input = Array.isArray(body.input) ? body.input : [];
  if (
    !tools.some((t) => ["namespace", "custom"].includes(String(record(t).type))) &&
    !input.some(
      (i) =>
        ["custom_tool_call", "custom_tool_call_output"].includes(String(record(i).type)) ||
        (record(i).type === "function_call" && record(i).namespace)
    ) &&
    !record(body.tool_choice).namespace
  )
    return customNames;
  const identities = new Map<string, NamespaceIdentity>();
  const names = new Map<string, string>();
  const reserved = new Set(
    tools.filter((t) => record(t).type !== "namespace").map((t) => record(t).name)
  );
  const wireName = (namespace: string, name: string): string => {
    const key = JSON.stringify([namespace, name]);
    const existing = names.get(key);
    if (existing) return existing;
    const base = flattenNamespaceToolName(namespace, name);
    let wire = base;
    let attempt = 0;
    while (reserved.has(wire)) {
      const hash = createHash("sha256").update(`${key}:${attempt++}`).digest("hex").slice(0, 10);
      wire = `${base.slice(0, 53)}_${hash}`;
    }
    reserved.add(wire);
    names.set(key, wire);
    identities.set(wire, { namespace, name });
    return wire;
  };
  const flatten = (values: unknown[], namespace = ""): unknown[] =>
    values.flatMap((value) => {
      const tool = record(value);
      if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
        return flatten(tool.tools, namespace ? `${namespace}.${tool.name}` : tool.name);
      }
      if (typeof tool.name !== "string") return [value];
      const name = namespace ? wireName(namespace, tool.name) : tool.name;
      if (tool.type === "custom") {
        customNames.add(name);
        return [
          {
            type: "function",
            name,
            description: tool.description,
            parameters: {
              type: "object",
              properties: { input: { type: "string" } },
              required: ["input"],
              additionalProperties: false,
            },
          },
        ];
      }
      if (!namespace) return [value];
      return [{ ...tool, type: tool.type ?? "function", name }];
    });
  body.tools = flatten(tools);

  const qualify = (value: unknown): unknown => {
    const item = record(value);
    if (typeof item.namespace !== "string" || !item.namespace || typeof item.name !== "string")
      return value;
    const result: RecordValue = { ...item, name: wireName(item.namespace, item.name) };
    delete result.namespace;
    return result;
  };
  if (Array.isArray(body.input)) {
    body.input = body.input.map((value) => {
      const item = record(value);
      if (item.type === "custom_tool_call") {
        const mapped = record(qualify(item));
        const result: RecordValue = {
          ...mapped,
          type: "function_call",
          arguments: JSON.stringify({ input: item.input ?? "" }),
        };
        delete result.input;
        return result;
      }
      if (item.type === "custom_tool_call_output") return { ...item, type: "function_call_output" };
      return item.type === "function_call" ? qualify(value) : value;
    });
  }
  if (record(body.tool_choice).type === "function") body.tool_choice = qualify(body.tool_choice);
  if (record(body.tool_choice).type === "custom")
    body.tool_choice = { ...record(qualify(body.tool_choice)), type: "function" };
  const choice = record(body.tool_choice);
  if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
    body.tool_choice = { ...choice, tools: choice.tools.map(qualify) };
  }
  if (identities.size > 0) {
    Object.defineProperty(body, "_namespaceToolIdentityMap", {
      value: identities,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return customNames;
}
