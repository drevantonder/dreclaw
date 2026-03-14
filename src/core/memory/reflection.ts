import {
  attachMemoryFactSource,
  listUnprocessedMemoryEpisodes,
  markMemoryEpisodesProcessed,
  upsertSimilarMemoryFact,
} from "./repo";
import { buildMemoryId } from "./ids";
import { extractFacts, scoreSalience } from "./salience";

export async function runMemoryReflection(params: {
  db: D1Database;
  chatId: number;
  limit: number;
  nowIso: string;
}): Promise<{ processedEpisodes: number; writtenFacts: number }> {
  const episodes = await listUnprocessedMemoryEpisodes(params.db, params.chatId, params.limit);
  if (!episodes.length) return { processedEpisodes: 0, writtenFacts: 0 };

  let writtenFacts = 0;
  for (const episode of episodes) {
    const salience = scoreSalience(episode.content);
    if (!salience.shouldStoreFact) continue;
    const extracted = extractFacts(episode.content);
    for (const fact of extracted) {
      const id = buildMemoryId("fact");
      const saved = await upsertSimilarMemoryFact(params.db, {
        id,
        chatId: params.chatId,
        kind: fact.kind,
        text: fact.text,
        confidence: fact.confidence,
        nowIso: params.nowIso,
      });
      await attachMemoryFactSource(params.db, saved.fact.id, episode.id, params.nowIso);
      if (saved.created) {
        writtenFacts += 1;
      }
    }
  }

  await markMemoryEpisodesProcessed(
    params.db,
    episodes.map((item) => item.id),
    params.nowIso,
  );
  return {
    processedEpisodes: episodes.length,
    writtenFacts,
  };
}
