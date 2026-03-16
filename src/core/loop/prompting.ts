import type { ModelMessage } from "ai";
import type { Reminder } from "../../plugins/reminders";
import type { ToolTrace } from "./tracing";
import type { BotThreadState } from "./state";

export const MEMORY_FACT_TOP_K = 6;
export const MEMORY_EPISODE_TOP_K = 4;
export const PROACTIVE_NO_MESSAGE = "NO_MESSAGE";
export const SYSTEM_PROMPT =
  "Be concise. Solve tasks with runtime-native tools and sandboxed execute scripts. Finish once you have enough information. Use the simplest reliable path. Keep streaming natural. Do not narrate plans. Before the final answer, avoid filler progress updates like 'let me check' or 'now I will'. Prefer silent tool calls unless a brief user-facing checkpoint is genuinely helpful. If an execute script fails, simplify it immediately instead of retrying the same shape. Use reminders tools to track follow-ups, recurring responsibilities, and commitments you should wake for later.";

export function buildAgentMessages(
  systemPrompt: string,
  userText: string,
  imageBlocks: string[],
): ModelMessage[] {
  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [];
  parts.push({ type: "text", text: userText || "[image message]" });
  for (const image of imageBlocks) parts.push({ type: "image", image });
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: imageBlocks.length ? parts : userText || "[image message]" },
  ];
}

export function renderHistoryContext(history: BotThreadState["history"]): string {
  if (!history.length) return "";
  return history.map((entry) => `${entry.role}: ${entry.content}`).join("\n");
}

export function renderWakePacket(item: Reminder, recentWakeSummaries: string[]): string {
  return [
    "Proactive wake packet:",
    `title: ${item.title}`,
    `kind: ${item.kind}`,
    `priority: ${item.priority}`,
    `notes: ${item.notes || "-"}`,
    `scheduled_for: ${item.nextWakeAt ?? "-"}`,
    recentWakeSummaries.length
      ? `recent_runs:\n${recentWakeSummaries.map((entry) => `- ${entry}`).join("\n")}`
      : "recent_runs: -",
  ].join("\n");
}

export function normalizeProactiveMessage(text: string): string | null {
  const normalized = String(text ?? "").trim();
  if (!normalized || normalized === PROACTIVE_NO_MESSAGE) return null;
  return normalized;
}

export function summarizeProactiveWake(
  item: Reminder,
  messageText: string | null,
  toolTraces: ToolTrace[],
): string {
  if (messageText) return messageText;
  const successful = toolTraces.filter((trace) => trace.ok).length;
  const failed = toolTraces.length - successful;
  return `${item.title} | silent wake | tools ok=${successful} failed=${failed}`;
}

export function shouldEnableAgentTools(userText: string): boolean {
  const text = String(userText ?? "")
    .trim()
    .toLowerCase();
  if (!text) return false;
  if (text.length > 120) return true;
  if (
    /(gmail|email|calendar|drive|docs|sheets|google|bash|shell|tool|file|skill|workflow|search|find|list|create|update|delete|remind|todo|memory|debug|investigate|compare|code|script|write|read|open|organize|library)/.test(
      text,
    )
  ) {
    return true;
  }
  if (text.startsWith("/")) return false;
  return false;
}

export function shouldIncludeMemoryContext(userText: string): boolean {
  const text = String(userText ?? "")
    .trim()
    .toLowerCase();
  if (!text) return false;
  if (text.length > 80) return true;
  return /(remember|earlier|before|previous|context|history|memory|follow up|follow-up)/.test(text);
}

export function inferImplicitSkillNames(userText: string): string[] {
  const text = String(userText ?? "").toLowerCase();
  const names = new Set<string>();
  if (/gmail|email|inbox|calendar|drive|docs|sheets|google/.test(text)) {
    names.add("google");
    names.add("execute-runtime");
  }
  if (/script|helper|vfs|file/.test(text)) {
    names.add("vfs");
    names.add("execute-runtime");
  }
  if (/memory|remember|label/.test(text)) names.add("memory");
  if (/skill|workflow/.test(text)) names.add("skill-authoring");
  return [...names];
}

export function renderTaskGuidance(userText: string): string {
  const text = String(userText ?? "").toLowerCase();
  const lines: string[] = [];
  if (/bash|shell|curl|grep|sed|awk|jq|yq|find|xargs|pipe|regex/.test(text)) {
    lines.push(
      "- Prefer bash for shell pipelines, curl, jq/yq, grep/sed/awk, and file-oriented text processing.",
    );
    lines.push(
      "- Prefer execute only when the task needs JavaScript, google.execute, memory.*, or fs.* runtime work.",
    );
  }
  if (/gmail|email|inbox/.test(text)) {
    lines.push("- For Gmail summaries, use at most one google.execute call per execute run.");
    lines.push(
      "- Good pattern: one execute run to list ids, one execute run per message detail, one final execute run to format a string summary.",
    );
    lines.push(
      "- For detail fetch runs, do not use return JSON.stringify({ ... }). Assign fields to const vars and return a plain string.",
    );
    lines.push(
      "- If one execute script fails, rewrite it to the simplest plain-string form on the next try.",
    );
  }
  if (/calendar/.test(text)) {
    lines.push(
      "- For Calendar tasks, prefer one focused execute run per API step and return a final string summary.",
    );
  }
  return lines.join("\n");
}
