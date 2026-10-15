import { ArrowRight, BarChart3, Clock, Lock, ShieldCheck, Zap } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { api, ApiError } from "../api";
import { useAuth } from "../App";
import { ErrorBox, Logo, Spinner } from "../components/ui";

const FEATURES = [
  { icon: Zap, title: "Milliseconds, not seconds", text: "Dashboards read a cached copy from the Cloudflare edge." },
  { icon: Clock, title: "Refreshed on schedule", text: "Every 5–60 minutes, automatically. Last good data is kept on errors." },
  { icon: BarChart3, title: "Ready for BI tools", text: "JSON and CSV links for Power BI, Excel, Looker and React." },
];

export default function Login() {
  const { authenticated, setAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  if (authenticated) return <Navigate to={from} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      setAuthenticated(true);
      toast.success("Welcome back!");
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden overflow-hidden bg-slate-950 lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute -top-40 -left-40 size-[36rem] rounded-full bg-indigo-600/40 blur-3xl" />
        <div className="pointer-events-none absolute -right-32 -bottom-48 size-[32rem] rounded-full bg-fuchsia-600/30 blur-3xl" />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)", backgroundSize: "40px 40px" }}
        />
        <div className="relative flex items-center gap-3">
          <Logo className="size-10" />
          <span className="text-lg font-semibold text-white">Apps Script Cache</span>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-4xl leading-tight font-semibold tracking-tight text-white">
            Make slow Apps Script{" "}
            <span className="bg-gradient-to-r from-indigo-300 via-violet-300 to-fuchsia-300 bg-clip-text text-transparent">feel instant.</span>
          </h2>
          <div className="mt-10 space-y-6">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <div key={title} className="flex gap-4">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-indigo-200 ring-1 ring-white/15">
                  <Icon className="size-5" />
                </div>
                <div>
                  <p className="font-medium text-white">{title}</p>
                  <p className="text-sm text-slate-400">{text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <p className="relative flex items-center gap-2 text-xs text-slate-500">
          <ShieldCheck className="size-4" /> Encrypted session · links are private tokens
        </p>
      </div>

      {/* Sign-in */}
      <div className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm animate-fade-in">
          <div className="mb-8 text-center lg:text-left">
            <Logo className="mx-auto mb-5 size-12 lg:hidden" />
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h1>
            <p className="mt-1 text-sm text-slate-500">Enter the admin password (your ADMIN_KEY) to manage sources.</p>
          </div>
          <form onSubmit={submit} className="card space-y-5 p-6 sm:p-8">
            <div>
              <label htmlFor="password" className="label">
                Admin password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="password"
                  type="password"
                  className="input pl-10"
                  placeholder="••••••••••••"
                  autoComplete="current-password"
                  autoFocus
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>
            {error && <ErrorBox message={error} />}
            <button type="submit" className="btn-primary w-full py-2.5" disabled={busy || !password}>
              {busy ? <Spinner /> : null}
              Sign in
              {!busy && <ArrowRight className="size-4" />}
            </button>
          </form>
          <p className="mt-6 text-center text-xs text-slate-400">Forgot it? Change ADMIN_KEY in .env and run npm run secrets.</p>
        </div>
      </div>
    </div>
  );
}
