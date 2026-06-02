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
import { Loader2, Eye, EyeOff } from "lucide-react";

export default function Register() {
  const [, navigate] = useLocation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accountType, setAccountType] = useState<"solo" | "agency">("solo");
  const [showPassword, setShowPassword] = useState(false);
  const [done, setDone] = useState(false);

  const registerMutation = trpc.iauth.register.useMutation({
    onSuccess: () => {
      setDone(true);
    },
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
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <div className="text-3xl font-extrabold text-primary tracking-tight mb-8">iAudit</div>
          <div className="bg-card border border-border rounded-xl p-8">
            <div className="text-4xl mb-4">✉️</div>
            <h2 className="text-xl font-bold text-foreground mb-2">Check your email</h2>
            <p className="text-sm text-muted-foreground mb-6">
              We've sent a verification link to <strong className="text-foreground">{email}</strong>.
              Click the link to activate your account, then log in.
            </p>
            <Button onClick={() => navigate("/login")} className="w-full">Go to Login</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-3xl font-extrabold text-primary tracking-tight">iAudit</div>
          <div className="text-xs text-muted-foreground uppercase tracking-widest mt-1">Blog Audit Engine</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-8 shadow-lg">
          <h1 className="text-xl font-bold text-foreground mb-1">Create your account</h1>
          <p className="text-sm text-muted-foreground mb-6">Start auditing and fixing your blog posts</p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Account Type</Label>
              <div className="grid grid-cols-2 gap-2">
                {(["solo", "agency"] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setAccountType(type)}
                    className={`py-2.5 px-4 rounded-lg border text-sm font-semibold transition-all ${
                      accountType === type
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-secondary text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    {type === "solo" ? "Solo / Freelancer" : "Agency"}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="name" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Full Name</Label>
              <Input id="name" type="text" placeholder="Rachel Mackay" value={name} onChange={(e) => setName(e.target.value)} required className="bg-secondary border-border" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email Address</Label>
              <Input id="email" type="email" placeholder="you@yourbusiness.com.au" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required className="bg-secondary border-border" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Password</Label>
              <div className="relative">
                <Input id="password" type={showPassword ? "text" : "password"} placeholder="Min. 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} className="bg-secondary border-border pr-10" />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <Button type="submit" className="w-full font-semibold" disabled={registerMutation.isPending || !name || !email || !password}>
              {registerMutation.isPending ? <><Loader2 size={16} className="animate-spin mr-2" />Creating account…</> : "Create Account"}
            </Button>
          </form>
          <div className="mt-6 pt-6 border-t border-border text-center">
            <p className="text-sm text-muted-foreground">Already have an account?{" "}<a href="/login" className="text-primary hover:text-primary/80 font-semibold transition-colors">Sign in</a></p>
          </div>
        </div>
      </div>
    </div>
  );
}
