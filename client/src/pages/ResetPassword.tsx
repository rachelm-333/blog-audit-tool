/**
 * iAudit — Reset Password Page
 * Reads ?token= from URL, submits new password.
 */
import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Eye, EyeOff } from "lucide-react";

export default function ResetPassword() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [done, setDone] = useState(false);

  const mutation = trpc.iauth.resetPassword.useMutation({
    onSuccess: () => setDone(true),
    onError: (err) => toast.error(err.message || "Reset failed. The link may have expired."),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { toast.error("Passwords do not match"); return; }
    if (password.length < 8) { toast.error("Password must be at least 8 characters"); return; }
    mutation.mutate({ token, newPassword: password });
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="bg-card border border-border rounded-xl p-8 max-w-md w-full text-center">
          <p className="text-destructive font-semibold">Invalid reset link. Please request a new one.</p>
          <a href="/forgot-password" className="block mt-4 text-sm text-primary">Request new link</a>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="bg-card border border-border rounded-xl p-8 max-w-md w-full text-center">
          <div className="text-4xl mb-4">✅</div>
          <h2 className="text-xl font-bold text-foreground mb-2">Password updated</h2>
          <p className="text-sm text-muted-foreground mb-6">Your password has been changed. All sessions have been signed out.</p>
          <Button onClick={() => navigate("/login")} className="w-full">Sign In</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-3xl font-extrabold text-primary tracking-tight">iAudit</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-8 shadow-lg">
          <h1 className="text-xl font-bold text-foreground mb-1">Set new password</h1>
          <p className="text-sm text-muted-foreground mb-6">Choose a strong password for your account</p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">New Password</Label>
              <div className="relative">
                <Input type={showPassword ? "text" : "password"} placeholder="Min. 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} className="bg-secondary border-border pr-10" />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Confirm Password</Label>
              <Input type="password" placeholder="Repeat password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required className="bg-secondary border-border" />
            </div>
            <Button type="submit" className="w-full font-semibold" disabled={mutation.isPending || !password || !confirm}>
              {mutation.isPending ? <><Loader2 size={16} className="animate-spin mr-2" />Updating…</> : "Update Password"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
