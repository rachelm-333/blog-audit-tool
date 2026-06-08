import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import DashboardLayout from "./components/DashboardLayout";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Register from "./pages/Register";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import Dashboard from "./pages/Dashboard";
import BusinessSetup from "./pages/BusinessSetup";
import CmsConnect from "./pages/CmsConnect";
import PostList from "./pages/PostList";
import ReviewEdit from "@/pages/ReviewEdit";
import ReviewQueue from "@/pages/ReviewQueue";
import AuditPage from "@/pages/Audit";
import Credits from "@/pages/Credits";
import AdminPanel from "@/pages/AdminPanel";
import SupportCentre from "@/pages/SupportCentre";
import Onboarding from "@/pages/Onboarding";

// Pages that use the sidebar DashboardLayout
function AuthenticatedRoutes() {
  return (
    <DashboardLayout>
      <Switch>
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/business/setup" component={BusinessSetup} />
        <Route path="/cms/connect" component={CmsConnect} />
        <Route path="/posts" component={PostList} />
        <Route path="/review-queue" component={ReviewQueue} />
        <Route path="/review/:postId" component={ReviewEdit} />
        <Route path="/credits" component={Credits} />
        <Route path="/credits/success" component={Credits} />
        <Route path="/admin" component={AdminPanel} />
        <Route path="/support" component={SupportCentre} />
      </Switch>
    </DashboardLayout>
  );
}

function Router() {
  return (
    <Switch>
      {/* Public pages — no sidebar */}
      <Route path="/" component={Home} />
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/audit" component={AuditPage} />
      <Route path="/onboarding" component={Onboarding} />
      <Route path="/404" component={NotFound} />

      {/* Authenticated pages — wrapped in DashboardLayout sidebar */}
      <Route component={AuthenticatedRoutes} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
