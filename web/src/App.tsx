import { LayoutGrid, LogOut, Plus } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from "react-router";
import { Toaster, toast } from "sonner";
import { api } from "./api";
import { Logo, Spinner } from "./components/ui";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import SourceDetail from "./pages/SourceDetail";
import SourceForm from "./pages/SourceForm";

interface Auth {
  authenticated: boolean | null;
  setAuthenticated(v: boolean): void;
}
const AuthContext = createContext<Auth>({ authenticated: null, setAuthenticated: () => {} });
export const useAuth = () => useContext(AuthContext);

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .session()
      .then((s) => setAuthenticated(s.authenticated))
      .catch(() => setAuthenticated(false));
    const onExpired = () => {
      setAuthenticated(false);
      toast.error("Your session expired. Please sign in again.");
      navigate("/login");
    };
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, [navigate]);

  return (
    <AuthContext.Provider value={{ authenticated, setAuthenticated }}>
      <Toaster richColors position="top-right" closeButton toastOptions={{ className: "!rounded-xl" }} />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAuth />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sources/new" element={<SourceForm />} />
          <Route path="/sources/:id" element={<SourceDetail />} />
          <Route path="/sources/:id/edit" element={<SourceForm />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthContext.Provider>
  );
}

function RequireAuth() {
  const { authenticated } = useAuth();
  const location = useLocation();
  if (authenticated === null) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <Logo className="size-12 animate-pulse" />
        <Spinner className="size-5 text-indigo-500" />
      </div>
    );
  }
  if (!authenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return (
    <div className="min-h-screen">
      <Header />
      <main key={location.pathname} className="mx-auto max-w-6xl animate-fade-in px-4 py-8 sm:px-6 lg:py-10">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-8 text-center text-xs text-slate-400 sm:px-6">
        Apps Script Cache · served from the Cloudflare edge · data in Cloudflare D1 + Google Drive
      </footer>
    </div>
  );
}

function Header() {
  const { setAuthenticated } = useAuth();
  const navigate = useNavigate();
  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setAuthenticated(false);
      toast.success("Signed out");
      navigate("/login");
    }
  }, [navigate, setAuthenticated]);

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium transition-colors ${
      isActive ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
    }`;

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <Logo />
          <span className="hidden leading-tight sm:block">
            <span className="block text-sm font-semibold text-slate-900">Apps Script Cache</span>
            <span className="block text-[11px] text-slate-500">Instant links for slow scripts</span>
          </span>
        </Link>
        <nav className="flex items-center gap-1">
          <NavLink to="/" end className={navClass}>
            <LayoutGrid className="size-4" />
            <span className="hidden sm:inline">Sources</span>
          </NavLink>
          <NavLink to="/sources/new" className={navClass}>
            <Plus className="size-4" />
            <span className="hidden sm:inline">Add source</span>
          </NavLink>
        </nav>
        <button onClick={logout} className="btn-ghost ml-auto" title="Sign out">
          <LogOut className="size-4" />
          <span className="hidden sm:inline">Sign out</span>
        </button>
      </div>
    </header>
  );
}
