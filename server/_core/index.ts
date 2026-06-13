import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { handleStripeWebhook } from "../stripe.webhook";
import { handleZapierInbound } from "../zapier.webhook";
import { parse as parseCookies } from "cookie";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  // ── Stripe webhook — MUST be registered before express.json() ──
  // Stripe requires the raw request body for signature verification.
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    handleStripeWebhook
  );

  // Parse cookies so req.cookies is available in all routes (needed for iAudit refresh token)
  app.use((req, _res, next) => {
    const raw = req.headers.cookie ?? "";
    (req as any).cookies = raw ? parseCookies(raw) : {};
    next();
  });

  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  // ── Zapier inbound webhook — receives posts from Zapier zaps ──
  app.post("/api/zapier/inbound/:token", handleZapierInbound);

  // ── TEMPORARY DEBUG: Test Wix credentials directly ──────────────────────────
  app.get("/api/test-wix", async (_req, res) => {
    try {
      const { getDb } = await import("../db");
      const { cmsConnections } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const { decryptCredentials } = await import("../encryption.service");

      const db = await getDb();
      if (!db) return res.json({ error: "DB not available" });

      // Find the first Wix connection in the database
      const rows = await db.select().from(cmsConnections).where(eq(cmsConnections.platform, "wix")).limit(1);
      if (!rows.length) return res.json({ error: "No Wix connection found in database" });

      const conn = rows[0]!;
      const encrypted = typeof conn.credentialsEncrypted === "string"
        ? conn.credentialsEncrypted
        : JSON.stringify(conn.credentialsEncrypted);
      const creds = decryptCredentials(encrypted) as { apiKey?: string; siteId?: string };

      const apiKey = creds.apiKey ?? "";
      const siteId = creds.siteId ?? "";

      // Test 1: simple URL (same as before)
      const url1 = "https://www.wixapis.com/blog/v3/posts?limit=1";
      const res1 = await fetch(url1, { method: "GET", headers: { "Authorization": apiKey, "wix-site-id": siteId, "Accept": "application/json" } });
      const raw1 = await res1.text();
      let body1: unknown; try { body1 = JSON.parse(raw1); } catch { body1 = raw1; }

      // Test 2: exact URL that importFromWix uses (URLSearchParams encoded)
      const params = new URLSearchParams({ fieldsets: "SEO,RICH_CONTENT", "paging.limit": "1" });
      const url2 = `https://www.wixapis.com/blog/v3/posts?${params.toString()}`;
      const res2 = await fetch(url2, { method: "GET", headers: { "Authorization": apiKey, "wix-site-id": siteId, "Accept": "application/json" } });
      const raw2 = await res2.text();
      let body2: unknown; try { body2 = JSON.parse(raw2); } catch { body2 = raw2; }

      // Test 3: GET single post by ID (first post from test1)
      const firstPostId = (body1 as any)?.posts?.[0]?.id ?? "";
      const url3 = `https://www.wixapis.com/blog/v3/posts/${firstPostId}`;
      const res3 = await fetch(url3, { method: "GET", headers: { "Authorization": apiKey, "wix-site-id": siteId, "Accept": "application/json" } });
      const raw3 = await res3.text();
      let body3: unknown; try { body3 = JSON.parse(raw3); } catch { body3 = raw3; }

      // Test 4: GET single post with fieldsets as query param
      const url4 = `https://www.wixapis.com/blog/v3/posts/${firstPostId}?fieldsets=SEO,RICH_CONTENT`;
      const res4 = await fetch(url4, { method: "GET", headers: { "Authorization": apiKey, "wix-site-id": siteId, "Accept": "application/json" } });
      const raw4 = await res4.text();
      let body4: unknown; try { body4 = JSON.parse(raw4); } catch { body4 = raw4; }

      // Test 5: POST /query with fieldsets in body (correct Wix v3 approach)
      const url5 = `https://www.wixapis.com/blog/v3/posts/query`;
      const res5 = await fetch(url5, {
        method: "POST",
        headers: { "Authorization": apiKey, "wix-site-id": siteId, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ fieldsets: ["SEO", "RICH_CONTENT"], paging: { limit: 1 } }),
      });
      const raw5 = await res5.text();
      let body5: unknown; try { body5 = JSON.parse(raw5); } catch { body5 = raw5; }

      return res.json({
        apiKeyFirst10: apiKey.slice(0, 10),
        siteIdFirst10: siteId.slice(0, 10),
        apiKeyLength: apiKey.length,
        firstPostId,
        test1_listNoFieldsets: { url: url1, status: res1.status, fieldsReturned: Object.keys((body1 as any)?.posts?.[0] ?? {}) },
        test2_listFieldsetsEncoded: { url: url2, status: res2.status, error: (body2 as any)?.message },
        test3_singlePostNoFieldsets: { url: url3, status: res3.status, fieldsReturned: Object.keys((body3 as any)?.post ?? {}), hasSeoData: !!(body3 as any)?.post?.seoData, hasRichContent: !!(body3 as any)?.post?.richContent },
        test4_singlePostFieldsetsRaw: { url: url4, status: res4.status, error: (body4 as any)?.message, fieldsReturned: Object.keys((body4 as any)?.post ?? {}), hasSeoData: !!(body4 as any)?.post?.seoData, hasRichContent: !!(body4 as any)?.post?.richContent },
        test5_postQueryWithFieldsets: { url: url5, status: res5.status, error: (body5 as any)?.message, fieldsReturned: Object.keys((body5 as any)?.posts?.[0] ?? {}), hasSeoData: !!(body5 as any)?.posts?.[0]?.seoData, hasRichContent: !!(body5 as any)?.posts?.[0]?.richContent, postCount: (body5 as any)?.posts?.length ?? 0 },
      });
    } catch (err: any) {
      return res.json({ error: err?.message ?? String(err), stack: err?.stack?.slice(0, 500) });
    }
  });
  // ── END TEMPORARY DEBUG ──────────────────────────────────────────────────────
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
