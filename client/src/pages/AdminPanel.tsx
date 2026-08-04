/**
 * AdminPanel.tsx — Layer 15
 *
 * Four views:
 *   1. User List — all users with stats, Add Credits, Suspend/Unsuspend, Delete
 *   2. Usage Dashboard — platform-wide audit/rewrite stats
 *   3. Revenue Dashboard — Stripe purchase stats
 *   4. Error Log — last 500 error_log rows with mark-reviewed
 *
 * Accessible only to admin accounts (server enforces this via assertAdmin).
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { getIauditUserId } from "@/hooks/useIauditAuth";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Download,
  Shield,
  TrendingUp,
  Users,
} from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatDate(d: Date | string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Add Credits Dialog
// ---------------------------------------------------------------------------
function AddCreditsDialog({
  userId,
  userName,
  open,
  onClose,
  iauditUserId,
}: {
  userId: string;
  userName: string;
  open: boolean;
  onClose: () => void;
  iauditUserId: string;
}) {
  const [credits, setCredits] = useState(10);
  const [note, setNote] = useState("");
  const utils = trpc.useUtils();

  const addCreditsMutation = trpc.admin.addCredits.useMutation({
    onSuccess: () => {
      toast.success(`${credits} credits added to ${userName}`);
      utils.admin.listUsers.invalidate();
      onClose();
      setCredits(10);
      setNote("");
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Credits — {userName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="credits-amount">Credits to add</Label>
            <Input
              id="credits-amount"
              type="number"
              min={1}
              max={10000}
              value={credits}
              onChange={(e) => setCredits(parseInt(e.target.value) || 1)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="credits-note">Note (required)</Label>
            <Input
              id="credits-note"
              placeholder="e.g. Goodwill grant — support ticket #123"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!note.trim() || addCreditsMutation.isPending}
            onClick={() =>
              addCreditsMutation.mutate({
                iauditUserId,
                userId,
                credits,
                note: note.trim(),
              })
            }
          >
            {addCreditsMutation.isPending ? "Adding…" : "Add Credits"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// User List Tab
// ---------------------------------------------------------------------------
function UserListTab({ iauditUserId }: { iauditUserId: string }) {
  const { data, isLoading } = trpc.admin.listUsers.useQuery({ iauditUserId });
  const utils = trpc.useUtils();
  const [addCreditsUser, setAddCreditsUser] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [keywordUserId, setKeywordUserId] = useState<string | null>(null);

  const suspendMutation = trpc.admin.suspendUser.useMutation({
    onSuccess: (_, vars) => {
      toast.success(vars.suspended ? "User suspended" : "User unsuspended");
      utils.admin.listUsers.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.admin.deleteUser.useMutation({
    onSuccess: () => {
      toast.success("User and all data deleted");
      utils.admin.listUsers.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const keywordQuery = trpc.admin.downloadKeywordRegistry.useQuery(
    { iauditUserId, userId: keywordUserId ?? "" },
    { enabled: !!keywordUserId }
  );

  // Handle keyword CSV download when query succeeds
  useEffect(() => {
    if (!keywordUserId || !keywordQuery.isSuccess || !keywordQuery.data) return;
    const d = keywordQuery.data;
    if (d.rowCount === 0) {
      toast.info("No keywords found for this user");
    } else {
      downloadCsv(d.csv, `keyword-registry-${keywordUserId.slice(0, 8)}.csv`);
      toast.success(`Downloaded ${d.rowCount} keyword rows`);
    }
    setKeywordUserId(null);
  }, [keywordUserId, keywordQuery.isSuccess, keywordQuery.data]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-[var(--fg-3)] text-sm">
        Loading users…
      </div>
    );
  }

  const users = data ?? [];

  return (
    <>
      <div className="rounded-[var(--r-md)] border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Credits</TableHead>
              <TableHead className="text-right">Audits</TableHead>
              <TableHead className="text-right">Rewrites</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-center text-[var(--fg-3)] py-8"
                >
                  No users found
                </TableCell>
              </TableRow>
            )}
            {users.map((u) => (
              <TableRow key={u.id} className={u.isSuspended ? "opacity-50" : ""}>
                <TableCell>
                  <div>
                    <p className="font-medium text-sm">{u.name}</p>
                    <p className="text-xs text-[var(--fg-3)]">{u.email}</p>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      u.accountType === "admin"
                        ? "default"
                        : u.accountType === "agency"
                          ? "secondary"
                          : "outline"
                    }
                    className="text-xs"
                  >
                    {u.accountType}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {u.creditsRemaining}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {u.totalAudits}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {u.totalRewrites}
                </TableCell>
                <TableCell className="text-sm text-[var(--fg-3)]">
                  {formatDate(u.createdAt)}
                </TableCell>
                <TableCell>
                  {u.isSuspended ? (
                    <Badge variant="destructive" className="text-xs">
                      Suspended
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="text-xs text-[var(--fg-1)] border-[var(--volt)]/30"
                    >
                      Active
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() =>
                        setAddCreditsUser({ id: u.id, name: u.name })
                      }
                    >
                      <CreditCard className="h-3 w-3 mr-1" />
                      Credits
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={keywordQuery.isFetching}
                      onClick={() => setKeywordUserId(u.id)}
                    >
                      <Download className="h-3 w-3 mr-1" />
                      Keywords
                    </Button>
                    {u.accountType !== "admin" && (
                      <>
                        <Button
                          size="sm"
                          variant={u.isSuspended ? "default" : "outline"}
                          className="h-7 text-xs"
                          disabled={suspendMutation.isPending}
                          onClick={() =>
                            suspendMutation.mutate({
                              iauditUserId,
                              userId: u.id,
                              suspended: !u.isSuspended,
                            })
                          }
                        >
                          {u.isSuspended ? "Unsuspend" : "Suspend"}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 text-xs"
                          disabled={deleteMutation.isPending}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete ${u.name} and ALL their data? This cannot be undone.`
                              )
                            ) {
                              deleteMutation.mutate({
                                iauditUserId,
                                userId: u.id,
                              });
                            }
                          }}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {addCreditsUser && (
        <AddCreditsDialog
          userId={addCreditsUser.id}
          userName={addCreditsUser.name}
          open={true}
          onClose={() => setAddCreditsUser(null)}
          iauditUserId={iauditUserId}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Usage Dashboard Tab
// ---------------------------------------------------------------------------
function UsageDashboardTab({ iauditUserId }: { iauditUserId: string }) {
  const { data, isLoading } = trpc.admin.getUsageDashboard.useQuery({
    iauditUserId,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-[var(--fg-3)] text-sm">
        Loading usage data…
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Audits</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {data.totalAudits}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Rewrites</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {data.totalRewrites}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Full Rewrites</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {data.rewritesByMode.fullRewrite}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Smart Patches</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {data.rewritesByMode.smartPatch}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Per-user breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-User Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Audits</TableHead>
                <TableHead className="text-right">Rewrites</TableHead>
                <TableHead className="text-right">Credits Used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.perUser.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center text-[var(--fg-3)] py-8"
                  >
                    No users yet
                  </TableCell>
                </TableRow>
              )}
              {data.perUser.map((u) => (
                <TableRow key={u.userId}>
                  <TableCell>
                    <p className="font-medium text-sm">{u.name}</p>
                    <p className="text-xs text-[var(--fg-3)]">{u.email}</p>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {u.auditCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {u.rewriteCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {u.creditsConsumed}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revenue Dashboard Tab
// ---------------------------------------------------------------------------
function RevenueDashboardTab({ iauditUserId }: { iauditUserId: string }) {
  const { data, isLoading } = trpc.admin.getRevenueDashboard.useQuery({
    iauditUserId,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-[var(--fg-3)] text-sm">
        Loading revenue data…
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      {data.isTestMode && (
        <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Stripe is in <strong>test mode</strong>. Revenue figures are from
            test transactions only.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Purchases</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {data.totalPurchases}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Revenue (AUD)</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              ${data.totalRevenueAud.toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Revenue by Pack Size</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pack Size</TableHead>
                <TableHead className="text-right">Purchases</TableHead>
                <TableHead className="text-right">Revenue (AUD)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.byPackSize.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center text-[var(--fg-3)] py-8"
                  >
                    No purchases yet
                  </TableCell>
                </TableRow>
              )}
              {data.byPackSize.map((p) => (
                <TableRow key={p.credits}>
                  <TableCell className="font-medium">
                    {p.credits} credits
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.count}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    ${p.revenueAud.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error Log Tab
// ---------------------------------------------------------------------------
function ErrorLogTab({ iauditUserId }: { iauditUserId: string }) {
  const { data, isLoading } = trpc.admin.getErrorLog.useQuery({ iauditUserId });
  const utils = trpc.useUtils();

  const markReviewedMutation = trpc.admin.markErrorReviewed.useMutation({
    onSuccess: () => utils.admin.getErrorLog.invalidate(),
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-[var(--fg-3)] text-sm">
        Loading error log…
      </div>
    );
  }

  const rows = data ?? [];
  const unreviewed = rows.filter((r) => !r.reviewed).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--fg-3)]">
          {rows.length} entries (last 500) —{" "}
          <span className="text-destructive font-medium">
            {unreviewed} unreviewed
          </span>
        </p>
      </div>

      <div className="rounded-[var(--r-md)] border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Layer</TableHead>
              <TableHead>Error Type</TableHead>
              <TableHead>Message</TableHead>
              <TableHead className="text-right">Reviewed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-[var(--fg-3)] py-8"
                >
                  No errors logged
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow
                key={r.id}
                className={r.reviewed ? "opacity-50" : ""}
              >
                <TableCell className="text-xs text-[var(--fg-3)] whitespace-nowrap">
                  {formatDate(r.createdAt)}
                </TableCell>
                <TableCell>
                  <p className="text-xs font-medium">{r.userEmail}</p>
                  {r.businessName && (
                    <p className="text-xs text-[var(--fg-3)]">
                      {r.businessName}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs font-mono">
                    {r.layer}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="secondary"
                    className="text-xs font-mono"
                  >
                    {r.errorType}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-xs">
                  <p className="text-xs text-[var(--fg-3)] truncate">
                    {r.errorMessage}
                  </p>
                </TableCell>
                <TableCell className="text-right">
                  <button
                    onClick={() =>
                      markReviewedMutation.mutate({
                        iauditUserId,
                        errorId: r.id,
                        reviewed: !r.reviewed,
                      })
                    }
                    className="inline-flex items-center justify-center"
                    title={r.reviewed ? "Mark unreviewed" : "Mark reviewed"}
                  >
                    <CheckCircle2
                      className={`h-4 w-4 transition-colors ${
                        r.reviewed
                          ? "text-green-500"
                          : "text-[var(--fg-3)] hover:text-green-500"
                      }`}
                    />
                  </button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Admin Panel Page
// ---------------------------------------------------------------------------
export default function AdminPanel() {
  const iauditUserId = getIauditUserId() ?? "";

  return (
    <DashboardLayout>
      <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-[var(--r-md)] bg-[var(--volt)]/10 flex items-center justify-center shrink-0">
            <Shield className="h-5 w-5 text-[var(--ink)]" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Admin Panel
            </h1>
            <p className="text-sm text-[var(--fg-3)]">
              Platform management — visible to admin accounts only
            </p>
          </div>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="users">
          <TabsList className="mb-4">
            <TabsTrigger value="users" className="gap-1.5">
              <Users className="h-3.5 w-3.5" />
              Users
            </TabsTrigger>
            <TabsTrigger value="usage" className="gap-1.5">
              <TrendingUp className="h-3.5 w-3.5" />
              Usage
            </TabsTrigger>
            <TabsTrigger value="revenue" className="gap-1.5">
              <CreditCard className="h-3.5 w-3.5" />
              Revenue
            </TabsTrigger>
            <TabsTrigger value="errors" className="gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              Error Log
            </TabsTrigger>
            <TabsTrigger value="auditrules" className="gap-1.5">
              <Shield className="h-3.5 w-3.5" />
              Audit Rules
            </TabsTrigger>
          </TabsList>

          <TabsContent value="users">
            <UserListTab iauditUserId={iauditUserId} />
          </TabsContent>
          <TabsContent value="usage">
            <UsageDashboardTab iauditUserId={iauditUserId} />
          </TabsContent>
          <TabsContent value="revenue">
            <RevenueDashboardTab iauditUserId={iauditUserId} />
          </TabsContent>
          <TabsContent value="errors">
            <ErrorLogTab iauditUserId={iauditUserId} />
          </TabsContent>
          <TabsContent value="auditrules">
            <AuditRulesTab />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}

// ── Audit Rules Tab ────────────────────────────────────────────────────────────

const AUDIT_RULES_FULL = [
  // Macro Architecture
  { id: "MAC-01", name: "URL Structure",        phase: "Macro", pts: 3,  criteria: "URL path has ≥ 2 segments and no date in path (e.g. /blog/brand-strategy not /2024/06/post)" },
  { id: "MAC-02", name: "Meta Title",           phase: "Macro", pts: 2,  criteria: "Meta title is present and ≤ 60 characters" },
  { id: "MAC-03", name: "Meta Description",     phase: "Macro", pts: 1,  criteria: "Meta description is present and ≤ 160 characters" },
  { id: "MAC-04", name: "Keyword Optimisation", phase: "Macro", pts: 4,  criteria: "Focus keyword appears in both meta title and meta description" },
  { id: "MAC-05", name: "Article Schema",       phase: "Macro", pts: 3,  criteria: "Page includes Article or BlogPosting schema markup (JSON-LD)" },
  { id: "MAC-06", name: "FAQ Schema",           phase: "Macro", pts: 4,  criteria: "Page includes FAQPage schema markup (JSON-LD)" },
  { id: "MAC-07", name: "Brand Schema",         phase: "Macro", pts: 2,  criteria: "Page includes Organization schema markup (JSON-LD)" },
  { id: "MAC-08", name: "Author Schema",        phase: "Macro", pts: 3,  criteria: "Page includes Person schema markup for the author (JSON-LD)" },
  { id: "MAC-09", name: "Pillar Link",          phase: "Macro", pts: 7,  criteria: "Post contains an internal anchor link whose exact text matches the hub keyword" },
  { id: "MAC-10", name: "Child Links",          phase: "Macro", pts: 3,  criteria: "Hub pages only: contains ≥ 1 internal link pointing to a deeper child page (path depth ≥ 2)" },
  { id: "MAC-11", name: "Internal Links",       phase: "Macro", pts: 3,  criteria: "Post contains ≥ 1 internal link (href starting with /)" },
  // Micro Architecture
  { id: "MIC-01", name: "Heading Structure",    phase: "Micro", pts: 3,  criteria: "Page has exactly one H1 tag" },
  { id: "MIC-02", name: "Keyword in Heading",   phase: "Micro", pts: 6,  criteria: "The focus keyword appears in the H1" },
  { id: "MIC-03", name: "Question Headlines",   phase: "Micro", pts: 6,  criteria: "≥ 50% of H2s are phrased as questions (end with ? or start with who/what/where/why/when/how/do/does/can/is/are/should)" },
  { id: "MIC-04", name: "Heading Depth",        phase: "Micro", pts: 3,  criteria: "Post contains at least one H3 tag" },
  { id: "MIC-05", name: "Answer Clarity",       phase: "Micro", pts: 5,  criteria: "First paragraph after each H2 is ≤ 60 words (direct answer pattern)" },
  { id: "MIC-06", name: "Content Lists",        phase: "Micro", pts: 5,  criteria: "Post contains at least one unordered (ul) or ordered (ol) list" },
  { id: "MIC-07", name: "Comparison Content",   phase: "Micro", pts: 4,  criteria: "Post contains a comparison table OR a list with ≥ 2 bold-label items (e.g. <strong>Label:</strong> value)" },
  { id: "MIC-08", name: "Paragraph Length",     phase: "Micro", pts: 5,  criteria: "No paragraph exceeds ~100 words or 4 sentences" },
  // E-E-A-T & Voice
  { id: "EAT-01", name: "Data & Stats",         phase: "E-E-A-T", pts: 6,  criteria: "Body contains a percentage, a number ≥ 10, or the phrase 'case study'" },
  { id: "EAT-02", name: "Experience Signals",   phase: "E-E-A-T", pts: 4,  criteria: "Body contains first-hand phrasing: 'in our experience', 'we tested', 'we found', 'when we', etc." },
  { id: "EAT-03", name: "Authenticity Signals", phase: "E-E-A-T", pts: 2,  criteria: "Body acknowledges a failed approach: 'mistake', 'doesn't work', 'avoid', 'pitfall', 'failed', etc." },
  { id: "EAT-04", name: "Expert Citations",     phase: "E-E-A-T", pts: 5,  criteria: "Post contains a blockquote attributed to a named person (— First Last pattern or <cite> tag)" },
  { id: "EAT-05", name: "Outbound Links",       phase: "E-E-A-T", pts: 4,  criteria: "Post links to a .gov, .gov.au, .edu, or wikipedia.org domain" },
  { id: "EAT-06", name: "External References",  phase: "E-E-A-T", pts: 2,  criteria: "Post links to ≥ 2 unique external domains" },
  { id: "EAT-07", name: "Writing Style",        phase: "E-E-A-T", pts: 2,  criteria: "≥ 70% of sentences use active voice (passive = is/are/was/were/be/been/being + past participle)" },
  { id: "EAT-08", name: "Natural Language",     phase: "E-E-A-T", pts: 3,  criteria: "Body contains none of the AI buzzword blocklist (leveraging, delve, tapestry, multifaceted, etc.)" },
];

const PHASE_COLORS: Record<string, string> = {
  Macro:   "bg-blue-500/10 text-blue-400 border-blue-500/20",
  Micro:   "bg-purple-500/10 text-purple-400 border-purple-500/20",
  "E-E-A-T": "bg-amber-500/10 text-amber-400 border-amber-500/20",
};

function AuditRulesTab() {
  const total = AUDIT_RULES_FULL.reduce((s, r) => s + r.pts, 0);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">27-Point Authority Standard</h2>
          <p className="text-sm text-[var(--fg-3)] mt-0.5">Full criteria for each check — admin view only. Users see check names only.</p>
        </div>
        <div className="text-sm font-bold text-[var(--fg-3)]">Total: {total} pts</div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-24">ID</TableHead>
            <TableHead className="w-32">Phase</TableHead>
            <TableHead className="w-48">Check Name</TableHead>
            <TableHead className="w-12 text-right">Pts</TableHead>
            <TableHead>What it checks</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {AUDIT_RULES_FULL.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-mono text-xs text-[var(--fg-3)]">{r.id}</TableCell>
              <TableCell>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${PHASE_COLORS[r.phase]}`}>
                  {r.phase}
                </span>
              </TableCell>
              <TableCell className="text-sm font-medium">{r.name}</TableCell>
              <TableCell className="text-right text-sm font-bold">{r.pts}</TableCell>
              <TableCell className="text-xs text-[var(--fg-3)] leading-relaxed">{r.criteria}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
