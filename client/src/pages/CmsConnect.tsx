/**
 * iAudit — CMS Connection & Post Import (Layer 4)
 *
 * Flow:
 *   Step 1: Platform selector (WordPress / Wix / Shopify / Zapier)
 *   Step 2: Connection form (WordPress only in this layer)
 *   Step 3: Import options (Published / Scheduled / Draft / All)
 *   Step 4: Import progress
 *   Step 5: Import results
 *
 * Error states (Table 12):
 *   - invalid_credentials
 *   - insufficient_permissions
 *   - site_unreachable
 *   - rate_limit
 *   - zero_posts
 */

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useIauditAuth, getIauditUserId } from "@/hooks/useIauditAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  Globe,
  Loader2,
  Lock,
  RefreshCw,
  ShoppingBag,
  Zap,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Platform = "wordpress" | "wix" | "shopify" | "zapier";
type StatusFilter = "published" | "scheduled" | "draft" | "all";
type Step = "platform" | "connect" | "import-options" | "importing" | "results";

interface ErrorState {
  code: string;
  message: string;
}

interface ImportResults {
  totalImported: number;
  counts: { published: number; scheduled: number; draft: number };
  errors: string[];
}

// ─── Platform cards ───────────────────────────────────────────────────────────

const PLATFORMS: Array<{
  id: Platform;
  name: string;
  description: string;
  icon: React.ReactNode;
  available: boolean;
  comingSoon?: boolean;
}> = [
  {
    id: "wordpress",
    name: "WordPress",
    description: "Connect via Application Password",
    icon: <Globe className="w-8 h-8" />,
    available: true,
  },
  {
    id: "wix",
    name: "Wix",
    description: "Connect via Wix Headless API",
    icon: <Globe className="w-8 h-8 opacity-50" />,
    available: false,
    comingSoon: true,
  },
  {
    id: "shopify",
    name: "Shopify",
    description: "Connect via Custom App API",
    icon: <ShoppingBag className="w-8 h-8 opacity-50" />,
    available: false,
    comingSoon: true,
  },
  {
    id: "zapier",
    name: "Zapier / Other",
    description: "Webhook integration for any platform",
    icon: <Zap className="w-8 h-8 opacity-50" />,
    available: false,
    comingSoon: true,
  },
];

// ─── Error messages ───────────────────────────────────────────────────────────

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials:
    "We could not connect to your WordPress site. Please check your URL, username, and application password.",
  insufficient_permissions:
    "Your WordPress user does not have permission to read or edit posts. Please use an Administrator account.",
  site_unreachable:
    "We could not reach your website. Please check it is online and try again.",
  rate_limit:
    "Import paused — too many requests. We will continue automatically in 60 seconds.",
  zero_posts:
    "No posts were found with the selected status. Try selecting All post types.",
  not_wordpress:
    "The URL does not appear to be a WordPress site, or the REST API is disabled.",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function ErrorBanner({ error, onDismiss }: { error: ErrorState; onDismiss: () => void }) {
  const message = ERROR_MESSAGES[error.code] ?? error.message;
  return (
    <div className="flex items-start gap-3 p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400">
      <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
      <div className="flex-1 text-sm">{message}</div>
      <button onClick={onDismiss} className="text-red-400/60 hover:text-red-400 text-xs shrink-0">
        Dismiss
      </button>
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: "platform", label: "Platform" },
    { id: "connect", label: "Connect" },
    { id: "import-options", label: "Import" },
    { id: "results", label: "Done" },
  ];
  const currentIndex = steps.findIndex((s) => s.id === step || (step === "importing" && s.id === "import-options"));

  return (
    <div className="flex items-center gap-2 mb-8">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-center gap-2">
          <div
            className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold transition-colors ${
              i < currentIndex
                ? "bg-emerald-500 text-white"
                : i === currentIndex
                ? "bg-blue-500 text-white"
                : "bg-white/10 text-white/40"
            }`}
          >
            {i < currentIndex ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
          </div>
          <span
            className={`text-sm ${
              i === currentIndex ? "text-white" : i < currentIndex ? "text-emerald-400" : "text-white/40"
            }`}
          >
            {s.label}
          </span>
          {i < steps.length - 1 && (
            <ChevronRight className="w-4 h-4 text-white/20 mx-1" />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CmsConnect() {
  const [, navigate] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useIauditAuth();

  // Step state
  const [step, setStep] = useState<Step>("platform");
  const [selectedPlatform, setSelectedPlatform] = useState<Platform | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [error, setError] = useState<ErrorState | null>(null);
  const [importResults, setImportResults] = useState<ImportResults | null>(null);

  // WordPress form state
  const [wpUrl, setWpUrl] = useState("");
  const [wpUsername, setWpUsername] = useState("");
  const [wpAppPassword, setWpAppPassword] = useState("");

  // Business ID from URL params
  const [businessId, setBusinessId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const bid = params.get("businessId");
    if (bid) setBusinessId(bid);
  }, []);

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate("/login");
    }
  }, [authLoading, isAuthenticated, navigate]);

  // tRPC mutations
  const connectMutation = trpc.cms.connect.useMutation();
  const importMutation = trpc.cms.importPosts.useMutation();

  const iauditUserId = getIauditUserId();  // module-level function, not a hook method

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
      </div>
    );
  }

  if (!businessId) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center">
        <div className="text-center">
          <p className="text-white/60 mb-4">No business selected.</p>
          <Button onClick={() => navigate("/dashboard")} variant="outline">
            Go to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  // ─── Step 1: Platform selector ─────────────────────────────────────────────

  if (step === "platform") {
    return (
      <div className="min-h-screen bg-[#0a0f1e] text-white px-4 py-10">
        <div className="max-w-2xl mx-auto">
          <button
            onClick={() => navigate("/dashboard")}
            className="flex items-center gap-2 text-white/50 hover:text-white/80 text-sm mb-8 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </button>

          <StepIndicator step="platform" />

          <h1 className="text-3xl font-bold mb-2">Connect Your CMS</h1>
          <p className="text-white/60 mb-8">
            Select your content management platform to import your blog posts.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {PLATFORMS.map((platform) => (
              <button
                key={platform.id}
                onClick={() => {
                  if (!platform.available) return;
                  setSelectedPlatform(platform.id);
                  setStep("connect");
                }}
                disabled={!platform.available}
                className={`relative flex flex-col items-start gap-3 p-6 rounded-xl border text-left transition-all ${
                  platform.available
                    ? "border-white/20 hover:border-blue-400/60 hover:bg-white/5 cursor-pointer"
                    : "border-white/10 opacity-50 cursor-not-allowed"
                }`}
              >
                <div className="text-white/70">{platform.icon}</div>
                <div>
                  <div className="font-semibold text-white flex items-center gap-2">
                    {platform.name}
                    {platform.comingSoon && (
                      <Badge variant="outline" className="text-xs border-white/20 text-white/40">
                        Coming soon
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm text-white/50 mt-0.5">{platform.description}</div>
                </div>
                {platform.available && (
                  <ChevronRight className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ─── Step 2: WordPress connection form ────────────────────────────────────

  if (step === "connect" && selectedPlatform === "wordpress") {
    const handleConnect = async () => {
      if (!iauditUserId) return;
      setError(null);

      try {
        const result = await connectMutation.mutateAsync({
          iauditUserId,
          businessId,
          siteUrl: wpUrl,
          username: wpUsername,
          applicationPassword: wpAppPassword,
        });
        setConnectionId(result.connectionId);
        setStep("import-options");
      } catch (err: any) {
        const msg: string = err?.message ?? "Connection failed.";
        // Map error message back to a code for the error banner
        const code = Object.entries(ERROR_MESSAGES).find(([, v]) => v === msg)?.[0] ?? "unknown";
        setError({ code, message: msg });
      }
    };

    return (
      <div className="min-h-screen bg-[#0a0f1e] text-white px-4 py-10">
        <div className="max-w-lg mx-auto">
          <button
            onClick={() => { setStep("platform"); setError(null); }}
            className="flex items-center gap-2 text-white/50 hover:text-white/80 text-sm mb-8 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>

          <StepIndicator step="connect" />

          <h1 className="text-3xl font-bold mb-2">Connect WordPress</h1>
          <p className="text-white/60 mb-8">
            Enter your WordPress site details. Your credentials are encrypted and never stored in plain text.
          </p>

          {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

          <div className="space-y-5 mt-6">
            <div>
              <Label className="text-white/80 mb-1.5 block">WordPress Site URL</Label>
              <Input
                type="url"
                placeholder="https://yoursite.com"
                value={wpUrl}
                onChange={(e) => setWpUrl(e.target.value)}
                className="bg-white/5 border-white/20 text-white placeholder:text-white/30 focus:border-blue-400"
              />
              <p className="text-xs text-white/40 mt-1">Enter the root URL of your WordPress site.</p>
            </div>

            <div>
              <Label className="text-white/80 mb-1.5 block">WordPress Username</Label>
              <Input
                type="text"
                placeholder="admin"
                value={wpUsername}
                onChange={(e) => setWpUsername(e.target.value)}
                className="bg-white/5 border-white/20 text-white placeholder:text-white/30 focus:border-blue-400"
              />
            </div>

            <div>
              <Label className="text-white/80 mb-1.5 block">Application Password</Label>
              <Input
                type="password"
                placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
                value={wpAppPassword}
                onChange={(e) => setWpAppPassword(e.target.value)}
                className="bg-white/5 border-white/20 text-white placeholder:text-white/30 focus:border-blue-400"
              />
              <p className="text-xs text-white/40 mt-1">
                Generate this in WordPress Admin → Users → Your Profile → Application Passwords.
              </p>
            </div>

            <div className="flex items-center gap-2 p-3 rounded-lg bg-white/5 border border-white/10">
              <Lock className="w-4 h-4 text-emerald-400 shrink-0" />
              <p className="text-xs text-white/50">
                Your credentials are encrypted with AES-256-GCM before being stored. They are never visible after saving.
              </p>
            </div>

            <Button
              onClick={handleConnect}
              disabled={!wpUrl || !wpUsername || !wpAppPassword || connectMutation.isPending}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white"
            >
              {connectMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Connecting…
                </>
              ) : (
                "Connect WordPress"
              )}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Step 3: Import options ───────────────────────────────────────────────

  if (step === "import-options") {
    const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string; description: string; icon: React.ReactNode }> = [
      {
        value: "all",
        label: "All Posts",
        description: "Import published, scheduled, and draft posts",
        icon: <FileText className="w-5 h-5" />,
      },
      {
        value: "published",
        label: "Published Only",
        description: "Only posts that are live on your site",
        icon: <CheckCircle2 className="w-5 h-5 text-emerald-400" />,
      },
      {
        value: "scheduled",
        label: "Scheduled Only",
        description: "Posts queued for future publication",
        icon: <Clock className="w-5 h-5 text-yellow-400" />,
      },
      {
        value: "draft",
        label: "Drafts Only",
        description: "Unpublished draft posts",
        icon: <FileText className="w-5 h-5 text-white/40" />,
      },
    ];

    const handleImport = async () => {
      if (!iauditUserId || !connectionId) return;
      setError(null);
      setStep("importing");

      try {
        const results = await importMutation.mutateAsync({
          iauditUserId,
          connectionId,
          statusFilter,
        });
        setImportResults(results);
        setStep("results");
      } catch (err: any) {
        const msg: string = err?.message ?? "Import failed.";
        const code = Object.entries(ERROR_MESSAGES).find(([, v]) => v === msg)?.[0] ?? "unknown";
        setError({ code, message: msg });
        setStep("import-options");
      }
    };

    return (
      <div className="min-h-screen bg-[#0a0f1e] text-white px-4 py-10">
        <div className="max-w-lg mx-auto">
          <button
            onClick={() => { setStep("connect"); setError(null); }}
            className="flex items-center gap-2 text-white/50 hover:text-white/80 text-sm mb-8 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>

          <StepIndicator step="import-options" />

          <h1 className="text-3xl font-bold mb-2">Import Posts</h1>
          <p className="text-white/60 mb-2">
            Select which post types to import. Trash posts are never imported.
          </p>

          {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

          <div className="space-y-3 mt-6">
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setStatusFilter(opt.value)}
                className={`w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-all ${
                  statusFilter === opt.value
                    ? "border-blue-400/60 bg-blue-500/10"
                    : "border-white/15 hover:border-white/30 hover:bg-white/5"
                }`}
              >
                <div className="text-white/70">{opt.icon}</div>
                <div className="flex-1">
                  <div className="font-medium text-white">{opt.label}</div>
                  <div className="text-sm text-white/50">{opt.description}</div>
                </div>
                <div
                  className={`w-4 h-4 rounded-full border-2 transition-colors ${
                    statusFilter === opt.value
                      ? "border-blue-400 bg-blue-400"
                      : "border-white/30"
                  }`}
                />
              </button>
            ))}
          </div>

          <Button
            onClick={handleImport}
            className="w-full mt-6 bg-blue-600 hover:bg-blue-500 text-white"
          >
            Import Posts
          </Button>
        </div>
      </div>
    );
  }

  // ─── Step 4: Importing progress ───────────────────────────────────────────

  if (step === "importing") {
    return (
      <div className="min-h-screen bg-[#0a0f1e] flex items-center justify-center text-white">
        <div className="text-center max-w-sm">
          <div className="relative w-20 h-20 mx-auto mb-6">
            <div className="absolute inset-0 rounded-full border-4 border-blue-500/20" />
            <div className="absolute inset-0 rounded-full border-4 border-t-blue-500 animate-spin" />
            <RefreshCw className="absolute inset-0 m-auto w-8 h-8 text-blue-400" />
          </div>
          <h2 className="text-xl font-semibold mb-2">Importing Your Posts</h2>
          <p className="text-white/50 text-sm">
            Connecting to WordPress and fetching your posts. This may take a moment for large sites.
          </p>
        </div>
      </div>
    );
  }

  // ─── Step 5: Import results ───────────────────────────────────────────────

  if (step === "results" && importResults) {
    return (
      <div className="min-h-screen bg-[#0a0f1e] text-white px-4 py-10">
        <div className="max-w-lg mx-auto">
          <StepIndicator step="results" />

          <div className="text-center mb-8">
            <div className="w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-emerald-400" />
            </div>
            <h1 className="text-3xl font-bold mb-2">Import Complete</h1>
            <p className="text-white/60">
              {importResults.totalImported} post{importResults.totalImported !== 1 ? "s" : ""} imported successfully.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-8">
            {[
              { label: "Published", count: importResults.counts.published, color: "text-emerald-400" },
              { label: "Scheduled", count: importResults.counts.scheduled, color: "text-yellow-400" },
              { label: "Drafts", count: importResults.counts.draft, color: "text-white/60" },
            ].map((item) => (
              <div key={item.label} className="text-center p-4 rounded-xl bg-white/5 border border-white/10">
                <div className={`text-2xl font-bold ${item.color}`}>{item.count}</div>
                <div className="text-xs text-white/50 mt-1">{item.label}</div>
              </div>
            ))}
          </div>

          {importResults.errors.length > 0 && (
            <div className="mb-6 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
              <p className="text-yellow-400 text-sm font-medium mb-2">
                {importResults.errors.length} post{importResults.errors.length !== 1 ? "s" : ""} could not be imported:
              </p>
              <ul className="text-xs text-yellow-400/70 space-y-1">
                {importResults.errors.slice(0, 5).map((e, i) => (
                  <li key={i}>• {e}</li>
                ))}
                {importResults.errors.length > 5 && (
                  <li>• …and {importResults.errors.length - 5} more</li>
                )}
              </ul>
            </div>
          )}

          <div className="flex gap-3">
            <Button
              onClick={() => navigate(`/posts?businessId=${businessId}`)}
              className="flex-1 bg-blue-600 hover:bg-blue-500 text-white"
            >
              View Posts
            </Button>
            <Button
              onClick={() => navigate("/dashboard")}
              variant="outline"
              className="flex-1 border-white/20 text-white hover:bg-white/5"
            >
              Dashboard
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
