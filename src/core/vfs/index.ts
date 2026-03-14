import {
  deleteVfsEntry,
  getVfsEntry,
  getVfsRevision,
  listVfsEntries,
  putVfsEntry,
  type VfsEntryRecord,
} from "./repo";
import {
  getBuiltinSkillByName,
  getBuiltinSkillByPath,
  isSystemSkillName,
  listBuiltinSkills,
  parseSkillDocument,
  type SkillRecord,
} from "../skills";

export interface WorkspaceOptions {
  db: D1Database;
  maxFileBytes: number;
}

export type WorkspaceWriteResult =
  | { ok: true; path: string }
  | { ok: false; code: "EEXIST" | "VFS_READ_ONLY" | "VFS_LIMIT_EXCEEDED" };

export interface WorkspaceBoundary {
  normalizePath(path: string): string;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string, overwrite: boolean): Promise<WorkspaceWriteResult>;
  listFiles(prefix: string, limit: number): Promise<string[]>;
  removeFile(path: string): Promise<boolean>;
  getRevision(): Promise<number>;
  listSkills(): Promise<Array<Pick<SkillRecord, "name" | "description" | "scope">>>;
  loadSkill(name: string): Promise<SkillRecord | null>;
}

export function createWorkspace(options: WorkspaceOptions): WorkspaceBoundary {
  return {
    normalizePath(path: string) {
      return normalizeWorkspacePath(path);
    },
    async readFile(path: string) {
      const normalized = normalizeWorkspacePath(path);
      const builtin = getBuiltinSkillByPath(normalized);
      if (builtin) return builtin.content;
      const row = await getVfsEntry(options.db, normalized);
      return row?.content ?? null;
    },
    async writeFile(path: string, content: string, overwrite: boolean) {
      const normalized = normalizeWorkspacePath(path);
      if (normalized.startsWith("/skills/system/")) {
        return { ok: false as const, code: "VFS_READ_ONLY" as const };
      }
      if (normalized.startsWith("/skills/user/")) validateUserSkillWrite(normalized, content);
      const sizeBytes = new TextEncoder().encode(content).byteLength;
      if (sizeBytes > options.maxFileBytes) {
        return { ok: false as const, code: "VFS_LIMIT_EXCEEDED" as const };
      }
      const result = await putVfsEntry(options.db, {
        path: normalized,
        content,
        sizeBytes,
        sha256: await sha256Hex(content),
        nowIso: new Date().toISOString(),
        overwrite,
      });
      return result.ok
        ? { ok: true as const, path: normalized }
        : { ok: false as const, code: result.code };
    },
    async listFiles(prefix: string, limit: number) {
      const normalized = normalizeWorkspacePath(prefix || "/");
      const max = Math.max(1, limit);
      const rows = await listVfsEntries(options.db, normalized, max);
      const builtinPaths = listBuiltinSkills()
        .map((skill) => skill.path)
        .filter((path) => path.startsWith(normalized));
      return [...new Set([...builtinPaths, ...rows.map((row) => row.path)])].sort().slice(0, max);
    },
    async removeFile(path: string) {
      const normalized = normalizeWorkspacePath(path);
      if (normalized.startsWith("/skills/system/")) return false;
      return deleteVfsEntry(options.db, normalized, new Date().toISOString());
    },
    async getRevision() {
      return getVfsRevision(options.db);
    },
    async listSkills() {
      const builtin = listBuiltinSkills().map(({ name, description, scope }) => ({
        name,
        description,
        scope,
      }));
      const userRows = await listVfsEntries(options.db, "/skills/user/", 200);
      const userSkills = userRows
        .filter((row) => row.path.endsWith("/SKILL.md"))
        .map(parseUserSkillSummary)
        .filter((skill): skill is { name: string; description: string; scope: "user" } =>
          Boolean(skill),
        )
        .filter((skill) => !isSystemSkillName(skill.name));
      return [...builtin, ...userSkills].sort((a, b) => a.name.localeCompare(b.name));
    },
    async loadSkill(name: string) {
      const normalized = String(name ?? "").trim();
      if (!normalized) return null;
      const builtin = getBuiltinSkillByName(normalized);
      if (builtin) return builtin;
      const row = await getVfsEntry(options.db, `/skills/user/${normalized}/SKILL.md`);
      if (!row) return null;
      const parsed = parseSkillDocument(row.content);
      if (parsed.name !== normalized) {
        throw new Error(`SKILL_INVALID: name mismatch for ${normalized}`);
      }
      return {
        name: parsed.name,
        description: parsed.description,
        scope: "user",
        path: row.path,
        content: row.content,
      };
    },
  };
}

function parseUserSkillSummary(
  row: VfsEntryRecord,
): { name: string; description: string; scope: "user" } | null {
  try {
    const parsed = parseSkillDocument(row.content);
    return { name: parsed.name, description: parsed.description, scope: "user" };
  } catch {
    return null;
  }
}

function validateUserSkillWrite(path: string, content: string): void {
  if (!path.startsWith("/skills/user/")) return;
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 3 && parts[2] && isSystemSkillName(parts[2])) {
    throw new Error(`SKILL_RESERVED: ${parts[2]}`);
  }
  if (!path.endsWith("/SKILL.md")) return;
  const parsed = parseSkillDocument(content);
  const dirName = parts[2] ?? "";
  if (parsed.name !== dirName) {
    throw new Error(`SKILL_INVALID: name must match directory (${dirName})`);
  }
  if (isSystemSkillName(parsed.name)) throw new Error(`SKILL_RESERVED: ${parsed.name}`);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeWorkspacePath(rawPath: string): string {
  const input = String(rawPath ?? "").trim();
  if (!input) throw new Error("VFS_INVALID_PATH: path is required");
  const path = input.startsWith("vfs:/") ? input.slice(4) : input;
  if (!path.startsWith("/")) throw new Error("VFS_INVALID_PATH: path must be absolute");
  const normalized: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!normalized.length) throw new Error("VFS_INVALID_PATH: path traversal is not allowed");
      normalized.pop();
      continue;
    }
    if (part.includes("\\")) throw new Error("VFS_INVALID_PATH: invalid separator");
    normalized.push(part);
  }
  return `/${normalized.join("/")}`;
}
