/**
 * AES-256-GCM encryption service for CMS credentials at rest.
 *
 * CRITICAL RULE: CMS credentials (Application Passwords, API keys, etc.) must
 * NEVER be stored as plain text. Every credential object is encrypted before
 * writing to `cms_connections.credentials_encrypted` and decrypted only when
 * needed for an active API call.
 *
 * Key derivation: PBKDF2-SHA256 from JWT_SECRET + a fixed salt.
 * Cipher: AES-256-GCM (authenticated encryption — detects tampering).
 * Output format: base64("iv:authTag:ciphertext") — all parts hex-encoded.
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "crypto";

// ─── Key derivation ───────────────────────────────────────────────────────────
// Derive a 32-byte AES key from the JWT_SECRET so we don't need a separate env var.
// The salt is fixed (not secret) — its purpose is domain separation only.
const ENCRYPTION_SALT = "iaudit-cms-credentials-v1";
const ENCRYPTION_ITERATIONS = 100_000;

function getDerivedKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("[Encryption] JWT_SECRET is not set — cannot derive encryption key");
  }
  return pbkdf2Sync(secret, ENCRYPTION_SALT, ENCRYPTION_ITERATIONS, 32, "sha256");
}

// ─── Encrypt ─────────────────────────────────────────────────────────────────
/**
 * Encrypts a credentials object to a base64 string.
 * The result is safe to store in the `credentials_encrypted` JSONB column.
 */
export function encryptCredentials(credentials: Record<string, string>): string {
  const key = getDerivedKey();
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const plaintext = JSON.stringify(credentials);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: hex(iv) + ":" + hex(authTag) + ":" + hex(ciphertext)
  const payload = `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
  return Buffer.from(payload).toString("base64");
}

// ─── Decrypt ─────────────────────────────────────────────────────────────────
/**
 * Decrypts a base64-encoded credentials string back to the original object.
 * Throws if the ciphertext has been tampered with (GCM auth tag mismatch).
 */
export function decryptCredentials(encryptedBase64: string): Record<string, string> {
  const key = getDerivedKey();
  const payload = Buffer.from(encryptedBase64, "base64").toString("utf8");
  const parts = payload.split(":");

  if (parts.length !== 3) {
    throw new Error("[Encryption] Invalid encrypted credentials format");
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex!, "hex");
  const authTag = Buffer.from(authTagHex!, "hex");
  const ciphertext = Buffer.from(ciphertextHex!, "hex");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as Record<string, string>;
}

// ─── Type helpers ─────────────────────────────────────────────────────────────
export interface WordPressCredentials {
  siteUrl: string;
  username: string;
  applicationPassword: string;
}

export interface WixCredentials {
  siteId: string;
  apiKey: string;
}

export interface ShopifyCredentials {
  shop: string; // e.g. "mystore.myshopify.com"
  accessToken: string;
}

export interface ZapierCredentials {
  webhookSecret: string; // iAudit-generated secret for inbound webhook auth
  outboundWebhookUrl?: string; // User-configured URL for post-back
}

export interface WebflowCredentials {
  apiKey: string;       // Webflow API key (Account Settings → API Access)
  collectionId: string; // CMS Collection ID for blog posts
}

export type CmsCredentials =
  | WordPressCredentials
  | WixCredentials
  | ShopifyCredentials
  | WebflowCredentials
  | ZapierCredentials;
