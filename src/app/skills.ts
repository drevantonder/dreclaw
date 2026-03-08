export interface SkillRecord {
  name: string;
  description: string;
  scope: "system" | "user";
  path: string;
  content: string;
}

const BUILTIN_SKILLS = [
  {
    name: "quickjs",
    description: "QuickJS runtime rules and patterns. Use for execute scripts, async returns, imports, and non-Node constraints.",
    content: `# QuickJS

Use this skill when writing or fixing QuickJS scripts for the execute tool.

Rules:
- The runtime is QuickJS, not Node.js.
- Use only built-in runtime globals and host APIs.
- Do not use require(), fs from Node, process, Buffer, or googleapis imports.
- If a script uses await or multiple statements, explicitly return the final value.
- For reusable helpers, write modules to VFS and import them with vfs:/ paths.

Patterns:

\
const result = await fetch('https://example.com').then((r) => r.text());
return result;
\

\
await fs.write({
  path: '/scripts/example.js',
  content: 'export async function run(input) { return input; }',
  overwrite: true,
});
const { run } = await import('vfs:/scripts/example.js');
return await run({ ok: true });
\
`,
  },
  {
    name: "google",
    description: "Google API access via built-in google.execute. Use for Gmail, Calendar, Drive, Docs, and Sheets tasks.",
    content: `# Google

Use this skill for Google workflows.

Rules:
- Use the built-in global google.
- Call google.execute with only: service, version, method, params, body.
- Never use endpoint.
- Prefer reusable helpers under /scripts/google/... for repeatable workflows.
- For multi-step flows, write a helper module with export async function run(input) { ... }.

Shapes:
- Gmail list: list.result?.messages
- Gmail message: msg.result?.payload?.headers and msg.result?.snippet
- Calendar events: calendar.result?.items

Examples:

\
const list = await google.execute({
  service: 'gmail',
  version: 'v1',
  method: 'users.messages.list',
  params: { userId: 'me', maxResults: 5 },
});
return list.result?.messages || [];
\

\
const events = await google.execute({
  service: 'calendar',
  version: 'v3',
  method: 'events.list',
  params: { calendarId: 'primary', singleEvents: true },
});
return events.result?.items || [];
\
`,
  },
  {
    name: "vfs",
    description: "VFS file rules for scripts, skills, and reusable artifacts. Use for fs.read/fs.write/fs.list/fs.remove patterns.",
    content: `# VFS

Use this skill when reading, writing, listing, or deleting runtime files.

Rules:
- VFS paths must be absolute, like /scripts/google/gmail.js.
- Use fs.write with an object payload: path, content, overwrite.
- Imports use vfs:/absolute/path.js.
- System skills under /skills/system/... are read-only.
- User-created skills belong under /skills/user/<name>/SKILL.md.

Examples:

\
await fs.write({
  path: '/scripts/google/gmail.js',
  content: "export async function run(input) { return input; }",
  overwrite: true,
});
\

\
const files = await fs.list({ prefix: '/scripts/google' });
return files;
\
`,
  },
  {
    name: "memory",
    description: "Memory API usage for finding, saving, and removing durable facts when a task benefits from recall.",
    content: `# Memory

Use this skill when durable recall helps complete the task.

Rules:
- Memory is persistent and runtime-managed.
- Save concise facts, preferences, goals, or labels when they are likely to matter later.
- Do not spam memory with transient debugging noise.

Examples:

\
await memory.save({ text: 'User labels inbox summary tasks as WIZ-EMAIL', kind: 'preference' });
return { ok: true };
\

\
return await memory.find({ query: 'recent inbox summary labels' });
\
`,
  },
  {
    name: "skill-authoring",
    description: "Create concise user skills in VFS. Use when a reusable workflow should become a skill.",
    content: `# Skill Authoring

Use this skill when creating or refining user skills.

Rules:
- Keep the skill focused on one job.
- Put the skill at /skills/user/<name>/SKILL.md.
- Frontmatter must include name and description.
- Description must say what the skill does and when to use it.
- Prefer short instructions. Move bulky examples into separate resources only if needed.
- Never try to override built-in system skill names.

Template:

\
---
name: inbox-summary
description: Summarize recent Gmail messages with concise bullets. Use when the task asks for inbox summaries.
---

# Inbox Summary

1. Load the google skill if needed.
2. Fetch the relevant messages.
3. Return a concise summary.
\
`,
  },
] as const;

const BUILTIN_BY_NAME = new Map<string, SkillRecord>(
  BUILTIN_SKILLS.map((skill) => [
    skill.name,
    {
      ...skill,
      scope: "system" as const,
      path: `/skills/system/${skill.name}/SKILL.md`,
    },
  ]),
);

export function listBuiltinSkills(): SkillRecord[] {
  return [...BUILTIN_BY_NAME.values()].map((skill) => ({ ...skill }));
}

export function getBuiltinSkillByName(name: string): SkillRecord | null {
  const skill = BUILTIN_BY_NAME.get(String(name ?? "").trim());
  return skill ? { ...skill } : null;
}

export function getBuiltinSkillByPath(path: string): SkillRecord | null {
  const normalized = String(path ?? "").trim();
  return listBuiltinSkills().find((skill) => skill.path === normalized) ?? null;
}

export function isSystemSkillName(name: string): boolean {
  return BUILTIN_BY_NAME.has(String(name ?? "").trim());
}

export function renderSkillCatalog(skills: Array<Pick<SkillRecord, "name" | "description" | "scope">>): string {
  if (!skills.length) return "";
  return skills
    .map((skill) => `- ${skill.name} [${skill.scope}]: ${skill.description}`)
    .join("\n");
}

export function renderLoadedSkill(skill: SkillRecord): string {
  return `<skill_content name="${skill.name}" scope="${skill.scope}">\n${skill.content.trim()}\n</skill_content>`;
}

export function parseSkillDocument(content: string): { name: string; description: string; body: string } {
  const input = String(content ?? "").trim();
  if (!input.startsWith("---")) throw new Error("SKILL_INVALID: missing frontmatter");
  const match = input.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error("SKILL_INVALID: malformed frontmatter");
  const frontmatter = match[1];
  const body = match[2]?.trim() ?? "";
  const name = matchLine(frontmatter, "name");
  const description = matchLine(frontmatter, "description");
  if (!name) throw new Error("SKILL_INVALID: missing name");
  if (!description) throw new Error("SKILL_INVALID: missing description");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("SKILL_INVALID: bad name");
  if (!body) throw new Error("SKILL_INVALID: missing body");
  return { name, description, body };
}

function matchLine(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim().replace(/^['\"]|['\"]$/g, "") : "";
}
