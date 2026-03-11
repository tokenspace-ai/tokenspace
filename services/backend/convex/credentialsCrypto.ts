const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const HKDF_SALT = textEncoder.encode("tokenspace:credentials:hkdf-salt:v1");
const CREDENTIAL_KEY_VERSION = 1;

type CredentialScope = "workspace" | "session" | "user";
type StoredCredentialKind = "secret" | "oauth";

export type CredentialCryptoContext = {
  workspaceId: string;
  credentialId: string;
  scope: CredentialScope;
  subject: string;
  kind: StoredCredentialKind;
  keyVersion: number;
};

export type LegacyCredentialCryptoContext = {
  workspaceId: string;
  reference: string;
  scope: CredentialScope;
  subject: string;
  kind: StoredCredentialKind;
  keyVersion: number;
};

export type CredentialCipherEnvelope = {
  keyVersion: number;
  iv: string;
  ciphertext: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toOwnedBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function deriveInfo(
  bindingKey: "credentialId" | "reference",
  bindingValue: string,
  context: Omit<CredentialCryptoContext, "credentialId">,
): Uint8Array {
  const info = [
    "tokenspace:credentials:v1",
    `workspace:${context.workspaceId}`,
    `${bindingKey}:${bindingValue}`,
    `scope:${context.scope}`,
    `subject:${context.subject}`,
    `kind:${context.kind}`,
    `keyVersion:${context.keyVersion}`,
  ].join("|");
  return textEncoder.encode(info);
}

export function getCurrentCredentialKeyVersion(): number {
  return CREDENTIAL_KEY_VERSION;
}

export function getMasterKey(): Uint8Array {
  const encoded = process.env.TOKENSPACE_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!encoded) {
    throw new Error("Server misconfigured: TOKENSPACE_CREDENTIAL_ENCRYPTION_KEY is not set");
  }

  let decoded: Uint8Array;
  try {
    decoded = base64ToBytes(encoded);
  } catch {
    throw new Error("Server misconfigured: TOKENSPACE_CREDENTIAL_ENCRYPTION_KEY must be valid base64");
  }

  if (decoded.byteLength !== 32) {
    throw new Error("Server misconfigured: TOKENSPACE_CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes");
  }

  return decoded;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, toArrayBuffer(data));
  return toOwnedBytes(new Uint8Array(signature));
}

async function hkdfSha256(args: {
  ikm: Uint8Array;
  salt: Uint8Array;
  info: Uint8Array;
  length: number;
}): Promise<Uint8Array> {
  const prk = await hmacSha256(args.salt, args.ikm);
  const blocks: Uint8Array[] = [];
  let previous: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let counter = 1;

  while (blocks.reduce((sum, block) => sum + block.byteLength, 0) < args.length) {
    const input = concatBytes(previous, args.info, Uint8Array.from([counter]));
    const block = toOwnedBytes(await hmacSha256(prk, input));
    blocks.push(block);
    previous = block;
    counter += 1;
  }

  return concatBytes(...blocks).slice(0, args.length);
}

export async function deriveRecordKey(context: CredentialCryptoContext): Promise<Uint8Array> {
  const masterKey = getMasterKey();
  return await hkdfSha256({
    ikm: masterKey,
    salt: HKDF_SALT,
    info: deriveInfo("credentialId", context.credentialId, context),
    length: 32,
  });
}

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

function deriveAad(context: CredentialCryptoContext): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      workspaceId: context.workspaceId,
      credentialId: context.credentialId,
      scope: context.scope,
      subject: context.subject,
      kind: context.kind,
      keyVersion: context.keyVersion,
    }),
  );
}

function deriveLegacyAad(context: LegacyCredentialCryptoContext): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      workspaceId: context.workspaceId,
      reference: context.reference,
      scope: context.scope,
      subject: context.subject,
      kind: context.kind,
      keyVersion: context.keyVersion,
    }),
  );
}

async function deriveLegacyRecordKey(context: LegacyCredentialCryptoContext): Promise<Uint8Array> {
  const masterKey = getMasterKey();
  return await hkdfSha256({
    ikm: masterKey,
    salt: HKDF_SALT,
    info: deriveInfo("reference", context.reference, context),
    length: 32,
  });
}

export async function encryptCredentialPayload(
  payload: unknown,
  context: CredentialCryptoContext,
): Promise<CredentialCipherEnvelope> {
  const keyBytes = await deriveRecordKey(context);
  const key = await importAesKey(keyBytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(payload));

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(deriveAad(context)),
    },
    key,
    toArrayBuffer(plaintext),
  );

  return {
    keyVersion: context.keyVersion,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function encryptLegacyCredentialPayload(
  payload: unknown,
  context: LegacyCredentialCryptoContext,
): Promise<CredentialCipherEnvelope> {
  const keyBytes = await deriveLegacyRecordKey(context);
  const key = await importAesKey(keyBytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(payload));

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(deriveLegacyAad(context)),
    },
    key,
    toArrayBuffer(plaintext),
  );

  return {
    keyVersion: context.keyVersion,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptCredentialPayload<T>(
  envelope: CredentialCipherEnvelope,
  context: CredentialCryptoContext,
): Promise<T> {
  if (envelope.keyVersion !== context.keyVersion) {
    throw new Error("Credential key version mismatch");
  }

  const keyBytes = await deriveRecordKey(context);
  const key = await importAesKey(keyBytes);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(deriveAad(context)),
      },
      key,
      toArrayBuffer(ciphertext),
    );

    return JSON.parse(textDecoder.decode(new Uint8Array(plaintext))) as T;
  } catch {
    throw new Error("Credential decryption failed");
  }
}

export async function decryptLegacyCredentialPayload<T>(
  envelope: CredentialCipherEnvelope,
  context: LegacyCredentialCryptoContext,
): Promise<T> {
  if (envelope.keyVersion !== context.keyVersion) {
    throw new Error("Credential key version mismatch");
  }

  const keyBytes = await deriveLegacyRecordKey(context);
  const key = await importAesKey(keyBytes);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(deriveLegacyAad(context)),
      },
      key,
      toArrayBuffer(ciphertext),
    );

    return JSON.parse(textDecoder.decode(new Uint8Array(plaintext))) as T;
  } catch {
    throw new Error("Credential decryption failed");
  }
}
