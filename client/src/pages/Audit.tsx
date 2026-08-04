/**
 * Audit.tsx — Layer 10: Free Public Audit Tool (/audit)
 *
 * Stage 1: URL input → 27-point audit results
 * Stage 2: Free rewrite unlock form → rewrite delivery in 3 formats + Blog Batcher upsell
 *
 * No login required. Accessible to anyone.
 */

import { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Link } from "wouter";

// ---------------------------------------------------------------------------
// Grade helpers (matches spec Table 31)
// ---------------------------------------------------------------------------

type Grade = "optimised" | "strong" | "needs_work" | "poor" | "critical";

const GRADE_LABELS: Record<Grade, string> = {
  optimised: "Great Score",
  strong: "Good Score",
  needs_work: "Needs a Refresh",
  poor: "Needs Improvement",
  critical: "Requires Full Rewrite",
};

const GRADE_COLORS: Record<Grade, { bg: string; text: string; border: string }> = {
  optimised: { bg: "bg-[#1A7A4A]", text: "text-white", border: "border-[#1A7A4A]" },
  strong:    { bg: "bg-[#2E6DA4]", text: "text-white", border: "border-[#2E6DA4]" },
  needs_work:{ bg: "bg-[#B8860B]", text: "text-white", border: "border-[#B8860B]" },
  poor:      { bg: "bg-[#C75B00]", text: "text-white", border: "border-[#C75B00]" },
  critical:  { bg: "bg-[#A30000]", text: "text-white", border: "border-[#A30000]" },
};

function GradeBadge({ grade }: { grade: Grade }) {
  const c = GRADE_COLORS[grade];
  return (
    <span
      className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${c.bg} ${c.text}`}
    >
      {GRADE_LABELS[grade]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Copy button helper
// ---------------------------------------------------------------------------

function CopyButton({ label, getValue }: { label: string; getValue: () => string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(getValue());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Copy failed — please select and copy manually.");
    }
  };
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCopy}
      className="gap-1.5 text-xs"
    >
      {copied ? "✓ Copied" : `Copy ${label}`}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// HTML → Markdown (simple conversion for copy button)
// ---------------------------------------------------------------------------

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n")
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n")
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n")
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n\n")
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**")
    .replace(/<em[^>]*>(.*?)<\/em>/gi, "_$1_")
    .replace(/<i[^>]*>(.*?)<\/i>/gi, "_$1_")
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, "[$2]($1)")
    .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
    .replace(/<\/?(ul|ol)[^>]*>/gi, "\n")
    .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Blog Batcher upsell banner
// ---------------------------------------------------------------------------

function BlogBatcherBanner() {
  return (
    <div className="mt-8 rounded-[var(--r-md)] border border-[#2A3560] bg-gradient-to-r from-[#0D1B3E] to-[#16213E] p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-xs font-bold uppercase tracking-widest text-[#4A90D9] mb-1">
            Blog Batcher — Bulk Content Engine
          </div>
          <div className="text-base font-bold text-white">
            Need brand-new, SEO-optimised posts from scratch?
          </div>
          <div className="text-sm text-[#8892A4] mt-1">
            Blog Batcher is Noize's companion tool for building high-converting blog content from the start — keyword-targeted, SEO-ready, and written in your brand voice.
          </div>
        </div>
        <div className="flex-shrink-0">
          <a
            href="https://blogbatcher.com.au"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button className="bg-[#2E6DA4] hover:bg-[#4A90D9] text-white font-semibold whitespace-nowrap">
              Explore Blog Batcher →
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage 2 — Sign-up CTA with countdown
// ---------------------------------------------------------------------------

const CLAIM_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export const PENDING_AUDIT_KEY = "iaudit_pending_audit";

interface PendingAudit {
  url: string;
  score: number;
  potentialScore: number;
  focusKeyword: string;
  expiresAt: number;
}

function savePendingAudit(data: Omit<PendingAudit, "expiresAt">) {
  try {
    localStorage.setItem(
      PENDING_AUDIT_KEY,
      JSON.stringify({ ...data, expiresAt: Date.now() + CLAIM_WINDOW_MS })
    );
  } catch { /* storage unavailable */ }
}

function SignUpCTA({
  auditScore,
  potentialScore,
  postUrl,
  focusKeyword,
}: {
  auditScore: number;
  potentialScore: number;
  postUrl: string;
  focusKeyword: string;
}) {
  const [secsLeft, setSecsLeft] = useState(CLAIM_WINDOW_MS / 1000);

  // Save pending audit and start countdown on mount
  useState(() => {
    savePendingAudit({ url: postUrl, score: auditScore, potentialScore, focusKeyword });
  });

  useEffect(() => {
    const interval = setInterval(() => {
      setSecsLeft((s) => {
        if (s <= 1) { clearInterval(interval); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const mins = Math.floor(secsLeft / 60);
  const secs = secsLeft % 60;
  const expired = secsLeft === 0;

  return (
    <div className="mt-6 rounded-[var(--r-md)] border border-[#2E6DA4] bg-gradient-to-br from-[#1E3A5F] to-[#0D2040] p-6 sm:p-8 text-center">
      <div className="text-2xl font-black text-white mb-2">
        Your post can score <span className="text-[#22A064]">{potentialScore}/100</span>
      </div>
      <div className="text-sm text-[#8892A4] mb-6 max-w-md mx-auto">
        Join iAudit and we'll rewrite this post to a{" "}
        <span className="text-[#22A064] font-semibold">Great Score</span> — fixing every failing check
        so your post ranks higher and gets cited by AI.
      </div>

      {/* Countdown */}
      {!expired ? (
        <div className="inline-flex items-center gap-2 bg-[#0F0F1A] border border-[#C75B00]/50 rounded-full px-4 py-2 mb-6">
          <span className="text-[#C75B00] text-xs font-bold uppercase tracking-wide">⏱ Offer expires in</span>
          <span className="text-white font-black text-base tabular-nums">
            {mins}:{secs.toString().padStart(2, "0")}
          </span>
        </div>
      ) : (
        <div className="inline-flex items-center gap-2 bg-[#0F0F1A] border border-[#4A5568]/50 rounded-full px-4 py-2 mb-6">
          <span className="text-[#4A5568] text-xs font-semibold">Offer expired — sign up to audit &amp; fix any post</span>
        </div>
      )}

      <div className="space-y-3 max-w-xs mx-auto">
        <Link href="/register">
          <Button className="w-full bg-[#1A7A4A] hover:bg-[#22A064] text-white font-bold py-3 text-base">
            Join Now &amp; Fix This Post →
          </Button>
        </Link>
        <p className="text-xs text-[#4A5568]">
          Your audit results are saved for 10 minutes — create an account and they'll be added automatically.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage 1 — Audit results panel
// ---------------------------------------------------------------------------

interface AuditResultsProps {
  url: string;
  title: string;
  score: number;
  grade: Grade;
  potentialScore: number;
  points: Array<{ point: string; name: string; status: string; note: string }>;
  focusKeyword: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  scrapedBodyHtml: string;
  scrapedMetaTitle: string | null;
  scrapedMetaDescription: string | null;
}

function AuditResults({
  url,
  title,
  score,
  grade,
  potentialScore,
  points,
  focusKeyword,
  metaTitle,
  metaDescription,
  scrapedBodyHtml,
  scrapedMetaTitle,
  scrapedMetaDescription,
}: AuditResultsProps) {
  const [keyword, setKeyword] = useState(focusKeyword ?? "");
  // Auto-detected keywords are pre-confirmed; only show prompt if truly no keyword at all
  const [keywordConfirmed, setKeywordConfirmed] = useState(!!focusKeyword);
  const [editingKeyword, setEditingKeyword] = useState(false);

  const failingPoints = points.filter((p) => p.status === "fail");
  const passingPoints = points.filter((p) => p.status === "pass");
  const unablePoints = points.filter((p) => p.status === "unable_to_score");

  const gradeColors = GRADE_COLORS[grade];

  return (
    <div className="max-w-2xl mx-auto mt-8 space-y-4">
      {/* Score summary */}
      <div className={`rounded-[var(--r-md)] border ${gradeColors.border} bg-[#16213E] p-6 text-center`}>
        <div className={`text-4xl font-black ${grade === "poor" || grade === "critical" ? "text-[#F0A800]" : "text-[#22A064]"} mb-1`}>
          {score} / 100
        </div>
        <div className="flex items-center justify-center gap-2 mb-2">
          <GradeBadge grade={grade} />
        </div>
        <div className="text-sm text-[#8892A4]">
          {failingPoints.length > 0 && `${failingPoints.length} SEO issue${failingPoints.length !== 1 ? "s" : ""} found`}
        </div>
        <div className="text-sm text-[#8892A4] mt-1">
          After a free rewrite, this post could score{" "}
          <span className="text-[#22A064] font-semibold">{potentialScore}/100 — Great Score</span>
        </div>
      </div>

      {/* Keyword display — show auto-detected keyword or prompt to enter one */}
      {keywordConfirmed && !editingKeyword ? (
        <div className="rounded-[var(--r-md)] border border-[#1A4A2A] bg-[#0D2E1E] p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs text-[#22A064] font-semibold uppercase tracking-wide flex-shrink-0">Focus Keyword</span>
            <span className="text-sm text-white font-medium truncate">{keyword}</span>
          </div>
          <button
            onClick={() => setEditingKeyword(true)}
            className="text-xs text-[#4A90D9] hover:text-white flex-shrink-0 underline"
          >
            Change
          </button>
        </div>
      ) : !keywordConfirmed || editingKeyword ? (
        <div className="rounded-[var(--r-md)] border border-[#2E6DA4] bg-[#0D1B3E] p-4">
          <div className="text-sm font-semibold text-[#4A90D9] mb-1">
            {editingKeyword ? "Change focus keyword" : "Set focus keyword for accurate P1–P7 scores"}
          </div>
          <p className="text-xs text-[#8892A4] mb-3">
            The focus keyword is used to score keyword density, headings, URL, and meta title. Enter the main phrase this post is targeting.
          </p>
          <div className="flex gap-2">
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="e.g. business start up australia"
              className="bg-[#0F0F1A] border-[#2A3560] text-white placeholder:text-[#4A5568] text-sm"
              autoFocus
            />
            <Button
              size="sm"
              onClick={() => { setKeywordConfirmed(true); setEditingKeyword(false); }}
              disabled={!keyword.trim()}
              className="bg-[#2E6DA4] hover:bg-[#4A90D9] text-white whitespace-nowrap"
            >
              Confirm
            </Button>
          </div>
        </div>
      ) : null}

      {/* Post title */}
      <div className="rounded-[var(--r-md)] border border-[#2A3560] bg-[#16213E] p-4">
        <div className="text-xs text-[#8892A4] uppercase tracking-wide mb-1">Post Audited</div>
        <div className="text-sm font-semibold text-white truncate">{title}</div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[#4A90D9] hover:underline truncate block mt-0.5"
        >
          {url}
        </a>
      </div>

      {/* What we found */}
      <div className="rounded-[var(--r-md)] border border-[#2A3560] bg-[#16213E] p-4">
        <div className="text-sm font-bold text-white mb-3">What we found:</div>
        <div className="space-y-2">
          {failingPoints.map((p) => (
            <div
              key={p.point}
              className="flex items-start gap-3 rounded-[var(--r-md)] bg-[#2A0000] border border-[#A30000]/30 px-3 py-2.5"
            >
              <span className="text-base flex-shrink-0">❌</span>
              <div>
                <span className="text-xs font-bold text-white">{p.point} {p.name}</span>
              </div>
            </div>
          ))}
          {unablePoints.map((p) => (
            <div
              key={p.point}
              className="flex items-start gap-3 rounded-[var(--r-md)] bg-[#2A2000] border border-[#B8860B]/30 px-3 py-2.5"
            >
              <span className="text-base flex-shrink-0">⚠️</span>
              <div>
                <span className="text-xs font-bold text-white">{p.point} {p.name}</span>
              </div>
            </div>
          ))}
          {passingPoints.map((p) => (
            <div
              key={p.point}
              className="flex items-start gap-3 rounded-[var(--r-md)] bg-[#0D2E1E] border border-[#1A7A4A]/30 px-3 py-2.5"
            >
              <span className="text-base flex-shrink-0">✅</span>
              <div>
                <span className="text-xs font-bold text-white">{p.point} {p.name}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Stage 2 — Sign-up CTA */}
      <SignUpCTA
        auditScore={score}
        potentialScore={potentialScore}
        postUrl={url}
        focusKeyword={keyword}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function AuditPage() {
  const [url, setUrl] = useState("");
  const [auditResult, setAuditResult] = useState<any | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const runAudit = trpc.publicAudit.runAudit.useMutation({
    onSuccess: (data) => {
      setAuditResult(data);
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to audit this URL. Please check it is publicly accessible.");
    },
  });

  const handleAudit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setAuditResult(null);
    runAudit.mutate({ url: url.trim() });
  };

  const handleReaudit = () => {
    if (!url.trim()) return;
    setAuditResult(null);
    runAudit.mutate({ url: url.trim() });
  };

  const handleClear = () => {
    setAuditResult(null);
    setUrl("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="min-h-screen bg-[#0F0F1A] text-[#E8EAF0]">
      {/* Minimal top nav */}
      <nav className="border-b border-[#2A3560] px-6 py-4 flex items-center justify-between">
        <Link href="/">
          <span className="text-xl font-black text-[#4A90D9] tracking-tight cursor-pointer">
            iAudit
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <Link href="/login">
            <Button variant="ghost" size="sm" className="text-[#8892A4] hover:text-white text-xs">
              Sign In
            </Button>
          </Link>
          <Link href="/register">
            <Button size="sm" className="bg-[#2E6DA4] hover:bg-[#4A90D9] text-white text-xs">
              Get Started Free
            </Button>
          </Link>
        </div>
      </nav>

      <main className="px-4 py-12 sm:py-16">
        {/* Hero */}
        <div className="max-w-2xl mx-auto text-center">
          <div className="text-xs font-bold uppercase tracking-widest text-[#4A90D9] mb-4">
            Free SEO Audit · No signup required
          </div>
          <h1 className="text-3xl sm:text-4xl font-black text-white leading-tight mb-4">
            Is your blog post{" "}
            <span className="text-[#4A90D9]">ranking on Google?</span>
          </h1>
          <p className="text-[#8892A4] text-base mb-8 max-w-lg mx-auto">
            Paste any blog post URL and get an instant 27-point score with specific fixes.
            Free, no account needed.
          </p>

          {/* URL input */}
          <form onSubmit={handleAudit} className="flex flex-col sm:flex-row gap-3 max-w-xl mx-auto">
            <Input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://yourbusiness.com.au/blog/your-post"
              required
              className="flex-1 bg-[#16213E] border-[#2A3560] text-white placeholder:text-[#4A5568] h-11"
            />
            <Button
              type="submit"
              disabled={runAudit.isPending}
              className="bg-[#2E6DA4] hover:bg-[#4A90D9] text-white font-semibold h-11 px-6 whitespace-nowrap"
            >
              {runAudit.isPending ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Auditing…
                </span>
              ) : (
                "Audit This Post Free"
              )}
            </Button>
          </form>

          {/* Trust signals */}
          <div className="flex items-center justify-center gap-6 mt-5 text-xs text-[#8892A4]">
            <span>✓ 27-point SEO check</span>
            <span>✓ Instant results</span>
            <span>✓ No credit card</span>
          </div>
        </div>

        {/* Audit results */}
        <div ref={resultsRef}>
          {auditResult && (
            <>
              <AuditResults
                url={auditResult.url}
                title={auditResult.title}
                score={auditResult.score}
                grade={auditResult.grade}
                potentialScore={auditResult.potentialScore}
                points={auditResult.points}
                focusKeyword={auditResult.focusKeyword}
                metaTitle={auditResult.metaTitle}
                metaDescription={auditResult.metaDescription}
                scrapedBodyHtml={auditResult.scrapedBodyHtml}
                scrapedMetaTitle={auditResult.metaTitle}
                scrapedMetaDescription={auditResult.metaDescription}
              />
              {/* Re-audit / Clear actions */}
              <div className="max-w-2xl mx-auto mt-4 flex items-center justify-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReaudit}
                  disabled={runAudit.isPending}
                  className="border-[#2A3560] text-[#8892A4] hover:text-white hover:border-[#4A90D9] text-xs"
                >
                  {runAudit.isPending ? "Re-auditing…" : "↻ Re-audit this post"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClear}
                  className="border-[#2A3560] text-[#8892A4] hover:text-white hover:border-[#4A90D9] text-xs"
                >
                  ✕ Audit a different post
                </Button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
