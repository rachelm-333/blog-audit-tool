/**
 * Credits.tsx — Layer 12
 *
 * The Credits screen at /credits.
 * Shows current balance, 4 credit packs, Stripe Checkout flow,
 * credit history ledger, low-credit banner, and Blog Batcher upsell.
 *
 * Layout mirrors UI Mockup Screen 6 exactly.
 */

import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useIauditAuth } from "@/hooks/useIauditAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, CreditCard, Zap, CheckCircle2, ExternalLink } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreditPack {
  id: string;
  name: string;
  credits: number;
  priceAud: number;
  priceAudCents: number;
  perPostPrice: string;
  isBestValue: boolean;
}

interface HistoryRow {
  id: string;
  date: Date | string;
  type: "purchase" | "use" | "admin_grant" | "refund";
  creditsDelta: number;
  postTitle: string | null;
  note: string | null;
  stripePaymentIntentId: string | null;
  balanceAfter: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function typeLabel(type: HistoryRow["type"]): React.ReactNode {
  switch (type) {
    case "purchase":
      return (
        <span className="text-green-400 font-medium">Purchase</span>
      );
    case "use":
      return <span className="text-muted-foreground">Used</span>;
    case "admin_grant":
      return <span className="text-blue-400 font-medium">Admin Grant</span>;
    case "refund":
      return <span className="text-amber-400 font-medium">Refund</span>;
  }
}

function deltaDisplay(delta: number): React.ReactNode {
  if (delta > 0) {
    return <span className="text-green-400 font-semibold">+{delta}</span>;
  }
  return <span className="text-red-400 font-semibold">{delta}</span>;
}

// ---------------------------------------------------------------------------
// Pack card
// ---------------------------------------------------------------------------

function PackCard({
  pack,
  onBuy,
  isBuying,
}: {
  pack: CreditPack;
  onBuy: (packId: string) => void;
  isBuying: boolean;
}) {
  return (
    <div
      className={`relative rounded-xl border p-5 flex flex-col gap-3 transition-all duration-200 cursor-pointer group
        ${
          pack.isBestValue
            ? "border-primary bg-primary/5 shadow-lg shadow-primary/10"
            : "border-border bg-card hover:border-primary/50 hover:bg-card/80"
        }`}
    >
      {pack.isBestValue && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <Badge className="bg-primary text-primary-foreground text-xs px-3 py-0.5 font-semibold shadow">
            Best Value
          </Badge>
        </div>
      )}

      <div className="text-center pt-1">
        <p className="text-xs uppercase tracking-widest text-muted-foreground font-medium mb-2">
          {pack.name}
        </p>
        <p className="text-4xl font-extrabold text-foreground leading-none">
          {pack.credits}
          <span className="text-sm font-normal text-muted-foreground ml-1">
            credits
          </span>
        </p>
        <p
          className={`text-2xl font-bold mt-2 ${
            pack.isBestValue ? "text-primary" : "text-foreground"
          }`}
        >
          ${pack.priceAud}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {pack.perPostPrice} per post
        </p>
      </div>

      <Button
        className={`w-full mt-auto ${
          pack.isBestValue ? "" : "variant-outline"
        }`}
        variant={pack.isBestValue ? "default" : "outline"}
        disabled={isBuying}
        onClick={() => onBuy(pack.id)}
      >
        {isBuying ? (
          <span className="flex items-center gap-2">
            <span className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
            Redirecting…
          </span>
        ) : (
          "Buy Now"
        )}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Credits() {
  const { user, isAuthenticated } = useIauditAuth();
  const [, navigate] = useLocation();
  const [buyingPackId, setBuyingPackId] = useState<string | null>(null);

  // Check for ?success=1 or ?cancelled=1 query params
  const params = new URLSearchParams(window.location.search);
  const justPurchased = params.get("session_id") !== null;
  const wasCancelled = params.get("cancelled") === "1";

  useEffect(() => {
    if (justPurchased) {
      toast.success("Payment successful! Your credits have been added.", {
        duration: 6000,
      });
      // Clean up URL
      window.history.replaceState({}, "", "/credits");
    }
    if (wasCancelled) {
      toast.info("Payment cancelled. No charge was made.");
      window.history.replaceState({}, "", "/credits");
    }
  }, []);

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated && user === null) {
      // Give auth state a moment to hydrate
      const t = setTimeout(() => {
        if (!isAuthenticated) navigate("/login");
      }, 1500);
      return () => clearTimeout(t);
    }
  }, [isAuthenticated, user, navigate]);

  const iauditUserId = user?.id ?? "";

  const balanceQuery = trpc.credits.getBalance.useQuery(
    { iauditUserId },
    { enabled: !!iauditUserId, refetchInterval: justPurchased ? 3000 : false }
  );

  const packsQuery = trpc.credits.getPacks.useQuery();

  const historyQuery = trpc.credits.getHistory.useQuery(
    { iauditUserId },
    { enabled: !!iauditUserId }
  );

  const checkoutMutation = trpc.credits.createCheckout.useMutation({
    onSuccess: ({ checkoutUrl }) => {
      window.open(checkoutUrl, "_blank");
      toast.info("Redirecting you to secure checkout…");
      setBuyingPackId(null);
    },
    onError: (err) => {
      toast.error(`Could not start checkout: ${err.message}`);
      setBuyingPackId(null);
    },
  });

  const handleBuy = (packId: string) => {
    if (!iauditUserId) {
      toast.error("Please log in to purchase credits.");
      return;
    }
    setBuyingPackId(packId);
    checkoutMutation.mutate({
      iauditUserId,
      userEmail: user?.email ?? "",
      userName: user?.name ?? "",
      packId: packId as "starter" | "standard" | "business" | "agency",
      origin: window.location.origin,
    });
  };

  const balance = balanceQuery.data;
  const packs = packsQuery.data ?? [];
  const history = historyQuery.data ?? [];

  const isLowCredits =
    balance !== undefined && balance.creditsRemaining > 0 && balance.creditsRemaining <= 3;
  const isZeroCredits = balance !== undefined && balance.creditsRemaining === 0;

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-8 pb-16">
        {/* ── Page header ── */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">Credits</h1>
          <p className="text-muted-foreground text-sm mt-1">
            1 credit = 1 post rewrite. Audits are always free.
          </p>
        </div>

        {/* ── Low-credit banner ── */}
        {isZeroCredits && (
          <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-5 py-4">
            <AlertTriangle className="h-5 w-5 text-red-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-red-300">
                You have no credits remaining
              </p>
              <p className="text-xs text-red-400 mt-0.5">
                Buy more credits below to continue rewriting posts.
              </p>
            </div>
          </div>
        )}
        {isLowCredits && !isZeroCredits && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-5 py-4">
            <AlertTriangle className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-300">
                Only {balance?.creditsRemaining} rewrite
                {balance?.creditsRemaining === 1 ? "" : "s"} remaining
              </p>
              <p className="text-xs text-amber-400 mt-0.5">
                Top up now to avoid interruptions.
              </p>
            </div>
          </div>
        )}

        {/* ── Balance summary card ── */}
        <div className="inline-flex items-center gap-8 rounded-xl border border-border bg-card px-6 py-4">
          {balanceQuery.isLoading ? (
            <>
              <Skeleton className="h-12 w-28" />
              <div className="w-px h-10 bg-border" />
              <Skeleton className="h-12 w-28" />
              <div className="w-px h-10 bg-border" />
              <Skeleton className="h-12 w-28" />
            </>
          ) : (
            <>
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                  Current Balance
                </p>
                <p className="text-3xl font-extrabold text-primary">
                  {balance?.creditsRemaining ?? 0}
                  <span className="text-sm font-normal text-muted-foreground ml-1">
                    credits
                  </span>
                </p>
              </div>
              <div className="w-px h-10 bg-border" />
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                  Total Purchased
                </p>
                <p className="text-3xl font-extrabold text-foreground">
                  {balance?.creditsTotalPurchased ?? 0}
                </p>
              </div>
              <div className="w-px h-10 bg-border" />
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                  Used
                </p>
                <p className="text-3xl font-extrabold text-foreground">
                  {balance?.creditsUsed ?? 0}
                </p>
              </div>
            </>
          )}
        </div>

        {/* ── Buy More Credits ── */}
        <div>
          <h2 className="text-base font-bold text-foreground mb-4">
            Buy More Credits
          </h2>

          {packsQuery.isLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-52 rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {packs.map((pack) => (
                <PackCard
                  key={pack.id}
                  pack={pack}
                  onBuy={handleBuy}
                  isBuying={buyingPackId === pack.id}
                />
              ))}
            </div>
          )}

          <p className="text-xs text-muted-foreground mt-3">
            All prices include GST. Credits never expire.
          </p>

          {/* Test mode notice */}
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground/70">
            <CreditCard className="h-3.5 w-3.5" />
            <span>
              Test mode — use card{" "}
              <code className="font-mono bg-muted px-1 py-0.5 rounded text-xs">
                4242 4242 4242 4242
              </code>{" "}
              with any future expiry and any CVC.
            </span>
          </div>
        </div>

        <Separator />

        {/* ── Credit History ── */}
        <div>
          <h2 className="text-base font-bold text-foreground mb-4">
            Credit History
          </h2>

          {historyQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 rounded-lg" />
              ))}
            </div>
          ) : history.length === 0 ? (
            <div className="rounded-xl border border-border bg-card/50 px-6 py-10 text-center">
              <Zap className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                No credit activity yet. Buy credits above to get started.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-muted-foreground text-xs font-medium">
                      Date
                    </TableHead>
                    <TableHead className="text-muted-foreground text-xs font-medium">
                      Type
                    </TableHead>
                    <TableHead className="text-muted-foreground text-xs font-medium">
                      Amount
                    </TableHead>
                    <TableHead className="text-muted-foreground text-xs font-medium">
                      Post / Note
                    </TableHead>
                    <TableHead className="text-muted-foreground text-xs font-medium text-right">
                      Balance After
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((row) => (
                    <TableRow
                      key={row.id}
                      className="border-border hover:bg-muted/20"
                    >
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDate(row.date)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {typeLabel(row.type)}
                      </TableCell>
                      <TableCell className="text-sm font-mono">
                        {deltaDisplay(row.creditsDelta)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                        {row.postTitle ?? row.note ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm text-right font-semibold text-foreground">
                        {row.balanceAfter}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <Separator />

        {/* ── Blog Batcher upsell ── */}
        <div className="rounded-xl border border-primary/20 bg-primary/5 px-6 py-5 flex flex-col md:flex-row items-start md:items-center gap-4 justify-between">
          <div>
            <h3 className="font-bold text-foreground flex items-center gap-2">
              <Zap className="h-4 w-4 text-primary" />
              All your posts are now fixed?
            </h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-xl">
              Want new posts built to the 16-Point Authority Standard from the
              start? Blog Batcher creates fully optimised content clusters ready
              to rank.
            </p>
          </div>
          <Button
            variant="default"
            className="shrink-0"
            onClick={() =>
              toast.info("Blog Batcher is coming soon — stay tuned!")
            }
          >
            Explore Blog Batcher
            <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
          </Button>
        </div>
      </div>
    </DashboardLayout>
  );
}
