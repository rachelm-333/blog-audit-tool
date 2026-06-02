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
import { Loader2, Eye, EyeOff } from "lucide-react";

export default function Login() {
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const loginMutation = trpc.iauth.login.useMutation({
    onSuccess: (data) => {
      setIauditSession(data.accessToken, {
        id: data.user.id,
        email: data.user.email,
        name: data.user.name,
        accountType: data.user.accountType as "solo" | "agency" | "admin",
        emailVerified: data.user.emailVerified,
        creditsRemaining: data.user.creditsRemaining,
      });
      navigate("/dashboard");
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
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-3xl font-extrabold text-primary tracking-tight">iAudit</div>
          <div className="text-xs text-muted-foreground uppercase tracking-widest mt-1">Blog Audit Engine</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-8 shadow-lg">
          <h1 className="text-xl font-bold text-foreground mb-1">Welcome back</h1>
          <p className="text-sm text-muted-foreground mb-6">Sign in to your iAudit account</p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email Address</Label>
              <Input id="email" type="email" placeholder="you@yourbusiness.com.au" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required className="bg-secondary border-border" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Password</Label>
              <div className="relative">
                <Input id="password" type={showPassword ? "text" : "password"} placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required className="bg-secondary border-border pr-10" />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div className="flex justify-end">
              <a href="/forgot-password" className="text-xs text-primary hover:text-primary/80 transition-colors">Forgot password?</a>
            </div>
            <Button type="submit" className="w-full font-semibold" disabled={loginMutation.isPending || !email || !password}>
              {loginMutation.isPending ? <><Loader2 size={16} className="animate-spin mr-2" />Signing in…</> : "Sign In"}
            </Button>
          </form>
          <div className="mt-6 pt-6 border-t border-border text-center">
            <p className="text-sm text-muted-foreground">Don't have an account?{" "}<a href="/register" className="text-primary hover:text-primary/80 font-semibold transition-colors">Create one free</a></p>
          </div>
        </div>
      </div>
    </div>
  );
}
