import { describe, expect, it } from "vitest";
import { decodeEncryptionKey, decryptSecret, encryptSecret } from "../../src/crypto";

describe("crypto", () => {
  it("roundtrips encrypted secrets", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const keyBase64 = btoa(String.fromCharCode(...key));
    const parsedKey = decodeEncryptionKey(keyBase64);
    const encrypted = await encryptSecret("refresh-token-value", parsedKey);
    const decrypted = await decryptSecret(encrypted, parsedKey);
    expect(decrypted).toBe("refresh-token-value");
  });

  it("rejects invalid key length", () => {
    expect(() => decodeEncryptionKey("c2hvcnQ=")).toThrow("32 bytes");
  });

  it("fails decryption on tampered data", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const keyBase64 = btoa(String.fromCharCode(...key));
    const parsedKey = decodeEncryptionKey(keyBase64);
    const encrypted = await encryptSecret("refresh-token-value", parsedKey);
    const tampered = {
      ...encrypted,
      ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA`,
    };
    await expect(decryptSecret(tampered, parsedKey)).rejects.toThrow();
  });
});
