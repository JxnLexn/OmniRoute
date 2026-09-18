import type { NamespaceIdentity } from "./requestToolIdentity.ts";

type Item = Record<string, unknown>;
const record = (value: unknown): Item =>
  value && typeof value === "object" ? (value as Item) : {};

function unwrapInput(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed.input === "string") return parsed.input;
  } catch {
    /* Preserve malformed model arguments as text instead of losing them. */
  }
  return value;
}

export function restoreXaiCustomToolItem(
  value: unknown,
  names: ReadonlySet<string>,
  identities: ReadonlyMap<string, NamespaceIdentity> | null
): void {
  const item = record(value);
  if (item.type !== "function_call" || typeof item.name !== "string" || !names.has(item.name))
    return;
  const identity = identities?.get(item.name);
  item.type = "custom_tool_call";
  item.input = unwrapInput(item.arguments);
  delete item.arguments;
  if (identity) {
    item.name = identity.name;
    item.namespace = identity.namespace;
  }
}

/** Restore custom free-text calls before the normal Responses passthrough processor. */
export function restoreXaiCustomToolStream(
  response: Response,
  names: ReadonlySet<string>,
  identities: ReadonlyMap<string, NamespaceIdentity> | null
): Response {
  if (!response.body || names.size === 0) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const customItems = new Set<string>();
  const argumentsById = new Map<string, string>();
  const emit = (event: Item) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const convert = (frame: string): string => {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    let parsed: Item;
    try {
      parsed = record(JSON.parse(data));
    } catch {
      return frame + "\n\n";
    }
    const item = record(parsed.item);
    if (item.type === "function_call" && typeof item.name === "string" && names.has(item.name)) {
      if (typeof item.id === "string") customItems.add(item.id);
      restoreXaiCustomToolItem(item, names, identities);
      return emit(parsed);
    }
    const id = String(parsed.item_id ?? "");
    if (customItems.has(id) && parsed.type === "response.function_call_arguments.delta") {
      argumentsById.set(id, (argumentsById.get(id) ?? "") + String(parsed.delta ?? ""));
      return "";
    }
    if (customItems.has(id) && parsed.type === "response.function_call_arguments.done") {
      const input = unwrapInput(parsed.arguments ?? argumentsById.get(id));
      argumentsById.delete(id);
      const base = { item_id: parsed.item_id, output_index: parsed.output_index };
      return (
        emit({ ...base, type: "response.custom_tool_call_input.delta", delta: input }) +
        emit({ ...base, type: "response.custom_tool_call_input.done", input })
      );
    }
    const output = record(parsed.response).output;
    if (Array.isArray(output)) {
      for (const value of output) restoreXaiCustomToolItem(value, names, identities);
      return emit(parsed);
    }
    return frame + "\n\n";
  };
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const converted = convert(frame);
          if (converted) controller.enqueue(encoder.encode(converted));
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) controller.enqueue(encoder.encode(convert(buffer)));
      },
    })
  );
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
