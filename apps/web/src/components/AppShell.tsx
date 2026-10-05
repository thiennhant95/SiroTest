import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { getToken, setToken } from "../lib/api";

const NAV = [
  { to: "/projects", label: "Projects" },
  { to: "/workers", label: "Workers" },
  { to: "/plugins", label: "Plugins" },
  { to: "/docs", label: "Docs" },
  { to: "/settings", label: "Settings" },
];

/** Shared app shell: brand topbar + primary nav + user/logout. Wraps every
 *  authenticated route so pages share one pro-looking frame. */
export function AppShell() {
  const nav = useNavigate();
  // vv_token holds either a session token or a dev user id (see LoginPage).
  let userLabel = "tester";
  try {
    const t = getToken();
    if (t && t.length < 64) userLabel = t;
    else if (t) userLabel = "session user";
  } catch {
    /* non-browser */
  }
  const logout = () => {
    setToken(null);
    nav("/login", { replace: true });
  };
  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link to="/projects" className="flex items-center gap-2 text-[15px] font-bold tracking-tight text-slate-900">
            <span aria-hidden className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 text-sm font-bold text-white">S</span>
            SiroTest
          </Link>
          <nav className="flex items-center gap-1" aria-label="Primary">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden max-w-40 truncate rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 sm:inline" title={userLabel}>
              {userLabel}
            </span>
            <button
              type="button"
              onClick={logout}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
