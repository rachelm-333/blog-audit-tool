/**
 * iAudit — Login Page
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { setIauditSession } from "@/hooks/useIauditAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Eye, EyeOff, Zap, CheckCircle2 } from "lucide-react";

const benefits = [
  "16-point SEO audit on every post",
  "Two-pass AI rewrite engine",
  "Direct CMS push-back (WordPress, Wix, Shopify, Webflow)",
  "Free audit on any URL — no account needed",
];

export default function Login() {
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const loginMutation = trpc.iauth.login.useMutation({
    onSuccess: (data) => {
      const user: import("@/hooks/useIauditAuth").IauditUser = {
        id: data.user.id,
        email: data.user.email,
        name: data.user.name,
        accountType: data.user.accountType as "solo" | "agency" | "admin",
        emailVerified: data.user.emailVerified,
        creditsRemaining: data.user.creditsRemaining,
        onboardingComplete: (data.user as any).onboardingComplete ?? false,
      };
      setIauditSession(data.accessToken, user);
      if (!user.onboardingComplete) {
        navigate("/onboarding");
      } else {
        navigate("/dashboard");
      }
    },
    onError: (err) => {
      toast.error(err.message || "Login failed. Please try again.");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    loginMutation.mutate({ email: email.trim(), password });
  };

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
              Get every blog post<br />ranking on page one.
            </h2>
            <p className="text-primary-foreground/75 text-base leading-relaxed">
              Audit, rewrite, and publish SEO-optimised content — all from one dashboard.
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
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Welcome back</h1>
            <p className="text-sm text-muted-foreground">Sign in to your iAudit account</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-sm font-medium text-foreground">
                Email address
              </Label>
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
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-sm font-medium text-foreground">
                  Password
                </Label>
                <a
                  href="/forgot-password"
                  className="text-xs text-primary hover:text-primary/80 transition-colors font-medium"
                >
                  Forgot password?
                </a>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
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
              disabled={loginMutation.isPending || !email || !password}
            >
              {loginMutation.isPending ? (
                <><Loader2 size={16} className="animate-spin mr-2" />Signing in…</>
              ) : (
                "Sign in"
              )}
            </Button>
          </form>

          <div className="text-center text-sm text-muted-foreground">
            Don't have an account?{" "}
            <a href="/register" className="text-primary hover:text-primary/80 font-semibold transition-colors">
              Create one free
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
