import { createWorkspace, type WorkspaceBoundary, type WorkspaceWriteResult } from "../../vfs";
import type { SkillRecord } from "../../skills";

export interface WorkspaceGateway {
  getWorkspace(): WorkspaceBoundary;
  listSkills(): Promise<Array<Pick<SkillRecord, "name" | "description" | "scope">>>;
  getLoadedSkills(names: string[]): Promise<SkillRecord[]>;
  writeFile(
    path: string,
    content: string,
    overwrite: boolean,
    writes?: string[],
  ): Promise<WorkspaceWriteResult>;
  deleteFile(path: string, writes?: string[]): Promise<boolean>;
  createVfsAdapter(writes: string[]): {
    readFile(path: string): Promise<string | null>;
    writeFile(path: string, content: string, overwrite: boolean): Promise<WorkspaceWriteResult>;
    listFiles(prefix: string, limit: number): Promise<string[]>;
    removeFile(path: string): Promise<boolean>;
    revision(): Promise<number>;
  };
}

export function createWorkspaceGateway(params: {
  db: D1Database;
  maxFileBytes: number;
}): WorkspaceGateway {
  let workspace: WorkspaceBoundary | undefined;
  let skillCatalogCache:
    | {
        revision: number;
        skills: Array<Pick<SkillRecord, "name" | "description" | "scope">>;
      }
    | undefined;
  const loadedSkillCache = new Map<string, { revision: number; skill: SkillRecord | null }>();

  const getWorkspace = () => {
    if (!workspace) {
      workspace = createWorkspace({
        db: params.db,
        maxFileBytes: params.maxFileBytes,
      });
    }
    return workspace;
  };

  const listSkills = async () => {
    const currentWorkspace = getWorkspace();
    const revision = await currentWorkspace.getRevision();
    if (skillCatalogCache?.revision === revision) return skillCatalogCache.skills;
    const skills = await currentWorkspace.listSkills();
    skillCatalogCache = { revision, skills };
    return skills;
  };

  const getLoadedSkills = async (names: string[]) => {
    const loaded: SkillRecord[] = [];
    const currentWorkspace = getWorkspace();
    const revision = await currentWorkspace.getRevision();
    for (const name of names) {
      const cached = loadedSkillCache.get(name);
      const skill =
        cached?.revision === revision ? cached.skill : await currentWorkspace.loadSkill(name);
      if (cached?.revision !== revision) loadedSkillCache.set(name, { revision, skill });
      if (skill) loaded.push(skill);
    }
    return loaded;
  };

  const writeFile = async (
    path: string,
    content: string,
    overwrite: boolean,
    writes?: string[],
  ) => {
    const currentWorkspace = getWorkspace();
    const normalized = currentWorkspace.normalizePath(path);
    writes?.push(`write ${normalized}`);
    return currentWorkspace.writeFile(normalized, content, overwrite);
  };

  const deleteFile = async (path: string, writes?: string[]) => {
    const currentWorkspace = getWorkspace();
    const normalized = currentWorkspace.normalizePath(path);
    writes?.push(`remove ${normalized}`);
    return currentWorkspace.removeFile(normalized);
  };

  return {
    getWorkspace,
    listSkills,
    getLoadedSkills,
    writeFile,
    deleteFile,
    createVfsAdapter(writes: string[]) {
      const currentWorkspace = getWorkspace();
      return {
        readFile: async (path: string) => currentWorkspace.readFile(path),
        writeFile: async (path: string, content: string, overwrite: boolean) =>
          writeFile(path, content, overwrite, writes),
        listFiles: async (prefix: string, limit: number) =>
          currentWorkspace.listFiles(prefix, limit),
        removeFile: async (path: string) => deleteFile(path, writes),
        revision: async () => currentWorkspace.getRevision(),
      };
    },
  };
}
