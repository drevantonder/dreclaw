export interface SalienceResult {
  score: number;
  shouldStoreEpisode: boolean;
  shouldStoreFact: boolean;
}

export interface ExtractedFact {
  kind: "preference" | "fact" | "goal" | "identity";
  text: string;
  confidence: number;
}

const STORE_EPISODE_THRESHOLD = 0.3;
const STORE_FACT_THRESHOLD = 0.65;

export function scoreSalience(text: string): SalienceResult {
  const input = String(text ?? "").trim();
  if (!input) {
    return { score: 0, shouldStoreEpisode: false, shouldStoreFact: false };
  }
  const normalized = input.toLowerCase();
  let score = 0.1;

  if (/(remember|don't forget|do not forget)/i.test(input)) score += 0.45;
  if (/(my name is|call me|i am\s+[a-z])/i.test(input)) score += 0.4;
  if (/(i prefer|i like|i love|i hate|i dislike)/i.test(input)) score += 0.35;
  if (/(always|never|every time)/i.test(input)) score += 0.2;
  if (/(wrong|that is incorrect|you are incorrect|correction)/i.test(input)) score += 0.25;
  if (/(goal|plan|deadline|due|remind me)/i.test(input)) score += 0.2;

  if (normalized.length < 12) score -= 0.15;
  if (/^(ok|thanks|cool|nice|lol|yes|no)[!. ]*$/i.test(input)) score -= 0.25;

  const clamped = Math.max(0, Math.min(1, score));
  return {
    score: clamped,
    shouldStoreEpisode: clamped >= STORE_EPISODE_THRESHOLD,
    shouldStoreFact: clamped >= STORE_FACT_THRESHOLD,
  };
}

export function extractFacts(text: string): ExtractedFact[] {
  const input = String(text ?? "").trim();
  if (!input) return [];

  const facts: ExtractedFact[] = [];
  const push = (fact: ExtractedFact) => {
    if (!fact.text.trim()) return;
    if (
      !facts.some(
        (item) => item.kind === fact.kind && item.text.toLowerCase() === fact.text.toLowerCase(),
      )
    ) {
      facts.push(fact);
    }
  };

  const nameMatch = input.match(/\b(?:my name is|call me)\s+([a-z][a-z0-9 _.-]{1,40})/i);
  if (nameMatch) {
    push({
      kind: "identity",
      text: `User prefers to be called ${nameMatch[1].trim()}.`,
      confidence: 0.95,
    });
  }

  const preferenceMatch = input.match(/\b(i (?:prefer|like|love|hate|dislike)\b[^.?!]{0,180})/i);
  if (preferenceMatch) {
    push({
      kind: "preference",
      text: preferenceMatch[1].trim(),
      confidence: 0.85,
    });
  }

  const goalMatch = input.match(/\b(my goal is\b[^.?!]{0,220}|i want to\b[^.?!]{0,220})/i);
  if (goalMatch) {
    push({
      kind: "goal",
      text: goalMatch[1].trim(),
      confidence: 0.8,
    });
  }

  const rememberMatch = input.match(/\bremember\s+(that\s+)?([^.?!]{3,260})/i);
  if (rememberMatch) {
    push({
      kind: "fact",
      text: rememberMatch[2].trim(),
      confidence: 0.8,
    });
  }

  return facts;
}
