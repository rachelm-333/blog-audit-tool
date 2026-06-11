/**
 * iAudit — Review & Edit Page (Layer 8 / Section 12 + Layer 9 / Section 13)
 *
 * Allows the user to review and edit the AI-rewritten post before approving it
 * for post-back to the CMS.
 *
 * Features:
 * - Rich-text body editor (TipTap)
 * - Meta title field with live character counter (red > 60)
 * - Meta description field with live counter (green 140-160, warn outside)
 * - Read-only fields: URL, author, publish date, status
 * - Image alt text list (editable per image)
 * - Auto-save every 30 seconds
 * - Manual Save button always visible
 * - Re-score on save — updates score/grade; shows point-specific warnings on regression
 * - Before/after score comparison (original audit vs rewrite)
 * - Export buttons: Plain Text, HTML, Markdown
 * - Approve and Post Back button — triggers real WordPress PATCH
 * - Post-back confirmation screen: title, score/grade badge, live link, Blog Batcher upsell
 * - Schema injection fallback: copyable JSON-LD block with exact spec message
 * - All 4 error states from Section 13.3
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation, useParams } from "wouter";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { trpc } from "@/lib/trpc";
import { useIauditAuth, getIauditUserId } from "@/hooks/useIauditAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Save,
  Download,
  ArrowLeft,
  ExternalLink,
  Clock,
  User,
  FileText,
  Code,
  AlignLeft,
  ChevronRight,
  Loader2,
  Send,
  Copy,
  PartyPopper,
  XCircle,
  RefreshCw,
} from "lucide-react";
import { HelpTooltip } from "@/components/HelpTooltip";

// ---------------------------------------------------------------------------
// Grade config (mirrors PostList.tsx)
// ---------------------------------------------------------------------------
const GRADE_CONFIG: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  optimised: {
    label: "Optimised",
    color: "text-emerald-400",
    bg: "bg-emerald-400/10",
  },
  strong: { label: "Strong", color: "text-blue-400", bg: "bg-blue-400/10" },
  needs_work: {
    label: "Needs Work",
    color: "text-amber-400",
    bg: "bg-amber-400/10",
  },
  poor: { label: "Poor", color: "text-orange-400", bg: "bg-orange-400/10" },
  critical: { label: "Critical", color: "text-red-400", bg: "bg-red-400/10" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

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
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
    .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
    .replace(/<ul[^>]*>|<\/ul>/gi, "\n")
    .replace(/<ol[^>]*>|<\/ol>/gi, "\n")
    .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function extractImgAlts(html: string): string[] {
  const matches = Array.from(html.matchAll(/<img[^>]*>/gi));
  return matches.map((m) => {
    const altMatch = m[0].match(/alt="([^"]*)"/i);
    return altMatch ? altMatch[1] : "";
  });
}

// ---------------------------------------------------------------------------
// GradeBadge
// ---------------------------------------------------------------------------
function GradeBadge({ grade, score }: { grade: string; score: number }) {
  const cfg = GRADE_CONFIG[grade] ?? GRADE_CONFIG.critical;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${cfg.color} ${cfg.bg}`}
    >
      {score}/16 · {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// MetaTitleField
// ---------------------------------------------------------------------------
function MetaTitleField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const len = value.length;
  const isGood = len >= 50 && len <= 60;
  const isOver = len > 60;
  const isShort = len > 0 && len < 50;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-foreground flex items-center">
          Meta Title
          <HelpTooltip text="The Meta Title is the headline that appears in Google search results. It should be 50–60 characters long and include your focus keyword. Keep it clear and descriptive — this is what people see before they click." />
        </label>
        <span
          className={`text-xs font-mono ${
            isGood
              ? "text-emerald-400 font-semibold"
              : isOver
                ? "text-red-400 font-bold"
                : isShort
                  ? "text-amber-400"
                  : "text-muted-foreground"
          }`}
        >
          {len}/60
          {isGood && " ✓ ideal length"}
          {isOver && " — too long, Google will truncate"}
          {isShort && " — too short (aim for 50–60)"}
        </span>
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`bg-card border-border text-foreground ${
          isOver
            ? "border-red-500 focus-visible:ring-red-500"
            : isShort
              ? "border-amber-500 focus-visible:ring-amber-500"
              : isGood
                ? "border-emerald-500"
                : ""
        }`}
        placeholder="Meta title (50–60 characters)"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MetaDescriptionField
// ---------------------------------------------------------------------------
function MetaDescriptionField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const len = value.length;
  const isGood = len >= 140 && len <= 160;
  const isOver = len > 160;
  const isShort = len > 0 && len < 140;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-foreground flex items-center">
          Meta Description
          <HelpTooltip text="The Meta Description is the short paragraph that appears under your title in Google search results. It should be 140–160 characters and include your focus keyword. It does not directly affect your ranking, but a good description gets more people to click." />
        </label>
        <span
          className={`text-xs font-mono ${
            isGood
              ? "text-emerald-400 font-semibold"
              : isOver
                ? "text-red-400 font-bold"
                : isShort
                  ? "text-amber-400"
                  : "text-muted-foreground"
          }`}
        >
          {len}/160
          {isGood && " ✓ ideal length"}
          {isOver && " — too long, Google will truncate"}
          {isShort && " — too short (aim for 140–160)"}
        </span>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className={`bg-card border-border text-foreground resize-none ${
          isOver
            ? "border-red-500 focus-visible:ring-red-500"
            : isShort
              ? "border-amber-500 focus-visible:ring-amber-500"
              : isGood
                ? "border-emerald-500"
                : ""
        }`}
        placeholder="Meta description (140–160 characters)"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScoreComparison
// ---------------------------------------------------------------------------
function ScoreComparison({
  auditScore,
  auditGrade,
  rewriteScore,
  rewriteGrade,
}: {
  auditScore: number | null;
  auditGrade: string | null;
  rewriteScore: number | null;
  rewriteGrade: string | null;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="text-[10px] text-muted-foreground w-24 shrink-0">Before rewrite:</div>
        {auditScore !== null && auditGrade ? (
          <GradeBadge grade={auditGrade} score={auditScore} />
        ) : (
          <span className="text-xs text-muted-foreground">Not audited</span>
        )}
      </div>
      {rewriteScore !== null && rewriteGrade && (
        <div className="flex items-center gap-2">
          <div className="text-[10px] text-muted-foreground w-24 shrink-0">After AI rewrite:</div>
          <GradeBadge grade={rewriteGrade} score={rewriteScore} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SeoScorePanel — full 16-point breakdown in the sidebar
// ---------------------------------------------------------------------------
type AuditPoint = { point: string; name: string; status: string; note: string };

function SeoScorePanel({
  currentScore,
  currentGrade,
  auditScore,
  auditGrade,
  rewriteScore,
  rewriteGrade,
  auditPoints,
}: {
  currentScore: number | null;
  currentGrade: string | null;
  auditScore: number | null;
  auditGrade: string | null;
  rewriteScore: number | null;
  rewriteGrade: string | null;
  auditPoints: AuditPoint[];
}) {
  const [expanded, setExpanded] = useState(true);
  const failing = auditPoints.filter((p) => p.status === "fail");
  const unscored = auditPoints.filter((p) => p.status === "unable_to_score");
  const passing = auditPoints.filter(
    (p) => p.status === "pass" || p.status === "na"
  );

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      {/* Score header */}
      <div className="p-4 space-y-3">
        <div className="text-sm font-semibold text-foreground">Current Score</div>
        {currentScore !== null && currentGrade ? (
          <>
            <GradeBadge grade={currentGrade} score={currentScore} />
            <p className="text-[10px] text-muted-foreground leading-tight">
              Score of the content in the editor. Updates when you save.
            </p>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Save to run re-score</span>
        )}
        <Separator />
        <ScoreComparison
          auditScore={auditScore}
          auditGrade={auditGrade}
          rewriteScore={rewriteScore}
          rewriteGrade={rewriteGrade}
        />
      </div>

      {/* 16-point breakdown */}
      {auditPoints.length > 0 && (
        <div className="border-t border-border">
          <button
            className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
            onClick={() => setExpanded((v) => !v)}
          >
            <span>Point Breakdown ({auditPoints.length})</span>
            <ChevronRight
              size={14}
              className={`transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>

          {expanded && (
            <div className="px-3 pb-3 space-y-2">
              {/* Failing */}
              {failing.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 mt-1">
                    Failing ({failing.length})
                  </div>
                  <div className="space-y-1.5">
                    {failing.map((p) => (
                      <div key={p.point}>
                        <div className="flex items-start gap-2 bg-red-500/5 border border-red-500/20 rounded-lg px-2.5 py-2">
                          <XCircle size={12} className="text-red-400 shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-foreground leading-tight">
                              {p.point} — {p.name}
                            </div>
                            {p.note && (
                              <div className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
                                {p.note}
                              </div>
                            )}
                          </div>
                        </div>
                        {/* P6 manual action callout */}
                        {p.point === "P6" && (
                          <div className="mt-1 ml-1 bg-amber-500/8 border border-amber-500/30 rounded-lg px-2.5 py-2 space-y-1">
                            <div className="flex items-center gap-1.5">
                              <AlertTriangle size={11} className="text-amber-400 shrink-0" />
                              <span className="text-[10px] font-semibold text-amber-400 uppercase tracking-wide">Manual action required after publishing</span>
                            </div>
                            <p className="text-[10px] text-muted-foreground leading-snug">
                              The URL slug cannot be changed here — it must be updated directly in your CMS after publishing. A keyword-rich slug looks like: <span className="font-mono text-foreground/80">/blog/your-focus-keyword-here</span>. Once updated, re-run the audit to confirm P6 passes.
                            </p>
                          </div>
                        )}
                        {/* P12 manual action callout */}
                        {p.point === "P12" && (
                          <div className="mt-1 ml-1 bg-amber-500/8 border border-amber-500/30 rounded-lg px-2.5 py-2 space-y-1">
                            <div className="flex items-center gap-1.5">
                              <AlertTriangle size={11} className="text-amber-400 shrink-0" />
                              <span className="text-[10px] font-semibold text-amber-400 uppercase tracking-wide">Manual action required — internal linking</span>
                            </div>
                            <p className="text-[10px] text-muted-foreground leading-snug">
                              Add a link in the body to a related post that is already live and published. Follow the content hierarchy: <span className="font-semibold text-foreground/80">Cluster → Pillar → Cornerstone</span>. Cluster posts link up to their pillar; pillar posts link up to the cornerstone. Never link to a draft or unpublished page — broken links hurt SEO.
                            </p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Unable to score */}
              {unscored.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 mt-1">
                    Unable to Score ({unscored.length})
                  </div>
                  <div className="space-y-1.5">
                    {unscored.map((p) => (
                      <div
                        key={p.point}
                        className="flex items-start gap-2 bg-amber-500/5 border border-amber-500/20 rounded-lg px-2.5 py-2"
                      >
                        <AlertTriangle size={12} className="text-amber-400 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-foreground leading-tight">
                            {p.point} — {p.name}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Passing */}
              {passing.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 mt-1">
                    Passing ({passing.length})
                  </div>
                  <div className="space-y-1">
                    {passing.map((p) => (
                      <div
                        key={p.point}
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-emerald-500/5 border border-emerald-500/15"
                      >
                        <CheckCircle2 size={12} className="text-emerald-400 shrink-0" />
                        <div className="text-xs text-foreground leading-tight">
                          {p.point} — {p.name}
                          {p.status === "na" && (
                            <span className="text-muted-foreground font-normal ml-1">(N/A)</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TipTap toolbar
// ---------------------------------------------------------------------------
function EditorToolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  if (!editor) return null;
  return (
    <div className="flex flex-wrap gap-1 p-2 border-b border-border bg-card/50">
      {[
        {
          label: "B",
          action: () => editor.chain().focus().toggleBold().run(),
          active: editor.isActive("bold"),
          title: "Bold",
        },
        {
          label: "I",
          action: () => editor.chain().focus().toggleItalic().run(),
          active: editor.isActive("italic"),
          title: "Italic",
        },
        {
          label: "H1",
          action: () =>
            editor.chain().focus().toggleHeading({ level: 1 }).run(),
          active: editor.isActive("heading", { level: 1 }),
          title: "Heading 1",
        },
        {
          label: "H2",
          action: () =>
            editor.chain().focus().toggleHeading({ level: 2 }).run(),
          active: editor.isActive("heading", { level: 2 }),
          title: "Heading 2",
        },
        {
          label: "H3",
          action: () =>
            editor.chain().focus().toggleHeading({ level: 3 }).run(),
          active: editor.isActive("heading", { level: 3 }),
          title: "Heading 3",
        },
        {
          label: "UL",
          action: () => editor.chain().focus().toggleBulletList().run(),
          active: editor.isActive("bulletList"),
          title: "Bullet list",
        },
        {
          label: "OL",
          action: () => editor.chain().focus().toggleOrderedList().run(),
          active: editor.isActive("orderedList"),
          title: "Numbered list",
        },
        {
          label: "—",
          action: () => editor.chain().focus().setHorizontalRule().run(),
          active: false,
          title: "Horizontal rule",
        },
      ].map((btn) => (
        <button
          key={btn.title}
          title={btn.title}
          onClick={btn.action}
          className={`px-2 py-1 text-xs rounded font-mono transition-colors ${
            btn.active
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          {btn.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PostBackConfirmation — shown after a successful post-back
// ---------------------------------------------------------------------------
interface PostBackConfirmationProps {
  postTitle: string;
  postUrl: string;
  rewriteScore: number | null;
  rewriteGrade: string | null;
  schemaInjected: boolean;
  schemaFallbackJson: string | null;
  showBlogBatcherUpsell: boolean;
  auditPoints?: Array<{ point: string; name: string; status: string; note: string }>;
  /** True if the original post had images that were preserved */
  hasImages: boolean;
  /** CMS platform — used to tailor the image notice wording */
  cmsPlatform: string;
  onDone: () => void;
}

function PostBackConfirmation({
  postTitle,
  postUrl,
  rewriteScore,
  rewriteGrade,
  schemaInjected,
  schemaFallbackJson,
  showBlogBatcherUpsell,
  hasImages,
  cmsPlatform,
  onDone,
  auditPoints = [],
}: PostBackConfirmationProps) {
  const [schemaCopied, setSchemaCopied] = useState(false);
  const p6Failing = auditPoints.some((p) => p.point === "P6" && p.status === "fail");
  const p12Failing = auditPoints.some((p) => p.point === "P12" && p.status === "fail");

  const handleCopySchema = () => {
    if (!schemaFallbackJson) return;
    navigator.clipboard.writeText(schemaFallbackJson);
    setSchemaCopied(true);
    setTimeout(() => setSchemaCopied(false), 2000);
  };

  return (
    <div className="flex items-center justify-center p-6">
      <div className="max-w-lg w-full space-y-6">
        {/* Success header */}
        <div className="text-center space-y-3">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-full bg-emerald-400/10 flex items-center justify-center">
              <PartyPopper size={32} className="text-emerald-400" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-foreground">
            Post published successfully!
          </h1>
          <p className="text-muted-foreground text-sm">
            Your optimised content is now live on your website.
          </p>
        </div>

        {/* Post details card */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">
              Post
            </div>
            <div className="font-semibold text-foreground">{postTitle}</div>
          </div>

          {rewriteScore !== null && rewriteGrade && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground uppercase tracking-wide">
                Final SEO Score
              </div>
              <GradeBadge grade={rewriteGrade} score={rewriteScore} />
            </div>
          )}

          <div className="space-y-1">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">
              Live URL
            </div>
            <a
              href={postUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline text-sm flex items-center gap-1 break-all"
            >
              {postUrl}
              <ExternalLink size={12} className="shrink-0" />
            </a>
          </div>

          {/* Schema injection status */}
          {schemaInjected && (
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <CheckCircle2 size={12} />
              Schema markup injected successfully.
            </div>
          )}
        </div>

        {/* Image placement notice — shown whenever the post had images */}
        {hasImages && (
          <div className="bg-blue-500/5 border border-blue-500/30 rounded-xl p-4 flex items-start gap-3">
            <div className="mt-0.5 shrink-0 text-blue-400">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            </div>
            <p className="text-sm text-blue-300">
              <span className="font-semibold">Images preserved.</span> Your original images have been placed at the top of the post. Please open your{" "}
              {cmsPlatform === "wix" ? "Wix" : cmsPlatform === "shopify" ? "Shopify" : cmsPlatform === "zapier" ? "CMS" : "WordPress"}{" "}
              editor and drag them to their preferred positions.
            </p>
          </div>
        )}

        {/* Schema fallback — shown if injection failed */}
        {!schemaInjected && schemaFallbackJson && (
          <div className="bg-amber-500/5 border border-amber-500/30 rounded-xl p-5 space-y-3">
            <div className="flex items-start gap-2">
              <AlertTriangle
                size={14}
                className="text-amber-400 mt-0.5 shrink-0"
              />
              <p className="text-sm text-amber-300">
                We could not inject schema automatically. Copy this code and
                paste it into your theme's header section or SEO plugin.
              </p>
            </div>
            <div className="relative">
              <pre className="text-[10px] text-muted-foreground bg-muted/30 rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap break-all font-mono">
                {schemaFallbackJson}
              </pre>
              <Button
                variant="ghost"
                size="sm"
                className="absolute top-1 right-1 text-xs h-6 px-2 gap-1"
                onClick={handleCopySchema}
              >
                {schemaCopied ? (
                  <>
                    <CheckCircle2 size={10} className="text-emerald-400" />{" "}
                    Copied
                  </>
                ) : (
                  <>
                    <Copy size={10} /> Copy
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Blog Batcher upsell — shown when credits = 0 */}
        {showBlogBatcherUpsell && (
          <div className="bg-blue-500/5 border border-blue-500/30 rounded-xl p-5 space-y-3">
            <div className="text-sm font-semibold text-blue-300">
              You've used all your credits
            </div>
            <p className="text-xs text-muted-foreground">
              All your existing posts are now optimised. Ready to create
              brand-new, SEO-optimised posts from scratch?{" "}
              <strong className="text-foreground">Blog Batcher</strong> is
              Noize's companion tool for building high-converting blog content
              from the start.
            </p>
              <a
              href="https://blogbatcher.com.au"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-400 hover:text-blue-300 hover:underline transition-colors"
            >
              Explore Blog Batcher
              <ExternalLink size={10} />
            </a>
          </div>
        )}

        {/* P6 manual action banner */}
        {p6Failing && (
          <div className="bg-amber-500/8 border border-amber-500/40 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle size={14} className="text-amber-400 shrink-0" />
              <span className="text-sm font-semibold text-amber-300">Action needed — Update the URL slug in your CMS</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              <strong className="text-foreground">P6 (Keyword in URL)</strong> is still failing. The URL slug must be updated manually in your CMS — it cannot be changed from here. A keyword-rich slug improves click-through rates and signals relevance to search engines.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Example: change <span className="font-mono text-foreground/70">/blog/post-123</span> to <span className="font-mono text-foreground/70">/blog/your-focus-keyword</span>. After updating, re-run the audit in iAudit to confirm P6 passes.
            </p>
          </div>
        )}

        {/* P12 manual action banner */}
        {p12Failing && (
          <div className="bg-amber-500/8 border border-amber-500/40 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle size={14} className="text-amber-400 shrink-0" />
              <span className="text-sm font-semibold text-amber-300">Action needed — Add an internal blog link</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              <strong className="text-foreground">P12 (Internal Blog Link)</strong> is still failing. Go back and add a link in the body to a related post that is <strong className="text-foreground">already live and published</strong>. Linking to a draft or unpublished page creates a broken link and hurts SEO.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Follow the content hierarchy: <strong className="text-foreground">Cluster → Pillar → Cornerstone</strong>. A cluster post should link up to its pillar page; a pillar post should link up to the cornerstone. This structure passes authority upward and strengthens the whole topic cluster.
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <Button
            className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white"
            onClick={onDone}
          >
            Back to Posts
          </Button>
          <Button variant="outline" asChild className="flex-1">
            <a href={postUrl} target="_blank" rel="noopener noreferrer">
              View Live Post
              <ExternalLink size={12} className="ml-1" />
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PartialFailureAlert — shown when content was written but meta failed
// ---------------------------------------------------------------------------
interface PartialFailureAlertProps {
  metaTitle: string;
  metaDescription: string;
  onDismiss: () => void;
}

function PartialFailureAlert({
  metaTitle,
  metaDescription,
  onDismiss,
}: PartialFailureAlertProps) {
  const [titleCopied, setTitleCopied] = useState(false);
  const [descCopied, setDescCopied] = useState(false);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-[#16213E] border border-amber-500/40 rounded-xl p-6 space-y-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={20} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div className="font-semibold text-foreground">
              Partial post-back
            </div>
            <p className="text-sm text-muted-foreground">
              Post body updated successfully, but meta title and meta description
              could not be written. Please update them manually in your CMS.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Meta Title</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-muted/30 rounded px-2 py-1 text-foreground break-all">
                {metaTitle}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs shrink-0 gap-1"
                onClick={() => {
                  navigator.clipboard.writeText(metaTitle);
                  setTitleCopied(true);
                  setTimeout(() => setTitleCopied(false), 2000);
                }}
              >
                {titleCopied ? (
                  <CheckCircle2 size={10} className="text-emerald-400" />
                ) : (
                  <Copy size={10} />
                )}
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">
              Meta Description
            </div>
            <div className="flex items-start gap-2">
              <code className="flex-1 text-xs bg-muted/30 rounded px-2 py-1 text-foreground break-all">
                {metaDescription}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs shrink-0 gap-1 mt-0.5"
                onClick={() => {
                  navigator.clipboard.writeText(metaDescription);
                  setDescCopied(true);
                  setTimeout(() => setDescCopied(false), 2000);
                }}
              >
                {descCopied ? (
                  <CheckCircle2 size={10} className="text-emerald-400" />
                ) : (
                  <Copy size={10} />
                )}
              </Button>
            </div>
          </div>
        </div>

        <Button
          className="w-full"
          variant="outline"
          onClick={onDismiss}
        >
          Got it — I'll update manually
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ReviewEdit component
// ---------------------------------------------------------------------------
export default function ReviewEdit() {
  const params = useParams();
  const postId = (params as Record<string, string>).postId;
  const [, navigate] = useLocation();
  const { user } = useIauditAuth();
  const iauditUserId = getIauditUserId();

  // ----- State -----
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [imageAlts, setImageAlts] = useState<string[]>([]);
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [currentScore, setCurrentScore] = useState<number | null>(null);
  const [currentGrade, setCurrentGrade] = useState<string | null>(null);
  const [currentAuditPoints, setCurrentAuditPoints] = useState<Array<{ point: string; name: string; status: string; note: string }>>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [approving, setApproving] = useState(false);
  // ----- Keyword editing state -----
  const [editingKeyword, setEditingKeyword] = useState(false);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [secondaryKeywordsDraft, setSecondaryKeywordsDraft] = useState("");
  const autoSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSavedRef = useRef<string>("");

  // ----- Post-back state -----
  const [postBackResult, setPostBackResult] = useState<{
    postTitle: string;
    postUrl: string;
    rewriteScore: number | null;
    rewriteGrade: string | null;
    schemaInjected: boolean;
    schemaFallbackJson: string | null;
    showBlogBatcherUpsell: boolean;
    auditPoints?: Array<{ point: string; name: string; status: string; note: string }>;
    hasImages: boolean;
    cmsPlatform: string;
  } | null>(null);

  const [partialFailure, setPartialFailure] = useState<{
    metaTitle: string;
    metaDescription: string;
  } | null>(null);
  const [rerunning, setRerunning] = useState(false);

  // ----- AI edit window state -----
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiEditing, setAiEditing] = useState(false);

  // ----- TipTap editor -----
  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false }),
      Image.configure({}),
    ],
    content: "",
    editorProps: {
      attributes: {
        class:
          "prose prose-invert prose-sm max-w-none min-h-[400px] p-4 focus:outline-none text-foreground",
      },
    },
  });

  // ----- Fetch post -----
  const { data: post, isLoading } = trpc.review.getPost.useQuery(
    { postId: postId ?? "", iauditUserId: iauditUserId ?? "" },
    { enabled: !!postId && !!iauditUserId, refetchOnWindowFocus: false }
  );

  // ----- Populate editor when post loads -----
  useEffect(() => {
    if (!post || !editor) return;
    const content = post.bodyApproved ?? post.bodyRewritten ?? post.bodyOriginal ?? "";
    editor.commands.setContent(content);
    setMetaTitle(post.metaTitleRewritten ?? post.metaTitleOriginal ?? "");
    setMetaDescription(
      post.metaDescriptionRewritten ?? post.metaDescriptionOriginal ?? ""
    );
    // Extract image alts from the content
    const alts = extractImgAlts(content);
    const storedAlts = (post.bodyImageAlts as string[] | null) ?? [];
    setImageAlts(alts.map((_, i) => storedAlts[i] ?? alts[i] ?? ""));
    // The top SEO Score badge shows the score of the CURRENT EDITOR CONTENT.
    // The editor is initialised with the rewritten body, so start from rewriteScore.
    // The original audit score (auditScore) is shown separately in the comparison row
    // and never changes — it reflects the pre-rewrite state.
    // After the user saves edits, currentScore updates to the re-scored value.
    setCurrentScore(post.rewriteScore ?? post.auditScore ?? null);
    setCurrentGrade(post.rewriteGrade ?? post.auditGrade ?? null);
    // Initialise audit points from stored rewrite results (prefer rewrite audit over original audit)
    const storedPoints = (post.auditResults as { points?: Array<{ point: string; name: string; status: string; note: string }> } | null)?.points ?? [];
    setCurrentAuditPoints(storedPoints);
    setKeywordDraft(post.focusKeyword ?? "");
    setSecondaryKeywordsDraft(
      Array.isArray(post.secondaryKeywords)
        ? (post.secondaryKeywords as string[]).join(", ")
        : (post.secondaryKeywords as string | null) ?? ""
    );
    lastSavedRef.current = content;
  }, [post, editor]);

  // ----- tRPC mutations -----
  const saveEditsMutation = trpc.review.saveEdits.useMutation({
    onSuccess: (data) => {
      setSaveStatus("saved");
      setCurrentScore(data.score);
      setCurrentGrade(data.grade);
      setWarnings(data.warnings);
      if (data.points) setCurrentAuditPoints(data.points as Array<{ point: string; name: string; status: string; note: string }>);
      if (data.warnings.length > 0) {
        toast.warning(
          `${data.warnings.length} point${data.warnings.length > 1 ? "s" : ""} regressed after your edit.`
        );
      } else {
        toast.success("Saved and re-scored.");
      }
      setTimeout(() => setSaveStatus("idle"), 3000);
    },
    onError: (err) => {
      setSaveStatus("error");
      toast.error(err.message ?? "Save failed. Please try again.");
      setTimeout(() => setSaveStatus("idle"), 3000);
    },
  });

  const saveKeywordMutation = trpc.keyword.saveKeyword.useMutation({
    onSuccess: () => {
      toast.success("Keyword saved. Re-run the audit to update your score.");
      setEditingKeyword(false);
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to save keyword.");
    },
  });

  // ----- Re-run Rewrite mutation -----
  const rerunRewriteMutation = trpc.rewrite.rerunRewrite.useMutation({
    onSuccess: (data: { rewriteScore: number; rewriteGrade: string; needsManualReview: boolean; message?: string }) => {
      setRerunning(false);
      setCurrentScore(data.rewriteScore);
      setCurrentGrade(data.rewriteGrade);
      if (data.needsManualReview && data.message) {
        toast.warning(data.message, { duration: 8000 });
      } else {
        toast.success(`Rewrite complete — scored ${data.rewriteScore}/16!`);
      }
      // Reload the page to get the new rewritten content
      window.location.reload();
    },
    onError: (err: { message?: string }) => {
      setRerunning(false);
      toast.error(err.message ?? "Re-run rewrite failed. Please try again.");
    },
  });

  const handleRerunRewrite = async () => {
    if (!postId || !iauditUserId || !post?.paaQuestion) {
      toast.error("Cannot re-run rewrite: missing PAA question. Please go back to Posts and start a new rewrite.");
      return;
    }
    setRerunning(true);
    rerunRewriteMutation.mutate({
      postId,
      iauditUserId,
      paaQuestion: post.paaQuestion,
    });
  };

  // ----- Apply AI Edit mutation -----
  const applyAiEditMutation = trpc.review.applyAiEdit.useMutation({
    onSuccess: (data) => {
      setAiEditing(false);
      if (editor) {
        editor.commands.setContent(data.updatedBody);
      }
      setAiInstruction("");
      toast.success("AI edit applied. Review the changes and click Save when happy.");
    },
    onError: (err) => {
      setAiEditing(false);
      toast.error(err.message ?? "AI edit failed. Please try again.");
    },
  });

  const handleApplyAiEdit = () => {
    if (!postId || !iauditUserId || !editor || !aiInstruction.trim()) return;
    setAiEditing(true);
    applyAiEditMutation.mutate({
      postId,
      iauditUserId,
      currentBody: editor.getHTML(),
      instruction: aiInstruction.trim(),
    });
  };

  const runPostBackMutation = trpc.postback.runPostBack.useMutation({
    onSuccess: (data) => {
      setApproving(false);
      setPostBackResult({
        postTitle: data.postTitle,
        postUrl: data.postUrl,
        rewriteScore: data.rewriteScore ?? null,
        rewriteGrade: data.rewriteGrade ?? null,
        schemaInjected: data.schemaInjected,
        schemaFallbackJson: data.schemaFallbackJson,
        showBlogBatcherUpsell: data.showBlogBatcherUpsell,
        auditPoints: currentAuditPoints,
        // Detect images from the stored original body
        hasImages: !!(post?.bodyOriginal && /<img\b/i.test(post.bodyOriginal)),
        cmsPlatform: (post as any)?.cmsPlatform ?? "wordpress",
      });
    },
    onError: (err) => {
      setApproving(false);
      const cause = (err.data as any)?.cause as
        | { errorCode?: string; partialData?: { contentWritten?: boolean; metaTitle?: string; metaDescription?: string } }
        | undefined;

      // Error state 4: Partial failure
      if (cause?.errorCode === "partial_failure" && cause.partialData) {
        setPartialFailure({
          metaTitle: cause.partialData.metaTitle ?? metaTitle,
          metaDescription: cause.partialData.metaDescription ?? metaDescription,
        });
        // Navigate to posts after dismissal (post was partially written)
        return;
      }

      // Error state 1: Connection lost
      if (cause?.errorCode === "connection_lost") {
        const platformName = (cause as any)?.platform === "wix" ? "Wix" : (cause as any)?.platform === "shopify" ? "Shopify" : "WordPress";
        toast.error(
          `Your CMS connection has been lost. Please reconnect your ${platformName} site before posting back.`,
          { duration: 8000 }
        );
        return;
      }

      // Error state 2: Post not found in CMS
      if (cause?.errorCode === "post_not_found") {
        toast.error(
          "This post no longer exists in your CMS — it may have been deleted. Use the Export buttons to save a copy.",
          { duration: 10000 }
        );
        return;
      }

      // Error state 3: Insufficient permissions
      if (cause?.errorCode === "insufficient_permissions") {
        toast.error(
          "iAudit does not have permission to update posts in your CMS. Please check your API credentials have write access, then reconnect.",
          { duration: 10000 }
        );
        return;
      }

      // Error state 5: Image loss risk — safety gate fired, nothing was written
      if (cause?.errorCode === "image_loss_risk") {
        toast.error(
          "Post-back blocked — your images could not be safely preserved. Your Wix post has NOT been changed. Please contact support.",
          { duration: 12000 }
        );
        return;
      }

      // Generic error
      toast.error(err.message ?? "Post-back failed. Please try again.");
    },
  });

  // ----- Save handler -----
  const handleSave = useCallback(async () => {
    if (!editor || !postId || !iauditUserId) return;
    const bodyHtml = editor.getHTML();
    setSaveStatus("saving");
    lastSavedRef.current = bodyHtml;
    saveEditsMutation.mutate({
      postId,
      iauditUserId,
      bodyApproved: bodyHtml,
      metaTitleRewritten: metaTitle,
      metaDescriptionRewritten: metaDescription,
      bodyImageAlts: imageAlts,
    });
  }, [
    editor,
    postId,
    iauditUserId,
    metaTitle,
    metaDescription,
    imageAlts,
    saveEditsMutation,
  ]);

  // ----- Auto-save every 30 seconds -----
  useEffect(() => {
    if (!editor) return;
    autoSaveTimerRef.current = setInterval(() => {
      const current = editor.getHTML();
      if (current !== lastSavedRef.current && saveStatus === "idle") {
        handleSave();
      }
    }, 30_000);
    return () => {
      if (autoSaveTimerRef.current) clearInterval(autoSaveTimerRef.current);
    };
  }, [editor, handleSave, saveStatus]);

  // ----- Approve and Post Back handler -----
  const handleApprove = async () => {
    if (!postId || !iauditUserId) return;
    setApproving(true);
    // Save first to ensure latest edits are persisted
    await handleSave();
    // Trigger the real post-back
    runPostBackMutation.mutate({ postId, iauditUserId });
  };

  // ----- Export handlers -----
  const handleExportPlainText = () => {
    if (!editor) return;
    const text = stripHtml(editor.getHTML());
    downloadFile(text, `${post?.title ?? "post"}.txt`, "text/plain");
  };

  const handleExportHtml = () => {
    if (!editor) return;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${metaTitle}</title>
  <meta name="description" content="${metaDescription}">
</head>
<body>
${editor.getHTML()}
</body>
</html>`;
    downloadFile(html, `${post?.title ?? "post"}.html`, "text/html");
  };

  const handleExportMarkdown = () => {
    if (!editor) return;
    const md = htmlToMarkdown(editor.getHTML());
    downloadFile(md, `${post?.title ?? "post"}.md`, "text/markdown");
  };

  // ----- Format date helper -----
  const formatDate = (d: Date | null | undefined) => {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  // ----- Post-back confirmation screen -----
  if (postBackResult) {
    return (
      <PostBackConfirmation
        {...postBackResult}
        onDone={() => navigate("/posts")}
      />
    );
  }

  // ----- Loading / auth guard -----
  if (!iauditUserId) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-muted-foreground">
          Please log in to review posts.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  if (!post) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-muted-foreground">Post not found.</p>
      </div>
    );
  }

  const hasRewrite = !!post.bodyRewritten;

  return (
    <div className="">
      {/* Partial failure overlay */}
      {partialFailure && (
        <PartialFailureAlert
          metaTitle={partialFailure.metaTitle}
          metaDescription={partialFailure.metaDescription}
          onDismiss={() => {
            setPartialFailure(null);
            navigate("/posts");
          }}
        />
      )}

      {/* Top bar */}
      <div className="sticky top-0 z-30 bg-[#16213E] border-b border-border px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => navigate("/posts")}
          >
            <ArrowLeft size={14} />
            Posts
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <span className="text-sm font-medium truncate max-w-xs">
            {post.title}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Save status indicator */}
          <span className="text-xs text-muted-foreground mr-1">
            {saveStatus === "saving" && (
              <span className="flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" /> Saving…
              </span>
            )}
            {saveStatus === "saved" && (
              <span className="flex items-center gap-1 text-emerald-400">
                <CheckCircle2 size={12} /> Saved
              </span>
            )}
            {saveStatus === "error" && (
              <span className="flex items-center gap-1 text-red-400">
                <AlertTriangle size={12} /> Save failed
              </span>
            )}
          </span>

          {/* Export buttons */}
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs text-slate-200 border-slate-600 hover:bg-slate-700 hover:text-white bg-slate-800"
            onClick={handleExportPlainText}
            title="Export as plain text"
          >
            <AlignLeft size={12} />
            Text
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs text-slate-200 border-slate-600 hover:bg-slate-700 hover:text-white bg-slate-800"
            onClick={handleExportHtml}
            title="Export as HTML"
          >
            <Code size={12} />
            HTML
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs text-slate-200 border-slate-600 hover:bg-slate-700 hover:text-white bg-slate-800"
            onClick={handleExportMarkdown}
            title="Export as Markdown"
          >
            <FileText size={12} />
            .md
          </Button>

          {/* Manual save */}
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs text-slate-200 border-slate-600 hover:bg-slate-700 hover:text-white bg-slate-800"
            onClick={handleSave}
            disabled={saveStatus === "saving"}
          >
            <Save size={12} />
            Save
          </Button>

          {/* Re-run Rewrite */}
          {hasRewrite && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-xs text-amber-300 border-amber-600/50 hover:bg-amber-900/30 hover:text-amber-200 bg-amber-900/20"
              onClick={handleRerunRewrite}
              disabled={rerunning || approving}
              title="Re-run the rewrite with the latest improvements"
            >
              {rerunning ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              {rerunning ? "Rewriting…" : "Re-run Rewrite"}
            </Button>
          )}

          {/* Approve and Post Back */}
          <Button
            size="sm"
            className="gap-1 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
            onClick={handleApprove}
            disabled={approving || !hasRewrite}
            title={
              !hasRewrite
                ? "Run the rewrite first before approving."
                : "Save and post back to your CMS"
            }
          >
            {approving ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Send size={12} />
            )}
            {approving ? "Posting…" : "Approve & Post Back"}
          </Button>
        </div>
      </div>

      {/* Main layout */}
      <div className="max-w-7xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        {/* Left: editor */}
        <div className="space-y-5">
          {/* Regression warnings */}
          {warnings.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 space-y-1">
              <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm">
                <AlertTriangle size={14} />
                Your edit has introduced SEO regressions
              </div>
              {warnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-300 pl-5">
                  {w}
                </p>
              ))}
            </div>
          )}

          {/* Meta title */}
          <MetaTitleField value={metaTitle} onChange={setMetaTitle} />

          {/* Meta description */}
          <MetaDescriptionField
            value={metaDescription}
            onChange={setMetaDescription}
          />

          {/* Body editor */}
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">
              Post Body
            </label>
            <div className="border border-border rounded-lg overflow-hidden bg-card">
              <EditorToolbar editor={editor} />
              <EditorContent editor={editor} />
            </div>
          </div>

          {/* AI Edit Window */}
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <ChevronRight size={14} className="text-primary" />
              <span className="text-sm font-semibold text-foreground">AI Edit</span>
              <span className="text-xs text-muted-foreground ml-1">— type an instruction and AI will apply it to the article</span>
            </div>
            <div className="p-4 space-y-3">
              <Textarea
                value={aiInstruction}
                onChange={(e) => setAiInstruction(e.target.value)}
                placeholder='e.g. "Restore the original FAQ section" or "Make the intro paragraph more conversational" or "Add a transition sentence between the second and third sections"'
                className="bg-card border-border text-foreground text-sm min-h-[80px] resize-none"
                disabled={aiEditing}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleApplyAiEdit();
                  }
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {aiInstruction.length}/1000 · Ctrl+Enter to apply
                </span>
                <Button
                  size="sm"
                  className="gap-1 text-xs bg-violet-600 hover:bg-violet-500 text-white"
                  onClick={handleApplyAiEdit}
                  disabled={aiEditing || !aiInstruction.trim() || aiInstruction.length > 1000}
                >
                  {aiEditing ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      Applying…
                    </>
                  ) : (
                    <>
                      <Send size={12} />
                      Apply Edit
                    </>
                  )}
                </Button>
              </div>
              {aiEditing && (
                <p className="text-xs text-muted-foreground">
                  AI is editing the article… this may take 15–30 seconds.
                </p>
              )}
            </div>
          </div>

          {/* Image alt texts */}
          {imageAlts.length > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Image Alt Texts ({imageAlts.length})
              </label>
              <div className="space-y-2">
                {imageAlts.map((alt, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-16 shrink-0">
                      Image {i + 1}
                    </span>
                    <Input
                      value={alt}
                      onChange={(e) => {
                        const next = [...imageAlts];
                        next[i] = e.target.value;
                        setImageAlts(next);
                      }}
                      className="bg-card border-border text-foreground text-xs h-8"
                      placeholder={`Alt text for image ${i + 1}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: sidebar */}
        <div className="space-y-5">
          {/* Score panel — full 16-point breakdown */}
          <SeoScorePanel
            currentScore={currentScore}
            currentGrade={currentGrade}
            auditScore={post.auditScore ?? null}
            auditGrade={post.auditGrade ?? null}
            rewriteScore={post.rewriteScore ?? null}
            rewriteGrade={post.rewriteGrade ?? null}
            auditPoints={currentAuditPoints}
          />

          {/* Post metadata (read-only) */}
          <div className="bg-card border border-border rounded-lg p-4 space-y-3">
            <div className="text-sm font-semibold text-foreground">
              Post Details
            </div>
            <div className="space-y-2 text-xs">
              {/* URL */}
              <div className="flex items-start gap-2">
                <ExternalLink
                  size={12}
                  className="text-muted-foreground mt-0.5 shrink-0"
                />
                <div className="min-w-0">
                  <div className="text-muted-foreground mb-0.5">URL</div>
                  <a
                    href={post.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline break-all"
                    title="This URL is read-only — it is preserved exactly as it was in your CMS."
                  >
                    {post.url}
                  </a>
                  <div className="text-muted-foreground/60 text-[10px] mt-0.5">
                    Read-only · URL is never changed
                  </div>
                </div>
              </div>
              {/* Author */}
              <div className="flex items-center gap-2">
                <User
                  size={12}
                  className="text-muted-foreground shrink-0"
                />
                <div>
                  <span className="text-muted-foreground">Author: </span>
                  <span className="text-foreground">{post.authorNameCms}</span>
                </div>
              </div>
              {/* Status */}
              <div className="flex items-center gap-2">
                <FileText
                  size={12}
                  className="text-muted-foreground shrink-0"
                />
                <div>
                  <span className="text-muted-foreground">Status: </span>
                  <Badge variant="outline" className="text-[10px] h-4 px-1">
                    {post.status}
                  </Badge>
                </div>
              </div>
              {/* Publish date */}
              {(post.publishDate ?? post.scheduledDate) && (
                <div className="flex items-center gap-2">
                  <Clock
                    size={12}
                    className="text-muted-foreground shrink-0"
                  />
                  <div>
                    <span className="text-muted-foreground">
                      {post.scheduledDate ? "Scheduled: " : "Published: "}
                    </span>
                    <span className="text-foreground">
                      {formatDate(post.scheduledDate ?? post.publishDate)}
                    </span>
                  </div>
                </div>
              )}
              {/* Focus keyword — editable */}
              <div className="pt-1">
                {editingKeyword ? (
                  <div className="space-y-2">
                    <div>
                      <label className="text-xs text-muted-foreground flex items-center mb-1">Focus Keyword <HelpTooltip text="Your focus keyword is the main phrase this post is trying to rank for in Google. Every post should have exactly one. iAudit checks that this keyword appears in the right places throughout your post." /></label>
                      <Input
                        value={keywordDraft}
                        onChange={(e) => setKeywordDraft(e.target.value)}
                        placeholder="e.g. pool installation cost"
                        className="text-sm h-8"
                        autoFocus
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground flex items-center mb-1">Secondary Keywords <span className="font-normal ml-1">(comma-separated)</span><HelpTooltip text="Secondary keywords are related phrases that support your main focus keyword. Separate them with commas. iAudit weaves these into the rewritten post to help it appear in more searches without losing focus on the main topic." /></label>
                      <Input
                        value={secondaryKeywordsDraft}
                        onChange={(e) => setSecondaryKeywordsDraft(e.target.value)}
                        placeholder="e.g. pool cost, inground pool price"
                        className="text-sm h-8"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 h-7 text-xs"
                        onClick={() => { setEditingKeyword(false); setKeywordDraft(post.focusKeyword ?? ""); setSecondaryKeywordsDraft(Array.isArray(post.secondaryKeywords) ? (post.secondaryKeywords as string[]).join(", ") : (post.secondaryKeywords as string | null) ?? ""); }}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="flex-1 h-7 text-xs"
                        disabled={saveKeywordMutation.isPending || !keywordDraft.trim()}
                        onClick={() => {
                          if (!postId || !iauditUserId) return;
                          const secondaryArr = secondaryKeywordsDraft
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean);
                          saveKeywordMutation.mutate({
                            postId,
                            iauditUserId,
                            focusKeyword: keywordDraft.trim(),
                            secondaryKeywords: secondaryArr,
                          });
                        }}
                      >
                        {saveKeywordMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : "Save Keyword"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-muted-foreground text-xs">Keyword:</span>
                    {post.focusKeyword ? (
                      <Badge variant="outline" className="text-[10px] h-4 px-1 text-violet-400 border-violet-400/40">
                        {post.focusKeyword}
                      </Badge>
                    ) : (
                      <span className="text-xs text-amber-400">No keyword set</span>
                    )}
                    {Array.isArray(post.secondaryKeywords) && (post.secondaryKeywords as string[]).length > 0 && (
                      <span className="text-xs text-muted-foreground">+{(post.secondaryKeywords as string[]).length} secondary</span>
                    )}
                    <button
                      className="text-xs text-primary hover:underline ml-auto"
                      onClick={() => setEditingKeyword(true)}
                    >
                      Edit
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Schema JSON preview — always shown when schema exists */}
          {!!post.schemaJson && (
            <div className="bg-card border border-border rounded-lg p-4 space-y-2">
              <div className="text-sm font-semibold text-foreground flex items-center">
                Schema Markup
                <HelpTooltip text="Schema markup is invisible code that tells Google what your page is about. It can help your post appear with star ratings, FAQs, or other rich results in Google. iAudit generates this automatically and injects it when you post back to your website." />
              </div>
              <p className="text-xs text-muted-foreground">
                iAudit will attempt to inject this schema automatically when you
                post back. If injection fails, a copyable fallback will be shown.
              </p>
              <div className="relative">
                <pre className="text-[10px] text-muted-foreground bg-muted/30 rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap break-all">
                  {JSON.stringify(post.schemaJson as Record<string, unknown>, null, 2)}
                </pre>
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute top-1 right-1 text-xs h-6 px-2 gap-1"
                  onClick={() => {
                    navigator.clipboard.writeText(
                      JSON.stringify(post.schemaJson, null, 2)
                    );
                    toast.success("Schema copied to clipboard.");
                  }}
                >
                  <Copy size={10} /> Copy
                </Button>
              </div>
            </div>
          )}

          {/* Export section (mobile duplicate — always visible) */}
          <div className="bg-card border border-border rounded-lg p-4 space-y-2 lg:hidden">
            <div className="text-sm font-semibold text-foreground">Export</div>
            <div className="flex gap-2 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                className="gap-1 text-xs"
                onClick={handleExportPlainText}
              >
                <Download size={12} /> Plain Text
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1 text-xs"
                onClick={handleExportHtml}
              >
                <Download size={12} /> HTML
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1 text-xs"
                onClick={handleExportMarkdown}
              >
                <Download size={12} /> Markdown
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
