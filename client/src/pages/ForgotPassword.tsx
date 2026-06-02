/**
 * iAudit — Forgot Password Page
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);

  const mutation = trpc.iauth.forgotPassword.useMutation({
    onSuccess: () => setDone(true),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({ email: email.trim(), origin: window.location.origin });
  };

  if (done) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <div className="text-3xl font-extrabold text-primary tracking-tight mb-8">iAudit</div>
          <div className="bg-card border border-border rounded-xl p-8">
            <div className="text-4xl mb-4">✉️</div>
            <h2 className="text-xl font-bold text-foreground mb-2">Check your email</h2>
            <p className="text-sm text-muted-foreground">If an account exists for <strong className="text-foreground">{email}</strong>, a reset link has been sent. It expires in 1 hour.</p>
            <a href="/login" className="block mt-6 text-sm text-primary hover:text-primary/80 transition-colors">Back to login</a>
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
        </div>
        <div className="bg-card border border-border rounded-xl p-8 shadow-lg">
          <h1 className="text-xl font-bold text-foreground mb-1">Reset your password</h1>
          <p className="text-sm text-muted-foreground mb-6">Enter your email and we'll send a reset link</p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email Address</Label>
              <Input id="email" type="email" placeholder="you@yourbusiness.com.au" value={email} onChange={(e) => setEmail(e.target.value)} required className="bg-secondary border-border" />
            </div>
            <Button type="submit" className="w-full font-semibold" disabled={mutation.isPending || !email}>
              {mutation.isPending ? <><Loader2 size={16} className="animate-spin mr-2" />Sending…</> : "Send Reset Link"}
            </Button>
          </form>
          <div className="mt-4 text-center">
            <a href="/login" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Back to login</a>
          </div>
        </div>
      </div>
    </div>
  );
}
