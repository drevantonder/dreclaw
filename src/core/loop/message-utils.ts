import type { ModelMessage } from "ai";

export function isModelMessageArray(value: unknown): value is ModelMessage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item && typeof item === "object" && typeof (item as { role?: unknown }).role === "string",
    )
  );
}

export function mergeContinuationMessages(
  base: ModelMessage[],
  continuation: ModelMessage[],
): ModelMessage[] {
  if (!continuation.length) return base;
  if (continuation.length >= base.length) {
    const prefix = continuation.slice(0, base.length);
    if (JSON.stringify(prefix) === JSON.stringify(base)) return continuation;
  }
  return [...base, ...continuation];
}

export function extractAssistantText(messages: ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content.trim();
  }
  return "";
}
