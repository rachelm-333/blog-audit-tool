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
  User,
  ClipboardCheck,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/_core/hooks/useAuth";

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
const DEFAULT_WIDTH = 260;
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
  // Use iAudit auth (30-day refresh cookie) — NOT Manus OAuth which expires quickly
  const { isAuthenticated, isLoading } = useIauditAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (isLoading) {
    return <DashboardLayoutSkeleton />;
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="flex flex-col items-center gap-8 p-8 max-w-sm w-full">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-primary flex items-center justify-center shadow-md">
              <Zap className="h-5 w-5 text-white" />
            </div>
            <span className="text-xl font-bold tracking-tight text-foreground">iAudit</span>
          </div>
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Sign in to continue</h1>
            <p className="text-sm text-muted-foreground">
              Access your blog audit dashboard.
            </p>
          </div>
          <Button
            onClick={() => { window.location.href = "/login"; }}
            size="lg"
            className="w-full btn-primary-glow"
          >
            Sign in
          </Button>
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
          className="border-r border-border/60 bg-sidebar"
          disableTransition={isResizing}
        >
          {/* Header / Logo */}
          <SidebarHeader className="h-16 border-b border-border/60 justify-center">
            <div className="flex items-center gap-3 px-3">
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center rounded-lg hover:bg-accent transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Toggle navigation"
              >
                <PanelLeft className="h-4 w-4 text-muted-foreground" />
              </button>
              {!isCollapsed && (
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center shadow-sm shrink-0">
                    <Zap className="h-4 w-4 text-white" />
                  </div>
                  <span className="font-bold text-base tracking-tight text-foreground truncate">
                    iAudit
                  </span>
                </div>
              )}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0 py-2">
            {/* Agency business selector */}
            {isAgency && bizData && bizData.businesses.length > 0 && !isCollapsed && (
              <div className="px-3 pb-2 mb-1 border-b border-border/60">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1.5 px-1">
                  Client
                </p>
                <div className="space-y-0.5">
                  {/* Deduplicate by name — keep the most recently created entry */}
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
                        className={cn(
                          "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-colors text-left",
                          isSelected
                            ? "bg-primary/10 text-primary font-medium"
                            : "text-muted-foreground hover:text-foreground hover:bg-accent"
                        )}
                      >
                        <Building2 className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate flex-1">{biz.name || "Unnamed"}</span>
                        {isSelected && <ChevronRight className="h-3 w-3 shrink-0 opacity-60" />}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setLocation("/business/setup")}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors text-left"
                  >
                    <PlusCircle className="h-3.5 w-3.5 shrink-0" />
                    <span>Add Business</span>
                  </button>
                </div>
              </div>
            )}

            {isAgency && isCollapsed && (
              <SidebarMenu className="px-2 py-1 border-b border-border/60">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => setLocation("/business/setup")}
                    tooltip="Add Business"
                    className="h-10 font-normal"
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
                      className={cn(
                        "h-10 font-normal rounded-lg transition-all",
                        isActive
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-muted-foreground hover:text-foreground hover:bg-accent"
                      )}
                    >
                      <item.icon className={cn("h-4 w-4 shrink-0", isActive ? "text-primary" : "")} />
                      <span>{item.label}</span>
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
                    className={cn(
                      "h-10 font-normal rounded-lg transition-all",
                      location === "/admin"
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent"
                    )}
                  >
                    <Shield className={cn("h-4 w-4 shrink-0", location === "/admin" ? "text-primary" : "")} />
                    <span>Admin Panel</span>
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
              className="flex items-start gap-2.5 rounded-xl border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 hover:border-indigo-300 p-3 transition-all duration-200 group/bb"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-widest text-indigo-500 mb-0.5">
                  Blog Batcher
                </div>
                <div className="text-xs font-semibold text-indigo-900 leading-snug">
                  Need new posts from scratch?
                </div>
                <div className="text-[10px] text-indigo-600 mt-0.5 leading-snug">
                  Bulk-generate SEO content with Noize's companion tool.
                </div>
              </div>
              <ExternalLink className="h-3.5 w-3.5 text-indigo-400 shrink-0 mt-0.5 opacity-70 group-hover/bb:opacity-100 transition-opacity" />
            </a>
          </div>

          {/* Footer / User */}
          <SidebarFooter className="p-3 border-t border-border/60">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-accent transition-colors w-full text-left group-data-[collapsible=icon]:justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Avatar className="h-8 w-8 shrink-0 ring-2 ring-primary/20">
                    <AvatarFallback className="text-xs font-semibold bg-primary/10 text-primary">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                    <p className="text-sm font-semibold truncate leading-none text-foreground">
                      {iauditUser?.name || "—"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate mt-1">
                      {iauditUser?.email || "—"}
                    </p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 shadow-lg">
                <div className="px-3 py-2 border-b border-border/60">
                  <p className="text-sm font-semibold text-foreground truncate">{iauditUser?.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{iauditUser?.email}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10 gap-2"
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
            "absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors",
            isCollapsed ? "hidden" : ""
          )}
          onMouseDown={() => { if (!isCollapsed) setIsResizing(true); }}
          style={{ zIndex: 50 }}
        />
      </div>

      {/* ── Main content ── */}
      <SidebarInset className="bg-background">
        {/* Mobile top bar */}
        {isMobile && (
          <div className="flex border-b border-border/60 h-14 items-center justify-between bg-background px-4 sticky top-0 z-40 shadow-sm">
            <div className="flex items-center gap-3">
              <SidebarTrigger className="h-9 w-9 rounded-lg hover:bg-accent transition-colors" />
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-md bg-primary flex items-center justify-center">
                  <Zap className="h-3.5 w-3.5 text-white" />
                </div>
                <span className="font-semibold text-sm text-foreground">
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
