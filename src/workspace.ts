import { WORKSPACE_ROOT } from "./types";

interface WorkspaceState {
  files: Record<string, string>;
}

function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return `${WORKSPACE_ROOT}/`;
  const absolute = trimmed.startsWith("/") ? trimmed : `${WORKSPACE_ROOT}/${trimmed}`;
  const noDouble = absolute.replace(/\/{2,}/g, "/");
  return noDouble.startsWith(WORKSPACE_ROOT) ? noDouble : `${WORKSPACE_ROOT}/${noDouble.replace(/^\/+/, "")}`;
}

export class Workspace {
  private readonly key: string;
  private state: WorkspaceState = { files: {} };

  constructor(private readonly bucket: R2Bucket, private readonly sessionId: string) {
    this.key = `sessions/${sessionId}/workspace.json`;
  }

  async restore(): Promise<void> {
    const object = await this.bucket.get(this.key);
    if (!object) return;
    const json = await object.json<WorkspaceState>();
    this.state = json ?? { files: {} };
  }

  async checkpoint(): Promise<void> {
    await this.bucket.put(this.key, JSON.stringify(this.state), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  has(path: string): boolean {
    return this.state.files[normalizePath(path)] !== undefined;
  }

  read(path: string): string {
    const normalized = normalizePath(path);
    const value = this.state.files[normalized];
    if (value === undefined) throw new Error(`File not found: ${normalized}`);
    return value;
  }

  write(path: string, content: string): void {
    this.state.files[normalizePath(path)] = content;
  }

  edit(path: string, find: string, replace: string): string {
    const normalized = normalizePath(path);
    const current = this.read(normalized);
    if (!current.includes(find)) throw new Error(`Text not found in ${normalized}`);
    const updated = current.replace(find, replace);
    this.state.files[normalized] = updated;
    return updated;
  }

  list(prefix = WORKSPACE_ROOT): string[] {
    const normalized = normalizePath(prefix);
    return Object.keys(this.state.files).filter((path) => path.startsWith(normalized)).sort();
  }

  authReady(): boolean {
    return this.has(`${WORKSPACE_ROOT}/.pi-ai/auth.json`);
  }
}
