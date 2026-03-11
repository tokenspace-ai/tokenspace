import { describe, expect, it } from "bun:test";
import {
  type CredentialCryptoContext,
  decryptCredentialPayload,
  decryptLegacyCredentialPayload,
  encryptCredentialPayload,
  encryptLegacyCredentialPayload,
  getMasterKey,
  type LegacyCredentialCryptoContext,
} from "../convex/credentialsCrypto";

const MASTER_KEY_SEED = "backend-unit-test-master-key-001";
const MASTER_KEY = Buffer.from(MASTER_KEY_SEED, "utf8").toString("base64");

async function withMasterKey<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.TOKENSPACE_CREDENTIAL_ENCRYPTION_KEY;
  process.env.TOKENSPACE_CREDENTIAL_ENCRYPTION_KEY = MASTER_KEY;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.TOKENSPACE_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.TOKENSPACE_CREDENTIAL_ENCRYPTION_KEY = previous;
    }
  }
}

const context: CredentialCryptoContext = {
  workspaceId: "workspace-1",
  credentialId: "my-secret",
  scope: "workspace",
  subject: "__workspace__",
  kind: "secret",
  keyVersion: 1,
};

const legacyContext: LegacyCredentialCryptoContext = {
  workspaceId: "workspace-1",
  reference: "[[my-secret]]",
  scope: "workspace",
  subject: "__workspace__",
  kind: "secret",
  keyVersion: 1,
};

describe("credentialsCrypto", () => {
  it("loads a valid 32-byte base64 master key", () => {
    return withMasterKey(() => {
      const key = getMasterKey();
      expect(key.byteLength).toBe(32);
    });
  });

  it("throws for invalid master key", () => {
    const previous = process.env.TOKENSPACE_CREDENTIAL_ENCRYPTION_KEY;
    process.env.TOKENSPACE_CREDENTIAL_ENCRYPTION_KEY = "not-base64";
    try {
      expect(() => getMasterKey()).toThrow();
    } finally {
      if (previous === undefined) {
        delete process.env.TOKENSPACE_CREDENTIAL_ENCRYPTION_KEY;
      } else {
        process.env.TOKENSPACE_CREDENTIAL_ENCRYPTION_KEY = previous;
      }
    }
  });

  it("encrypts and decrypts payloads", async () => {
    await withMasterKey(async () => {
      const encrypted = await encryptCredentialPayload({ value: "top-secret" }, context);
      expect(encrypted.ciphertext).toBeString();
      expect(encrypted.iv).toBeString();
      const decrypted = await decryptCredentialPayload<{ value: string }>(encrypted, context);
      expect(decrypted.value).toBe("top-secret");
    });
  });

  it("fails decryption when context does not match", async () => {
    await withMasterKey(async () => {
      const encrypted = await encryptCredentialPayload({ value: "top-secret" }, context);
      await expect(
        decryptCredentialPayload<{ value: string }>(encrypted, {
          ...context,
          subject: "someone-else",
        }),
      ).rejects.toThrow("Credential decryption failed");
    });
  });

  it("can migrate legacy reference-bound ciphertext to credentialId-bound ciphertext", async () => {
    await withMasterKey(async () => {
      const legacyEncrypted = await encryptLegacyCredentialPayload({ value: "top-secret" }, legacyContext);
      const decryptedLegacy = await decryptLegacyCredentialPayload<{ value: string }>(legacyEncrypted, legacyContext);
      const migratedEncrypted = await encryptCredentialPayload(decryptedLegacy, context);
      const decryptedNew = await decryptCredentialPayload<{ value: string }>(migratedEncrypted, context);

      expect(decryptedLegacy.value).toBe("top-secret");
      expect(decryptedNew.value).toBe("top-secret");
    });
  });
});
