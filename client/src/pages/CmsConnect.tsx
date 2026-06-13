/**
 * iAudit — CMS Connection & Post Import (Layer 4 + Layer 13)
 *
 * Flow:
 *   Landing:  Shows all saved connections for the current business.
 *             If none exist → shows platform selector.
 *   Connect:  Platform-specific credential form.
 *   Import:   Status filter + import progress + results.
 *
 * Key fix: on mount, listConnections is called so saved connections are
 * always shown when the user returns to this page.
 */

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useIauditAuth, getIauditUserId } from "@/hooks/useIauditAuth";
import { useBusinessContext } from "@/contexts/BusinessContext";
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
  Copy,
  FileText,
  Globe,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  ShoppingBag,
  Trash2,
  Zap,
  Layers,
} from "lucide-react";
import { toast } from "sonner";
import { HelpTooltip } from "@/components/HelpTooltip";

// ─── Types ────────────────────────────────────────────────────────────────────

type Platform = "wordpress" | "wix" | "shopify" | "webflow" | "zapier";
type StatusFilter = "published" | "scheduled" | "draft" | "all";
type View = "connections" | "add-platform" | "connect" | "import-options" | "importing" | "results";

interface ErrorState {
  code: string;
  message: string;
}

interface ImportResults {
  totalImported: number;
  counts: { published: number; scheduled: number; draft: number };
  errors: string[];
}

interface SavedConnection {
  id: string;
  platform: string;
  siteUrl: string | null;
  connectionStatus: string | null;
  lastSyncAt: Date | null;
  createdAt: Date | null;
}

// ─── Platform metadata ────────────────────────────────────────────────────────

const PLATFORM_META: Record<Platform, { name: string; description: string; icon: React.ReactNode }> = {
  wordpress: {
    name: "WordPress",
    description: "Connect via Application Password",
    icon: <Globe className="w-8 h-8" />,
  },
  wix: {
    name: "Wix",
    description: "Connect via Wix Headless API",
    icon: <Globe className="w-8 h-8" />,
  },
  shopify: {
    name: "Shopify",
    description: "Connect via Custom App API",
    icon: <ShoppingBag className="w-8 h-8" />,
  },
  webflow: {
    name: "Webflow",
    description: "Connect via Webflow Data API v2",
    icon: <Layers className="w-8 h-8" />,
  },
  zapier: {
    name: "Zapier / Other",
    description: "Webhook integration for any platform",
    icon: <Zap className="w-8 h-8" />,
  },
};

const PLATFORMS = Object.entries(PLATFORM_META) as Array<[Platform, (typeof PLATFORM_META)[Platform]]>;

// ─── Error messages ───────────────────────────────────────────────────────────

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials:
    "We could not connect to your site. Please check your credentials and try again.",
  insufficient_permissions:
    "Your account does not have permission to read or edit posts. Please use an Administrator account.",
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
    <div className="flex items-start gap-3 p-4 rounded-lg bg-red-50 border border-red-200 text-red-700 mt-4">
      <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
      <div className="flex-1 text-sm">{message}</div>
      <button onClick={onDismiss} className="text-red-400 hover:text-red-600 text-xs shrink-0">
        Dismiss
      </button>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
        <CheckCircle2 className="w-3 h-3" /> Connected
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
        <AlertCircle className="w-3 h-3" /> Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
      <Clock className="w-3 h-3" /> {status ?? "Unknown"}
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CmsConnect() {
  const [, navigate] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useIauditAuth();

  const [view, setView] = useState<View>("connections");
  const [selectedPlatform, setSelectedPlatform] = useState<Platform | null>(null);
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [error, setError] = useState<ErrorState | null>(null);
  const [importResults, setImportResults] = useState<ImportResults | null>(null);
  const [justConnected, setJustConnected] = useState<string | null>(null); // platform name after successful connect

  // WordPress form
  const [wpUrl, setWpUrl] = useState("");
  const [wpUsername, setWpUsername] = useState("");
  const [wpAppPassword, setWpAppPassword] = useState("");

  // Wix form
  const [wixSiteId, setWixSiteId] = useState("");
  const [wixApiKey, setWixApiKey] = useState("");

  // Shopify form
  const [shopifyShop, setShopifyShop] = useState("");
  const [shopifyAccessToken, setShopifyAccessToken] = useState("");

  // Webflow form
  const [webflowApiKey, setWebflowApiKey] = useState("");
  const [webflowCollectionId, setWebflowCollectionId] = useState("");

  // Zapier form
  const [zapierOutboundUrl, setZapierOutboundUrl] = useState("");
  const [zapierInboundUrl, setZapierInboundUrl] = useState<string | null>(null);

  const { selectedBusinessId: businessId } = useBusinessContext();
  const iauditUserId = getIauditUserId();

  useEffect(() => {
    if (!authLoading && !isAuthenticated) navigate("/login");
  }, [authLoading, isAuthenticated, navigate]);

  // ── Load existing connections ──────────────────────────────────────────────
  const {
    data: connections,
    isLoading: connectionsLoading,
    refetch: refetchConnections,
  } = trpc.cms.listConnections.useQuery(
    { iauditUserId: iauditUserId ?? "", businessId: businessId ?? "" },
    { enabled: !!iauditUserId && !!businessId }
  );

  const connectMutation = trpc.cms.connect.useMutation();
  const connectWixMutation = trpc.cms.connectWix.useMutation();
  const connectShopifyMutation = trpc.cms.connectShopify.useMutation();
  const connectWebflowMutation = trpc.cms.connectWebflow.useMutation();
  const connectZapierMutation = trpc.cms.connectZapier.useMutation();
  const disconnectMutation = trpc.cms.disconnect.useMutation();
  const importMutation = trpc.cms.importPosts.useMutation();

  const handleDisconnect = async (connectionId: string) => {
    if (!iauditUserId) return;
    if (!confirm("Are you sure you want to disconnect this CMS? This will not delete your imported posts.")) return;
    try {
      await disconnectMutation.mutateAsync({ iauditUserId, connectionId });
      toast.success("CMS disconnected.");
      refetchConnections();
    } catch {
      toast.error("Failed to disconnect. Please try again.");
    }
  };

  if (authLoading || connectionsLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
      </div>
    );
  }

  if (!businessId) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <p className="text-gray-500 mb-4">No business selected.</p>
          <Button onClick={() => navigate("/dashboard")} variant="outline">
            Go to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  // ─── View: Saved connections landing ──────────────────────────────────────

  if (view === "connections") {
    const hasConnections = connections && connections.length > 0;

    return (
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">CMS Connections</h1>
            <p className="text-gray-500 text-sm mt-1">
              Manage your connected content platforms and import blog posts.
            </p>
          </div>
          <Button
            onClick={() => setView("add-platform")}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Connection
          </Button>
        </div>

        {/* Success banner after connecting */}
        {justConnected && (
          <div className="flex items-start gap-3 p-4 rounded-xl bg-emerald-50 border border-emerald-200 mb-6">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-emerald-800">{justConnected} connected successfully!</p>
              <p className="text-xs text-emerald-700 mt-0.5">Click <strong>Import Posts</strong> next to your connection to pull in your blog posts.</p>
            </div>
            <button onClick={() => setJustConnected(null)} className="text-emerald-400 hover:text-emerald-600 text-xs shrink-0">Dismiss</button>
          </div>
        )}

        {!hasConnections ? (
          // Empty state
          <div className="text-center py-16 border-2 border-dashed border-gray-200 rounded-xl">
            <Globe className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-700 mb-2">No CMS connected yet</h3>
            <p className="text-gray-500 text-sm mb-6">
              Connect your Wix, WordPress, or Shopify site to import and audit your blog posts.
            </p>
            <Button
              onClick={() => setView("add-platform")}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              <Plus className="w-4 h-4 mr-2" />
              Connect a CMS
            </Button>
          </div>
        ) : (
          // Connection cards
          <div className="space-y-4">
            {(connections as SavedConnection[]).map((conn) => {
              const meta = PLATFORM_META[conn.platform as Platform];
              return (
                <div
                  key={conn.id}
                  className="flex items-center gap-4 p-5 rounded-xl border border-gray-200 bg-white shadow-sm"
                >
                  <div className="text-gray-400 shrink-0">
                    {meta?.icon ?? <Globe className="w-8 h-8" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-gray-900">
                        {meta?.name ?? conn.platform}
                      </span>
                      <StatusBadge status={conn.connectionStatus} />
                    </div>
                    {conn.siteUrl && (
                      <p className="text-sm text-gray-500 truncate">{conn.siteUrl}</p>
                    )}
                    {conn.lastSyncAt && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        Last synced {new Date(conn.lastSyncAt).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      onClick={() => {
                        setActiveConnectionId(conn.id);
                        setSelectedPlatform(conn.platform as Platform);
                        setView("import-options");
                      }}
                      className="bg-indigo-600 hover:bg-indigo-700 text-white"
                    >
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                      Import Posts
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSelectedPlatform(conn.platform as Platform);
                        setView("connect");
                      }}
                      className="border-gray-200 text-gray-600 hover:bg-gray-50"
                    >
                      Edit Credentials
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDisconnect(conn.id)}
                      className="border-red-200 text-red-500 hover:bg-red-50 gap-1.5"
                      disabled={disconnectMutation.isPending}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Remove
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ─── View: Add platform selector ──────────────────────────────────────────

  if (view === "add-platform") {
    return (
      <div className="max-w-2xl mx-auto px-4 py-6">
        <button
          onClick={() => setView("connections")}
          className="flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm mb-8 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Connections
        </button>

        <h1 className="text-2xl font-bold text-gray-900 mb-2">Choose a Platform</h1>
        <p className="text-gray-500 mb-8">
          Select your content management platform to get started.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {PLATFORMS.map(([id, platform]) => (
            <button
              key={id}
              onClick={() => {
                setSelectedPlatform(id);
                setView("connect");
                setError(null);
              }}
              className="relative flex flex-col items-start gap-3 p-6 rounded-xl border border-gray-200 hover:border-indigo-400 hover:bg-indigo-50/50 cursor-pointer text-left transition-all"
            >
              <div className="text-gray-500">{platform.icon}</div>
              <div>
                <div className="font-semibold text-gray-900">{platform.name}</div>
                <div className="text-sm text-gray-500 mt-0.5">{platform.description}</div>
              </div>
              <ChevronRight className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ─── View: Connection forms ────────────────────────────────────────────────

  if (view === "connect") {
    const goBack = () => {
      setView("connections");
      setError(null);
    };

    // ── WordPress ──
    if (selectedPlatform === "wordpress") {
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
          setActiveConnectionId(result.connectionId);
          await refetchConnections();
          setJustConnected("WordPress");
          setView("connections");
        } catch (err: any) {
          const msg: string = err?.message ?? "Connection failed.";
          const code = Object.entries(ERROR_MESSAGES).find(([, v]) => v === msg)?.[0] ?? "unknown";
          setError({ code, message: msg });
        }
      };

      return (
        <div className="max-w-2xl mx-auto px-4 py-6">
          <div className="max-w-lg mx-auto">
            <button onClick={goBack} className="flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm mb-8 transition-colors">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Connect WordPress</h1>
            <p className="text-gray-500 mb-6">Enter your WordPress site details. Your credentials are encrypted and never stored in plain text.</p>
            {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
            <div className="space-y-5 mt-6">
              <div>
                <Label className="text-gray-700 mb-1.5 flex items-center gap-1">WordPress Site URL <HelpTooltip text="The full web address of your WordPress website, for example https://yourwebsite.com.au." /></Label>
                <Input type="url" placeholder="https://yoursite.com" value={wpUrl} onChange={(e) => setWpUrl(e.target.value)} />
              </div>
              <div>
                <Label className="text-gray-700 mb-1.5 flex items-center gap-1">WordPress Username <HelpTooltip text="Your WordPress login username." /></Label>
                <Input type="text" placeholder="admin" value={wpUsername} onChange={(e) => setWpUsername(e.target.value)} />
              </div>
              <div>
                <Label className="text-gray-700 mb-1.5 flex items-center gap-1">Application Password <HelpTooltip text="Create one in WordPress Admin → Users → Your Profile → Application Passwords." /></Label>
                <Input type="password" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx" value={wpAppPassword} onChange={(e) => setWpAppPassword(e.target.value)} />
                <p className="text-xs text-gray-400 mt-1">Generate in WordPress Admin → Users → Your Profile → Application Passwords.</p>
              </div>
              <div className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 border border-gray-200">
                <Lock className="w-4 h-4 text-emerald-500 shrink-0" />
                <p className="text-xs text-gray-500">Your credentials are encrypted with AES-256-GCM before being stored.</p>
              </div>
              <Button onClick={handleConnect} disabled={!wpUrl || !wpUsername || !wpAppPassword || connectMutation.isPending} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white">
                {connectMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Connecting…</> : "Connect WordPress"}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    // ── Wix ──
    if (selectedPlatform === "wix") {
      const handleConnect = async () => {
        if (!iauditUserId) return;
        setError(null);
        try {
          const result = await connectWixMutation.mutateAsync({
            iauditUserId,
            businessId,
            siteId: wixSiteId,
            apiKey: wixApiKey,
          });
          setActiveConnectionId(result.connectionId);
          await refetchConnections();
          setJustConnected(result.reconnected ? "Wix (credentials updated)" : "Wix");
          setView("connections");
        } catch (err: any) {
          const msg: string = err?.message ?? "Connection failed.";
          const code = Object.entries(ERROR_MESSAGES).find(([, v]) => v === msg)?.[0] ?? "unknown";
          setError({ code, message: msg });
        }
      };

      return (
        <div className="max-w-2xl mx-auto px-4 py-6">
          <div className="max-w-lg mx-auto">
            <button onClick={goBack} className="flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm mb-8 transition-colors">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Connect Wix</h1>
            <p className="text-gray-500 mb-6">Connect your Wix site using the Wix Headless API. Your credentials are encrypted at rest.</p>
            {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
            <div className="space-y-5 mt-6">
              <div>
                <Label className="text-gray-700 mb-1.5 flex items-center gap-1">
                  Wix Site ID
                  <HelpTooltip text="Your Wix Site ID is a unique code that identifies your website. Find it by logging in to manage.wix.com, opening your site's dashboard, and looking at the URL — it is the long string of letters and numbers between /dashboard/ and /home." />
                </Label>
                <Input
                  type="text"
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  value={wixSiteId}
                  onChange={(e) => setWixSiteId(e.target.value)}
                />
                <p className="text-xs text-gray-400 mt-1">
                  Find this in your Wix Dashboard URL: manage.wix.com/dashboard/<strong>YOUR-SITE-ID</strong>/home
                </p>
              </div>
              <div>
                <Label className="text-gray-700 mb-1.5 flex items-center gap-1">
                  API Key
                  <HelpTooltip text="A Wix API Key lets iAudit read and update your blog posts. Create one in your Wix Dashboard → Settings → API Keys. Give it a name like 'iAudit' and make sure you tick the Wix Blog permission. Save the key somewhere safe — Wix only shows it once." />
                </Label>
                <Input
                  type="password"
                  placeholder="Your Wix API key"
                  value={wixApiKey}
                  onChange={(e) => setWixApiKey(e.target.value)}
                />
                <p className="text-xs text-gray-400 mt-1">
                  Create in Wix Dashboard → Settings → API Keys → Add Key. Requires <strong>Blog</strong> read permission.
                </p>
              </div>
              <div className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 border border-gray-200">
                <Lock className="w-4 h-4 text-emerald-500 shrink-0" />
                <p className="text-xs text-gray-500">Your credentials are encrypted with AES-256-GCM before being stored.</p>
              </div>
              <Button
                onClick={handleConnect}
                disabled={!wixSiteId || !wixApiKey || connectWixMutation.isPending}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                {connectWixMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Connecting…</>
                ) : (
                  "Connect Wix"
                )}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    // ── Shopify ──
    if (selectedPlatform === "shopify") {
      const handleConnect = async () => {
        if (!iauditUserId) return;
        setError(null);
        try {
          const result = await connectShopifyMutation.mutateAsync({
            iauditUserId,
            businessId,
            shop: shopifyShop,
            accessToken: shopifyAccessToken,
          });
          setActiveConnectionId(result.connectionId);
          await refetchConnections();
          setJustConnected(result.reconnected ? "Shopify (credentials updated)" : "Shopify");
          setView("connections");
        } catch (err: any) {
          const msg: string = err?.message ?? "Connection failed.";
          const code = Object.entries(ERROR_MESSAGES).find(([, v]) => v === msg)?.[0] ?? "unknown";
          setError({ code, message: msg });
        }
      };

      return (
        <div className="max-w-2xl mx-auto px-4 py-6">
          <div className="max-w-lg mx-auto">
            <button onClick={goBack} className="flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm mb-8 transition-colors">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Connect Shopify</h1>
            <p className="text-gray-500 mb-6">Connect your Shopify store using a Custom App access token.</p>
            {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
            <div className="space-y-5 mt-6">
              <div>
                <Label className="text-gray-700 mb-1.5 flex items-center gap-1">Shopify Store Domain <HelpTooltip text="Your Shopify store domain ends in .myshopify.com. For example: yourstore.myshopify.com" /></Label>
                <Input type="text" placeholder="your-store.myshopify.com" value={shopifyShop} onChange={(e) => setShopifyShop(e.target.value)} />
              </div>
              <div>
                <Label className="text-gray-700 mb-1.5 flex items-center gap-1">Admin API Access Token <HelpTooltip text="Create a Custom App in Shopify Admin → Settings → Apps → Develop apps. Requires read_content and write_content permissions." /></Label>
                <Input type="password" placeholder="shpat_xxxxxxxxxxxxxxxxxxxx" value={shopifyAccessToken} onChange={(e) => setShopifyAccessToken(e.target.value)} />
              </div>
              <div className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 border border-gray-200">
                <Lock className="w-4 h-4 text-emerald-500 shrink-0" />
                <p className="text-xs text-gray-500">Your credentials are encrypted with AES-256-GCM before being stored.</p>
              </div>
              <Button onClick={handleConnect} disabled={!shopifyShop || !shopifyAccessToken || connectShopifyMutation.isPending} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white">
                {connectShopifyMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Connecting…</> : "Connect Shopify"}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    // ── Webflow ──
    if (selectedPlatform === "webflow") {
      const handleConnect = async () => {
        if (!iauditUserId) return;
        setError(null);
        try {
          const result = await connectWebflowMutation.mutateAsync({
            iauditUserId,
            businessId,
            apiKey: webflowApiKey,
            collectionId: webflowCollectionId,
          });
          setActiveConnectionId(result.connectionId);
          await refetchConnections();
          setJustConnected(result.reconnected ? "Webflow (credentials updated)" : "Webflow");
          setView("connections");
        } catch (err: any) {
          const msg: string = err?.message ?? "Connection failed.";
          const code = Object.entries(ERROR_MESSAGES).find(([, v]) => v === msg)?.[0] ?? "unknown";
          setError({ code, message: msg });
        }
      };

      return (
        <div className="max-w-2xl mx-auto px-4 py-6">
          <div className="max-w-lg mx-auto">
            <button onClick={goBack} className="flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm mb-8 transition-colors">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Connect Webflow</h1>
            <p className="text-gray-500 mb-6">Connect your Webflow CMS collection using the Webflow Data API v2. Your credentials are encrypted at rest.</p>
            {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
            <div className="space-y-5 mt-6">
              <div>
                <Label className="text-gray-700 mb-1.5 flex items-center gap-1">
                  Webflow API Key
                  <HelpTooltip text="Generate a Webflow API key in your Webflow Account Settings → Integrations → API Access → Generate API Token. Give it CMS read access." />
                </Label>
                <Input
                  type="password"
                  placeholder="Your Webflow API token"
                  value={webflowApiKey}
                  onChange={(e) => setWebflowApiKey(e.target.value)}
                />
                <p className="text-xs text-gray-400 mt-1">
                  Generate in Webflow Account Settings → Integrations → API Access.
                </p>
              </div>
              <div>
                <Label className="text-gray-700 mb-1.5 flex items-center gap-1">
                  CMS Collection ID
                  <HelpTooltip text="The Collection ID for your blog posts collection. Find it in Webflow Designer → CMS → select your Blog Posts collection → the ID appears in the URL or in Collection Settings." />
                </Label>
                <Input
                  type="text"
                  placeholder="xxxxxxxxxxxxxxxxxxxxxxxx"
                  value={webflowCollectionId}
                  onChange={(e) => setWebflowCollectionId(e.target.value)}
                />
                <p className="text-xs text-gray-400 mt-1">
                  Find in Webflow Designer → CMS → your blog collection → Collection Settings.
                </p>
              </div>
              <div className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 border border-gray-200">
                <Lock className="w-4 h-4 text-emerald-500 shrink-0" />
                <p className="text-xs text-gray-500">Your credentials are encrypted with AES-256-GCM before being stored.</p>
              </div>
              <Button
                onClick={handleConnect}
                disabled={!webflowApiKey || !webflowCollectionId || connectWebflowMutation.isPending}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                {connectWebflowMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Connecting…</>
                ) : (
                  "Connect Webflow"
                )}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    // ── Zapier ──
    if (selectedPlatform === "zapier") {
      const handleConnect = async () => {
        if (!iauditUserId) return;
        setError(null);
        try {
          const result = await connectZapierMutation.mutateAsync({
            iauditUserId,
            businessId,
            outboundWebhookUrl: zapierOutboundUrl || undefined,
          });
          setActiveConnectionId(result.connectionId);
          if (result.inboundUrl) {
            setZapierInboundUrl(`${window.location.origin}${result.inboundUrl}`);
          }
          await refetchConnections();
          setJustConnected("Zapier");
          setView("connections");
        } catch (err: any) {
          const msg: string = err?.message ?? "Connection failed.";
          setError({ code: "unknown", message: msg });
        }
      };

      return (
        <div className="max-w-2xl mx-auto px-4 py-6">
          <div className="max-w-lg mx-auto">
            <button onClick={goBack} className="flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm mb-8 transition-colors">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Connect via Zapier</h1>
            <p className="text-gray-500 mb-4">Use Zapier as a universal fallback to connect any CMS platform — including platforms not listed above, or when direct API access is restricted.</p>

            {/* Platform-specific setup instructions */}
            <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4 mb-6">
              <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wide mb-3">How to connect your platform via Zapier</p>
              <ol className="space-y-2 text-xs text-gray-700 list-decimal list-inside">
                <li>Create a free account at <a href="https://zapier.com" target="_blank" rel="noopener noreferrer" className="text-indigo-600 underline">zapier.com</a> if you don’t have one.</li>
                <li>Create a new Zap. Choose your CMS as the <strong>Trigger</strong> (e.g. “New Blog Post in WordPress”, “New Post in Wix”, “New Article in Shopify”).</li>
                <li>Add a <strong>Webhooks by Zapier</strong> action step. Select <em>POST</em> as the method.</li>
                <li>Paste your iAudit inbound webhook URL (generated below) as the destination URL.</li>
                <li>Map these fields from your CMS to the webhook payload:
                  <ul className="ml-4 mt-1 space-y-0.5 list-disc list-inside text-gray-600">
                    <li><code className="bg-white px-1 rounded">title</code> — post title (required)</li>
                    <li><code className="bg-white px-1 rounded">body</code> — full post body HTML (required)</li>
                    <li><code className="bg-white px-1 rounded">focusKeyword</code>, <code className="bg-white px-1 rounded">metaTitle</code>, <code className="bg-white px-1 rounded">metaDescription</code> (optional)</li>
                    <li><code className="bg-white px-1 rounded">slug</code>, <code className="bg-white px-1 rounded">status</code>, <code className="bg-white px-1 rounded">platform</code>, <code className="bg-white px-1 rounded">postId</code> (optional)</li>
                  </ul>
                </li>
                <li>Turn on your Zap. New posts will appear in iAudit automatically.</li>
              </ol>
            </div>

            {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
            <div className="space-y-5">
              <div>
                <Label className="text-gray-700 mb-1.5 block">Inbound Webhook URL</Label>
                <p className="text-xs text-gray-500 mb-2">Copy this URL into your Zapier zap as the webhook destination.</p>
                {zapierInboundUrl ? (
                  <div className="flex gap-2">
                    <Input readOnly value={zapierInboundUrl} className="text-xs font-mono" />
                    <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(zapierInboundUrl); toast.success("Webhook URL copied"); }}>
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400">Click "Save Zapier Connection" to generate your unique webhook URL.</p>
                )}
              </div>
              <div>
                <Label className="text-gray-700 mb-1.5 flex items-center gap-1">
                  Outbound Webhook URL <span className="text-gray-400 font-normal ml-1">(optional)</span>
                  <HelpTooltip text="When a rewrite is approved in iAudit, it will send the rewritten post to this Zapier webhook URL." />
                </Label>
                <Input type="url" placeholder="https://hooks.zapier.com/hooks/catch/..." value={zapierOutboundUrl} onChange={(e) => setZapierOutboundUrl(e.target.value)} />
              </div>
              <Button onClick={handleConnect} disabled={connectZapierMutation.isPending} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white">
                {connectZapierMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save Zapier Connection"}
              </Button>
            </div>
          </div>
        </div>
      );
    }
  }

  // ─── View: Import options ──────────────────────────────────────────────────

  if (view === "import-options") {
    const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string; description: string; icon: React.ReactNode }> = [
      { value: "all", label: "All Posts", description: "Import published, scheduled, and draft posts", icon: <FileText className="w-5 h-5" /> },
      { value: "published", label: "Published Only", description: "Only posts that are live on your site", icon: <CheckCircle2 className="w-5 h-5 text-emerald-500" /> },
      { value: "scheduled", label: "Scheduled Only", description: "Posts queued for future publication", icon: <Clock className="w-5 h-5 text-yellow-500" /> },
      { value: "draft", label: "Drafts Only", description: "Unpublished draft posts", icon: <FileText className="w-5 h-5 text-gray-400" /> },
    ];

    // Zapier doesn't support import — posts arrive via webhook
    if (selectedPlatform === "zapier") {
      return (
        <div className="max-w-2xl mx-auto px-4 py-6">
          <div className="max-w-lg mx-auto text-center">
            <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-emerald-600" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Zapier Connected</h1>
            <p className="text-gray-500 mb-6">Posts will appear in iAudit automatically when your Zapier zap triggers.</p>
            <div className="flex gap-3 justify-center">
              <Button onClick={() => navigate("/posts")} className="bg-indigo-600 hover:bg-indigo-700 text-white">View Posts</Button>
              <Button onClick={() => setView("connections")} variant="outline">Back to Connections</Button>
            </div>
          </div>
        </div>
      );
    }

    const handleImport = async () => {
      if (!iauditUserId || !activeConnectionId) return;
      setError(null);
      setView("importing");
      try {
        const results = await importMutation.mutateAsync({ iauditUserId, connectionId: activeConnectionId, statusFilter });
        setImportResults(results);
        setView("results");
      } catch (err: any) {
        const msg: string = err?.message ?? "Import failed.";
        const code = Object.entries(ERROR_MESSAGES).find(([, v]) => v === msg)?.[0] ?? "unknown";
        setError({ code, message: msg });
        setView("import-options");
      }
    };

    return (
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="max-w-lg mx-auto">
          <button onClick={() => setView("connections")} className="flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm mb-8 transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back to Connections
          </button>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Import Posts</h1>
          <p className="text-gray-500 mb-2">Select which post types to import. Trash posts are never imported.</p>
          {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
          <div className="space-y-3 mt-6">
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setStatusFilter(opt.value)}
                className={`w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-all ${
                  statusFilter === opt.value
                    ? "border-indigo-400 bg-indigo-50"
                    : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                <div className="text-gray-500">{opt.icon}</div>
                <div className="flex-1">
                  <div className="font-medium text-gray-900">{opt.label}</div>
                  <div className="text-sm text-gray-500">{opt.description}</div>
                </div>
                <div className={`w-4 h-4 rounded-full border-2 transition-colors ${statusFilter === opt.value ? "border-indigo-500 bg-indigo-500" : "border-gray-300"}`} />
              </button>
            ))}
          </div>
          <Button onClick={handleImport} className="w-full mt-6 bg-indigo-600 hover:bg-indigo-700 text-white">
            Import Posts
          </Button>
        </div>
      </div>
    );
  }

  // ─── View: Importing progress ──────────────────────────────────────────────

  if (view === "importing") {
    const platformName = selectedPlatform === "wix" ? "Wix" : selectedPlatform === "shopify" ? "Shopify" : "WordPress";
    return (
      <div className="flex items-center justify-center py-24">
        <div className="text-center max-w-sm">
          <div className="relative w-20 h-20 mx-auto mb-6">
            <div className="absolute inset-0 rounded-full border-4 border-indigo-100" />
            <div className="absolute inset-0 rounded-full border-4 border-t-indigo-500 animate-spin" />
            <RefreshCw className="absolute inset-0 m-auto w-8 h-8 text-indigo-400" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Importing Your Posts</h2>
          <p className="text-gray-500 text-sm">
            Connecting to {platformName} and fetching your posts. This may take a moment for large sites.
          </p>
        </div>
      </div>
    );
  }

  // ─── View: Import results ──────────────────────────────────────────────────

  if (view === "results" && importResults) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="max-w-lg mx-auto">
          <div className="text-center mb-8">
            <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-emerald-600" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Import Complete</h1>
            <p className="text-gray-500">
              {importResults.totalImported} post{importResults.totalImported !== 1 ? "s" : ""} imported successfully.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-8">
            {[
              { label: "Published", count: importResults.counts.published, color: "text-emerald-600" },
              { label: "Scheduled", count: importResults.counts.scheduled, color: "text-yellow-600" },
              { label: "Drafts", count: importResults.counts.draft, color: "text-gray-500" },
            ].map((item) => (
              <div key={item.label} className="text-center p-4 rounded-xl bg-gray-50 border border-gray-200">
                <div className={`text-2xl font-bold ${item.color}`}>{item.count}</div>
                <div className="text-xs text-gray-500 mt-1">{item.label}</div>
              </div>
            ))}
          </div>

          {importResults.errors.length > 0 && (
            <div className="mb-6 p-4 rounded-lg bg-yellow-50 border border-yellow-200">
              <p className="text-yellow-700 text-sm font-medium mb-2">
                {importResults.errors.length} post{importResults.errors.length !== 1 ? "s" : ""} could not be imported:
              </p>
              <ul className="text-xs text-yellow-600 space-y-1">
                {importResults.errors.slice(0, 5).map((e, i) => <li key={i}>• {e}</li>)}
                {importResults.errors.length > 5 && <li>• …and {importResults.errors.length - 5} more</li>}
              </ul>
            </div>
          )}

          <div className="flex gap-3">
            <Button onClick={() => navigate("/posts")} className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white">
              View Posts
            </Button>
            <Button onClick={() => setView("connections")} variant="outline" className="flex-1">
              Back to Connections
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
