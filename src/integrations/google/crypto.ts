export interface EncryptedSecret {
  ciphertext: string;
  nonce: string;
}

const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_KEY_BYTES = 32;

export function decodeEncryptionKey(raw: string): Uint8Array {
  const value = String(raw ?? "").trim();
  if (!value) {
    throw new Error("GOOGLE_OAUTH_ENCRYPTION_KEY is required");
  }
  const bytes = base64ToBytes(value);
  if (bytes.byteLength !== AES_GCM_KEY_BYTES) {
    throw new Error("GOOGLE_OAUTH_ENCRYPTION_KEY must decode to 32 bytes");
  }
  return bytes;
}

export async function encryptSecret(
  plaintext: string,
  keyBytes: Uint8Array,
): Promise<EncryptedSecret> {
  const plain = String(plaintext ?? "");
  if (!plain) {
    throw new Error("plaintext is required");
  }
  const key = await importAesKey(keyBytes, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const encoded = new TextEncoder().encode(plain);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toOwnedBytes(nonce) },
    key,
    toOwnedBytes(encoded),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    nonce: bytesToBase64(nonce),
  };
}

export async function decryptSecret(
  payload: EncryptedSecret,
  keyBytes: Uint8Array,
): Promise<string> {
  const key = await importAesKey(keyBytes, ["decrypt"]);
  const nonce = base64ToBytes(payload.nonce);
  if (nonce.byteLength !== AES_GCM_NONCE_BYTES) {
    throw new Error("nonce must decode to 12 bytes");
  }
  const ciphertext = base64ToBytes(payload.ciphertext);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toOwnedBytes(nonce) },
    key,
    toOwnedBytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

async function importAesKey(keyBytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (keyBytes.byteLength !== AES_GCM_KEY_BYTES) {
    throw new Error("encryption key must be 32 bytes");
  }
  return crypto.subtle.importKey(
    "raw",
    toOwnedBytes(keyBytes),
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function toOwnedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
