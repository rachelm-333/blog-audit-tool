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

      // Make a direct raw fetch — no helper functions
      const url = "https://www.wixapis.com/blog/v3/posts?limit=1";
      const fetchRes = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": apiKey,
          "wix-site-id": siteId,
          "Accept": "application/json",
        },
      });

      let body: unknown;
      const rawText = await fetchRes.text();
      try { body = JSON.parse(rawText); } catch { body = rawText; }

      return res.json({
        httpStatus: fetchRes.status,
        httpStatusText: fetchRes.statusText,
        wixResponse: body,
        apiKeyFirst10: apiKey.slice(0, 10),
        siteIdFirst10: siteId.slice(0, 10),
        apiKeyLength: apiKey.length,
        siteIdLength: siteId.length,
        urlCalled: url,
        headersUsed: {
          Authorization: apiKey.slice(0, 10) + "...",
          "wix-site-id": siteId.slice(0, 10) + "...",
          Accept: "application/json",
        },
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
