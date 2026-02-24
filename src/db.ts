import { retryOnce } from "./retry";

export async function markUpdateSeen(db: D1Database, updateId: number): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare("INSERT OR IGNORE INTO telegram_updates (update_id, received_at) VALUES (?, ?)")
      .bind(updateId, new Date().toISOString())
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}
