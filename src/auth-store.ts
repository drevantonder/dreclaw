import type { OAuthCredential } from "./oauth";

const AUTH_MAP_KEY = "provider-auth-map";

export type CredentialMap = Record<string, OAuthCredential>;

export async function loadCredentialMap(kv: KVNamespace): Promise<CredentialMap> {
  const raw = await kv.get(AUTH_MAP_KEY);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as CredentialMap;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

export async function saveCredentialMap(kv: KVNamespace, map: CredentialMap): Promise<void> {
  await kv.put(AUTH_MAP_KEY, JSON.stringify(map));
}

export async function upsertCredential(kv: KVNamespace, map: CredentialMap, credential: OAuthCredential): Promise<CredentialMap> {
  const next = { ...map, [credential.provider]: credential };
  await saveCredentialMap(kv, next);
  return next;
}
