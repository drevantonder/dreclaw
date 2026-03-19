import {
  FileSystemStateBackend,
  Workspace,
  type FileInfo,
  type FileSystem,
  type FsStat,
} from "@cloudflare/shell";
import { listVfsEntries } from "../../vfs/repo";
import {
  getBuiltinSkillByName,
  isSystemSkillName,
  listBuiltinSkills,
  parseSkillDocument,
  type SkillRecord,
} from "../../skills";

const WORKSPACE_NAMESPACE = "dreclaw";
const LEGACY_MIGRATION_MARKER = "/.dreclaw/migrations/legacy-vfs-imported.json";

export interface WorkspaceGateway {
  listSkills(): Promise<Array<Pick<SkillRecord, "name" | "description" | "scope">>>;
  getLoadedSkills(names: string[]): Promise<SkillRecord[]>;
  createStateBackend(writes?: string[]): FileSystemStateBackend;
  factoryReset(): Promise<void>;
}

type WorkspaceDirent = {
  name: string;
  type: "file" | "directory" | "symlink";
};

export function createWorkspaceGateway(params: {
  db: D1Database;
  maxFileBytes: number;
  maxPathLength: number;
}): WorkspaceGateway {
  const workspace = new Workspace(
    createD1WorkspaceHost(params.db, `dreclaw-${WORKSPACE_NAMESPACE}`),
    {
      namespace: WORKSPACE_NAMESPACE,
    },
  );
  let readyPromise: Promise<void> | undefined;
  let skillCatalogCache:
    | {
        key: string;
        skills: Array<Pick<SkillRecord, "name" | "description" | "scope">>;
      }
    | undefined;
  const loadedSkillCache = new Map<string, { key: string; skill: SkillRecord | null }>();

  const ensureReady = async () => {
    if (!readyPromise) {
      readyPromise = (async () => {
        await ensureBuiltinSkills(workspace);
        await migrateLegacyVfs(params.db, workspace);
        await ensureBuiltinSkills(workspace);
      })();
    }
    await readyPromise;
  };

  const getSkillCacheKey = async () => {
    await ensureReady();
    const userSkillFiles = await workspace.glob("/skills/user/*/SKILL.md");
    return userSkillFiles
      .map((file) => `${file.path}:${file.updatedAt}`)
      .sort()
      .join("|");
  };

  return {
    async listSkills() {
      const key = await getSkillCacheKey();
      if (skillCatalogCache?.key === key) return skillCatalogCache.skills;
      const builtin = listBuiltinSkills().map(({ name, description, scope }) => ({
        name,
        description,
        scope,
      }));
      const userSkillFiles = await workspace.glob("/skills/user/*/SKILL.md");
      const userSkills = (
        await Promise.all(
          userSkillFiles.map(async (file) => {
            const content = await workspace.readFile(file.path);
            if (!content) return null;
            try {
              const parsed = parseSkillDocument(content);
              if (isSystemSkillName(parsed.name)) return null;
              return {
                name: parsed.name,
                description: parsed.description,
                scope: "user" as const,
              };
            } catch {
              return null;
            }
          }),
        )
      ).filter((skill): skill is { name: string; description: string; scope: "user" } =>
        Boolean(skill),
      );
      const skills = [...builtin, ...userSkills].sort((a, b) => a.name.localeCompare(b.name));
      skillCatalogCache = { key, skills };
      return skills;
    },

    async getLoadedSkills(names: string[]) {
      const key = await getSkillCacheKey();
      const loaded: SkillRecord[] = [];
      for (const name of names) {
        const cached = loadedSkillCache.get(name);
        const skill = cached?.key === key ? cached.skill : await loadSkill(workspace, name);
        if (cached?.key !== key) loadedSkillCache.set(name, { key, skill });
        if (skill) loaded.push(skill);
      }
      return loaded;
    },

    createStateBackend(writes = []) {
      const fs = new PolicyWorkspaceFileSystem({
        workspace,
        ensureReady,
        writes,
        maxFileBytes: params.maxFileBytes,
        maxPathLength: params.maxPathLength,
      });
      return new FileSystemStateBackend(fs);
    },

    async factoryReset() {
      await ensureReady();
      const entries = await workspace.readDir("/", { limit: 1000 });
      for (const entry of entries) {
        if (entry.path.startsWith("/skills/system/")) continue;
        await workspace.rm(entry.path, { recursive: true, force: true });
      }
      await ensureBuiltinSkills(workspace);
    },
  };
}

class PolicyWorkspaceFileSystem implements FileSystem {
  constructor(
    private readonly params: {
      workspace: Workspace;
      ensureReady: () => Promise<void>;
      writes: string[];
      maxFileBytes: number;
      maxPathLength: number;
    },
  ) {}

  async readFile(path: string): Promise<string> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    const content = await this.params.workspace.readFile(normalized);
    if (content === null) throw new Error(`ENOENT: no such file or directory: ${normalized}`);
    return content;
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    const bytes = await this.params.workspace.readFileBytes(normalized);
    if (bytes === null) throw new Error(`ENOENT: no such file or directory: ${normalized}`);
    return bytes;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    assertWritablePath(normalized, content);
    assertFileSize(new TextEncoder().encode(content).byteLength, this.params.maxFileBytes);
    await this.params.workspace.writeFile(normalized, content);
    this.params.writes.push(`write ${normalized}`);
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    assertWritablePath(normalized);
    assertFileSize(content.byteLength, this.params.maxFileBytes);
    await this.params.workspace.writeFileBytes(normalized, content);
    this.params.writes.push(`write ${normalized}`);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    assertWritablePath(normalized, typeof content === "string" ? content : undefined);
    const existing = (await this.params.workspace.readFileBytes(normalized)) ?? new Uint8Array();
    const next =
      typeof content === "string"
        ? new TextEncoder().encode(new TextDecoder().decode(existing) + content)
        : concatBytes(existing, content);
    assertFileSize(next.byteLength, this.params.maxFileBytes);
    await this.params.workspace.writeFileBytes(normalized, next);
    this.params.writes.push(`write ${normalized}`);
  }

  async exists(path: string): Promise<boolean> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    return this.params.workspace.exists(normalized);
  }

  async stat(path: string): Promise<FsStat> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    const stat = await this.params.workspace.stat(normalized);
    if (!stat) throw new Error(`ENOENT: no such file or directory: ${normalized}`);
    return toFsStat(stat);
  }

  async lstat(path: string): Promise<FsStat> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    const stat = await this.params.workspace.lstat(normalized);
    if (!stat) throw new Error(`ENOENT: no such file or directory: ${normalized}`);
    return toFsStat(stat);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    assertWritablePath(normalized);
    await this.params.workspace.mkdir(normalized, options);
  }

  async readdir(path: string): Promise<string[]> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    return (await this.params.workspace.readDir(normalized)).map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<WorkspaceDirent[]> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    return (await this.params.workspace.readDir(normalized)).map((entry) => ({
      name: entry.name,
      type: entry.type,
    }));
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    assertMutableTarget(normalized);
    await this.params.workspace.rm(normalized, options);
    this.params.writes.push(`remove ${normalized}`);
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    await this.params.ensureReady();
    const normalizedSrc = normalizeWorkspacePath(src, this.params.maxPathLength);
    const normalizedDest = normalizeWorkspacePath(dest, this.params.maxPathLength);
    assertWritablePath(normalizedDest);
    await this.params.workspace.cp(normalizedSrc, normalizedDest, options);
    this.params.writes.push(`copy ${normalizedSrc} -> ${normalizedDest}`);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.params.ensureReady();
    const normalizedSrc = normalizeWorkspacePath(src, this.params.maxPathLength);
    const normalizedDest = normalizeWorkspacePath(dest, this.params.maxPathLength);
    assertMutableTarget(normalizedSrc);
    assertWritablePath(normalizedDest);
    await this.params.workspace.mv(normalizedSrc, normalizedDest);
    this.params.writes.push(`move ${normalizedSrc} -> ${normalizedDest}`);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.params.ensureReady();
    const normalizedLinkPath = normalizeWorkspacePath(linkPath, this.params.maxPathLength);
    assertWritablePath(normalizedLinkPath);
    await this.params.workspace.symlink(target, normalizedLinkPath);
    this.params.writes.push(`write ${normalizedLinkPath}`);
  }

  async readlink(path: string): Promise<string> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    return this.params.workspace.readlink(normalized);
  }

  async realpath(path: string): Promise<string> {
    await this.params.ensureReady();
    const normalized = normalizeWorkspacePath(path, this.params.maxPathLength);
    const stat = await this.params.workspace.lstat(normalized);
    if (!stat) throw new Error(`ENOENT: no such file or directory: ${normalized}`);
    if (stat.type !== "symlink") return normalized;
    const target = await this.params.workspace.readlink(normalized);
    const resolved = target.startsWith("/")
      ? target
      : normalizeWorkspacePath(dirname(normalized) + "/" + target, this.params.maxPathLength);
    return this.realpath(resolved);
  }

  resolvePath(base: string, path: string): string {
    const basePath = normalizeWorkspacePath(base, this.params.maxPathLength);
    return normalizeWorkspacePath(
      path.startsWith("/") ? path : `${basePath}/${path}`,
      this.params.maxPathLength,
    );
  }

  async glob(pattern: string): Promise<string[]> {
    await this.params.ensureReady();
    const normalizedPattern = String(pattern ?? "").trim() || "/";
    return (await this.params.workspace.glob(normalizedPattern)).map((entry) => entry.path);
  }
}

async function loadSkill(workspace: Workspace, name: string): Promise<SkillRecord | null> {
  const normalized = String(name ?? "").trim();
  if (!normalized) return null;
  const builtin = getBuiltinSkillByName(normalized);
  if (builtin) return builtin;
  const content = await workspace.readFile(`/skills/user/${normalized}/SKILL.md`);
  if (!content) return null;
  const parsed = parseSkillDocument(content);
  if (parsed.name !== normalized) throw new Error(`SKILL_INVALID: name mismatch for ${normalized}`);
  return {
    name: parsed.name,
    description: parsed.description,
    scope: "user",
    path: `/skills/user/${normalized}/SKILL.md`,
    content,
  };
}

async function ensureBuiltinSkills(workspace: Workspace): Promise<void> {
  for (const skill of listBuiltinSkills()) {
    const parent = dirname(skill.path);
    if (parent !== "/") await workspace.mkdir(parent, { recursive: true });
    const current = await workspace.readFile(skill.path);
    if (current !== skill.content) await workspace.writeFile(skill.path, skill.content);
  }
}

async function migrateLegacyVfs(db: D1Database, workspace: Workspace): Promise<void> {
  if (await workspace.readFile(LEGACY_MIGRATION_MARKER)) return;
  const rows = await listVfsEntries(db, "/", 10_000);
  for (const row of rows) {
    if (row.path === LEGACY_MIGRATION_MARKER) continue;
    if (row.path.startsWith("/skills/system/")) continue;
    const parent = dirname(row.path);
    if (parent !== "/") await workspace.mkdir(parent, { recursive: true });
    await workspace.writeFile(row.path, row.content);
  }
  const parent = dirname(LEGACY_MIGRATION_MARKER);
  if (parent !== "/") await workspace.mkdir(parent, { recursive: true });
  await workspace.writeFile(
    LEGACY_MIGRATION_MARKER,
    JSON.stringify({
      migratedAt: new Date().toISOString(),
      files: rows.filter((row) => !row.path.startsWith("/skills/system/")).length,
    }),
  );
}

function createD1WorkspaceHost(db: D1Database, name: string) {
  return {
    name,
    async sqlQuery<T = Record<string, string | number | boolean | null>>(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ): Promise<T[]> {
      const { sql, args } = toSql(strings, values);
      const result = await db
        .prepare(sql)
        .bind(...args)
        .all<T>();
      return result.results ?? [];
    },
    async sqlRun(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ): Promise<void> {
      const { sql, args } = toSql(strings, values);
      await db
        .prepare(sql)
        .bind(...args)
        .run();
    },
  };
}

function toSql(
  strings: TemplateStringsArray,
  values: (string | number | boolean | null)[],
): { sql: string; args: (string | number | boolean | null)[] } {
  let sql = "";
  for (let index = 0; index < strings.length; index += 1) {
    sql += strings[index] ?? "";
    if (index < values.length) sql += "?";
  }
  return { sql, args: values };
}

function assertWritablePath(path: string, content?: string): void {
  if (path.startsWith("/skills/system/")) {
    throw new Error(`EACCES: ${path} is read-only`);
  }
  if (path.startsWith("/skills/user/") && typeof content === "string") {
    validateUserSkillWrite(path, content);
  }
}

function assertMutableTarget(path: string): void {
  if (path.startsWith("/skills/system/")) {
    throw new Error(`EACCES: ${path} is read-only`);
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

function assertFileSize(sizeBytes: number, maxFileBytes: number): void {
  if (sizeBytes > maxFileBytes) {
    throw new Error(`EFBIG: file exceeds max size (${maxFileBytes} bytes)`);
  }
}

function normalizeWorkspacePath(rawPath: string, maxPathLength: number): string {
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
  const result = `/${normalized.join("/")}`;
  if (result.length > maxPathLength) {
    throw new Error(`VFS_INVALID_PATH: path exceeds ${maxPathLength} chars`);
  }
  return result;
}

function dirname(path: string): string {
  const normalized = path === "/" ? "/" : path.replace(/\/+$/, "");
  if (normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : normalized.slice(0, lastSlash);
}

function toFsStat(stat: FileInfo): FsStat {
  return {
    type: stat.type as FsStat["type"],
    size: stat.size,
    mtime: new Date(stat.updatedAt),
  };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
}
