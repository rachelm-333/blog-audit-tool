/**
 * Audit.tsx — Layer 10: Free Public Audit Tool (/audit)
 *
 * Stage 1: URL input → 16-point audit results
 * Stage 2: Free rewrite unlock form → rewrite delivery in 3 formats + Blog Batcher upsell
 *
 * No login required. Accessible to anyone.
 */

import { useState, useRef } from "react";
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
  optimised: "Optimised",
  strong: "Strong",
  needs_work: "Needs Work",
  poor: "Poor",
  critical: "Critical",
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
    <div className="mt-8 rounded-xl border border-[#2A3560] bg-gradient-to-r from-[#0D1B3E] to-[#16213E] p-6">
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
// Stage 2 — Rewrite unlock form
// ---------------------------------------------------------------------------

type BrandVoice = "Professional" | "Friendly" | "Bold" | "Conversational";
const BRAND_VOICES: BrandVoice[] = ["Professional", "Friendly", "Bold", "Conversational"];

interface Stage2FormProps {
  auditScore: number;
  potentialScore: number;
  postUrl: string;
  scrapedTitle: string;
  scrapedBodyHtml: string;
  scrapedMetaTitle: string | null;
  scrapedMetaDescription: string | null;
  focusKeyword: string;
  onSuccess: (result: RewriteDelivery) => void;
}

interface RewriteDelivery {
  bodyRewritten: string;
  metaTitleRewritten: string;
  metaDescriptionRewritten: string;
  rewriteScore: number;
  rewriteGrade: Grade;
  auditScoreBefore: number;
}

function Stage2Form({
  auditScore,
  potentialScore,
  postUrl,
  scrapedTitle,
  scrapedBodyHtml,
  scrapedMetaTitle,
  scrapedMetaDescription,
  focusKeyword,
  onSuccess,
}: Stage2FormProps) {
  const [businessName, setBusinessName] = useState("");
  const [industry, setIndustry] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [primaryCtaUrl, setPrimaryCtaUrl] = useState("");
  const [brandVoice, setBrandVoice] = useState<BrandVoice>("Professional");
  const [email, setEmail] = useState("");
  const [duplicateEmail, setDuplicateEmail] = useState(false);

  const runFreeRewrite = trpc.publicAudit.runFreeRewrite.useMutation({
    onSuccess: (data) => {
      onSuccess(data as RewriteDelivery);
    },
    onError: (err) => {
      if (err.data?.code === "CONFLICT") {
        setDuplicateEmail(true);
      } else {
        toast.error(err.message ?? "Rewrite failed. Please try again.");
      }
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setDuplicateEmail(false);
    runFreeRewrite.mutate({
      url: postUrl,
      focusKeyword,
      auditScoreBefore: auditScore,
      email,
      businessName,
      industry,
      targetAudience,
      primaryCtaUrl,
      brandVoice,
      scrapedTitle,
      scrapedBodyHtml,
      scrapedMetaTitle,
      scrapedMetaDescription,
    });
  };

  return (
    <div className="mt-6 rounded-xl border border-[#2E6DA4] bg-gradient-to-br from-[#1E3A5F] to-[#0D2040] p-6 sm:p-8">
      <div className="text-center mb-6">
        <div className="text-xl font-bold text-white mb-2">Fix this post for free</div>
        <div className="text-sm text-[#8892A4]">
          Tell us about your business and we'll rewrite this post to a{" "}
          <span className="text-[#22A064] font-semibold">{potentialScore}/16 — Optimised</span>{" "}
          score — ready to copy back to your site.
        </div>
      </div>

      <form onSubmit={handleSubmit} className="max-w-md mx-auto space-y-4">
        <div>
          <label className="block text-xs font-semibold text-[#8892A4] uppercase tracking-wide mb-1">
            Business Name
          </label>
          <Input
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="e.g. Luxia Pools"
            required
            className="bg-[#0F0F1A] border-[#2A3560] text-white placeholder:text-[#4A5568]"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#8892A4] uppercase tracking-wide mb-1">
            Industry
          </label>
          <Input
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            placeholder="e.g. Pool Installation, Dental Practice"
            required
            className="bg-[#0F0F1A] border-[#2A3560] text-white placeholder:text-[#4A5568]"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#8892A4] uppercase tracking-wide mb-1">
            Who is your customer?
          </label>
          <Input
            value={targetAudience}
            onChange={(e) => setTargetAudience(e.target.value)}
            placeholder="e.g. Sydney homeowners planning a renovation"
            required
            className="bg-[#0F0F1A] border-[#2A3560] text-white placeholder:text-[#4A5568]"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#8892A4] uppercase tracking-wide mb-1">
            Your most important page URL
          </label>
          <Input
            type="url"
            value={primaryCtaUrl}
            onChange={(e) => setPrimaryCtaUrl(e.target.value)}
            placeholder="e.g. your bookings or contact page"
            required
            className="bg-[#0F0F1A] border-[#2A3560] text-white placeholder:text-[#4A5568]"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#8892A4] uppercase tracking-wide mb-1">
            Brand Voice
          </label>
          <div className="flex flex-wrap gap-2 mt-1">
            {BRAND_VOICES.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setBrandVoice(v)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  brandVoice === v
                    ? "bg-[#2E6DA4] border-[#4A90D9] text-white"
                    : "bg-transparent border-[#2A3560] text-[#8892A4] hover:border-[#4A90D9] hover:text-white"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#8892A4] uppercase tracking-wide mb-1">
            Email Address{" "}
            <span className="text-[#4A5568] normal-case font-normal">(one free rewrite per address)</span>
          </label>
          <Input
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setDuplicateEmail(false); }}
            placeholder="you@yourbusiness.com.au"
            required
            className={`bg-[#0F0F1A] border-[#2A3560] text-white placeholder:text-[#4A5568] ${duplicateEmail ? "border-red-500" : ""}`}
          />
          {duplicateEmail && (
            <p className="mt-1.5 text-xs text-red-400">
              This email address has already used its free rewrite.{" "}
              <Link href="/register" className="underline text-[#4A90D9]">
                Sign up for an account
              </Link>{" "}
              to fix all your posts.
            </p>
          )}
        </div>

        <Button
          type="submit"
          disabled={runFreeRewrite.isPending}
          className="w-full bg-[#1A7A4A] hover:bg-[#22A064] text-white font-semibold py-3 text-sm mt-2"
        >
          {runFreeRewrite.isPending ? (
            <span className="flex items-center gap-2 justify-center">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Rewriting your post… this takes 30–60 seconds
            </span>
          ) : (
            "✨ Rewrite My Post Free"
          )}
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rewrite delivery panel
// ---------------------------------------------------------------------------

function RewriteDeliveryPanel({ result }: { result: RewriteDelivery }) {
  const [activeTab, setActiveTab] = useState<"html" | "markdown" | "plaintext">("html");

  const getContent = () => {
    if (activeTab === "html") return result.bodyRewritten;
    if (activeTab === "markdown") return htmlToMarkdown(result.bodyRewritten);
    return htmlToPlainText(result.bodyRewritten);
  };

  return (
    <div className="mt-6 space-y-4">
      {/* Before / after score */}
      <div className="rounded-xl border border-[#2A3560] bg-[#16213E] p-5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-8">
          <div className="text-center">
            <div className="text-xs text-[#8892A4] uppercase tracking-wide mb-1">Before</div>
            <div className="text-3xl font-black text-[#C75B00]">{result.auditScoreBefore}/16</div>
          </div>
          <div className="text-2xl text-[#2A3560] hidden sm:block">→</div>
          <div className="text-center">
            <div className="text-xs text-[#8892A4] uppercase tracking-wide mb-1">After Rewrite</div>
            <div className="text-3xl font-black text-[#22A064]">{result.rewriteScore}/16</div>
          </div>
          <div className="sm:ml-auto">
            <GradeBadge grade={result.rewriteGrade} />
          </div>
        </div>
        <p className="text-sm text-[#8892A4] mt-3">
          Your post scored {result.auditScoreBefore}/16. After rewrite:{" "}
          <span className="text-[#22A064] font-semibold">
            {result.rewriteScore}/16 — {GRADE_LABELS[result.rewriteGrade]}
          </span>
        </p>
      </div>

      {/* Meta fields */}
      <div className="rounded-xl border border-[#2A3560] bg-[#16213E] p-5 space-y-3">
        <div className="text-xs font-bold uppercase tracking-wide text-[#8892A4] mb-2">
          Updated Meta Fields
        </div>
        <div>
          <div className="text-xs text-[#8892A4] mb-1">Meta Title ({result.metaTitleRewritten.length} chars)</div>
          <div className="text-sm text-white font-medium bg-[#0F0F1A] rounded p-2 border border-[#2A3560]">
            {result.metaTitleRewritten}
          </div>
        </div>
        <div>
          <div className="text-xs text-[#8892A4] mb-1">Meta Description ({result.metaDescriptionRewritten.length} chars)</div>
          <div className="text-sm text-white bg-[#0F0F1A] rounded p-2 border border-[#2A3560]">
            {result.metaDescriptionRewritten}
          </div>
        </div>
      </div>

      {/* Rewritten body with format tabs */}
      <div className="rounded-xl border border-[#2A3560] bg-[#16213E] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#2A3560]">
          <div className="flex gap-1">
            {(["html", "markdown", "plaintext"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1 rounded text-xs font-semibold transition-all ${
                  activeTab === tab
                    ? "bg-[#2E6DA4] text-white"
                    : "text-[#8892A4] hover:text-white"
                }`}
              >
                {tab === "html" ? "HTML" : tab === "markdown" ? "Markdown" : "Plain Text"}
              </button>
            ))}
          </div>
          <CopyButton
            label={activeTab === "html" ? "HTML" : activeTab === "markdown" ? "Markdown" : "Plain Text"}
            getValue={getContent}
          />
        </div>
        <div className="p-4 max-h-96 overflow-y-auto">
          <pre className="text-xs text-[#8892A4] whitespace-pre-wrap font-mono leading-relaxed">
            {getContent()}
          </pre>
        </div>
      </div>

      {/* CTA */}
      <div className="text-center py-2">
        <Link href="/register">
          <Button variant="outline" className="border-[#2E6DA4] text-[#4A90D9] hover:bg-[#2E6DA4] hover:text-white">
            Fix all your posts with iAudit →
          </Button>
        </Link>
      </div>

      <BlogBatcherBanner />
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
  const [showRewriteForm, setShowRewriteForm] = useState(false);
  const [rewriteResult, setRewriteResult] = useState<RewriteDelivery | null>(null);
  const [keyword, setKeyword] = useState(focusKeyword ?? "");
  const [keywordConfirmed, setKeywordConfirmed] = useState(!!focusKeyword);

  const failingPoints = points.filter((p) => p.status === "fail");
  const passingPoints = points.filter((p) => p.status === "pass");
  const unablePoints = points.filter((p) => p.status === "unable_to_score");

  const gradeColors = GRADE_COLORS[grade];

  return (
    <div className="max-w-2xl mx-auto mt-8 space-y-4">
      {/* Score summary */}
      <div className={`rounded-xl border ${gradeColors.border} bg-[#16213E] p-6 text-center`}>
        <div className={`text-4xl font-black ${grade === "poor" || grade === "critical" ? "text-[#F0A800]" : "text-[#22A064]"} mb-1`}>
          {score} / 16
        </div>
        <div className="flex items-center justify-center gap-2 mb-2">
          <GradeBadge grade={grade} />
        </div>
        <div className="text-sm text-[#8892A4]">
          {failingPoints.length > 0 && `${failingPoints.length} SEO issue${failingPoints.length !== 1 ? "s" : ""} found`}
        </div>
        <div className="text-sm text-[#8892A4] mt-1">
          After a free rewrite, this post could score{" "}
          <span className="text-[#22A064] font-semibold">{potentialScore}/16 — Optimised</span>
        </div>
      </div>

      {/* Keyword confirmation (if not found in meta) */}
      {!keywordConfirmed && (
        <div className="rounded-xl border border-[#B8860B] bg-[#2A2000] p-4">
          <div className="text-sm font-semibold text-[#F0A800] mb-2">
            Focus keyword not found in page meta tags
          </div>
          <p className="text-xs text-[#8892A4] mb-3">
            Enter the focus keyword for this post to get accurate scores for P1–P6 (keyword density, headings, URL, etc.).
          </p>
          <div className="flex gap-2">
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="e.g. pool installation sydney"
              className="bg-[#0F0F1A] border-[#2A3560] text-white placeholder:text-[#4A5568] text-sm"
            />
            <Button
              size="sm"
              onClick={() => setKeywordConfirmed(true)}
              disabled={!keyword.trim()}
              className="bg-[#2E6DA4] hover:bg-[#4A90D9] text-white whitespace-nowrap"
            >
              Confirm
            </Button>
          </div>
        </div>
      )}

      {/* Post title */}
      <div className="rounded-xl border border-[#2A3560] bg-[#16213E] p-4">
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
      <div className="rounded-xl border border-[#2A3560] bg-[#16213E] p-4">
        <div className="text-sm font-bold text-white mb-3">What we found:</div>
        <div className="space-y-2">
          {failingPoints.map((p) => (
            <div
              key={p.point}
              className="flex items-start gap-3 rounded-lg bg-[#2A0000] border border-[#A30000]/30 px-3 py-2.5"
            >
              <span className="text-base flex-shrink-0">❌</span>
              <div>
                <span className="text-xs font-bold text-white">{p.point} {p.name}</span>
                <p className="text-xs text-[#8892A4] mt-0.5">{p.note}</p>
              </div>
            </div>
          ))}
          {unablePoints.map((p) => (
            <div
              key={p.point}
              className="flex items-start gap-3 rounded-lg bg-[#2A2000] border border-[#B8860B]/30 px-3 py-2.5"
            >
              <span className="text-base flex-shrink-0">⚠️</span>
              <div>
                <span className="text-xs font-bold text-white">{p.point} {p.name}</span>
                <p className="text-xs text-[#8892A4] mt-0.5">{p.note}</p>
              </div>
            </div>
          ))}
          {passingPoints.map((p) => (
            <div
              key={p.point}
              className="flex items-start gap-3 rounded-lg bg-[#0D2E1E] border border-[#1A7A4A]/30 px-3 py-2.5"
            >
              <span className="text-base flex-shrink-0">✅</span>
              <div>
                <span className="text-xs font-bold text-white">{p.point} {p.name}</span>
                <p className="text-xs text-[#8892A4] mt-0.5">{p.note}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Stage 2 CTA or form */}
      {!rewriteResult && !showRewriteForm && (
        <div className="text-center">
          <Button
            onClick={() => setShowRewriteForm(true)}
            className="bg-[#1A7A4A] hover:bg-[#22A064] text-white font-semibold px-8 py-3 text-sm"
          >
            Fix This Post Free →
          </Button>
        </div>
      )}

      {showRewriteForm && !rewriteResult && (
        <Stage2Form
          auditScore={score}
          potentialScore={potentialScore}
          postUrl={url}
          scrapedTitle={title}
          scrapedBodyHtml={scrapedBodyHtml}
          scrapedMetaTitle={scrapedMetaTitle}
          scrapedMetaDescription={scrapedMetaDescription}
          focusKeyword={keyword}
          onSuccess={(result) => {
            setRewriteResult(result);
            setShowRewriteForm(false);
          }}
        />
      )}

      {rewriteResult && <RewriteDeliveryPanel result={rewriteResult} />}
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
            Paste any blog post URL and get an instant 16-point score with specific fixes.
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
            <span>✓ 16-point SEO check</span>
            <span>✓ Instant results</span>
            <span>✓ No credit card</span>
          </div>
        </div>

        {/* Audit results */}
        <div ref={resultsRef}>
          {auditResult && (
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
          )}
        </div>
      </main>
    </div>
  );
}
