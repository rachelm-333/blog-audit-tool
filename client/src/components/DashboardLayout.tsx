import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { getLoginUrl } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import { useIauditAuth, getIauditUserId } from "@/hooks/useIauditAuth";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { trpc } from "@/lib/trpc";
import {
  LayoutDashboard,
  LogOut,
  PanelLeft,
  FileText,
  Plug,
  CreditCard,
  Globe,
  Building2,
  PlusCircle,
  ChevronRight,
  Shield,
  LifeBuoy,
  ExternalLink,
  Zap,
  Settings,
  ClipboardCheck,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { cn } from "@/lib/utils";

const menuItems = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/dashboard" },
  { icon: FileText, label: "Posts", path: "/posts" },
  { icon: ClipboardCheck, label: "Review Queue", path: "/review-queue" },
  { icon: Settings, label: "Business Setup", path: "/business/setup" },
  { icon: Plug, label: "CMS Connect", path: "/cms/connect" },
  { icon: CreditCard, label: "Credits", path: "/credits" },
  { icon: Globe, label: "Free Audit", path: "/audit" },
  { icon: LifeBuoy, label: "Support", path: "/support" },
];

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { isAuthenticated, isLoading } = useIauditAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (isLoading) {
    return <DashboardLayoutSkeleton />;
  }

  if (!isAuthenticated) {
    return (
      <div
        className="flex items-center justify-center min-h-screen"
        style={{ background: "var(--bg-page)" }}
      >
        <div className="flex flex-col items-center gap-8 p-8 max-w-sm w-full">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div
              className="h-9 w-9 rounded-xl flex items-center justify-center"
              style={{ background: "var(--ink)", boxShadow: "var(--shadow-2)" }}
            >
              <Zap className="h-5 w-5" style={{ color: "var(--volt)" }} />
            </div>
            <span
              className="text-xl tracking-tight"
              style={{ fontWeight: 800, color: "var(--fg-1)" }}
            >
              iAudit
            </span>
          </div>
          <div className="text-center" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--fg-1)" }}>
              Sign in to continue
            </h1>
            <p style={{ fontSize: 14, color: "var(--fg-2)" }}>
              Access your blog audit dashboard.
            </p>
          </div>
          <button
            onClick={() => { window.location.href = "/login"; }}
            className="pd-btn-primary w-full justify-center"
            style={{ padding: "10px 14px", fontSize: 14 }}
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({ children, setSidebarWidth }: DashboardLayoutContentProps) {
  const { user: iauditUser, logout } = useIauditAuth();
  const iauditUserId = getIauditUserId();
  const { selectedBusinessId, setSelectedBusinessId } = useBusinessContext();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activeMenuItem = menuItems.find(item => item.path === location);
  const isMobile = useIsMobile();

  const isAgency = iauditUser?.accountType === "agency" || iauditUser?.accountType === "admin";

  const { data: bizData } = trpc.dashboard.listBusinesses.useQuery(
    { iauditUserId: iauditUserId ?? "" },
    { enabled: !!iauditUserId && isAgency }
  );

  useEffect(() => {
    if (!selectedBusinessId && bizData?.businesses && bizData.businesses.length > 0) {
      setSelectedBusinessId(bizData.businesses[0].id);
    }
  }, [selectedBusinessId, bizData, setSelectedBusinessId]);

  useEffect(() => {
    if (isCollapsed) setIsResizing(false);
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => setIsResizing(false);
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  function handleBusinessSelect(id: string) {
    setSelectedBusinessId(id);
    setLocation("/dashboard");
  }

  const initials = iauditUser?.name
    ? iauditUser.name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2)
    : "?";

  return (
    <>
      {/* ── Sidebar ── */}
      <div className="relative" ref={sidebarRef}>
        <Sidebar
          collapsible="icon"
          style={{
            background: "var(--bg-page)",
            borderRight: "1px solid var(--border-1)",
          }}
          disableTransition={isResizing}
        >
          {/* Header / Logo */}
          <SidebarHeader
            style={{
              height: "var(--topbar-h)",
              borderBottom: "1px solid var(--border-1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div className="flex items-center gap-3 px-3 w-full">
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center transition-colors shrink-0"
                style={{ borderRadius: "var(--r-sm)", color: "var(--fg-3)" }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-inset)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                aria-label="Toggle navigation"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
              {!isCollapsed && (
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className="h-7 w-7 flex items-center justify-center shrink-0"
                    style={{ borderRadius: "var(--r-sm)", background: "var(--ink)" }}
                  >
                    <Zap className="h-4 w-4" style={{ color: "var(--volt)" }} />
                  </div>
                  <span
                    className="truncate"
                    style={{ fontWeight: 800, fontSize: 15, letterSpacing: "-0.02em", color: "var(--fg-1)" }}
                  >
                    iAudit
                  </span>
                </div>
              )}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0 py-2">
            {/* Agency business selector */}
            {isAgency && bizData && bizData.businesses.length > 0 && !isCollapsed && (
              <div
                className="px-3 pb-2 mb-1"
                style={{ borderBottom: "1px solid var(--border-1)" }}
              >
                <p
                  className="px-1 mb-1.5"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    fontWeight: 500,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "var(--fg-3)",
                  }}
                >
                  Client
                </p>
                <div className="space-y-0.5">
                  {bizData.businesses
                    .reduce((acc: typeof bizData.businesses, biz) => {
                      const existing = acc.findIndex(b => b.name === biz.name);
                      if (existing === -1) acc.push(biz);
                      else if (biz.id > acc[existing].id) acc[existing] = biz;
                      return acc;
                    }, [])
                    .map((biz) => {
                      const isSelected = selectedBusinessId === biz.id;
                      return (
                        <button
                          key={biz.id}
                          onClick={() => handleBusinessSelect(biz.id)}
                          className="w-full flex items-center gap-2 text-left transition-colors"
                          style={{
                            padding: "6px 10px",
                            borderRadius: "var(--r-sm)",
                            fontSize: 13,
                            fontWeight: isSelected ? 600 : 400,
                            background: isSelected ? "var(--bg-card)" : "transparent",
                            border: isSelected ? "1px solid var(--border-2)" : "1px solid transparent",
                            color: isSelected ? "var(--fg-1)" : "var(--fg-2)",
                          }}
                          onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "var(--bg-inset)"; }}
                          onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                        >
                          <Building2 className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate flex-1">{biz.name || "Unnamed"}</span>
                          {isSelected && (
                            <span
                              className="shrink-0 rounded-full"
                              style={{ width: 6, height: 6, background: "var(--volt)", display: "inline-block" }}
                            />
                          )}
                        </button>
                      );
                    })}
                  <button
                    onClick={() => setLocation("/business/setup")}
                    className="w-full flex items-center gap-2 text-left transition-colors"
                    style={{
                      padding: "6px 10px",
                      borderRadius: "var(--r-sm)",
                      fontSize: 13,
                      color: "var(--fg-3)",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-inset)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <PlusCircle className="h-3.5 w-3.5 shrink-0" />
                    <span>Add Business</span>
                  </button>
                </div>
              </div>
            )}

            {isAgency && isCollapsed && (
              <SidebarMenu className="px-2 py-1" style={{ borderBottom: "1px solid var(--border-1)" }}>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => setLocation("/business/setup")}
                    tooltip="Add Business"
                    className="h-10"
                  >
                    <Building2 className="h-4 w-4" />
                    <span>Businesses</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            )}

            {/* Nav items */}
            <SidebarMenu className="px-2">
              {menuItems.map(item => {
                const isActive = location === item.path;
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => setLocation(item.path)}
                      tooltip={item.label}
                      className="h-10 transition-all relative"
                      style={{
                        borderRadius: "var(--r-sm)",
                        fontSize: 14,
                        fontWeight: isActive ? 500 : 400,
                        background: isActive ? "var(--bg-card)" : "transparent",
                        border: isActive ? "1px solid var(--border-2)" : "1px solid transparent",
                        color: isActive ? "var(--fg-1)" : "var(--fg-2)",
                        paddingRight: isActive ? 32 : undefined,
                      }}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                      {/* Volt active dot */}
                      {isActive && (
                        <span
                          className="absolute right-2.5 shrink-0 rounded-full"
                          style={{ width: 6, height: 6, background: "var(--volt)" }}
                        />
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
              {/* Admin only */}
              {iauditUser?.accountType === "admin" && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={location === "/admin"}
                    onClick={() => setLocation("/admin")}
                    tooltip="Admin Panel"
                    className="h-10 transition-all relative"
                    style={{
                      borderRadius: "var(--r-sm)",
                      fontSize: 14,
                      fontWeight: location === "/admin" ? 500 : 400,
                      background: location === "/admin" ? "var(--bg-card)" : "transparent",
                      border: location === "/admin" ? "1px solid var(--border-2)" : "1px solid transparent",
                      color: location === "/admin" ? "var(--fg-1)" : "var(--fg-2)",
                    }}
                  >
                    <Shield className="h-4 w-4 shrink-0" />
                    <span>Admin Panel</span>
                    {location === "/admin" && (
                      <span
                        className="absolute right-2.5 shrink-0 rounded-full"
                        style={{ width: 6, height: 6, background: "var(--volt)" }}
                      />
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarContent>

          {/* Blog Batcher upsell */}
          <div className="px-3 pb-2 group-data-[collapsible=icon]:hidden">
            <a
              href="https://blogbatcher.com.au"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-2.5 p-3 transition-all group/bb"
              style={{
                borderRadius: "var(--r-md)",
                border: "1px solid var(--border-2)",
                background: "var(--bg-card)",
                textDecoration: "none",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-inset)")}
              onMouseLeave={e => (e.currentTarget.style.background = "var(--bg-card)")}
            >
              <div className="flex-1 min-w-0">
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    fontWeight: 500,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: "var(--fg-3)",
                    marginBottom: 2,
                  }}
                >
                  Blog Batcher
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-1)", lineHeight: 1.3 }}>
                  Need new posts from scratch?
                </div>
                <div style={{ fontSize: 11, color: "var(--fg-2)", marginTop: 2, lineHeight: 1.3 }}>
                  Bulk-generate SEO content with Noize's companion tool.
                </div>
              </div>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 mt-0.5" style={{ color: "var(--fg-3)" }} />
            </a>
          </div>

          {/* Footer / User */}
          <SidebarFooter
            className="p-3"
            style={{ borderTop: "1px solid var(--border-1)" }}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex items-center gap-3 w-full text-left transition-colors group-data-[collapsible=icon]:justify-center"
                  style={{ borderRadius: "var(--r-sm)", padding: "8px 8px" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-inset)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <Avatar
                    className="h-8 w-8 shrink-0"
                    style={{ borderRadius: "var(--r-pill)" }}
                  >
                    <AvatarFallback
                      style={{
                        background: "var(--ink)",
                        color: "var(--paper)",
                        fontSize: 12,
                        fontWeight: 600,
                        borderRadius: "var(--r-pill)",
                      }}
                    >
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                    <p style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-1)", lineHeight: 1.2 }} className="truncate">
                      {iauditUser?.name || "—"}
                    </p>
                    <p style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.2 }} className="truncate">
                      {iauditUser?.email || "—"}
                    </p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52" style={{ boxShadow: "var(--shadow-2)" }}>
                <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--border-1)" }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-1)" }} className="truncate">{iauditUser?.name}</p>
                  <p style={{ fontSize: 11, color: "var(--fg-3)" }} className="truncate">{iauditUser?.email}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer gap-2"
                  style={{ color: "var(--danger)" }}
                >
                  <LogOut className="h-4 w-4" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>

        {/* Resize handle */}
        <div
          className={cn(
            "absolute top-0 right-0 w-1 h-full cursor-col-resize transition-colors",
            isCollapsed ? "hidden" : ""
          )}
          onMouseDown={() => { if (!isCollapsed) setIsResizing(true); }}
          style={{ zIndex: 50 }}
          onMouseEnter={e => (e.currentTarget.style.background = "var(--volt)")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
        />
      </div>

      {/* ── Main content ── */}
      <SidebarInset style={{ background: "var(--bg-page)" }}>
        {/* Mobile top bar */}
        {isMobile && (
          <div
            className="flex h-14 items-center justify-between px-4 sticky top-0 z-40"
            style={{
              background: "var(--bg-page)",
              borderBottom: "1px solid var(--border-1)",
            }}
          >
            <div className="flex items-center gap-3">
              <SidebarTrigger
                className="h-9 w-9 transition-colors"
                style={{ borderRadius: "var(--r-sm)" }}
              />
              <div className="flex items-center gap-2">
                <div
                  className="h-6 w-6 flex items-center justify-center"
                  style={{ borderRadius: "var(--r-sm)", background: "var(--ink)" }}
                >
                  <Zap className="h-3.5 w-3.5" style={{ color: "var(--volt)" }} />
                </div>
                <span style={{ fontWeight: 600, fontSize: 14, color: "var(--fg-1)" }}>
                  {activeMenuItem?.label ?? "iAudit"}
                </span>
              </div>
            </div>
          </div>
        )}
        <main className="flex-1 p-6">{children}</main>
      </SidebarInset>
    </>
  );
}
