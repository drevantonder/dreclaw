import { VFS_ROOT } from "./types";

const LEGACY_ROOT = "/root/dreclaw";

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

export class R2FilesystemService {
  private readonly prefix: string;

  constructor(
    private readonly bucket: R2Bucket,
    sessionId: string,
  ) {
    this.prefix = `sessions/${sessionId}/fs`;
  }

  normalizePath(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return VFS_ROOT;

    const legacyRebased = trimmed === LEGACY_ROOT || trimmed.startsWith(`${LEGACY_ROOT}/`)
      ? `${VFS_ROOT}${trimmed.slice(LEGACY_ROOT.length)}`
      : trimmed;

    const absolute = legacyRebased.startsWith("/") ? legacyRebased : `${VFS_ROOT}/${legacyRebased}`;
    const normalized = absolute.replace(/\/{2,}/g, "/");
    if (normalized === VFS_ROOT) return normalized;
    if (normalized.startsWith(`${VFS_ROOT}/`)) return normalized;
    throw new Error(`Path escapes workspace root: ${trimmed}`);
  }

  async read(path: string): Promise<Uint8Array> {
    const normalized = this.normalizePath(path);
    const object = await this.bucket.get(this.keyFromPath(normalized));
    if (!object) throw new Error(`File not found: ${normalized}`);
    return new Uint8Array(await object.arrayBuffer());
  }

  async readText(path: string): Promise<string> {
    const normalized = this.normalizePath(path);
    const bytes = await this.read(normalized);
    try {
      return textDecoder.decode(bytes);
    } catch {
      throw new Error(`File is binary: ${normalized}`);
    }
  }

  async write(path: string, content: Uint8Array): Promise<void> {
    const normalized = this.normalizePath(path);
    await this.bucket.put(this.keyFromPath(normalized), content, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.write(path, textEncoder.encode(content));
  }

  async edit(path: string, find: string, replace: string): Promise<void> {
    const normalized = this.normalizePath(path);
    const current = await this.readText(normalized);
    if (!current.includes(find)) {
      throw new Error(`Text not found in ${normalized}`);
    }
    await this.writeText(normalized, current.replace(find, replace));
  }

  async list(prefix = VFS_ROOT): Promise<string[]> {
    const normalizedPrefix = this.normalizePath(prefix);
    const keyPrefix = this.keyPrefixFromPath(normalizedPrefix);
    const output: string[] = [];

    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix: keyPrefix, cursor });
      for (const object of page.objects) {
        const path = this.pathFromKey(object.key);
        if (path) output.push(path);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    return output.sort();
  }

  async replaceAll(files: Record<string, Uint8Array>): Promise<void> {
    const wantedPaths = new Set(Object.keys(files).map((path) => this.normalizePath(path)));
    const existingPaths = await this.list(VFS_ROOT);

    const deletes: string[] = [];
    for (const existingPath of existingPaths) {
      if (!wantedPaths.has(existingPath)) {
        deletes.push(this.keyFromPath(existingPath));
      }
    }
    if (deletes.length) await this.bucket.delete(deletes);

    const writes = Object.entries(files).map(async ([path, content]) => {
      const normalized = this.normalizePath(path);
      await this.bucket.put(this.keyFromPath(normalized), content, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
    });
    await Promise.all(writes);
  }

  private keyFromPath(path: string): string {
    const relative = path === VFS_ROOT ? "" : path.slice(VFS_ROOT.length).replace(/^\/+/, "");
    return relative ? `${this.prefix}/${relative}` : `${this.prefix}/.root`;
  }

  private keyPrefixFromPath(path: string): string {
    const relative = path === VFS_ROOT ? "" : path.slice(VFS_ROOT.length).replace(/^\/+/, "");
    return relative ? `${this.prefix}/${relative}` : `${this.prefix}/`;
  }

  private pathFromKey(key: string): string | null {
    if (!key.startsWith(`${this.prefix}/`)) return null;
    const relative = key.slice(this.prefix.length + 1);
    if (!relative || relative === ".root") return null;
    return this.normalizePath(`${VFS_ROOT}/${relative}`);
  }
}
