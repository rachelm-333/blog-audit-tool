/**
 * iAudit — Business Setup Page (Layer 3)
 * Step 1: Enter website URL → trigger scrape
 * Step 2: Review + edit scraped fields → confirm (sets stage1_complete=true)
 */
import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { getIauditUserId } from "@/hooks/useIauditAuth";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Loader2, Globe, CheckCircle2, AlertCircle, RefreshCw, Save } from "lucide-react";

// ─── Required fields (cannot confirm without these) ───────────────────────────
const REQUIRED_FIELDS = [
  "businessName", "industry", "location", "uvp",
  "brandVoice", "tone", "targetAudience", "primaryCtaUrl",
] as const;
type RequiredField = (typeof REQUIRED_FIELDS)[number];

interface BusinessForm {
  businessName: string;
  websiteUrl: string;
  industry: string;
  location: string;
  yearsInBusiness: string;
  clientsServed: string;
  awardsCredentials: string;
  brandVoice: string;
  tone: string;
  targetAudience: string;
  languageStyle: string;
  uvp: string;
  services: string;
  primaryCtaUrl: string;
  primaryCtaLabel: string;
  competitors: string;
}

const EMPTY_FORM: BusinessForm = {
  businessName: "", websiteUrl: "", industry: "", location: "",
  yearsInBusiness: "", clientsServed: "", awardsCredentials: "",
  brandVoice: "", tone: "", targetAudience: "", languageStyle: "",
  uvp: "", services: "", primaryCtaUrl: "", primaryCtaLabel: "", competitors: "",
};

// ─── Scrape failure messages ─────────────────────────────────────────────────
// Keys MUST match ScrapeFailureReason in scrape.service.ts:
//   "unreachable" | "robots_blocked" | "timeout" | "js_rendered_blank" | "non_english"
const FAILURE_MESSAGES: Record<string, { title: string; body: string }> = {
  unreachable: {
    title: "Website not found or unreachable",
    body: "The URL returned a 404 error or could not be reached. Please check the address and try again, or fill in your business details manually below.",
  },
  timeout: {
    title: "Scrape timed out (30 s)",
    body: "The website took too long to respond. We may have captured partial data — please review and complete any missing fields below.",
  },
  robots_blocked: {
    title: "Blocked by robots.txt",
    body: "This website's robots.txt disallows automated access. Please fill in your business details manually below.",
  },
  js_rendered_blank: {
    title: "JavaScript-rendered site detected",
    body: "This site requires JavaScript to load content. We used a headless browser to capture what we could — please review and complete any missing fields.",
  },
  non_english: {
    title: "Non-English content detected",
    body: "The website appears to be in another language. We've attempted to translate key content — please review and correct any inaccuracies below.",
  },
  // Generic fallback for unexpected failure values
  failed: {
    title: "Scrape failed",
    body: "We were unable to extract data from this website. Please fill in your business details manually below.",
  },
};

export default function BusinessSetup() {
  const [, navigate] = useLocation();
  const userId = getIauditUserId();
  const { setSelectedBusinessId } = useBusinessContext();

  // Step 1: URL input
  const [urlInput, setUrlInput] = useState("");
  const [step, setStep] = useState<"url" | "scraping" | "review">("url");
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [scrapeStatus, setScrapeStatus] = useState<string>("pending");
  const [scrapeFailureType, setScrapeFailureType] = useState<string | null>(null);
  const [form, setForm] = useState<BusinessForm>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);

  // tRPC mutations
  const startScrapeMutation = trpc.business.startScrape.useMutation();
  const saveBusinessMutation = trpc.business.save.useMutation();
  const confirmBusinessMutation = trpc.business.confirm.useMutation();

  // Poll scrape status
  const statusQuery = trpc.business.getScrapeStatus.useQuery(
    { businessId: businessId ?? "", iauditUserId: userId ?? "" },
    // @ts-ignore - skipToken when userId not available
    {
      enabled: !!businessId && step === "scraping",
      refetchInterval: (query) => {
        const status = query.state.data?.scrapeStatus;
        if (status === "complete" || status === "failed") return false;
        return 2000;
      },
    }
  );

  // When scrape finishes, populate form
  useEffect(() => {
    if (!statusQuery.data) return;
    const { scrapeStatus: status, business } = statusQuery.data;

    if (status === "complete" || status === "failed") {
      setScrapeStatus(status);
      if (business) {
        setScrapeFailureType(business.scrapeFailureType ?? null);
        setForm({
          businessName: business.businessName ?? "",
          websiteUrl: business.websiteUrl ?? "",
          industry: business.industry ?? "",
          location: business.location ?? "",
          yearsInBusiness: business.yearsInBusiness ?? "",
          clientsServed: business.clientsServed ?? "",
          awardsCredentials: business.awardsCredentials ?? "",
          brandVoice: business.brandVoice ?? "",
          tone: business.tone ?? "",
          targetAudience: business.targetAudience ?? "",
          languageStyle: business.languageStyle ?? "",
          uvp: business.uvp ?? "",
          services: Array.isArray(business.services)
            ? business.services.join(", ")
            : (business.services ?? ""),
          primaryCtaUrl: business.primaryCtaUrl ?? "",
          primaryCtaLabel: business.primaryCtaLabel ?? "",
          competitors: Array.isArray(business.competitors)
            ? business.competitors.join(", ")
            : (business.competitors ?? ""),
        });
      }
      setStep("review");
    }
  }, [statusQuery.data]);

  // ─── Handlers ────────────────────────────────────────────────────────────────

  const handleStartScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId) { toast.error("You must be logged in"); navigate("/login"); return; }
    const url = urlInput.trim();
    if (!url) return;
    try {
      const result = await startScrapeMutation.mutateAsync({ iauditUserId: userId ?? "", websiteUrl: url });
      setBusinessId(result.businessId);
      setStep("scraping");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to start scrape");
    }
  };

  const handleFieldChange = (field: keyof BusinessForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSaveProgress = useCallback(async () => {
    if (!businessId) return;
    setIsSaving(true);
    try {
      await saveBusinessMutation.mutateAsync({
        businessId,
        iauditUserId: userId ?? "",
        ...form,
        services: form.services ? form.services.split(",").map((s) => s.trim()).filter(Boolean) : [],
        competitors: form.competitors ? form.competitors.split(",").map((s) => s.trim()).filter(Boolean) : [],
      });
      toast.success("Progress saved");
    } catch (err: any) {
      toast.error(err?.message ?? "Save failed");
    } finally {
      setIsSaving(false);
    }
  }, [businessId, userId, form, saveBusinessMutation]);

  const isFormComplete = REQUIRED_FIELDS.every((f) => form[f as RequiredField]?.trim());

  const handleConfirm = async () => {
    if (!businessId || !isFormComplete) return;
    setIsConfirming(true);
    try {
      // Save latest edits first
      await saveBusinessMutation.mutateAsync({
        businessId,
        iauditUserId: userId ?? "",
        ...form,
        services: form.services ? form.services.split(",").map((s) => s.trim()).filter(Boolean) : [],
        competitors: form.competitors ? form.competitors.split(",").map((s) => s.trim()).filter(Boolean) : [],
      });
      await confirmBusinessMutation.mutateAsync({ businessId, iauditUserId: userId ?? "" });
      // Set the new business as the selected business in context
      setSelectedBusinessId(businessId);
      toast.success("Business profile confirmed!");
      // Navigate to CMS Connect to set up the connection for this new business
      navigate("/cms/connect");
    } catch (err: any) {
      toast.error(err?.message ?? "Confirmation failed");
    } finally {
      setIsConfirming(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────────

  // Step 1: URL input
  if (step === "url") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-lg">
          <div className="text-center mb-8">
            <div className="text-3xl font-extrabold text-primary tracking-tight">iAudit</div>
            <div className="text-xs text-muted-foreground uppercase tracking-widest mt-1">Step 1 of 2 — Business Setup</div>
          </div>
          <div className="bg-card border border-border rounded-xl p-8 shadow-lg">
            <h1 className="text-xl font-bold text-foreground mb-1">Enter your website URL</h1>
            <p className="text-sm text-muted-foreground mb-6">
              We'll scan your website to pre-fill your business profile. You can review and edit everything before confirming.
            </p>
            <form onSubmit={handleStartScrape} className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Website URL</Label>
                <div className="relative">
                  <Globe size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="url"
                    placeholder="https://yourbusiness.com.au"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    required
                    className="bg-secondary border-border pl-9"
                  />
                </div>
              </div>
              <Button type="submit" className="w-full font-semibold" disabled={startScrapeMutation.isPending || !urlInput}>
                {startScrapeMutation.isPending ? <><Loader2 size={16} className="animate-spin mr-2" />Starting scan…</> : "Scan My Website"}
              </Button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Step 2: Scraping in progress
  if (step === "scraping") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <div className="text-3xl font-extrabold text-primary tracking-tight mb-8">iAudit</div>
          <div className="bg-card border border-border rounded-xl p-8">
            <div className="flex justify-center mb-4">
              <div className="relative">
                <div className="w-16 h-16 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
              </div>
            </div>
            <h2 className="text-lg font-bold text-foreground mb-2">Scanning your website…</h2>
            <p className="text-sm text-muted-foreground">
              We're reading your homepage, about page, services, and contact page to build your business profile. This takes up to 30 seconds.
            </p>
            <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              Analysing copy and inferring brand voice…
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Step 3: Review form
  const failureInfo = scrapeFailureType ? FAILURE_MESSAGES[scrapeFailureType] ?? FAILURE_MESSAGES.failed : null;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-card/80 backdrop-blur border-b border-border px-6 py-3 flex items-center justify-between">
        <div>
          <span className="text-sm font-bold text-foreground">iAudit</span>
          <span className="text-xs text-muted-foreground ml-2">— Step 2 of 2: Review Business Profile</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleSaveProgress} disabled={isSaving || !businessId}>
            {isSaving ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Save size={14} className="mr-1.5" />}
            Save Progress
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={!isFormComplete || isConfirming}
            className="font-semibold"
            title={!isFormComplete ? "Please fill in all required fields before confirming" : ""}
          >
            {isConfirming ? <><Loader2 size={14} className="animate-spin mr-1.5" />Confirming…</> : <><CheckCircle2 size={14} className="mr-1.5" />Confirm Profile</>}
          </Button>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* Failure banner */}
        {failureInfo && (
          <div className="flex gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
            <AlertCircle size={18} className="text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-300">{failureInfo.title}</p>
              <p className="text-xs text-amber-200/80 mt-0.5">{failureInfo.body}</p>
            </div>
          </div>
        )}

        {/* Required fields notice */}
        {!isFormComplete && (
          <div className="flex gap-3 bg-primary/10 border border-primary/30 rounded-lg p-4">
            <AlertCircle size={18} className="text-primary flex-shrink-0 mt-0.5" />
            <p className="text-sm text-primary/90">
              Fields marked <span className="text-destructive font-bold">*</span> are required before you can confirm your profile.
            </p>
          </div>
        )}

        {/* Form sections */}
        <FormSection title="Business Basics">
          <FormField label="Business Name" required value={form.businessName} onChange={(v) => handleFieldChange("businessName", v)} placeholder="Noize Digital" />
          <FormField label="Website URL" value={form.websiteUrl} onChange={(v) => handleFieldChange("websiteUrl", v)} placeholder="https://noize.com.au" />
          <FormField label="Industry" required value={form.industry} onChange={(v) => handleFieldChange("industry", v)} placeholder="Digital Marketing Agency" />
          <FormField label="Location" required value={form.location} onChange={(v) => handleFieldChange("location", v)} placeholder="Brisbane, QLD" />
          <FormField label="Years in Business" value={form.yearsInBusiness} onChange={(v) => handleFieldChange("yearsInBusiness", v)} placeholder="8" />
          <FormField label="Clients Served" value={form.clientsServed} onChange={(v) => handleFieldChange("clientsServed", v)} placeholder="200+" />
          <FormField label="Awards & Credentials" value={form.awardsCredentials} onChange={(v) => handleFieldChange("awardsCredentials", v)} placeholder="Google Partner, Semrush Certified" />
        </FormSection>

        <FormSection title="Brand Voice & Messaging">
          <FormField label="Unique Value Proposition" required value={form.uvp} onChange={(v) => handleFieldChange("uvp", v)} placeholder="We help SMEs rank on page 1 with content that converts" textarea />
          <FormField label="Brand Voice" required value={form.brandVoice} onChange={(v) => handleFieldChange("brandVoice", v)} placeholder="Confident, approachable, data-driven" textarea />
          <FormField label="Tone" required value={form.tone} onChange={(v) => handleFieldChange("tone", v)} placeholder="Professional but conversational" />
          <FormField label="Target Audience" required value={form.targetAudience} onChange={(v) => handleFieldChange("targetAudience", v)} placeholder="Australian SMEs in professional services" textarea />
          <FormField label="Language Style" value={form.languageStyle} onChange={(v) => handleFieldChange("languageStyle", v)} placeholder="Australian English, plain language" />
        </FormSection>

        <FormSection title="Services & CTAs">
          <FormField label="Services (comma-separated)" value={form.services} onChange={(v) => handleFieldChange("services", v)} placeholder="SEO, Content Marketing, Google Ads, Social Media" textarea />
          <FormField label="Primary CTA URL" required value={form.primaryCtaUrl} onChange={(v) => handleFieldChange("primaryCtaUrl", v)} placeholder="https://noize.com.au/contact" />
          <FormField label="Primary CTA Label" value={form.primaryCtaLabel} onChange={(v) => handleFieldChange("primaryCtaLabel", v)} placeholder="Book a Free Strategy Call" />
          <FormField label="Competitors (comma-separated)" value={form.competitors} onChange={(v) => handleFieldChange("competitors", v)} placeholder="Impressive Digital, Clearwater Agency" />
        </FormSection>

        {/* Bottom action bar */}
        <div className="flex items-center justify-between pt-4 border-t border-border">
          <Button variant="outline" onClick={handleSaveProgress} disabled={isSaving}>
            {isSaving ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Save size={14} className="mr-1.5" />}
            Save Progress
          </Button>
          <div className="flex items-center gap-3">
            {!isFormComplete && (
              <span className="text-xs text-muted-foreground">Fill all required fields to continue</span>
            )}
            <Button onClick={handleConfirm} disabled={!isFormComplete || isConfirming} className="font-semibold px-6">
              {isConfirming ? <><Loader2 size={14} className="animate-spin mr-1.5" />Confirming…</> : <><CheckCircle2 size={14} className="mr-1.5" />Confirm & Continue</>}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-xl p-6 space-y-4">
      <h2 className="text-sm font-bold text-foreground uppercase tracking-wide border-b border-border pb-2">{title}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{children}</div>
    </div>
  );
}

function FormField({
  label, required, value, onChange, placeholder, textarea,
}: {
  label: string; required?: boolean; value: string;
  onChange: (v: string) => void; placeholder?: string; textarea?: boolean;
}) {
  const id = label.toLowerCase().replace(/\s+/g, "-");
  // Show error state when a required field is empty
  const hasError = required && !value.trim();
  const borderClass = hasError
    ? "border-destructive focus:border-destructive ring-destructive/20"
    : "border-border";
  return (
    <div className={`space-y-1.5 ${textarea ? "md:col-span-2" : ""}`}>
      <Label htmlFor={id} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}{required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {textarea ? (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className={`bg-secondary resize-none ${borderClass}`}
        />
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`bg-secondary ${borderClass}`}
        />
      )}
      {hasError && (
        <p className="text-xs text-destructive mt-0.5">This field is required</p>
      )}
    </div>
  );
}
