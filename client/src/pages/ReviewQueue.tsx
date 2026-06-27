/**
 * ReviewQueue — Shows all posts in "awaiting_review" status.
 * Three-column layout: left = post list grouped by type, centre = article preview, right = SEO fields + approve button.
 */
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { getIauditUserId } from "@/hooks/useIauditAuth";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  CheckCircle2,
  ExternalLink,
  Pencil,
  ChevronRight,
  FileText,
  BookOpen,
  Layers,
  ClipboardCheck,
  AlertTriangle,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Grade badge helper
// ---------------------------------------------------------------------------
function GradeBadge({ grade, score }: { grade: string | null; score: number | null }) {
  const map: Record<string, string> = {
    optimised: "bg-green-100 text-green-800 border-green-200",
    strong: "bg-blue-100 text-blue-800 border-blue-200",
    needs_work: "bg-yellow-100 text-yellow-800 border-yellow-200",
    poor: "bg-orange-100 text-orange-800 border-orange-200",
    critical: "bg-red-100 text-red-800 border-red-200",
  };
  const label: Record<string, string> = {
    optimised: "Optimised",
    strong: "Strong",
    needs_work: "Needs Work",
    poor: "Poor",
    critical: "Critical",
  };
  const cls = map[grade ?? ""] ?? "bg-slate-100 text-slate-600 border-slate-200";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>
      {score !== null ? `${score}/16` : ""} {label[grade ?? ""] ?? "—"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Article type icon
// ---------------------------------------------------------------------------
function ArticleTypeIcon({ type }: { type: string | null }) {
  if (type === "cornerstone") return <BookOpen className="w-3.5 h-3.5 text-purple-600" />;
  if (type === "pillar") return <Layers className="w-3.5 h-3.5 text-blue-600" />;
  return <FileText className="w-3.5 h-3.5 text-slate-500" />;
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function ReviewQueue() {
  const [, navigate] = useLocation();
  const userId = getIauditUserId();
  const { selectedBusinessId: businessId } = useBusinessContext();
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [showFullArticle, setShowFullArticle] = useState(false);

  const { data: rewriteResult } = trpc.rewrite.getRewriteResult.useQuery(
    { postId: selectedPostId ?? "", iauditUserId: userId ?? "" },
    { enabled: !!selectedPostId && !!userId }
  );

  const { data, isLoading, refetch } = trpc.dashboard.getReviewQueue.useQuery(
    { iauditUserId: userId ?? "", businessId: businessId ?? "" },
    { enabled: !!userId && !!businessId }
  );

  const approveMutation = trpc.dashboard.approvePost.useMutation({
    onSuccess: () => {
      toast.success("Post approved and moved to Approved queue");
      refetch();
      setSelectedPostId(null);
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to approve post");
    },
  });

  const allPosts = data?.posts ?? [];
  const posts = allPosts.filter((p) => p.rewriteStatus === "awaiting_review");
  const attentionPosts = allPosts.filter((p) => p.rewriteStatus === "needs_manual_review");

  // Group awaiting_review posts by article type
  const grouped = useMemo(() => {
    const groups: Record<string, typeof posts> = {
      cornerstone: [],
      pillar: [],
      cluster: [],
      unknown: [],
    };
    for (const p of posts) {
      const key = p.articleType ?? "unknown";
      if (key in groups) groups[key].push(p);
      else groups.unknown.push(p);
    }
    return groups;
  }, [posts]);

  const selectedPost = allPosts.find((p) => p.id === selectedPostId) ?? null;

  const handleApproveAll = () => {
    if (!userId || !businessId) return;
    for (const post of posts) {
      approveMutation.mutate({ iauditUserId: userId, businessId, postId: post.id });
    }
  };

  if (!businessId) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500">
        No business selected. Please complete business setup first.
      </div>
    );
  }


  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* ------------------------------------------------------------------ */}
      {/* LEFT — Post list */}
      {/* ------------------------------------------------------------------ */}
      <aside className="w-72 flex-shrink-0 border-r border-slate-200 bg-white flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-4 border-b border-slate-200">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2">
              <ClipboardCheck className="w-4 h-4 text-blue-600" />
              Review Queue
            </h2>
          </div>
          <p className="text-xs text-slate-500">
            {isLoading ? "Loading…" : `${posts.length} post${posts.length !== 1 ? "s" : ""} awaiting review`}
          </p>
          {posts.length > 0 && (
            <Button
              size="sm"
              className="mt-3 w-full bg-green-600 hover:bg-green-700 text-white text-xs"
              onClick={handleApproveAll}
              disabled={approveMutation.isPending}
            >
              <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
              Approve All ({posts.length})
            </Button>
          )}
        </div>

        {/* Post list */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          ) : allPosts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center px-6">
              <CheckCircle2 className="w-10 h-10 text-green-400 mb-3" />
              <p className="text-sm font-medium text-slate-700">All clear!</p>
              <p className="text-xs text-slate-500 mt-1">
                No posts awaiting review. Run rewrites on posts from the Posts page.
              </p>
            </div>
          ) : (
            <div className="p-2 space-y-4">
              {/* Needs Attention section */}
              {attentionPosts.length > 0 && (
                <div>
                  <div className="px-2 py-1.5 text-xs font-semibold text-amber-700 uppercase tracking-wider flex items-center gap-1.5 bg-amber-50 rounded mb-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Needs Attention
                    <span className="ml-auto text-amber-400">{attentionPosts.length}</span>
                  </div>
                  {attentionPosts.map((post) => (
                    <button
                      key={post.id}
                      onClick={() => setSelectedPostId(post.id)}
                      className={`w-full text-left rounded-lg px-3 py-2.5 mb-1 transition-colors group ${
                        selectedPostId === post.id
                          ? "bg-amber-50 border border-amber-300"
                          : "hover:bg-amber-50/60 border border-transparent"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-slate-800 line-clamp-2 leading-snug flex-1">
                          {post.title}
                        </p>
                        <ChevronRight className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5 group-hover:text-amber-500" />
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <GradeBadge grade={post.rewriteGrade} score={post.rewriteScore} />
                        <span className="text-xs text-amber-600 font-medium">Manual review needed</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Ready to Review section */}
              {posts.length > 0 && (
                <div>
                  {attentionPosts.length > 0 && (
                    <div className="px-2 py-1 text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5 mt-2">
                      <ClipboardCheck className="w-3.5 h-3.5" />
                      Ready to Review
                      <span className="ml-auto text-slate-300">{posts.length}</span>
                    </div>
                  )}
                  {(["cornerstone", "pillar", "cluster", "unknown"] as const).map((type) => {
                    const group = grouped[type];
                    if (!group || group.length === 0) return null;
                    return (
                      <div key={type}>
                        <div className="px-2 py-1 text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                          <ArticleTypeIcon type={type} />
                          {type === "unknown" ? "Other" : type.charAt(0).toUpperCase() + type.slice(1)}
                          <span className="ml-auto text-slate-300">{group.length}</span>
                        </div>
                        {group.map((post) => (
                          <button
                            key={post.id}
                            onClick={() => setSelectedPostId(post.id)}
                            className={`w-full text-left rounded-lg px-3 py-2.5 mb-1 transition-colors group ${
                              selectedPostId === post.id
                                ? "bg-blue-50 border border-blue-200"
                                : "hover:bg-slate-50 border border-transparent"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <p className="text-sm font-medium text-slate-800 line-clamp-2 leading-snug flex-1">
                                {post.title}
                              </p>
                              <ChevronRight className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5 group-hover:text-slate-600" />
                            </div>
                            <div className="mt-1.5 flex items-center gap-2">
                              <GradeBadge grade={post.rewriteGrade} score={post.rewriteScore} />
                              {post.rewrittenAt && (
                                <span className="text-xs text-slate-400">
                                  {new Date(post.rewrittenAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                                </span>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* ------------------------------------------------------------------ */}
      {/* CENTRE + RIGHT — Post detail / empty state */}
      {/* ------------------------------------------------------------------ */}
      {selectedPost ? (
        <div className="flex flex-1 min-w-0 overflow-hidden">
          {/* Centre — article info */}
          <div className="flex-1 overflow-y-auto bg-white px-8 py-6">
            <div className="max-w-2xl mx-auto">
              {/* Status bar */}
              <div className="flex items-center gap-3 mb-4">
                <Badge variant="outline" className="text-blue-700 border-blue-300 bg-blue-50 text-xs">
                  Awaiting Review
                </Badge>
                <GradeBadge grade={selectedPost.rewriteGrade} score={selectedPost.rewriteScore} />
                {selectedPost.articleType && (
                  <span className="flex items-center gap-1 text-xs text-slate-500">
                    <ArticleTypeIcon type={selectedPost.articleType} />
                    {selectedPost.articleType.charAt(0).toUpperCase() + selectedPost.articleType.slice(1)}
                  </span>
                )}
              </div>

              {/* Title */}
              <h1 className="text-2xl font-bold text-slate-900 mb-2 leading-tight">
                {selectedPost.title}
              </h1>

              {/* Meta */}
              <div className="flex items-center gap-4 text-sm text-slate-500 mb-6 pb-4 border-b border-slate-100">
                {selectedPost.focusKeyword && (
                  <span className="flex items-center gap-1">
                    <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-mono">
                      {selectedPost.focusKeyword}
                    </span>
                  </span>
                )}
                <span>By {selectedPost.authorNameCms}</span>
                {selectedPost.rewrittenAt && (
                  <span>
                    Rewritten {new Date(selectedPost.rewrittenAt).toLocaleDateString("en-AU", {
                      day: "numeric", month: "long", year: "numeric"
                    })}
                  </span>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-3 mb-6">
                <Button
                  className="bg-green-600 hover:bg-green-700 text-white"
                  onClick={() => {
                    if (!userId || !businessId) return;
                    approveMutation.mutate({
                      iauditUserId: userId,
                      businessId,
                      postId: selectedPost.id,
                    });
                  }}
                  disabled={approveMutation.isPending}
                >
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Approve Post
                </Button>
                <Button
                  variant="outline"
                  onClick={() => navigate(`/review/${selectedPost.id}`)}
                >
                  <Pencil className="w-4 h-4 mr-2" />
                  Edit Post
                </Button>
                <a
                  href={selectedPost.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  View original
                </a>
              </div>

              {/* Info cards */}
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg border border-slate-200 p-4">
                  <p className="text-xs font-medium text-slate-500 mb-1">SEO Score After Rewrite</p>
                  <p className="text-2xl font-bold text-slate-900">
                    {selectedPost.rewriteScore ?? "—"}<span className="text-sm font-normal text-slate-400">/16</span>
                  </p>
                  <GradeBadge grade={selectedPost.rewriteGrade} score={null} />
                </div>
                <div className="rounded-lg border border-slate-200 p-4">
                  <p className="text-xs font-medium text-slate-500 mb-1">Article Type</p>
                  <p className="text-lg font-semibold text-slate-900 capitalize">
                    {selectedPost.articleType ?? "Unknown"}
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {selectedPost.articleType === "cornerstone" && "2,500–3,200 words"}
                    {selectedPost.articleType === "pillar" && "1,500–1,800 words"}
                    {selectedPost.articleType === "cluster" && "1,000–1,200 words"}
                  </p>
                </div>
              </div>

              {/* Article body preview */}
              {rewriteResult?.bodyRewritten ? (
                <div className="mt-6">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-slate-700">Rewritten Article</h3>
                    <button
                      onClick={() => setShowFullArticle(v => !v)}
                      className="text-xs text-indigo-600 hover:underline"
                    >
                      {showFullArticle ? "Show less" : "Show full article"}
                    </button>
                  </div>
                  <div
                    className={`prose prose-sm max-w-none rounded-lg border border-slate-200 bg-white px-6 py-5 overflow-hidden transition-all ${showFullArticle ? "" : "max-h-96"}`}
                    dangerouslySetInnerHTML={{ __html: rewriteResult.bodyRewritten }}
                  />
                  {!showFullArticle && (
                    <div className="h-12 bg-gradient-to-t from-white to-transparent -mt-12 relative rounded-b-lg pointer-events-none" />
                  )}
                </div>
              ) : selectedPostId ? (
                <div className="mt-6 h-32 rounded-lg border border-slate-200 bg-slate-50 animate-pulse" />
              ) : null}

              <div className="mt-6 rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm text-blue-800">
                <p className="font-medium mb-1">Ready to approve?</p>
                <p className="text-xs text-blue-700">
                  Read the article above, then click <strong>Approve Post</strong> to send it live to your CMS.
                  Or click <strong>Edit Post</strong> to make changes first.
                </p>
              </div>
            </div>
          </div>

          {/* Right — URL info */}
          <aside className="w-64 flex-shrink-0 border-l border-slate-200 bg-slate-50 overflow-y-auto px-4 py-5">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Post Details</h3>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs text-slate-400 mb-0.5">URL</p>
                <a
                  href={selectedPost.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline text-xs break-all flex items-start gap-1"
                >
                  <ExternalLink className="w-3 h-3 flex-shrink-0 mt-0.5" />
                  {selectedPost.url}
                </a>
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-0.5">Author</p>
                <p className="text-slate-700">{selectedPost.authorNameCms}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-0.5">CMS Status</p>
                <Badge variant="outline" className="text-xs capitalize">{selectedPost.status}</Badge>
              </div>
              {selectedPost.focusKeyword && (
                <div>
                  <p className="text-xs text-slate-400 mb-0.5">Focus Keyword</p>
                  <span className="text-xs bg-white border border-slate-200 text-slate-700 px-2 py-0.5 rounded font-mono">
                    {selectedPost.focusKeyword}
                  </span>
                </div>
              )}
            </div>

            <div className="mt-6 pt-4 border-t border-slate-200">
              <Button
                className="w-full bg-green-600 hover:bg-green-700 text-white text-sm"
                onClick={() => {
                  if (!userId || !businessId) return;
                  approveMutation.mutate({
                    iauditUserId: userId,
                    businessId,
                    postId: selectedPost.id,
                  });
                }}
                disabled={approveMutation.isPending}
              >
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Approve
              </Button>
              <Button
                variant="outline"
                className="w-full mt-2 text-sm"
                onClick={() => navigate(`/review/${selectedPost.id}`)}
              >
                <Pencil className="w-4 h-4 mr-2" />
                Edit in Editor
              </Button>
            </div>
          </aside>
        </div>
      ) : (
        /* Empty state when no post selected */
        <div className="flex-1 flex items-center justify-center bg-slate-50">
          <div className="text-center max-w-sm">
            <ClipboardCheck className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-slate-700 mb-2">
              {allPosts.length === 0 ? "No posts awaiting review" : "Select a post to review"}
            </h3>
            <p className="text-sm text-slate-500">
              {allPosts.length === 0
                ? "Posts will appear here after a rewrite is completed. Run a rewrite from the Posts page to get started."
                : "Click a post from the list on the left to see its details and approve it."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
