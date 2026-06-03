/**
 * iAudit — Zapier Inbound Webhook Handler (Layer 13 / Section 16.4)
 *
 * Route: POST /api/zapier/inbound/:token
 *
 * The token is the zapierInboundToken stored in the connection's encrypted credentials.
 * iAudit looks up the connection by token, validates the payload, and upserts the post.
 *
 * Response:
 *   200 { received: true, postId: string } on success
 *   400 { error: "invalid_payload" } if id or title missing
 *   401 { error: "invalid_token" } if token not found
 *   500 { error: "internal_error" } on unexpected failure
 */

import type { Request, Response } from "express";
import { getDb } from "./db";
import { cmsConnections } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { decryptConnectionCredentials, upsertPost } from "./cms.db";
import { mapZapierPayloadToPost } from "./zapier.service";
import type { ZapierInboundPayload } from "./zapier.service";
import type { ZapierCredentials } from "./encryption.service";

export async function handleZapierInbound(req: Request, res: Response): Promise<void> {
  const { token } = req.params as { token: string };

  if (!token) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  try {
    // 1. Find connection by token — scan all Zapier connections
    //    (token is unique per connection, stored in encrypted credentials)
    const db = await getDb();
    if (!db) { res.status(500).json({ error: "internal_error" }); return; }

    const zapierConnections = await db
      .select()
      .from(cmsConnections)
      .where(eq(cmsConnections.platform, "zapier"));

    let matchedConnection: typeof zapierConnections[0] | null = null;
    let matchedCreds: ZapierCredentials | null = null;

    for (const conn of zapierConnections) {
      try {
        const creds = decryptConnectionCredentials(conn) as unknown as ZapierCredentials;
        if (creds.webhookSecret === token) {
          matchedConnection = conn;
          matchedCreds = creds;
          break;
        }
      } catch {
        // Skip connections with decryption errors
      }
    }

    if (!matchedConnection || !matchedCreds) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }

    // 2. Validate and map payload
    const payload = req.body as ZapierInboundPayload;
    const post = mapZapierPayloadToPost(payload);

    if (!post) {
      res.status(400).json({ error: "invalid_payload", message: "Payload must include 'id' and 'title' fields." });
      return;
    }

    // 3. Upsert the post into the database
    const postId = await upsertPost({
      businessId: matchedConnection.businessId,
      cmsPlatform: "zapier",
      ...post,
    });

    res.status(200).json({ received: true, postId });
  } catch (err: any) {
    console.error("[Zapier Inbound] Error:", err?.message ?? err);
    res.status(500).json({ error: "internal_error" });
  }
}
