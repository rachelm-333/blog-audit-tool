/**
 * iAudit — Onboarding Wizard (Layer 17)
 *
 * Five-step guided first-time experience:
 *   Step 1 — Welcome
 *   Step 2 — Add your business (links to BusinessSetup, polls for completion)
 *   Step 3 — Connect your blog (links to CmsConnect, polls for completion)
 *   Step 4 — Buy credits or skip
 *   Step 5 — Run your first audit
 *
 * Cannot be skipped. Returning users (onboardingComplete=true) are redirected
 * to /dashboard immediately.
 */

import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useIauditAuth, getIauditUserId } from "@/hooks/useIauditAuth";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Loader2, CheckCircle2, Zap } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-3 mb-6">
      <div className="flex gap-1.5">
        {Array.from({ length: total }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-1.5 rounded-full transition-all duration-300",
              i + 1 < current
                ? "w-6 bg-primary"
                : i + 1 === current
                ? "w-8 bg-primary"
                : "w-6 bg-muted"
            )}
          />
        ))}
      </div>
      <span className="text-xs text-muted-foreground font-medium">
        Step {current} of {total}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared step wrapper
// ---------------------------------------------------------------------------

function StepWrapper({
  step,
  title,
  description,
  children,
}: {
  step: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="border-b bg-card/50 px-6 py-5">
        <StepIndicator current={step} total={5} />
        <h2 className="text-lg font-bold text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      </div>
      <div className="flex-1 overflow-auto p-4 sm:p-6">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Welcome
// ---------------------------------------------------------------------------

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background p-6 text-center">
      <div className="max-w-md w-full">
        <div className="mb-8">
          <div className="text-5xl font-extrabold text-primary tracking-tight mb-2">iAudit</div>
          <div className="text-xs text-muted-foreground uppercase tracking-widest">Blog Audit Engine</div>
        </div>
        <h1 className="text-2xl font-bold text-foreground mb-3 leading-snug">
          Let's get your blog posts ranking on page one.
        </h1>
        <p className="text-sm text-muted-foreground mb-10">
          We'll walk you through setting up your account in just a few minutes.
        </p>
        <Button size="lg" className="w-full text-base font-semibold" onClick={onNext}>
          Get Started
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Business setup
// ---------------------------------------------------------------------------

function StepBusiness({ onNext }: { onNext: () => void }) {
  const [, navigate] = useLocation();
  const iauditUserId = getIauditUserId();

  const businessListQuery = trpc.business.list.useQuery(
    { iauditUserId: iauditUserId! },
    { enabled: !!iauditUserId, refetchInterval: 4000 }
  );

  const isComplete = (businessListQuery.data ?? []).some((b: { stage1Complete?: boolean }) => b.stage1Complete);

  return (
    <StepWrapper
      step={2}
      title="Add Your Business"
      description="Tell us about your business so iAudit can personalise every rewrite to your brand voice."
    >
      {isComplete ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
          <CheckCircle2 className="h-12 w-12 text-emerald-400" />
          <div>
            <div className="text-lg font-bold text-foreground">Business profile saved!</div>
            <div className="text-sm text-muted-foreground mt-1">Your brand voice and business details are ready.</div>
          </div>
          <Button onClick={onNext} className="mt-2">
            Continue to Connect Your Blog →
          </Button>
        </div>
      ) : (
        <div className="max-w-md mx-auto">
          <div className="rounded-xl border border-border bg-card p-5 mb-4">
            <div className="flex items-start gap-3">
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-sm font-bold text-primary">2</span>
              </div>
              <div>
                <div className="text-sm font-semibold text-foreground mb-1">Set up your business profile</div>
                <div className="text-xs text-muted-foreground">
                  Enter your website URL and we'll automatically analyse your brand voice, services, and tone.
                  You can review and edit everything before continuing.
                </div>
              </div>
            </div>
          </div>
          <Button className="w-full" onClick={() => navigate("/business/setup")}>
            Open Business Setup →
          </Button>
          <p className="text-xs text-muted-foreground text-center mt-3">
            Complete the business profile to unlock Step 3.
          </p>
          {businessListQuery.isLoading && (
            <div className="flex justify-center mt-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      )}
    </StepWrapper>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — CMS connection
// ---------------------------------------------------------------------------

function StepCms({ onNext }: { onNext: () => void }) {
  const [, navigate] = useLocation();
  const iauditUserId = getIauditUserId();

  const businessListQuery = trpc.business.list.useQuery(
    { iauditUserId: iauditUserId! },
    { enabled: !!iauditUserId }
  );
  const businessId = (businessListQuery.data ?? []).find((b: { stage1Complete?: boolean }) => b.stage1Complete)?.id;

  const connectionsQuery = trpc.cms.listConnections.useQuery(
    { iauditUserId: iauditUserId!, businessId: businessId! },
    { enabled: !!businessId && !!iauditUserId, refetchInterval: 4000 }
  );

  const hasConnection = (connectionsQuery.data?.length ?? 0) > 0;

  return (
    <StepWrapper
      step={3}
      title="Connect Your Blog"
      description="Connect your CMS so iAudit can import your posts and push rewrites directly."
    >
      {hasConnection ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
          <CheckCircle2 className="h-12 w-12 text-emerald-400" />
          <div>
            <div className="text-lg font-bold text-foreground">Blog connected!</div>
            <div className="text-sm text-muted-foreground mt-1">
              {(connectionsQuery.data?.[0] as { platform?: string })?.platform ?? "Your CMS"} is connected and ready.
            </div>
          </div>
          <Button onClick={onNext} className="mt-2">
            Continue to Credits →
          </Button>
        </div>
      ) : (
        <div className="max-w-md mx-auto">
          <div className="rounded-xl border border-border bg-card p-5 mb-4">
            <div className="flex items-start gap-3">
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-sm font-bold text-primary">3</span>
              </div>
              <div>
                <div className="text-sm font-semibold text-foreground mb-1">Connect your CMS</div>
                <div className="text-xs text-muted-foreground">
                  Supports WordPress, Wix, Shopify, Webflow, and Zapier. You'll need your site URL and API credentials.
                </div>
              </div>
            </div>
          </div>
          <Button className="w-full" onClick={() => navigate("/cms/connect")}>
            Open CMS Connect →
          </Button>
          <p className="text-xs text-muted-foreground text-center mt-3">
            Successfully connect a CMS to unlock Step 4.
          </p>
        </div>
      )}
    </StepWrapper>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Buy credits or skip
// ---------------------------------------------------------------------------

function StepCredits({ onNext }: { onNext: () => void }) {
  const { user } = useIauditAuth();
  const iauditUserId = getIauditUserId();
  const packsQuery = trpc.credits.getPacks.useQuery();
  const packs = packsQuery.data ?? [];

  const checkoutMutation = trpc.credits.createCheckout.useMutation({
    onSuccess: ({ checkoutUrl }) => {
      window.open(checkoutUrl, "_blank");
      toast.info("Redirecting to checkout…");
    },
    onError: (err: { message?: string }) => toast.error(err.message || "Checkout failed"),
  });

  return (
    <StepWrapper
      step={4}
      title="Buy Credits"
      description="1 credit = 1 post rewrite. Audits are always free."
    >
      <div className="max-w-2xl mx-auto">
        {packsQuery.isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
            {packs.map((pack: { id: string; name: string; credits: number; priceAud: number; isBestValue: boolean; perPostPrice: string }) => (
              <div
                key={pack.id}
                className={cn(
                  "relative rounded-xl border p-5 cursor-pointer transition-all hover:border-primary/50",
                  pack.isBestValue
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card"
                )}
                onClick={() => {
                  if (!iauditUserId || !user) return;
                  checkoutMutation.mutate({
                    iauditUserId,
                    userEmail: user.email,
                    userName: user.name,
                    packId: pack.id as "starter" | "standard" | "business" | "agency",
                    origin: window.location.origin,
                  });
                }}
              >
                {pack.isBestValue && (
                  <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
                    <span className="bg-primary text-primary-foreground text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide">
                      Best Value
                    </span>
                  </div>
                )}
                <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1">
                  {pack.name}
                </div>
                <div className="text-2xl font-extrabold text-foreground">
                  {pack.credits}{" "}
                  <span className="text-base font-normal text-muted-foreground">credits</span>
                </div>
                <div className="text-lg font-bold text-primary mt-1">A${pack.priceAud}</div>
                <div className="text-xs text-muted-foreground mt-1">{pack.perPostPrice} per post</div>
                {checkoutMutation.isPending && (
                  <div className="absolute inset-0 flex items-center justify-center bg-background/50 rounded-xl">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="text-center">
          <button
            onClick={onNext}
            className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
          >
            Skip for now — start with a free audit
          </button>
        </div>
      </div>
    </StepWrapper>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — Run first audit
// ---------------------------------------------------------------------------

function StepAudit({ onComplete }: { onComplete: () => void }) {
  const [, navigate] = useLocation();
  const iauditUserId = getIauditUserId();

  const businessListQuery = trpc.business.list.useQuery(
    { iauditUserId: iauditUserId! },
    { enabled: !!iauditUserId }
  );
  const businessId = (businessListQuery.data ?? []).find((b: { stage1Complete?: boolean }) => b.stage1Complete)?.id;

  const auditAllMutation = trpc.audit.runAuditAll.useMutation({
    onSuccess: () => {
      toast.success("Audit complete! Your posts have been scored.");
      onComplete();
    },
    onError: (err: { message?: string }) => toast.error(err.message || "Audit failed. Please try again."),
  });

  const [auditStarted, setAuditStarted] = useState(false);

  const handleStartAudit = () => {
    if (!businessId || !iauditUserId) return;
    setAuditStarted(true);
    auditAllMutation.mutate({ businessId, iauditUserId });
  };

  if (auditAllMutation.isSuccess) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-8 text-center">
        <div className="max-w-md w-full">
          <div className="mb-6">
            <div className="h-20 w-20 rounded-full bg-emerald-500/10 border-2 border-emerald-500/30 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="h-10 w-10 text-emerald-400" />
            </div>
            <h2 className="text-2xl font-bold text-foreground mb-2">You're all set!</h2>
            <p className="text-sm text-muted-foreground">
              Your posts have been audited. Head to the dashboard to see your results and start fixing posts.
            </p>
          </div>
          <Button size="lg" className="w-full" onClick={onComplete}>
            Go to Dashboard →
          </Button>
        </div>
      </div>
    );
  }

  return (
    <StepWrapper
      step={5}
      title="Run Your First Audit"
      description="iAudit will check every one of your posts against the 16-Point Authority Standard."
    >
      <div className="max-w-md mx-auto flex flex-col items-center justify-center py-8 text-center">
        <div className="rounded-xl border border-border bg-card p-6 mb-6 w-full">
          <Zap className="h-10 w-10 text-primary mx-auto mb-3" />
          <div className="text-base font-semibold text-foreground mb-2">
            16-Point Authority Standard
          </div>
          <p className="text-sm text-muted-foreground">
            iAudit will check every one of your posts against the 16-Point Authority Standard.
            It is free and takes about 1 minute per 10 posts.
          </p>
        </div>

        {auditStarted && auditAllMutation.isPending ? (
          <div className="flex flex-col items-center gap-3 w-full">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <div className="text-sm text-muted-foreground">Auditing your posts…</div>
            <Progress value={undefined} className="w-full h-1.5 animate-pulse" />
          </div>
        ) : (
          <>
            <Button
              size="lg"
              className="w-full text-base font-semibold"
              onClick={handleStartAudit}
              disabled={!businessId}
            >
              {!businessId ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Loading…
                </>
              ) : (
                "Start Audit →"
              )}
            </Button>
            <button
              onClick={() => navigate("/posts")}
              className="mt-3 text-sm text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
            >
              Skip — go to Posts
            </button>
          </>
        )}
      </div>
    </StepWrapper>
  );
}

// ---------------------------------------------------------------------------
// Main Onboarding component
// ---------------------------------------------------------------------------

export default function Onboarding() {
  const [, navigate] = useLocation();
  const { user, isAuthenticated, isLoading } = useIauditAuth();
  const [step, setStep] = useState(1);
  const iauditUserId = getIauditUserId();

  const completeOnboardingMutation = trpc.iauth.completeOnboarding.useMutation({
    onSuccess: () => navigate("/dashboard"),
    onError: () => navigate("/dashboard"),
  });

  // Redirect returning users to dashboard
  useEffect(() => {
    if (!isLoading && isAuthenticated && user?.onboardingComplete) {
      navigate("/dashboard");
    }
    if (!isLoading && !isAuthenticated) {
      navigate("/login");
    }
  }, [isLoading, isAuthenticated, user, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated || !user) return null;

  const handleComplete = () => {
    if (iauditUserId) {
      completeOnboardingMutation.mutate({ iauditUserId });
    } else {
      navigate("/dashboard");
    }
  };

  return (
    <>
      {step === 1 && <StepWelcome onNext={() => setStep(2)} />}
      {step === 2 && <StepBusiness onNext={() => setStep(3)} />}
      {step === 3 && <StepCms onNext={() => setStep(4)} />}
      {step === 4 && <StepCredits onNext={() => setStep(5)} />}
      {step === 5 && <StepAudit onComplete={handleComplete} />}
    </>
  );
}
