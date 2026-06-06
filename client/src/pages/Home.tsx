import { Button } from "@/components/ui/button";
import { useIauditAuth } from "@/hooks/useIauditAuth";
import {
  Zap,
  BarChart3,
  FileText,
  CheckCircle2,
  ArrowRight,
  Star,
  Globe,
  Plug,
  Shield,
} from "lucide-react";
import { useEffect } from "react";
import { useLocation } from "wouter";

const features = [
  {
    icon: BarChart3,
    title: "16-Point SEO Audit",
    description:
      "Every post is scored against our Authority Standard — keyword density, meta tags, internal links, schema markup, and more.",
  },
  {
    icon: Zap,
    title: "AI-Powered Rewrite",
    description:
      "Two-pass AI rewrite engine fixes every failing point while preserving your brand voice and unique insights.",
  },
  {
    icon: Plug,
    title: "Direct CMS Integration",
    description:
      "Connect WordPress, Wix, or Shopify and push optimised posts back with one click — no copy-paste required.",
  },
  {
    icon: Globe,
    title: "Free Public Audit",
    description:
      "Paste any URL and get a full SEO audit in under 60 seconds — no account needed to start.",
  },
  {
    icon: FileText,
    title: "Rich Review & Edit",
    description:
      "Fine-tune rewrites in a full rich-text editor with live character counters, alt-text management, and export options.",
  },
  {
    icon: Shield,
    title: "Agency Ready",
    description:
      "Manage multiple client blogs from one dashboard. Per-business keyword registries and CSV exports included.",
  },
];

const stats = [
  { value: "16", label: "SEO checkpoints" },
  { value: "2×", label: "AI rewrite passes" },
  { value: "3", label: "CMS integrations" },
  { value: "< 60s", label: "per audit" },
];

export default function Home() {
  const { isAuthenticated: iauditAuthenticated, isLoading: iauditLoading } = useIauditAuth();
  const [, setLocation] = useLocation();

  // Auto-redirect logged-in users to dashboard
  useEffect(() => {
    if (!iauditLoading && iauditAuthenticated) {
      setLocation("/dashboard");
    }
  }, [iauditAuthenticated, iauditLoading, setLocation]);

  function handleCTA() {
    if (iauditAuthenticated) {
      setLocation("/dashboard");
    } else {
      setLocation("/login");
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* ── Nav ── */}
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="container flex h-16 items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center shadow-sm">
              <Zap className="h-4.5 w-4.5 text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight">iAudit</span>
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">Features</a>
            <a href="#how-it-works" className="hover:text-foreground transition-colors">How it works</a>
            <a href="/audit" className="hover:text-foreground transition-colors">Free Audit</a>
          </nav>
          <div className="flex items-center gap-3">
            {!iauditLoading && (
              iauditAuthenticated ? (
                <Button onClick={() => setLocation("/dashboard")} size="sm" className="btn-primary-glow">
                  Go to Dashboard <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setLocation("/login")} className="text-muted-foreground hover:text-foreground">
                    Sign in
                  </Button>
                  <Button size="sm" onClick={() => setLocation("/register")} className="btn-primary-glow">
                    Get started free
                  </Button>
                </>
              )
            )}
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="flex-1 flex items-center justify-center py-24 px-4">
        <div className="max-w-3xl mx-auto text-center space-y-8">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-4 py-1.5 text-xs font-semibold text-indigo-700">
            <Star className="h-3.5 w-3.5 fill-indigo-500 text-indigo-500" />
            Blog Audit &amp; Rewrite Engine
          </div>

          {/* Headline */}
          <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight leading-[1.1] text-foreground">
            Get every blog post{" "}
            <span className="text-primary">ranking on page one</span>
          </h1>

          {/* Sub */}
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            iAudit audits every post against our 16-Point Authority Standard, rewrites the ones that fail, and pushes the result straight back to your CMS — all in minutes.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-2">
            <Button
              size="lg"
              onClick={handleCTA}
              className="btn-primary-glow h-12 px-8 text-base font-semibold"
            >
              {iauditAuthenticated ? "Go to Dashboard" : "Start for free"}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => setLocation("/audit")}
              className="h-12 px-8 text-base font-medium border-border hover:bg-accent"
            >
              Try free audit
            </Button>
          </div>

          {/* Trust line */}
          <p className="text-sm text-muted-foreground">
            No credit card required · Free audit on any URL · Cancel anytime
          </p>
        </div>
      </section>

      {/* ── Stats ── */}
      <section className="border-y border-border/60 bg-muted/40 py-12">
        <div className="container">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            {stats.map((s) => (
              <div key={s.label} className="space-y-1">
                <div className="text-3xl font-extrabold text-primary">{s.value}</div>
                <div className="text-sm text-muted-foreground font-medium">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" className="py-24">
        <div className="container">
          <div className="text-center mb-16 space-y-3">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
              Everything you need to rank
            </h2>
            <p className="text-lg text-muted-foreground max-w-xl mx-auto">
              From audit to publish — iAudit handles the entire SEO optimisation workflow.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f) => (
              <div
                key={f.title}
                className="group rounded-2xl border border-border/60 bg-card p-6 shadow-sm hover:shadow-md hover:border-primary/30 transition-all duration-200"
              >
                <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/15 transition-colors">
                  <f.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-semibold text-base mb-2 text-foreground">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how-it-works" className="py-24 bg-muted/30 border-y border-border/60">
        <div className="container">
          <div className="text-center mb-16 space-y-3">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
              From zero to optimised in 4 steps
            </h2>
          </div>
          <div className="grid md:grid-cols-4 gap-8">
            {[
              { step: "01", title: "Connect your CMS", desc: "Link WordPress, Wix, or Shopify in under 2 minutes." },
              { step: "02", title: "Run the audit", desc: "iAudit scores every post against 16 SEO checkpoints instantly." },
              { step: "03", title: "Rewrite failing posts", desc: "One click triggers a two-pass AI rewrite that fixes every issue." },
              { step: "04", title: "Push back live", desc: "Approve the result and post it back to your CMS — done." },
            ].map((item) => (
              <div key={item.step} className="text-center space-y-3">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary text-white font-bold text-sm shadow-md mx-auto">
                  {item.step}
                </div>
                <h3 className="font-semibold text-base text-foreground">{item.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA Banner ── */}
      <section className="py-24">
        <div className="container">
          <div className="rounded-3xl bg-primary px-8 py-16 text-center text-white shadow-xl">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Ready to rank every post?
            </h2>
            <p className="text-primary-foreground/80 text-lg mb-8 max-w-xl mx-auto">
              Start with a free audit on any URL — no account required.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button
                size="lg"
                variant="secondary"
                onClick={handleCTA}
                className="h-12 px-8 text-base font-semibold bg-white text-primary hover:bg-white/90"
              >
                {iauditAuthenticated ? "Go to Dashboard" : "Create free account"}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
              <Button
                size="lg"
                variant="ghost"
                onClick={() => setLocation("/audit")}
                className="h-12 px-8 text-base font-medium text-white hover:bg-white/10"
              >
                Try free audit
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-border/60 py-8">
        <div className="container flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-primary flex items-center justify-center">
              <Zap className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="font-semibold text-foreground">iAudit</span>
            <span className="text-border">·</span>
            <span>Blog Audit &amp; Rewrite Engine</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="/audit" className="hover:text-foreground transition-colors">Free Audit</a>
            <a href="/support" className="hover:text-foreground transition-colors">Support</a>
            <a href="https://blogbatcher.com.au" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Blog Batcher</a>
          </div>
          <p>© {new Date().getFullYear()} Noize. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
