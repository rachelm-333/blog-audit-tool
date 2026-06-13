/**
 * iAudit — Dashboard (Layer 11)
 *
 * Route: /dashboard?businessId=<id>
 *
 * Features:
 *  - 4 stat cards: Blog Health, Score Potential, Total Posts, Credits Remaining
 *  - Grade breakdown row: Optimised / Strong / Needs Work / Poor+Critical
 *  - Cannibalisation warning banner (orange)
 *  - Score potential banner (blue)
 *  - Post table with grade + status filter buttons and sort
 *  - Empty states: no businesses, no posts, no audit run
 *  - Skeleton loader while data fetches
 */

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useIauditAuth, getIauditUserId } from "@/hooks/useIauditAuth";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import {
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  CreditCard,
  ExternalLink,
  FileText,
  Lightbulb,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Grade badge colours (spec Section 20.2)
// ---------------------------------------------------------------------------

const GRADE_CONFIG = {
  optimised: {
    label: "Optimised",
    bg: "bg-[#1A7A4A]",
    text: "text-white",
    border: "border-[#1A7A4A]",
    scoreColor: "text-[#4ADE80]",
    barColor: "bg-[#1A7A4A]",
  },
  strong: {
    label: "Strong",
    bg: "bg-[#2E6DA4]",
    text: "text-white",
    border: "border-[#2E6DA4]",
    scoreColor: "text-[#60A5FA]",
    barColor: "bg-[#2E6DA4]",
  },
  needs_work: {
    label: "Needs Work",
    bg: "bg-[#B8860B]",
    text: "text-white",
    border: "border-[#B8860B]",
    scoreColor: "text-[#FBBF24]",
    barColor: "bg-[#B8860B]",
  },
  poor: {
    label: "Poor",
    bg: "bg-[#C75B00]",
    text: "text-white",
    border: "border-[#C75B00]",
    scoreColor: "text-[#FB923C]",
    barColor: "bg-[#C75B00]",
  },
  critical: {
    label: "Critical",
    bg: "bg-[#A30000]",
    text: "text-white",
    border: "border-[#A30000]",
    scoreColor: "text-[#F87171]",
    barColor: "bg-[#A30000]",
  },
} as const;

type GradeKey = keyof typeof GRADE_CONFIG;

function GradeBadge({
  grade,
  size = "sm",
}: {
  grade: GradeKey | null | undefined;
  size?: "sm" | "md";
}) {
  if (!grade) return <span className="text-muted-foreground text-xs">—</span>;
  const cfg = GRADE_CONFIG[grade];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-2 font-semibold",
        cfg.bg,
        cfg.text,
        size === "sm" ? "text-xs py-0.5" : "text-sm py-1 px-3"
      )}
    >
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Health score → grade label
// ---------------------------------------------------------------------------

function healthGradeLabel(
  grade: string | null | undefined
): string {
  if (!grade) return "—";
  return GRADE_CONFIG[grade as GradeKey]?.label ?? "—";
}

// ---------------------------------------------------------------------------
// Score bar
// ---------------------------------------------------------------------------

function ScoreBar({
  score,
  grade,
}: {
  score: number | null;
  grade: GradeKey | null | undefined;
}) {
  if (score === null) {
    return <span className="text-xs text-muted-foreground">Not audited</span>;
  }
  const pct = Math.round((score / 16) * 100);
  const cfg = grade ? GRADE_CONFIG[grade] : null;
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full", cfg?.barColor ?? "bg-primary")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={cn(
          "text-xs font-semibold tabular-nums",
          cfg?.scoreColor ?? "text-foreground"
        )}
      >
        {score}/16
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
  valueClass,
  loading,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  valueClass?: string;
  loading?: boolean;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-5 flex flex-col gap-1">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {loading ? (
        <Skeleton className="h-9 w-24 mt-1" />
      ) : (
        <div className={cn("text-3xl font-extrabold leading-none", valueClass)}>
          {value}
        </div>
      )}
      {loading ? (
        <Skeleton className="h-4 w-32 mt-1" />
      ) : (
        sub && (
          <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grade breakdown card
// ---------------------------------------------------------------------------

function GradeCard({
  count,
  grade,
  loading,
}: {
  count: number;
  grade: GradeKey;
  loading?: boolean;
}) {
  const cfg = GRADE_CONFIG[grade];
  return (
    <div
      className={cn(
        "bg-card border rounded-xl p-4 flex flex-col items-center gap-2",
        cfg.border
      )}
    >
      {loading ? (
        <Skeleton className="h-8 w-12" />
      ) : (
        <div className={cn("text-2xl font-extrabold", cfg.scoreColor)}>
          {count}
        </div>
      )}
      <GradeBadge grade={grade} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter button
// ---------------------------------------------------------------------------

function FilterBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border",
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-transparent text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sort icon
// ---------------------------------------------------------------------------

function SortIcon({
  field,
  active,
  dir,
}: {
  field: string;
  active: boolean;
  dir: "asc" | "desc";
}) {
  if (!active) return <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />;
  return dir === "asc" ? (
    <ChevronUp className="h-3 w-3 text-primary" />
  ) : (
    <ChevronDown className="h-3 w-3 text-primary" />
  );
}

// ---------------------------------------------------------------------------
// Main Dashboard component
// ---------------------------------------------------------------------------

type GradeFilter = "all" | "optimised" | "strong" | "needs_work" | "poor" | "critical";
type StatusFilter = "all" | "published" | "scheduled" | "draft";
type SortField = "score" | "grade" | "title";

export default function Dashboard() {
  const [, navigate] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useIauditAuth();
  const iauditUserId = getIauditUserId();
  const { selectedBusinessId, setSelectedBusinessId } = useBusinessContext();

  // Table filter/sort state
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortField, setSortField] = useState<SortField>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate("/login");
    }
  }, [authLoading, isAuthenticated, navigate]);

  // ---- List businesses to find the selected one ----
  const { data: bizData, isLoading: bizLoading } =
    trpc.dashboard.listBusinesses.useQuery(
      { iauditUserId: iauditUserId ?? "" },
      { enabled: !!iauditUserId }
    );

  // Determine active businessId: context → first business
  const businessId = useMemo(() => {
    if (selectedBusinessId) return selectedBusinessId;
    if (bizData?.businesses && bizData.businesses.length > 0) {
      return bizData.businesses[0].id;
    }
    return null;
  }, [selectedBusinessId, bizData]);

  // Auto-set context when first business loads
  useEffect(() => {
    if (!selectedBusinessId && bizData?.businesses && bizData.businesses.length > 0) {
      setSelectedBusinessId(bizData.businesses[0].id);
    }
  }, [selectedBusinessId, bizData, setSelectedBusinessId]);

  // ---- Dashboard stats ----
  const {
    data: statsData,
    isLoading: statsLoading,
    refetch: refetchStats,
  } = trpc.dashboard.getStats.useQuery(
    { iauditUserId: iauditUserId ?? "", businessId: businessId ?? "" },
    { enabled: !!iauditUserId && !!businessId }
  );

  // ---- Post table ----
  const { data: tableData, isLoading: tableLoading } =
    trpc.dashboard.getPostTable.useQuery(
      {
        iauditUserId: iauditUserId ?? "",
        businessId: businessId ?? "",
        gradeFilter,
        statusFilter,
        sortField,
        sortDir,
      },
      { enabled: !!iauditUserId && !!businessId }
    );

  // ---- Loading states ----
  const isLoading = authLoading || bizLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  // ---- Empty state: no businesses ----
  if (!bizLoading && (!bizData?.businesses || bizData.businesses.length === 0)) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="max-w-md w-full text-center">
          <div className="bg-card border border-border rounded-2xl p-10 flex flex-col items-center gap-6">
            <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
              <BarChart3 className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground mb-2">
                Add your first business to get started
              </h2>
              <p className="text-sm text-muted-foreground">
                Connect your website and we'll pull in all your blog posts.
              </p>
            </div>
            <Button
              onClick={() => navigate("/business/setup")}
              className="font-semibold px-8"
            >
              Set Up Business Profile
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const stats = statsData?.stats;
  const business = statsData?.business;
  const connection = statsData?.connection;
  const creditsRemaining = statsData?.creditsRemaining ?? 0;
  const rows = tableData?.rows ?? [];

  // ---- Empty state: posts imported but no audit run ----
  const showNoAuditState =
    !statsLoading && stats && stats.totalPosts > 0 && stats.needsFirstAudit;

  // ---- Empty state: no posts imported ----
  const showNoPostsState =
    !statsLoading && stats && stats.totalPosts === 0;

  // ---- Sort toggle ----
  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  // ---- Grade filter counts ----
  const gradeCounts: Record<GradeFilter, number> = {
    all: stats?.totalPosts ?? 0,
    optimised: stats?.optimisedCount ?? 0,
    strong: stats?.strongCount ?? 0,
    needs_work: stats?.needsWorkCount ?? 0,
    poor: stats?.poorCount ?? 0,
    critical: stats?.criticalCount ?? 0,
  };

  // ---- Last sync label ----
  function lastSyncLabel(date: Date | null | undefined): string {
    if (!date) return "Never synced";
    const now = Date.now();
    const diff = now - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 2) return "Just now";
    if (mins < 60) return `${mins} minutes ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days > 1 ? "s" : ""} ago`;
  }

  return (
    <div className="space-y-6">

        {/* Page header */}
        <div>
          <h1 className="text-2xl font-extrabold text-foreground">
            {statsLoading ? (
              <Skeleton className="h-8 w-64" />
            ) : (
              `${business?.name ?? "—"} — Blog Dashboard`
            )}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {statsLoading ? (
              <Skeleton className="h-4 w-80 mt-1" />
            ) : (
              <>
                {connection?.siteUrl ?? business?.siteUrl ?? "—"}
                {connection && (
                  <>
                    {" · "}Connected via{" "}
                    <span className="capitalize">{connection.platform}</span>
                    {" · "}Last synced {lastSyncLabel(connection.lastSyncAt)}
                  </>
                )}
              </>
            )}
          </p>
        </div>

        {/* ── Cannibalisation warning ── */}
        {!statsLoading && stats && stats.cannibalisationCount > 0 && (
          <div className="flex items-start gap-3 rounded-xl border border-[#C75B00]/40 bg-[#C75B00]/10 px-4 py-3">
            <AlertTriangle className="h-5 w-5 text-[#FB923C] shrink-0 mt-0.5" />
            <div className="text-sm">
              <strong className="text-[#FB923C]">
                {stats.cannibalisationCount} cannibalisation warning
                {stats.cannibalisationCount > 1 ? "s" : ""}
              </strong>{" "}
              <span className="text-foreground/80">
                — Two or more posts share the same focus keyword. Resolve these
                before running rewrites.
              </span>{" "}
              <button
                onClick={() =>
                  navigate("/posts")
                }
                className="text-[#FB923C] underline underline-offset-2 hover:no-underline font-medium"
              >
                View conflicts →
              </button>
            </div>
          </div>
        )}

        {/* ── 4 Stat cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Blog Health"
            loading={statsLoading}
            value={
              stats?.healthScore !== null && stats?.healthScore !== undefined ? (
                <>
                  <span
                    className={cn(
                      stats.healthGrade
                        ? GRADE_CONFIG[stats.healthGrade as GradeKey]?.scoreColor
                        : "text-foreground"
                    )}
                  >
                    {Math.round(stats.healthScore * 10) / 10}
                  </span>
                  <span className="text-base text-muted-foreground">/16</span>
                </>
              ) : (
                <span className="text-muted-foreground text-xl">No data</span>
              )
            }
            sub={
              stats?.healthGrade
                ? healthGradeLabel(stats.healthGrade)
                : "No audits run yet"
            }
            valueClass=""
          />
          <StatCard
            label="Score Potential"
            loading={statsLoading}
            value={
              stats?.scorePotential !== null &&
              stats?.scorePotential !== undefined ? (
                <span className="text-[#4ADE80]">
                  +{Math.round(stats.scorePotential * 10) / 10} pts
                </span>
              ) : (
                <span className="text-muted-foreground text-xl">—</span>
              )
            }
            sub="If Poor &amp; Critical posts fixed"
          />
          <StatCard
            label="Total Posts"
            loading={statsLoading}
            value={stats?.totalPosts ?? 0}
            sub={
              stats
                ? `${stats.publishedCount} published · ${stats.scheduledCount} scheduled · ${stats.draftCount} draft`
                : undefined
            }
          />
          <StatCard
            label="Credits Remaining"
            loading={statsLoading}
            value={
              <span className="text-primary">{creditsRemaining}</span>
            }
            sub={
              creditsRemaining < 10 ? (
                <button
                  onClick={() => navigate("/credits")}
                  className="text-primary underline underline-offset-2 hover:no-underline"
                >
                  Top up →
                </button>
              ) : (
                <button
                  onClick={() => navigate("/credits")}
                  className="text-muted-foreground hover:text-primary underline-offset-2 hover:underline"
                >
                  Manage credits
                </button>
              )
            }
          />
        </div>

        {/* ── Grade breakdown row ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <GradeCard
            count={stats?.optimisedCount ?? 0}
            grade="optimised"
            loading={statsLoading}
          />
          <GradeCard
            count={stats?.strongCount ?? 0}
            grade="strong"
            loading={statsLoading}
          />
          <GradeCard
            count={stats?.needsWorkCount ?? 0}
            grade="needs_work"
            loading={statsLoading}
          />
          <GradeCard
            count={(stats?.poorCount ?? 0) + (stats?.criticalCount ?? 0)}
            grade="poor"
            loading={statsLoading}
          />
        </div>

        {/* ── Score potential banner ── */}
        {!statsLoading &&
          stats &&
          stats.poorAndCriticalCount > 0 &&
          stats.projectedHealthScore !== null && (
            <div className="flex items-start gap-3 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3">
              <Lightbulb className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div className="flex-1 text-sm">
                <span className="text-foreground">
                  💡 Fixing your{" "}
                  <strong>{stats.poorAndCriticalCount} Poor and Critical</strong>{" "}
                  posts could lift your blog health from{" "}
                  <strong>
                    {Math.round((stats.healthScore ?? 0) * 10) / 10} →{" "}
                    {Math.round(stats.projectedHealthScore * 10) / 10}
                  </strong>
                  . At 1 credit per post, that's{" "}
                  <strong>{stats.poorAndCriticalCount} credits</strong>.
                </span>
              </div>
              <Button
                size="sm"
                className="shrink-0 text-xs"
                onClick={() => {
                  setGradeFilter("poor");
                }}
              >
                View Posts to Fix →
              </Button>
            </div>
          )}

        {/* ── Empty states ── */}
        {showNoPostsState && (
          <div className="bg-card border border-border rounded-xl p-10 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-base font-bold text-foreground mb-2">
              No posts found
            </h3>
            <p className="text-sm text-muted-foreground mb-6">
              Make sure your CMS connection is working and try importing again.
            </p>
            <Button
              variant="outline"
              onClick={() =>
                navigate("/cms/connect")
              }
            >
              Manage CMS Connection
            </Button>
          </div>
        )}

        {showNoAuditState && (
          <div className="bg-card border border-border rounded-xl p-10 text-center">
            <Zap className="h-10 w-10 text-primary mx-auto mb-4" />
            <h3 className="text-base font-bold text-foreground mb-2">
              Your posts are ready
            </h3>
            <p className="text-sm text-muted-foreground mb-6">
              Click Start Audit to check every post against the 16-point
              standard.
            </p>
            <Button
              onClick={() =>
                navigate("/posts")
              }
            >
              <Zap className="h-4 w-4 mr-2" />
              Start Audit
            </Button>
          </div>
        )}

        {/* ── Post table ── */}
        {!showNoPostsState && !showNoAuditState && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            {/* Table header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="text-sm font-bold text-foreground">All Posts</div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() =>
                    navigate("/posts")
                  }
                >
                  <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
                  Full Audit Report
                </Button>
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={() =>
                    navigate("/posts")
                  }
                >
                  <Zap className="h-3.5 w-3.5 mr-1.5" />
                  Audit All Posts
                </Button>
              </div>
            </div>

            {/* Filter row */}
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border bg-background/30">
              {(
                [
                  "all",
                  "optimised",
                  "strong",
                  "needs_work",
                  "poor",
                  "critical",
                ] as GradeFilter[]
              ).map((g) => (
                <FilterBtn
                  key={g}
                  active={gradeFilter === g}
                  onClick={() => setGradeFilter(g)}
                >
                  {g === "all"
                    ? `All (${gradeCounts.all})`
                    : g === "needs_work"
                    ? `Needs Work (${gradeCounts.needs_work})`
                    : `${GRADE_CONFIG[g as GradeKey]?.label ?? g} (${gradeCounts[g]})`}
                </FilterBtn>
              ))}
              <div className="ml-auto flex items-center gap-2">
                {(["all", "published", "scheduled", "draft"] as StatusFilter[]).map(
                  (s) => (
                    <FilterBtn
                      key={s}
                      active={statusFilter === s}
                      onClick={() => setStatusFilter(s)}
                    >
                      {s === "all"
                        ? "All Statuses"
                        : s.charAt(0).toUpperCase() + s.slice(1)}
                    </FilterBtn>
                  )
                )}
              </div>
            </div>

            {/* Table */}
            {tableLoading ? (
              <div className="p-6 space-y-3">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">
                No posts match the selected filters.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-background/20">
                      <th className="text-left px-4 py-2.5 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                        Post
                      </th>
                      <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                        Keyword
                      </th>
                      <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                        Status
                      </th>
                      <th className="px-3 py-2.5 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                        <button
                          className="flex items-center gap-1 hover:text-foreground transition-colors"
                          onClick={() => handleSort("score")}
                        >
                          Score
                          <SortIcon
                            field="score"
                            active={sortField === "score"}
                            dir={sortDir}
                          />
                        </button>
                      </th>
                      <th className="px-3 py-2.5 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                        <button
                          className="flex items-center gap-1 hover:text-foreground transition-colors"
                          onClick={() => handleSort("grade")}
                        >
                          Grade
                          <SortIcon
                            field="grade"
                            active={sortField === "grade"}
                            dir={sortDir}
                          />
                        </button>
                      </th>
                      <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                        Issues
                      </th>
                      <th className="text-right px-4 py-2.5 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        className="border-b border-border/50 hover:bg-accent/20 transition-colors"
                      >
                        {/* Post title */}
                        <td className="px-4 py-3 max-w-xs">
                          <div className="font-medium text-foreground truncate">
                            {row.title}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            <span className="capitalize">{row.status}</span>
                            {(row.publishDate || row.scheduledDate) && (
                              <>
                                {" · "}
                                {new Date(
                                  row.publishDate ?? row.scheduledDate!
                                ).toLocaleDateString("en-AU", {
                                  day: "numeric",
                                  month: "short",
                                  year: "numeric",
                                })}
                              </>
                            )}
                            {" · "}
                            {row.authorNameCms}
                          </div>
                        </td>

                        {/* Keyword */}
                        <td className="px-3 py-3">
                          {row.focusKeyword ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded border border-border text-xs text-foreground bg-background/50">
                              {row.focusKeyword}
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded border border-[#A30000]/60 text-xs text-[#F87171] bg-[#A30000]/10">
                              No keyword set ⚠
                            </span>
                          )}
                        </td>

                        {/* Cannibalisation flag */}
                        <td className="px-3 py-3">
                          {row.cannibalizationFlag ? (
                            <span className="text-xs text-[#FB923C] flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              Duplicate keyword
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>

                        {/* Score bar */}
                        <td className="px-3 py-3">
                          <div className="space-y-0.5">
                            <ScoreBar
                              score={row.displayScore}
                              grade={row.displayGrade as GradeKey | null}
                            />
                            {row.displayScore !== null && (
                              <span className={cn(
                                "text-[10px] font-medium",
                                row.isRewriteScore ? "text-violet-400" : "text-muted-foreground/60"
                              )}>
                                {row.isRewriteScore ? "Post-Rewrite" : "Original Audit"}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Grade badge */}
                        <td className="px-3 py-3">
                          <GradeBadge grade={row.displayGrade as GradeKey | null} />
                        </td>

                        {/* Issues count */}
                        <td className="px-3 py-3">
                          {row.displayScore === null ? (
                            <span className="text-xs text-muted-foreground">
                              Not audited
                            </span>
                          ) : row.issueCount === 0 ? (
                            <span className="text-xs text-[#4ADE80] flex items-center gap-1">
                              <CheckCircle2 className="h-3 w-3" />
                              None
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {row.issueCount} issue
                              {row.issueCount !== 1 ? "s" : ""}
                            </span>
                          )}
                        </td>

                        {/* Action button */}
                        <td className="px-4 py-3 text-right">
                          {!row.focusKeyword ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs h-7"
                              onClick={() => navigate("/posts")}
                            >
                              Set Keyword
                            </Button>
                          ) : row.cannibalizationFlag ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span>
                                  <Button
                                    size="sm"
                                    className="text-xs h-7 opacity-50 cursor-not-allowed"
                                    disabled
                                  >
                                    Fix — 1 Credit
                                  </Button>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                Resolve the duplicate keyword before rewriting
                              </TooltipContent>
                            </Tooltip>
                          ) : row.auditGrade === "optimised" ||
                            row.auditGrade === "strong" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs h-7"
                              onClick={() =>
                                navigate(`/review/${row.id}`)
                              }
                            >
                              <ExternalLink className="h-3 w-3 mr-1" />
                              View
                            </Button>
                          ) : row.rewriteStatus === "complete" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs h-7"
                              onClick={() => navigate(`/review/${row.id}`)}
                            >
                              Review Rewrite
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              className="text-xs h-7"
                              onClick={() => navigate(`/posts?fix=${row.id}`)}
                            >
                              <ArrowUpRight className="h-3 w-3 mr-1" />
                              Fix — 1 Credit
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Table footer */}
            {rows.length > 0 && (
              <div className="px-4 py-2.5 border-t border-border text-xs text-muted-foreground flex items-center justify-between">
                <span>
                  Showing {rows.length} of {stats?.totalPosts ?? rows.length}{" "}
                  posts
                </span>
                <button
                  onClick={() => {
                    setGradeFilter("poor");
                    setStatusFilter("all");
                  }}
                  className="text-primary hover:underline underline-offset-2"
                >
                  Select all Poor and Critical →
                </button>
              </div>
            )}
          </div>
        )}
      </div>
  );
}
