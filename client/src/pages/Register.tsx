/**
 * iAudit — Register Page
 * Creates a new account (solo or agency only — admin blocked).
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Eye, EyeOff, Zap, CheckCircle2, Mail } from "lucide-react";
import { cn } from "@/lib/utils";

const benefits = [
  "16-point SEO audit on every post",
  "Two-pass AI rewrite engine",
  "Direct CMS push-back (WordPress, Wix, Shopify, Webflow)",
  "Free audit on any URL — no account needed",
];

export default function Register() {
  const [, navigate] = useLocation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accountType, setAccountType] = useState<"solo" | "agency">("solo");
  const [showPassword, setShowPassword] = useState(false);
  const [done, setDone] = useState(false);

  const registerMutation = trpc.iauth.register.useMutation({
    onSuccess: () => setDone(true),
    onError: (err) => {
      toast.error(err.message || "Registration failed. Please try again.");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    registerMutation.mutate({
      name: name.trim(),
      email: email.trim(),
      password,
      accountType,
      origin: window.location.origin,
    });
  };

  if (done) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-8">
        <div className="w-full max-w-md text-center space-y-6">
          <div className="flex items-center gap-2.5 justify-center">
            <div className="h-9 w-9 rounded-xl bg-primary flex items-center justify-center shadow-md">
              <Zap className="h-5 w-5 text-white" />
            </div>
            <span className="font-bold text-xl tracking-tight text-foreground">iAudit</span>
          </div>
          <div className="rounded-2xl border border-border bg-card p-10 shadow-sm space-y-4">
            <div className="h-14 w-14 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center mx-auto">
              <Mail className="h-7 w-7 text-emerald-600" />
            </div>
            <h2 className="text-xl font-bold text-foreground">Check your email</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              We've sent a verification link to{" "}
              <strong className="text-foreground">{email}</strong>.
              Click the link to activate your account, then sign in.
            </p>
            <Button onClick={() => navigate("/login")} className="w-full h-11 btn-primary-glow">
              Go to sign in
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex">
      {/* ── Left panel — branding ── */}
      <div className="hidden lg:flex lg:w-[45%] bg-primary flex-col justify-between p-12 text-white">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-xl bg-white/20 flex items-center justify-center">
            <Zap className="h-5 w-5 text-white" />
          </div>
          <span className="font-bold text-xl tracking-tight">iAudit</span>
        </div>

        <div className="space-y-8">
          <div className="space-y-3">
            <h2 className="text-3xl font-extrabold leading-tight">
              Start ranking every<br />post on page one.
            </h2>
            <p className="text-primary-foreground/75 text-base leading-relaxed">
              Join iAudit and get your entire blog SEO-optimised in minutes.
            </p>
          </div>
          <ul className="space-y-3">
            {benefits.map((b) => (
              <li key={b} className="flex items-start gap-3 text-sm text-primary-foreground/90">
                <CheckCircle2 className="h-4.5 w-4.5 text-white/70 shrink-0 mt-0.5" />
                {b}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-primary-foreground/50">
          © {new Date().getFullYear()} Noize. All rights reserved.
        </p>
      </div>

      {/* ── Right panel — form ── */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-md space-y-8">
          {/* Mobile logo */}
          <div className="flex lg:hidden items-center gap-2.5 justify-center">
            <div className="h-9 w-9 rounded-xl bg-primary flex items-center justify-center shadow-md">
              <Zap className="h-5 w-5 text-white" />
            </div>
            <span className="font-bold text-xl tracking-tight text-foreground">iAudit</span>
          </div>

          <div className="space-y-1.5">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Create your account</h1>
            <p className="text-sm text-muted-foreground">Start auditing and fixing your blog posts</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Account type */}
            <div className="space-y-2">
              <Label className="text-sm font-medium text-foreground">Account type</Label>
              <div className="grid grid-cols-2 gap-2.5">
                {(["solo", "agency"] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setAccountType(type)}
                    className={cn(
                      "py-3 px-4 rounded-xl border text-sm font-semibold transition-all",
                      accountType === type
                        ? "border-primary bg-primary/10 text-primary shadow-sm"
                        : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:bg-accent"
                    )}
                  >
                    {type === "solo" ? "Solo / Freelancer" : "Agency"}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="name" className="text-sm font-medium text-foreground">Full name</Label>
              <Input
                id="name"
                type="text"
                placeholder="Rachel Mackay"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="h-11 bg-background border-border focus-visible:ring-primary"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-sm font-medium text-foreground">Email address</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@yourbusiness.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                className="h-11 bg-background border-border focus-visible:ring-primary"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-sm font-medium text-foreground">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Min. 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  className="h-11 bg-background border-border pr-10 focus-visible:ring-primary"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              className="w-full h-11 font-semibold btn-primary-glow"
              disabled={registerMutation.isPending || !name || !email || !password}
            >
              {registerMutation.isPending ? (
                <><Loader2 size={16} className="animate-spin mr-2" />Creating account…</>
              ) : (
                "Create account"
              )}
            </Button>
          </form>

          <div className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <a href="/login" className="text-primary hover:text-primary/80 font-semibold transition-colors">
              Sign in
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
