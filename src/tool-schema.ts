export const TOOL_NAMES = ["read", "write", "edit", "bash"] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolSpec {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "read",
    description: "Read file content from session filesystem",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write",
    description: "Write file content to session filesystem",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit",
    description: "Replace text within a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
      required: ["path", "find", "replace"],
      additionalProperties: false,
    },
  },
  {
    name: "bash",
    description: "Run shell command in session filesystem",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

export function isToolName(value: string): value is ToolName {
  return TOOL_NAMES.includes(value as ToolName);
}
