export function buildMemoryId(prefix: "episode" | "fact"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
