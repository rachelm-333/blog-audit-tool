/**
 * iAudit — Post List (Layer 5)
 *
 * Displays all imported posts for a business with:
 * - Keyword status badge (cms_scraped / ai_suggested / user_entered / missing)
 * - AI keyword suggestion modal (3 clickable options + custom text input)
 * - Cannibalisation warning banner linking to both conflicting posts
 * - Fix button disabled with tooltip when cannibalization_flag is set
 */
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useIauditAuth, getIauditUserId } from "@/hooks/useIauditAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Loader2, AlertTriangle, CheckCircle2, Sparkles, Tag, ArrowLeft, RefreshCw } from "lucide-react";
import { toast } from "sonner";

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
}

interface KeywordSuggestion {
  keyword: string;
  rationale: string;
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
  if (!keyword || !source) {
    return (
      <Badge
        variant="outline"
        className="text-amber-400 border-amber-400/40 bg-amber-400/10 gap-1 text-xs"
      >
        <AlertTriangle size={11} />
        Missing keyword
      </Badge>
    );
  }

  if (source === "cms_scraped") {
    return (
      <Badge
        variant="outline"
        className="text-blue-400 border-blue-400/40 bg-blue-400/10 gap-1 text-xs"
      >
        <Tag size={11} />
        {keyword}
      </Badge>
    );
  }

  if (source === "ai_suggested") {
    return (
      <Badge
        variant="outline"
        className="text-violet-400 border-violet-400/40 bg-violet-400/10 gap-1 text-xs"
      >
        <Sparkles size={11} />
        {keyword}
      </Badge>
    );
  }

  // user_entered
  return (
    <Badge
      variant="outline"
      className="text-emerald-400 border-emerald-400/40 bg-emerald-400/10 gap-1 text-xs"
    >
      <CheckCircle2 size={11} />
      {keyword}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Cannibalisation Warning Banner
// ---------------------------------------------------------------------------

function CannibalisationBanner({
  duplicateGroups,
  posts,
}: {
  duplicateGroups: Array<{ keyword: string; postIds: string[] }>;
  posts: Post[];
}) {
  if (duplicateGroups.length === 0) return null;

  const postMap = new Map(posts.map((p) => [p.id, p]));

  return (
    <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="text-red-400 mt-0.5 shrink-0" size={18} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-red-300 mb-2">
            Keyword cannibalisation detected
          </p>
          <div className="space-y-2">
            {duplicateGroups.map((group) => (
              <div key={group.keyword} className="text-xs text-red-200/80">
                <span className="font-mono bg-red-900/30 px-1.5 py-0.5 rounded text-red-300">
                  {group.keyword}
                </span>
                <span className="ml-2">
                  is used in {group.postIds.length} posts. Two posts competing for the same keyword will split Google ranking authority and harm both. Resolve this before running rewrites — change the keyword on one post or merge the posts.
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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Keyword Suggestion Modal
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
  const [suggestions, setSuggestions] = useState<KeywordSuggestion[]>([]);
  const [customKeyword, setCustomKeyword] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const iauditUserId = getIauditUserId();
  const suggestMutation = trpc.keyword.suggest.useMutation();
  const confirmMutation = trpc.keyword.confirm.useMutation();

  useEffect(() => {
    if (open && post && iauditUserId) {
      setIsLoading(true);
      setSuggestions([]);
      setSelected(null);
      setCustomKeyword("");
      suggestMutation.mutate(
        { postId: post.id, iauditUserId },
        {
          onSuccess: (data) => {
            setSuggestions(data.suggestions);
            setIsLoading(false);
          },
          onError: () => {
            toast.error("Failed to generate keyword suggestions. Please try again.");
            setIsLoading(false);
            onClose();
          },
        }
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, post?.id]);

  const handleConfirm = () => {
    if (!post || !iauditUserId) return;
    const keyword = customKeyword.trim() || selected;
    if (!keyword) {
      toast.error("Please select or enter a keyword.");
      return;
    }
    const source = customKeyword.trim() ? "user_entered" : "ai_suggested";
    confirmMutation.mutate(
      { postId: post.id, keyword, source, iauditUserId },
      {
        onSuccess: () => {
          toast.success(`Keyword confirmed: "${keyword}"`);
          onConfirmed();
          onClose();
        },
        onError: () => {
          toast.error("Failed to save keyword. Please try again.");
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg bg-card border-border">
        <DialogHeader>
          <DialogTitle className="text-foreground">Confirm Focus Keyword</DialogTitle>
          <DialogDescription className="text-muted-foreground text-sm leading-relaxed">
            No focus keyword was found for this post. These are our best guesses based on your
            content — confirm one or type your own before the audit runs. Changing the keyword
            after an audit has run will require a full re-audit.
          </DialogDescription>
        </DialogHeader>

        {post && (
          <p className="text-xs text-muted-foreground truncate border-b border-border pb-3 mb-1">
            <span className="font-medium text-foreground">Post:</span> {post.title}
          </p>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-10 gap-3 text-muted-foreground">
            <Loader2 className="animate-spin" size={20} />
            <span className="text-sm">Analysing your content…</span>
          </div>
        ) : (
          <div className="space-y-3 mt-1">
            {suggestions.map((s) => (
              <button
                key={s.keyword}
                onClick={() => {
                  setSelected(s.keyword);
                  setCustomKeyword("");
                }}
                className={`w-full text-left rounded-lg border px-4 py-3 transition-all ${
                  selected === s.keyword && !customKeyword
                    ? "border-primary bg-primary/10 ring-1 ring-primary"
                    : "border-border bg-background hover:border-primary/40 hover:bg-primary/5"
                }`}
              >
                <div className="text-sm font-semibold text-foreground">{s.keyword}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{s.rationale}</div>
              </button>
            ))}

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">or type your own</span>
              </div>
            </div>

            <Input
              placeholder="e.g. best coffee shops Melbourne"
              value={customKeyword}
              onChange={(e) => {
                setCustomKeyword(e.target.value);
                setSelected(null);
              }}
              className="bg-background border-border"
            />
          </div>
        )}

        <div className="flex gap-2 mt-2">
          <Button variant="outline" onClick={onClose} className="flex-1" disabled={confirmMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            className="flex-1"
            disabled={isLoading || confirmMutation.isPending || (!selected && !customKeyword.trim())}
          >
            {confirmMutation.isPending ? (
              <Loader2 className="animate-spin mr-2" size={14} />
            ) : null}
            Confirm Keyword
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// PostList Page
// ---------------------------------------------------------------------------

export default function PostList() {
  const [, navigate] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useIauditAuth();
  const iauditUserId = getIauditUserId();

  // Get businessId from URL query param
  const params = new URLSearchParams(window.location.search);
  const businessId = params.get("businessId") ?? "";

  const [modalPost, setModalPost] = useState<Post | null>(null);
  const [duplicateGroups, setDuplicateGroups] = useState<
    Array<{ keyword: string; postIds: string[] }>
  >([]);

  const { data, isLoading, refetch } = trpc.keyword.listPosts.useQuery(
    { businessId, iauditUserId: iauditUserId ?? "" },
    { enabled: !!businessId && !!iauditUserId }
  );

  const scanMutation = trpc.keyword.runCannibalisationScan.useMutation();

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate("/login");
    }
  }, [authLoading, isAuthenticated, navigate]);

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

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  const posts: Post[] = data?.posts ?? [];

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
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
            Run Cannibalisation Scan
          </Button>
        </div>

        {/* Cannibalisation banner */}
        <CannibalisationBanner duplicateGroups={duplicateGroups} posts={posts} />

        {/* Legend */}
        <div className="flex flex-wrap gap-3 mb-6 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-blue-400" />
            CMS keyword
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-violet-400" />
            AI suggested
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            User entered
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            Missing
          </span>
        </div>

        {/* Post table */}
        {posts.length === 0 ? (
          <div className="bg-card border border-border rounded-xl p-12 text-center">
            <p className="text-muted-foreground text-sm">No posts imported yet.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => navigate("/cms/connect")}
            >
              Import Posts
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {posts.map((post) => (
              <div
                key={post.id}
                className={`bg-card border rounded-xl px-5 py-4 flex items-center gap-4 transition-colors ${
                  post.cannibalizationFlag
                    ? "border-red-500/40 bg-red-500/5"
                    : "border-border"
                }`}
              >
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
                      Duplicate keyword detected. Resolve the cannibalisation conflict before rewriting.
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Title + URL */}
                <div className="flex-1 min-w-0">
                  <a
                    href={post.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-foreground hover:text-primary truncate block"
                  >
                    {post.title}
                  </a>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{post.url}</p>
                </div>

                {/* Keyword badge */}
                <div className="shrink-0">
                  <KeywordBadge source={post.keywordSource} keyword={post.focusKeyword} />
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

                  {/* Fix / Audit button — disabled when cannibalization_flag is set */}
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
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          className="text-xs h-7 px-2.5"
                          disabled={!post.focusKeyword}
                          onClick={() => {
                            if (!post.focusKeyword) {
                              toast.info("Confirm a focus keyword before running the audit.");
                            } else {
                              toast.info("Audit feature coming in Layer 6.");
                            }
                          }}
                        >
                          Audit
                        </Button>
                      </TooltipTrigger>
                      {!post.focusKeyword && (
                        <TooltipContent side="left" className="max-w-xs">
                          Confirm a focus keyword before running the audit.
                        </TooltipContent>
                      )}
                    </Tooltip>
                  )}
                </div>
              </div>
            ))}
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
    </div>
  );
}
