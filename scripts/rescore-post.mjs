/**
 * Re-score a specific post using its stored body_approved/body_rewritten
 * and write the correct rewrite_score/rewrite_grade/audit_results back.
 *
 * Usage: node scripts/rescore-post.mjs <postId>
 */
import { createConnection } from "mysql2/promise";
import { createRequire } from "module";
import { pathToFileURL } from "url";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const postId = process.argv[2];
if (!postId) {
  console.error("Usage: node scripts/rescore-post.mjs <postId>");
  process.exit(1);
}

// Dynamically import the compiled audit runner via tsx
const { runFullAudit } = await import("../server/audit.service.ts");

const conn = await createConnection(process.env.DATABASE_URL || "");

const [rows] = await conn.execute(
  "SELECT id, title, body_approved, body_rewritten, meta_title_rewritten, meta_description_rewritten, focus_keyword, url, schema_json FROM posts WHERE id = ?",
  [postId]
);

if (!rows.length) {
  console.error("Post not found:", postId);
  await conn.end();
  process.exit(1);
}

const post = rows[0];
console.log("Post:", post.title);
console.log("Focus keyword:", post.focus_keyword);
console.log("Meta title:", post.meta_title_rewritten);

const body = post.body_approved ?? post.body_rewritten ?? "";
let bodyForScoring = body;
if (post.schema_json && !bodyForScoring.includes("application/ld+json")) {
  const schema = typeof post.schema_json === "string" ? post.schema_json : JSON.stringify(post.schema_json);
  bodyForScoring = `<script type="application/ld+json">${schema}</script>\n${bodyForScoring}`;
}

console.log("\nRunning audit...");
const auditResult = await runFullAudit({
  title: post.title,
  bodyHtml: bodyForScoring,
  focusKeyword: post.focus_keyword,
  url: post.url ?? "",
  metaTitle: post.meta_title_rewritten ?? "",
  metaDescription: post.meta_description_rewritten ?? "",
  primaryCtaUrl: null,
});

const newScore = auditResult.points.filter(
  (p) => p.status === "pass" || p.status === "na"
).length;

const gradeMap = { 16: "optimised", 15: "optimised", 14: "strong", 13: "strong", 12: "needs_work", 11: "needs_work", 10: "needs_work" };
const newGrade = newScore >= 14 ? (newScore >= 15 ? "optimised" : "strong") : newScore >= 10 ? "needs_work" : newScore >= 7 ? "poor" : "critical";

console.log("\nAudit complete:");
console.log("  Score:", newScore, "/", auditResult.points.length);
console.log("  Grade:", newGrade);
console.log("\nPoint breakdown:");
for (const p of auditResult.points) {
  console.log(`  [${p.status.toUpperCase().padEnd(12)}] ${p.point} — ${p.name}`);
}

const auditResultsJson = JSON.stringify({
  points: auditResult.points,
  potentialScore: auditResult.potentialScore,
});

await conn.execute(
  "UPDATE posts SET rewrite_score = ?, rewrite_grade = ?, audit_results = ? WHERE id = ?",
  [newScore, newGrade, auditResultsJson, postId]
);

console.log(`\nDatabase updated: rewrite_score=${newScore}, rewrite_grade=${newGrade}`);
await conn.end();
