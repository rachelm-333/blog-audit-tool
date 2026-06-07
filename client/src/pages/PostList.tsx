/**
 * iAudit — Post List (Layers 5, 6 + 7)
 *
 * Displays all imported posts for a business with:
 * - Keyword status badge (cms_scraped / ai_suggested / user_entered / missing)
 * - AI keyword suggestion modal (3 clickable options + custom text input)
 * - Cannibalisation warning banner linking to both conflicting posts
 * - Fix button disabled with tooltip when cannibalization_flag is set
 * - Audit All button with progress indicator (Layer 6)
 * - Per-post audit results panel (score, grade badge, passing/failing points) (Layer 6)
 * - Dashboard overview (health score, grade breakdown, score potential) (Layer 6)
 * - Fix This Post rewrite flow: PAA modal → progress → result panel (Layer 7)
 */
import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useIauditAuth, getIauditUserId } from "@/hooks/useIauditAuth";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import {
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  Tag,
  ArrowLeft,
  RefreshCw,
  BarChart3,
  ChevronDown,
  ChevronUp,
  XCircle,
  Minus,
  Zap,
  FileText,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { HelpTooltip } from "@/components/HelpTooltip";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Post {
  id: string;
  title: string;
  url: string;
  focusKeyword: string | null;
  keywordSource: string | null;
  cannibalizationFlag: boolean;
  auditStatus?: string | null;
  auditScore?: number | null;
  auditGrade?: string | null;
  rewriteStatus?: string | null;
  rewriteScore?: number | null;
  rewriteGrade?: string | null;
}

interface AuditPoint {
  point: string;
  name: string;
  status: string;
  note: string;
}

// ---------------------------------------------------------------------------
// Grade helpers
// ---------------------------------------------------------------------------

const GRADE_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; border: string }
> = {
  optimised: {
    label: "Optimised",
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
  },
  strong: {
    label: "Strong",
    color: "text-sky-400",
    bg: "bg-sky-500/10",
    border: "border-sky-500/30",
  },
  needs_work: {
    label: "Needs Work",
    color: "text-yellow-400",
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/30",
  },
  poor: {
    label: "Poor",
    color: "text-orange-400",
    bg: "bg-orange-500/10",
    border: "border-orange-500/30",
  },
  critical: {
    label: "Critical",
    color: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/30",
  },
};

function GradeBadge({ grade }: { grade: string | null | undefined }) {
  if (!grade) return null;
  const cfg = GRADE_CONFIG[grade] ?? GRADE_CONFIG.critical;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${cfg.color} ${cfg.bg} border ${cfg.border}`}
    >
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Keyword Status Badge
// ---------------------------------------------------------------------------

function KeywordBadge({
  source,
  keyword,
}: {
  source: string | null;
  keyword: string | null;
}) {
  if (!keyword) {
    return (
      <Badge
        variant="outline"
        className="text-amber-400 border-amber-400/40 bg-amber-400/5 text-xs gap-1"
      >
        <Tag size={10} />
        No keyword
      </Badge>
    );
  }
  const sourceConfig: Record<
    string,
    { label: string; className: string }
  > = {
    cms_scraped: {
      label: "CMS",
      className:
        "text-sky-400 border-sky-400/40 bg-sky-400/5",
    },
    user_entered: {
      label: "Custom",
      className:
        "text-emerald-400 border-emerald-400/40 bg-emerald-400/5",
    },
  };
  const cfg = sourceConfig[source ?? ""] ?? {
    label: "Set",
    className: "text-muted-foreground border-border",
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={`text-xs gap-1 cursor-default max-w-[160px] ${cfg.className}`}
        >
          <CheckCircle2 size={10} />
          <span className="truncate">{keyword}</span>
          <span className="opacity-60 shrink-0">· {cfg.label}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        Focus keyword: <strong>{keyword}</strong> (source: {source ?? "unknown"})
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Audit Results Panel
// ---------------------------------------------------------------------------

function AuditResultsPanel({
  postId,
  iauditUserId,
  onClose,
  onFix,
}: {
  postId: string;
  iauditUserId: string;
  onClose: () => void;
  onFix?: () => void;
}) {
  const { data, isLoading } = trpc.audit.getPostResults.useQuery(
    { postId, iauditUserId },
    { enabled: !!postId && !!iauditUserId }
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="animate-spin text-primary" size={24} />
      </div>
    );
  }

  if (!data || !data.auditResults) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        No audit results available.
      </div>
    );
  }

  const { auditResults, auditScore, auditGrade } = data;
  const points: AuditPoint[] = auditResults.points ?? [];
  const passing = points.filter(
    (p) => p.status === "pass" || p.status === "na"
  );
  const failing = points.filter((p) => p.status === "fail");
  const unscored = points.filter((p) => p.status === "unable_to_score");

  const hasAiFailure = unscored.length > 0;

  return (
    <div className="space-y-4">
      {/* Score header */}
      <div className="flex items-center gap-3 pb-3 border-b border-border">
        <div className="text-3xl font-extrabold text-foreground">
          {auditScore ?? 0}
          <span className="text-lg font-normal text-muted-foreground">/16</span>
        </div>
        <GradeBadge grade={auditGrade} />
        <div className="ml-auto text-xs text-muted-foreground">
          Potential: {auditResults.potentialScore}/16
        </div>
      </div>

      {/* AI failure warning */}
      {hasAiFailure && (
        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5 text-xs text-amber-300">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>
            We could not complete the AI portion of this audit. The mechanical
            checks are shown below. Try re-running the audit.
          </span>
        </div>
      )}

      {/* Failing points */}
      {failing.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Failing ({failing.length})
          </div>
          <div className="space-y-1.5">
            {failing.map((p) => (
              <div
                key={p.point}
                className="flex items-start gap-2.5 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2"
              >
                <XCircle
                  size={14}
                  className="text-red-400 shrink-0 mt-0.5"
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-foreground">
                    {p.point} — {p.name}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {p.note}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unable to score */}
      {unscored.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Unable to Score ({unscored.length})
          </div>
          <div className="space-y-1.5">
            {unscored.map((p) => (
              <div
                key={p.point}
                className="flex items-start gap-2.5 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2"
              >
                <Minus size={14} className="text-amber-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-foreground">
                    {p.point} — {p.name}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Passing points */}
      {passing.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Passing ({passing.length})
          </div>
          <div className="space-y-1.5">
            {passing.map((p) => (
              <div
                key={p.point}
                className="flex items-start gap-2.5 bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-3 py-2"
              >
                <CheckCircle2
                  size={14}
                  className="text-emerald-400 shrink-0 mt-0.5"
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-foreground">
                    {p.point} — {p.name}
                    {p.status === "na" && (
                      <span className="ml-1 text-muted-foreground font-normal">
                        (N/A)
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {p.note}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fix CTA */}
      <div className="pt-2 border-t border-border">
        <Button
          size="sm"
          className="w-full gap-2 font-semibold"
          onClick={() => {
            onClose();
            onFix?.();
          }}
        >
          <Zap size={14} />
          Fix This Post · 1 Credit · Ready in ~2 minutes
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Overview Panel
// ---------------------------------------------------------------------------

function DashboardOverview({
  businessId,
  iauditUserId,
}: {
  businessId: string;
  iauditUserId: string;
}) {
  const { data, isLoading } = trpc.audit.getDashboard.useQuery(
    { businessId, iauditUserId },
    { enabled: !!businessId && !!iauditUserId, refetchInterval: 5000 }
  );

  if (isLoading || !data) {
    return (
      <div className="bg-card border border-border rounded-xl p-6 mb-6 animate-pulse h-28" />
    );
  }

  const { healthScore, healthGrade, gradeBreakdown, upliftBanner, cannibalisationWarnings, auditedCount, totalPosts } =
    data;

  if (auditedCount === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-6 mb-6 text-center">
        <BarChart3 size={24} className="text-muted-foreground mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">
          Run the audit to see your blog health score and grade breakdown.
        </p>
      </div>
    );
  }

  const gradeOrder = ["optimised", "strong", "needs_work", "poor", "critical"];

  return (
    <div className="bg-card border border-border rounded-xl p-5 mb-6 space-y-4">
      {/* Uplift banner */}
      {upliftBanner && (
        <div className="flex items-center gap-2 bg-primary/10 border border-primary/30 rounded-lg px-3 py-2.5 text-xs text-primary font-medium">
          <Zap size={14} className="shrink-0" />
          {upliftBanner}
        </div>
      )}

      {/* Health score + grade breakdown */}
      <div className="flex items-center gap-6 flex-wrap">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
            Blog Health Score
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-foreground">
              {healthScore ?? "—"}
            </span>
            <span className="text-sm text-muted-foreground">/16</span>
            <GradeBadge grade={healthGrade} />
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {auditedCount} of {totalPosts} posts audited
          </div>
        </div>

        {/* Grade breakdown */}
        <div className="flex-1 min-w-[200px]">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Grade Breakdown
          </div>
          <div className="flex gap-2 flex-wrap">
            {gradeOrder.map((grade) => {
              const count = gradeBreakdown[grade] ?? 0;
              if (count === 0) return null;
              const cfg = GRADE_CONFIG[grade];
              return (
                <div
                  key={grade}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs font-medium ${cfg.color} ${cfg.bg} ${cfg.border}`}
                >
                  <span className="font-bold">{count}</span>
                  <span className="opacity-80">{cfg.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Cannibalisation warnings */}
      {cannibalisationWarnings.length > 0 && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs text-red-300">
          <AlertTriangle size={14} className="shrink-0" />
          <span>
            {cannibalisationWarnings.length} keyword cannibalisation conflict
            {cannibalisationWarnings.length > 1 ? "s" : ""} detected. Resolve
            before rewriting.
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rewrite Result Panel (Layer 7)
// ---------------------------------------------------------------------------
function RewriteResultPanel({
  postId,
  iauditUserId,
  auditScore,
  auditGrade,
  onClose,
}: {
  postId: string;
  iauditUserId: string;
  auditScore: number | null;
  auditGrade: string | null;
  onClose: () => void;
}) {
  const { data, isLoading } = trpc.rewrite.getRewriteResult.useQuery(
    { postId, iauditUserId },
    { enabled: !!postId && !!iauditUserId }
  );
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="animate-spin text-primary" size={24} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="text-sm text-muted-foreground py-4 text-center">
        Rewrite result not available.
      </div>
    );
  }
  const improved =
    data.rewriteScore !== null &&
    auditScore !== null &&
    data.rewriteScore > auditScore;
  return (
    <div className="space-y-4">
      {/* Score comparison header */}
      <div className="flex items-center gap-4 pb-3 border-b border-border">
        <div>
          <div className="text-xs text-muted-foreground mb-0.5">Before</div>
          <div className="flex items-center gap-1.5">
            <span className="text-xl font-bold text-muted-foreground">
              {auditScore ?? "—"}/16
            </span>
            <GradeBadge grade={auditGrade} />
          </div>
        </div>
        {improved && (
          <div className="text-muted-foreground text-lg">→</div>
        )}
        <div>
          <div className="text-xs text-muted-foreground mb-0.5">After</div>
          <div className="flex items-center gap-1.5">
            <span className="text-xl font-bold text-foreground">
              {data.rewriteScore ?? "—"}/16
            </span>
            <GradeBadge grade={data.rewriteGrade} />
          </div>
        </div>
        {data.rewriteStatus === "needs_manual_review" && (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-amber-400">
            <AlertTriangle size={14} />
            Needs manual review
          </div>
        )}
      </div>
      {/* PAA question */}
      {data.paaQuestion && (
        <div className="bg-card border border-border rounded-lg px-4 py-3">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
            PAA Question Answered
          </div>
          <div className="text-sm text-foreground">{data.paaQuestion}</div>
        </div>
      )}
      {/* Meta title */}
      {data.metaTitleRewritten && (
        <div className="bg-card border border-border rounded-lg px-4 py-3">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
            Meta Title
          </div>
          <div className="text-sm text-foreground">{data.metaTitleRewritten}</div>
        </div>
      )}
      {/* Meta description */}
      {data.metaDescriptionRewritten && (
        <div className="bg-card border border-border rounded-lg px-4 py-3">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
            Meta Description
          </div>
          <div className="text-sm text-foreground">{data.metaDescriptionRewritten}</div>
        </div>
      )}
      {/* Rewritten body preview */}
      {data.bodyRewritten && (
        <div className="bg-card border border-border rounded-lg px-4 py-3">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Rewritten Content Preview
          </div>
          <div className="text-sm text-foreground whitespace-pre-wrap line-clamp-12 font-mono text-xs leading-relaxed">
            {data.bodyRewritten.slice(0, 1200)}
            {data.bodyRewritten.length > 1200 && (
              <span className="text-muted-foreground"> … (truncated)</span>
            )}
          </div>
        </div>
      )}
      {/* Close */}
      <div className="pt-1">
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={onClose}
        >
          Close
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rewrite Modal (Layer 7) — PAA confirmation → running → result summary
// ---------------------------------------------------------------------------
function RewriteModal({
  post,
  open,
  step,
  paaQuestion,
  paaSuggested,
  paaLoading,
  onPaaChange,
  onConfirm,
  onClose,
  rewriteResult,
}: {
  post: Post | null;
  open: boolean;
  step: "paa" | "running" | "result" | "view_result";
  paaQuestion: string;
  paaSuggested: string;
  paaLoading: boolean;
  onPaaChange: (v: string) => void;
  onConfirm: (mode: "full_rewrite" | "smart_patch") => void;
  onClose: () => void;
  rewriteResult?: { rewriteScore: number; rewriteGrade: string; needsManualReview: boolean; message?: string } | null;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap size={18} className="text-primary" />
            {step === "paa" && "Fix This Post"}
            {step === "running" && "Rewriting…"}
            {step === "result" && "Rewrite Complete"}
          </DialogTitle>
          {step === "paa" && (
            <DialogDescription>
              Confirm the PAA question to answer in this post. The rewrite will
              open with a direct answer to this question.
            </DialogDescription>
          )}
        </DialogHeader>

        {/* PAA step */}
        {step === "paa" && (
          <div className="space-y-4 pt-2">
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">
                People Also Ask question
              </label>
              {paaLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  Looking up top PAA question…
                </div>
              ) : (
                <>
                  {paaSuggested && (
                    <button
                      type="button"
                      className={`w-full text-left text-sm rounded-lg border px-3 py-2.5 mb-2 transition-colors ${
                        paaQuestion === paaSuggested
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border hover:border-primary/50 text-foreground"
                      }`}
                      onClick={() => onPaaChange(paaSuggested)}
                    >
                      <span className="text-xs text-muted-foreground block mb-0.5">Suggested</span>
                      {paaSuggested}
                    </button>
                  )}
                  <Input
                    placeholder="Or type your own PAA question…"
                    value={paaQuestion === paaSuggested ? "" : paaQuestion}
                    onChange={(e) => onPaaChange(e.target.value)}
                    className="text-sm"
                  />
                </>
              )}
            </div>
            <div className="space-y-2 pt-1">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center mb-1">
                Choose rewrite mode
                <HelpTooltip text="Full Rewrite rebuilds the entire post from scratch to fix all 16 SEO points — best for posts scoring below 8/16. Smart Patch makes targeted fixes while keeping your writing style — best for posts scoring 8/16 or above. Both use 1 credit." />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                    !paaQuestion.trim() || paaLoading
                      ? "opacity-50 cursor-not-allowed border-border"
                      : "border-primary bg-primary/10 hover:bg-primary/20 cursor-pointer"
                  }`}
                  disabled={!paaQuestion.trim() || paaLoading}
                  onClick={() => onConfirm("full_rewrite")}
                >
                  <span className="text-xs font-semibold text-primary flex items-center gap-1"><Zap size={12} /> Full Rewrite</span>
                  <span className="text-[11px] text-muted-foreground">AI rewrites the entire post from scratch targeting all 16 points.</span>
                  <span className="text-[10px] text-muted-foreground mt-0.5">1 Credit</span>
                </button>
                <button
                  type="button"
                  className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                    !paaQuestion.trim() || paaLoading
                      ? "opacity-50 cursor-not-allowed border-border"
                      : "border-violet-400/60 bg-violet-400/5 hover:bg-violet-400/10 cursor-pointer"
                  }`}
                  disabled={!paaQuestion.trim() || paaLoading}
                  onClick={() => onConfirm("smart_patch")}
                >
                  <span className="text-xs font-semibold text-violet-400 flex items-center gap-1"><Zap size={12} /> Smart Patch</span>
                  <span className="text-[11px] text-muted-foreground">Keeps your author's voice. Makes only the minimum changes to fix failing points.</span>
                  <span className="text-[10px] text-muted-foreground mt-0.5">1 Credit</span>
                </button>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={onClose}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Running step */}
        {step === "running" && (
          <div className="space-y-4 py-4">
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={32} className="animate-spin text-primary" />
              <div className="text-sm text-foreground font-medium">
                Rewriting {post?.title ?? "post"}…
              </div>
              <div className="text-xs text-muted-foreground text-center max-w-xs">
                Running two-pass AI rewrite with SEO enforcement. This usually
                takes 30–90 seconds.
              </div>
            </div>
          </div>
        )}

        {/* Result step */}
        {step === "result" && rewriteResult && (
          <div className="space-y-4 pt-2">
            {rewriteResult.needsManualReview ? (
              <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-3 text-sm text-amber-300">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold mb-0.5">Needs Manual Review</div>
                  <div className="text-xs">
                    {rewriteResult.message ?? "The rewrite scored below 13/16 after two attempts. Your credit has been refunded."}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-3 text-sm text-emerald-300">
                <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold mb-0.5">Rewrite Complete</div>
                  <div className="text-xs">
                    Scored {rewriteResult.rewriteScore}/16
                    ({GRADE_CONFIG[rewriteResult.rewriteGrade]?.label ?? rewriteResult.rewriteGrade}).
                    The rewritten content is ready to review.
                  </div>
                </div>
              </div>
            )}
            <Button size="sm" className="w-full" onClick={onClose}>
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Set Keyword Modal (replaces AI suggestion — user enters keyword manually)
// ---------------------------------------------------------------------------
function KeywordSuggestionModal({
  post,
  open,
  onClose,
  onConfirmed,
}: {
  post: Post | null;
  open: boolean;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const iauditUserId = getIauditUserId();
  const [keyword, setKeyword] = useState("");
  const confirmMutation = trpc.keyword.confirm.useMutation();

  useEffect(() => {
    if (!open) setKeyword("");
  }, [open]);

  const handleConfirm = useCallback(() => {
    const kw = keyword.trim();
    if (!kw || !post?.id || !iauditUserId) return;
    confirmMutation.mutate(
      { postId: post.id, keyword: kw, source: "user_entered", iauditUserId },
      {
        onSuccess: () => {
          toast.success(`Keyword saved: "${kw}"`);
          onConfirmed();
          onClose();
        },
        onError: () => {
          toast.error("Failed to save keyword. Please try again.");
        },
      }
    );
  }, [keyword, post?.id, iauditUserId, confirmMutation, onConfirmed, onClose]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Set Focus Keyword</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground leading-relaxed">
            Enter the primary keyword this post should rank for. You can also
            add secondary keywords in the Review &amp; Edit page. Changing the
            keyword after an audit has run will require a full re-audit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          <Input
            placeholder="e.g. pool installation cost"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleConfirm()}
            className="text-sm"
            autoFocus
          />
          <Button
            className="w-full font-semibold"
            disabled={confirmMutation.isPending || keyword.trim().length === 0}
            onClick={handleConfirm}
          >
            {confirmMutation.isPending ? (
              <Loader2 className="animate-spin" size={14} />
            ) : (
              "Save Keyword"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Cannibalisation Banner
// ---------------------------------------------------------------------------

function CannibalisationBanner({
  duplicateGroups,
  postMap,
}: {
  duplicateGroups: Array<{ keyword: string; postIds: string[] }>;
  postMap: Map<string, Post>;
}) {
  if (duplicateGroups.length === 0) return null;
  return (
    <div className="bg-red-950/40 border border-red-500/30 rounded-xl p-4 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle size={16} className="text-red-400 shrink-0" />
        <span className="text-sm font-semibold text-red-300">
          Keyword Cannibalisation Detected
        </span>
      </div>
      <div className="space-y-3">
        {duplicateGroups.map((group) => (
          <div key={group.keyword} className="text-xs text-red-200/80">
            <span className="font-mono bg-red-900/30 px-1.5 py-0.5 rounded text-red-300">
              {group.keyword}
            </span>
            <span className="ml-2">
              is used in {group.postIds.length} posts. Two posts competing for
              the same keyword will split Google ranking authority and harm both.
              Resolve this before running rewrites — change the keyword on one
              post or merge the posts.
            </span>
            <div className="mt-1 ml-2 space-y-0.5">
              {group.postIds.map((pid) => {
                const p = postMap.get(pid);
                return p ? (
                  <a
                    key={pid}
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block truncate text-red-300 hover:text-red-100 underline underline-offset-2"
                  >
                    {p.title}
                  </a>
                ) : null;
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PostContentPanel — slide-out panel to preview a post's full body content
// ---------------------------------------------------------------------------

function PostContentPanel({
  post,
  iauditUserId,
  onClose,
}: {
  post: Post | null;
  iauditUserId: string;
  onClose: () => void;
}) {
  const { data, isLoading } = trpc.keyword.getPostContent.useQuery(
    { postId: post?.id ?? "", iauditUserId },
    { enabled: !!post?.id && !!iauditUserId }
  );

  return (
    <Sheet open={!!post} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl p-0 flex flex-col">
        <SheetHeader className="px-6 pt-6 pb-4 border-b shrink-0">
          <SheetTitle className="text-base leading-snug pr-8">
            {post?.title}
          </SheetTitle>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {post?.focusKeyword && (
              <span className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 px-2 py-0.5 rounded-full font-medium">
                {post.focusKeyword}
              </span>
            )}
            {post?.auditScore !== null && post?.auditScore !== undefined && (
              <span className="text-xs font-semibold text-foreground">
                {post.auditScore}/16
              </span>
            )}
            {post?.url && (
              <a
                href={post.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 ml-auto"
              >
                <ExternalLink size={12} />
                View on Wix
              </a>
            )}
          </div>
        </SheetHeader>
        <ScrollArea className="flex-1 px-6 py-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="animate-spin text-muted-foreground" size={24} />
            </div>
          ) : data?.bodyOriginal ? (
            <div
              className="prose prose-sm dark:prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: data.bodyOriginal }}
            />
          ) : (
            <p className="text-sm text-muted-foreground italic">No content available for this post.</p>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// PostList Page
// ---------------------------------------------------------------------------

export default function PostList() {
  const [, navigate] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useIauditAuth();
  const iauditUserId = getIauditUserId();

  // Get businessId from BusinessContext (Layer 14 agency multi-client)
  const { selectedBusinessId } = useBusinessContext();
  const businessId = selectedBusinessId ?? "";

  const [modalPost, setModalPost] = useState<Post | null>(null);
  const [duplicateGroups, setDuplicateGroups] = useState<
    Array<{ keyword: string; postIds: string[] }>
  >([]);
  const [expandedAuditPostId, setExpandedAuditPostId] = useState<string | null>(
    null
  );
    const [auditingAll, setAuditingAll] = useState(false);
  const [auditProgress, setAuditProgress] = useState(0);
  // Post content preview panel
  const [previewPost, setPreviewPost] = useState<Post | null>(null);

  // Layer 7 rewrite state
  const [rewritePost, setRewritePost] = useState<Post | null>(null);
  const [rewriteStep, setRewriteStep] = useState<"paa" | "running" | "result" | "view_result">("paa");
  const [paaQuestion, setPaaQuestion] = useState("");
  const [paaLoading, setPaaLoading] = useState(false);
  const [paaSuggested, setPaaSuggested] = useState("");
  const [expandedRewritePostId, setExpandedRewritePostId] = useState<string | null>(null);
  const [rewriteMode, setRewriteMode] = useState<"full_rewrite" | "smart_patch">("full_rewrite");
  const { data, isLoading, refetch } = trpc.keyword.listPosts.useQuery(
    { businessId, iauditUserId: iauditUserId ?? "" },
    { enabled: !!businessId && !!iauditUserId }
  );
  const scanMutation = trpc.keyword.runCannibalisationScan.useMutation();
  const bulkSuggestMutation = trpc.keyword.bulkSuggest.useMutation();
  const backfillMutation = trpc.keyword.backfillFromTitles.useMutation();
  const [bulkSuggestRunning, setBulkSuggestRunning] = useState(false);
  const auditAllMutation = trpc.audit.runAuditAll.useMutation();
  const auditOneMutation = trpc.audit.runAudit.useMutation();
  const getPaaMutation = trpc.rewrite.getPaaQuestion.useMutation();
  const runRewriteMutation = trpc.rewrite.runRewrite.useMutation();

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate("/login");
    }
  }, [authLoading, isAuthenticated, navigate]);

  const postsWithoutKeyword = (data?.posts ?? []).filter((p) => !p.focusKeyword);

  const handleBackfillFromTitles = () => {
    if (!businessId || !iauditUserId) return;
    backfillMutation.mutate(
      { businessId, iauditUserId },
      {
        onSuccess: (result) => {
          refetch();
          toast.success(
            `Set keywords for ${result.processed} post${result.processed !== 1 ? "s" : ""} from their titles. You can now run Audit All.`
          );
        },
        onError: () => {
          toast.error("Failed to set keywords from titles. Please try again.");
        },
      }
    );
  };

  const handleBulkSuggest = () => {
    if (!businessId || !iauditUserId) return;
    setBulkSuggestRunning(true);
    bulkSuggestMutation.mutate(
      { businessId, iauditUserId },
      {
        onSuccess: (result) => {
          setBulkSuggestRunning(false);
          refetch();
          toast.success(
            `AI suggested keywords for ${result.processed} post${result.processed !== 1 ? "s" : ""}.${
              result.failed > 0 ? ` ${result.failed} could not be processed.` : ""
            } You can now run Audit All.`
          );
        },
        onError: () => {
          setBulkSuggestRunning(false);
          toast.error("Bulk keyword suggestion failed. Please try again.");
        },
      }
    );
  };

  const handleRunScan = () => {
    if (!businessId || !iauditUserId) return;
    scanMutation.mutate(
      { businessId, iauditUserId },
      {
        onSuccess: (result) => {
          setDuplicateGroups(result.duplicateGroups);
          refetch();
          if (result.flaggedCount > 0) {
            toast.warning(
              `${result.flaggedCount} post${result.flaggedCount > 1 ? "s" : ""} flagged for keyword cannibalisation.`
            );
          } else {
            toast.success("No keyword cannibalisation detected.");
          }
        },
        onError: () => {
          toast.error("Cannibalisation scan failed. Please try again.");
        },
      }
    );
  };

  const handleAuditAll = () => {
    if (!businessId || !iauditUserId) return;
    setAuditingAll(true);
    setAuditProgress(10);
    auditAllMutation.mutate(
      { businessId, iauditUserId },
      {
        onSuccess: (result) => {
          setAuditProgress(100);
          setTimeout(() => {
            setAuditingAll(false);
            setAuditProgress(0);
            refetch();
            toast.success(
              `Audit complete — ${result.audited} post${result.audited !== 1 ? "s" : ""} scored.${result.skipped > 0 ? ` ${result.skipped} skipped (no keyword).` : ""}`
            );
          }, 600);
        },
        onError: () => {
          setAuditingAll(false);
          setAuditProgress(0);
          toast.error("Audit failed. Please try again.");
        },
      }
    );
    // Animate progress while running
    const interval = setInterval(() => {
      setAuditProgress((prev) => {
        if (prev >= 90) {
          clearInterval(interval);
          return prev;
        }
        return prev + 5;
      });
    }, 800);
  };

    const handleAuditOne = (post: Post) => {
    if (!iauditUserId) return;
    auditOneMutation.mutate(
      { postId: post.id, iauditUserId },
      {
        onSuccess: (result) => {
          refetch();
          setExpandedAuditPostId(post.id);
          toast.success(
            `Audit complete — ${result.score}/16 (${GRADE_CONFIG[result.grade]?.label ?? result.grade})`
          );
        },
        onError: () => {
          toast.error("Audit failed. Please try again.");
        },
      }
    );
  };

  /** Open the PAA modal for a post (Layer 7 rewrite flow) */
  const handleFix = (post: Post) => {
    if (!iauditUserId) return;
    setRewritePost(post);
    setRewriteStep("paa");
    setPaaQuestion("");
    setPaaSuggested("");
    setPaaLoading(true);
    getPaaMutation.mutate(
      { postId: post.id, iauditUserId },
      {
        onSuccess: (res) => {
          setPaaSuggested(res.paaQuestion);
          setPaaQuestion(res.paaQuestion);
          setPaaLoading(false);
        },
        onError: () => {
          setPaaLoading(false);
          // Still allow user to type their own
        },
      }
    );
  };

  /** Run the rewrite after PAA confirmation */
  const handleRunRewrite = (mode: "full_rewrite" | "smart_patch" = rewriteMode) => {
    if (!rewritePost || !iauditUserId || !paaQuestion.trim()) return;
    setRewriteMode(mode);
    setRewriteStep("running");
    runRewriteMutation.mutate(
      { postId: rewritePost.id, iauditUserId, paaQuestion: paaQuestion.trim(), rewriteMode: mode },
      {
        onSuccess: (result) => {
          refetch();
          setRewriteStep("result");
          if (result.needsManualReview) {
            toast.warning(
              result.message ?? "Rewrite needs manual review. Credit refunded."
            );
          } else {
            toast.success(
              `Rewrite complete — ${result.rewriteScore}/16 (${GRADE_CONFIG[result.rewriteGrade]?.label ?? result.rewriteGrade})`
            );
          }
        },
        onError: (err) => {
          setRewriteStep("paa");
          const msg = err.message?.includes("INSUFFICIENT_CREDITS")
            ? "You have no credits remaining. Buy more to continue."
            : err.message?.includes("cannibalisation")
            ? "Resolve the duplicate keyword before rewriting."
            : "Rewrite failed. Please try again.";
          toast.error(msg);
        },
      }
    );
  };

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  const posts: Post[] = data?.posts ?? [];
  const postMap = new Map(posts.map((p) => [p.id, p]));
  const postsWithKeyword = posts.filter((p) => p.focusKeyword);

  return (
    <div className="p-4">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate("/dashboard")}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft size={18} />
            </Button>
            <div>
              <h1 className="text-xl font-bold text-foreground">Post Library</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                {posts.length} post{posts.length !== 1 ? "s" : ""} imported
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRunScan}
              disabled={scanMutation.isPending || posts.length === 0}
              className="gap-2"
            >
              {scanMutation.isPending ? (
                <Loader2 className="animate-spin" size={14} />
              ) : (
                <RefreshCw size={14} />
              )}
              Cannibalisation Scan
            </Button>
            {postsWithoutKeyword.length > 0 && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleBackfillFromTitles}
                      disabled={backfillMutation.isPending}
                      className="gap-2 border-blue-500/50 text-blue-500 hover:bg-blue-500/10"
                    >
                      {backfillMutation.isPending ? (
                        <Loader2 className="animate-spin" size={14} />
                      ) : (
                        <Tag size={14} />
                      )}
                      {backfillMutation.isPending
                        ? `Setting keywords…`
                        : `Set Keywords from Titles (${postsWithoutKeyword.length})`}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Instantly extract a focus keyword from each post title — no AI needed, runs in seconds.
                    Best for posts with descriptive titles like "How to Write a Company Profile".
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleBulkSuggest}
                      disabled={bulkSuggestRunning || bulkSuggestMutation.isPending}
                      className="gap-2 border-amber-500/50 text-amber-500 hover:bg-amber-500/10"
                    >
                      {bulkSuggestRunning ? (
                        <Loader2 className="animate-spin" size={14} />
                      ) : (
                        <Sparkles size={14} />
                      )}
                      {bulkSuggestRunning
                        ? `Suggesting keywords…`
                        : `AI Suggest Keywords (${postsWithoutKeyword.length})`}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    AI reads each post and suggests the best focus keyword. Slower but more accurate
                    for posts with vague or unusual titles.
                  </TooltipContent>
                </Tooltip>
              </>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    size="sm"
                    onClick={handleAuditAll}
                    disabled={
                      auditingAll ||
                      auditAllMutation.isPending ||
                      posts.length === 0
                    }
                    className="gap-2"
                  >
                    {auditingAll ? (
                      <Loader2 className="animate-spin" size={14} />
                    ) : (
                      <BarChart3 size={14} />
                    )}
                    Audit All
                  </Button>
                </span>
              </TooltipTrigger>
              {posts.length === 0 && (
                <TooltipContent>
                  No posts imported yet. Connect your CMS and import posts first.
                </TooltipContent>
              )}
            </Tooltip>
          </div>
        </div>

        {/* Bulk suggest progress banner */}
        {bulkSuggestRunning && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <Loader2 className="animate-spin text-amber-500" size={14} />
              <p className="text-xs text-amber-400">
                AI is suggesting keywords for {postsWithoutKeyword.length} post{postsWithoutKeyword.length !== 1 ? "s" : ""}…
                This may take a few minutes. Please keep this page open.
              </p>
            </div>
          </div>
        )}

        {/* Audit progress bar */}
        {auditingAll && (
          <div className="mb-4">
            <Progress value={auditProgress} className="h-1.5" />
            <p className="text-xs text-muted-foreground mt-1.5">
              Auditing {posts.length} post
              {posts.length !== 1 ? "s" : ""}… this may take a
              moment.
            </p>
          </div>
        )}

        {/* Dashboard overview */}
        {businessId && iauditUserId && (
          <DashboardOverview
            businessId={businessId}
            iauditUserId={iauditUserId}
          />
        )}

        {/* Cannibalisation banner */}
        <CannibalisationBanner
          duplicateGroups={duplicateGroups}
          postMap={postMap}
        />

        {/* Post list */}
        {posts.length === 0 ? (
          <div className="bg-card border border-border rounded-xl p-12 text-center">
            <div className="flex flex-col items-center gap-4">
              <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center">
                <FileText className="h-7 w-7 text-primary/60" />
              </div>
              <div>
                <p className="text-base font-semibold text-foreground">No posts imported yet</p>
                <p className="text-sm text-muted-foreground mt-1 max-w-xs mx-auto">
                  Connect your CMS and import your blog posts to start auditing and rewriting them.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate("/cms/connect")}
                >
                  Connect CMS
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {posts.map((post) => {
              const isExpanded = expandedAuditPostId === post.id;
              const isAuditingThis = auditOneMutation.isPending;

              return (
                <div
                  key={post.id}
                  className={`bg-card border rounded-xl transition-colors ${
                    post.cannibalizationFlag
                      ? "border-red-500/40 bg-red-500/5"
                      : "border-border"
                  }`}
                >
                  {/* Post row */}
                  <div className="px-5 py-4 flex items-center gap-4">
                    {/* Cannibalisation indicator */}
                    {post.cannibalizationFlag && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <AlertTriangle
                            size={16}
                            className="text-red-400 shrink-0 cursor-help"
                          />
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs">
                          Duplicate keyword detected. Resolve the cannibalisation
                          conflict before rewriting.
                        </TooltipContent>
                      </Tooltip>
                    )}

                    {/* Title + URL */}
                    <div className="flex-1 min-w-0">
                      <button
                        onClick={() => setPreviewPost(post)}
                        className="text-sm font-medium text-foreground hover:text-primary truncate block text-left w-full"
                      >
                        {post.title}
                      </button>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {post.url}
                      </p>
                    </div>

                    {/* Audit score badge (if audited) */}
                    {post.auditScore !== null && post.auditScore !== undefined && (
                      <div className="shrink-0 flex items-center gap-1.5">
                        <span className="text-xs font-bold text-foreground">
                          {post.auditScore}/16
                        </span>
                        <GradeBadge grade={post.auditGrade} />
                      </div>
                    )}

                    {/* Keyword badge */}
                    <div className="shrink-0">
                      <KeywordBadge
                        source={post.keywordSource}
                        keyword={post.focusKeyword}
                      />
                    </div>

                    {/* Actions */}
                    <div className="shrink-0 flex gap-2">
                      {/* Suggest keyword button — only shown when no keyword */}
                      {!post.focusKeyword && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs gap-1.5 h-7 px-2.5"
                          onClick={() => setModalPost(post)}
                        >
                          <Sparkles size={12} />
                          Suggest
                        </Button>
                      )}

                      {/* Audit button */}
                      {!post.cannibalizationFlag && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs h-7 px-2.5 gap-1.5"
                          disabled={isAuditingThis}
                          onClick={() => handleAuditOne(post)}
                        >
                          {isAuditingThis ? (
                            <Loader2 className="animate-spin" size={12} />
                          ) : (
                            <BarChart3 size={12} />
                          )}
                          Audit
                        </Button>
                      )}

                      {/* View results button (if audited) */}
                      {post.auditStatus === "complete" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-xs h-7 px-2 text-muted-foreground hover:text-foreground"
                          onClick={() =>
                            setExpandedAuditPostId(
                              isExpanded ? null : post.id
                            )
                          }
                        >
                          {isExpanded ? (
                            <ChevronUp size={14} />
                          ) : (
                            <ChevronDown size={14} />
                          )}
                        </Button>
                      )}

                      {/* Fix / Rewrite button — disabled when cannibalization_flag is set */}
                      {post.cannibalizationFlag ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <Button
                                size="sm"
                                disabled
                                className="text-xs h-7 px-2.5 cursor-not-allowed opacity-50"
                              >
                                Fix
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="left" className="max-w-xs">
                            Resolve the duplicate keyword before rewriting.
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        post.auditStatus === "complete" && (
                          <Button
                            size="sm"
                            className="text-xs h-7 px-2.5 gap-1"
                            onClick={() => handleFix(post)}
                          >
                            <Zap size={12} />
                            Fix
                          </Button>
                        )
                      )}
                      {/* View Rewrite button — shown when rewrite is complete */}
                      {post.rewriteStatus === "complete" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs h-7 px-2.5 gap-1 text-emerald-400 border-emerald-400/40 hover:bg-emerald-400/10"
                          onClick={() =>
                            setExpandedRewritePostId(
                              expandedRewritePostId === post.id ? null : post.id
                            )
                          }
                        >
                          <FileText size={12} />
                          Rewrite
                        </Button>
                      )}
                      {/* Review & Edit button — navigates to the full review screen */}
                      {post.rewriteStatus === "complete" && (
                        <Button
                          size="sm"
                          className="text-xs h-7 px-2.5 gap-1 bg-violet-600 hover:bg-violet-500 text-white"
                          onClick={() => navigate(`/review/${post.id}`)}
                        >
                          <ExternalLink size={12} />
                          Review
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Expanded audit results */}
                  {isExpanded && iauditUserId && (
                    <div className="border-t border-border px-5 py-4">
                      <AuditResultsPanel
                        postId={post.id}
                        iauditUserId={iauditUserId}
                        onClose={() => setExpandedAuditPostId(null)}
                        onFix={() => handleFix(post)}
                      />
                    </div>
                  )}
                  {/* Expanded rewrite result */}
                  {expandedRewritePostId === post.id && iauditUserId && (
                    <div className="border-t border-border px-5 py-4">
                      <RewriteResultPanel
                        postId={post.id}
                        iauditUserId={iauditUserId}
                        auditScore={post.auditScore ?? null}
                        auditGrade={post.auditGrade ?? null}
                        onClose={() => setExpandedRewritePostId(null)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* AI Keyword Suggestion Modal */}
      <KeywordSuggestionModal
        post={modalPost}
        open={!!modalPost}
        onClose={() => setModalPost(null)}
        onConfirmed={() => refetch()}
      />
      {/* Rewrite Modal (Layer 7) */}
      <RewriteModal
        post={rewritePost}
        open={!!rewritePost}
        step={rewriteStep}
        paaQuestion={paaQuestion}
        paaSuggested={paaSuggested}
        paaLoading={paaLoading}
        onPaaChange={setPaaQuestion}
        onConfirm={handleRunRewrite}
        onClose={() => {
          if (rewriteStep !== "running") {
            setRewritePost(null);
            setRewriteStep("paa");
          }
        }}
        rewriteResult={
          rewriteStep === "result" && runRewriteMutation.data
            ? {
                rewriteScore: runRewriteMutation.data.rewriteScore,
                rewriteGrade: runRewriteMutation.data.rewriteGrade,
                needsManualReview: runRewriteMutation.data.needsManualReview,
                message: runRewriteMutation.data.message,
              }
            : null
        }
      />

      {/* Blog Content Preview Panel */}
      <PostContentPanel
        post={previewPost}
        iauditUserId={iauditUserId ?? ""}
        onClose={() => setPreviewPost(null)}
      />
    </div>
  );
}
