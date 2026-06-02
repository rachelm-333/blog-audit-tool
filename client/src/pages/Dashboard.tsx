/**
 * iAudit — Dashboard (placeholder for Layer 3 verification)
 * Users land here after login / business profile confirmation.
 */
import { useEffect } from "react";
import { useLocation } from "wouter";
import { useIauditAuth } from "@/hooks/useIauditAuth";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export default function Dashboard() {
  const [, navigate] = useLocation();
  const { user, isAuthenticated, isLoading, logout } = useIauditAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate("/login");
    }
  }, [isLoading, isAuthenticated, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="text-2xl font-extrabold text-primary">iAudit</div>
            <p className="text-sm text-muted-foreground mt-1">Welcome back, {user?.name ?? "User"}</p>
          </div>
          <Button variant="outline" onClick={logout} size="sm">Sign Out</Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Credits Remaining</div>
            <div className="text-3xl font-bold text-foreground">{user?.creditsRemaining ?? 0}</div>
          </div>
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Account Type</div>
            <div className="text-xl font-bold text-foreground capitalize">{user?.accountType ?? "—"}</div>
          </div>
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Email</div>
            <div className="text-sm font-medium text-foreground truncate">{user?.email ?? "—"}</div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-8 text-center">
          <h2 className="text-lg font-bold text-foreground mb-2">Set up your business profile</h2>
          <p className="text-sm text-muted-foreground mb-6">
            Before you can audit and rewrite blog posts, we need to understand your business.
          </p>
          <Button onClick={() => navigate("/business/setup")} className="font-semibold px-8">
            Start Business Setup
          </Button>
        </div>
      </div>
    </div>
  );
}
