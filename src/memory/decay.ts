export function applyTemporalDecay(
  score: number,
  updatedAtIso: string,
  now = Date.now(),
  halfLifeDays = 30,
): number {
  const updatedAt = Date.parse(updatedAtIso);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return score;
  const ageDays = Math.max(0, (now - updatedAt) / (1000 * 60 * 60 * 24));
  if (ageDays <= 0) return score;
  const factor = Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
  return score * factor;
}
