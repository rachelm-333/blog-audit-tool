/**
 * Script: find-wix-post.mjs
 * Searches Wix API for a post by title and prints its current ID.
 * Usage: npx tsx scripts/find-wix-post.mjs
 */
import { createDecipheriv, pbkdf2Sync } from "crypto";
import mysql from "mysql2/promise";
import "dotenv/config";

// Decrypt credentials using the same logic as encryption.service.ts
function decryptCredentials(encryptedBase64) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not set");
  const key = pbkdf2Sync(secret, "iaudit-cms-credentials-v1", 100_000, 32, "sha256");
  const payload = Buffer.from(encryptedBase64, "base64").toString("utf8");
  const parts = payload.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted credentials format");
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get the Wix connection for the business
const [conns] = await conn.execute(
  "SELECT id, platform, site_url, credentials_encrypted FROM cms_connections WHERE platform = 'wix' LIMIT 1"
);

if (!conns.length) {
  console.log("No Wix connection found");
  await conn.end();
  process.exit(1);
}

const wixConn = conns[0];
console.log("Wix site URL:", wixConn.site_url);

const creds = decryptCredentials(wixConn.credentials_encrypted);
console.log("Credentials decrypted. API key starts with:", creds.apiKey?.substring(0, 10) + "...");
console.log("Site ID:", creds.siteId);

// Search Wix API for the post by title
const searchRes = await fetch("https://www.wixapis.com/v3/posts/query", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${creds.apiKey}`,
    "wix-site-id": creds.siteId,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    fieldsets: ["SEO"],
    filter: { title: { $contains: "Blog Post Template" } },
    paging: { limit: 10 },
  }),
});

console.log("Search response status:", searchRes.status);
const searchBody = await searchRes.json();
console.log("Posts found:", searchBody.posts?.length ?? 0);

if (searchBody.posts?.length) {
  for (const p of searchBody.posts) {
    console.log(`  ID: ${p.id} | Title: ${p.title} | Status: ${p.status}`);
  }
}

// Also try fetching the stored ID directly
const directRes = await fetch(`https://www.wixapis.com/v3/posts/b1f35234-45c9-4729-ab4b-e461c393b06a`, {
  headers: {
    "Authorization": `Bearer ${creds.apiKey}`,
    "wix-site-id": creds.siteId,
  },
});
console.log("\nDirect fetch of stored ID b1f35234... status:", directRes.status);
if (!directRes.ok) {
  const body = await directRes.json().catch(() => ({}));
  console.log("Error body:", JSON.stringify(body));
}

await conn.end();
