// src/components/Navbar.jsx
import { NavLink, Link, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../ThemeContext";
import { api } from "../lib/api";
import MoatLogo from "./MoatLogo";
import {
  LayoutDashboard,
  FolderKanban,
  ListChecks,
  Users as UsersIcon,
  Clock3,
  Boxes,
  Truck,
  FileText,
  FlaskConical,
  Shield,
  Settings,
  ChevronLeft,
  ChevronRight,
  LogIn,
  LogOut,
} from "lucide-react";

const ALL_MODULES = [
  "projects",
  "tasks",
  "users",
  "clockings",
  "assets",
  "vehicles",
  "invoices",
  "inspections",
  "vault",
];

// Accent (can be themed)
const ACCENT = "var(--accent, #14b8a6)"; // teal
const SIDEBAR_BG = "var(--sidebar-bg, #0f172a)";
const SIDEBAR_FG = "var(--sidebar-fg, #e5e7eb)";
const ACTIVE_BG = "var(--active-bg, #ffffff)";
const ACTIVE_FG = "var(--active-fg, #0f172a)";

/* ---- small helpers for token + roles ---- */
function safeParseJwt(t) {
  try {
    const parts = String(t || "").split(".");
    if (parts.length < 2) return null;
    return JSON.parse(atob(parts[1]));
  } catch {
    return null;
  }
}

function readToken() {
  try {
    return localStorage.getItem("token") || sessionStorage.getItem("token") || "";
  } catch {
    return "";
  }
}

function normRole(r) {
  if (!r) return "";
  return String(r).trim().toLowerCase().replace(/\s+/g, "-");
}

export default function Navbar() {
  const { org } = useTheme();
  const [token, setToken] = useState(() => readToken());
  const [open, setOpen] = useState(() => (localStorage.getItem("sidebar-open") ?? "1") === "1");
  const [meGlobalRole, setMeGlobalRole] = useState(null);
  const [meIsGlobalSuper, setMeIsGlobalSuper] = useState(false);

  const location = useLocation();
  const navigate = useNavigate();
  const adminDetailsRef = useRef(null);

  // Refresh token when route changes
  useEffect(() => {
    setToken(readToken());
  }, [location]);

  // Close admin <details> on route change (so it doesn't stay open forever)
  useEffect(() => {
    if (adminDetailsRef.current) adminDetailsRef.current.open = false;
  }, [location]);

  // Persist sidebar open/closed state
  useEffect(() => {
    localStorage.setItem("sidebar-open", open ? "1" : "0");
  }, [open]);

  const isAdminActive = location.pathname.startsWith("/admin");

  const payload = useMemo(() => safeParseJwt(token), [token]);

  // Ask backend who we are (authoritative globalRole / isGlobalSuperadmin)
  useEffect(() => {
    let cancelled = false;
    async function fetchMe() {
      if (!token) {
        setMeGlobalRole(null);
        setMeIsGlobalSuper(false);
        return;
      }
      try {
        const { data } = await api.get("/auth/me");
        if (cancelled) return;
        const gRole = data?.user?.globalRole || null;
        const flag = data?.user?.isGlobalSuperadmin === true;
        setMeGlobalRole(gRole);
        setMeIsGlobalSuper(normRole(gRole) === "superadmin" || flag);
      } catch (_err) {
        if (cancelled) return;
        // If auth fails for some reason, just clear
        setMeGlobalRole(null);
        setMeIsGlobalSuper(false);
      }
    }
    fetchMe();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Fallback to token in case api/me hasn't run yet (or old env)
  const tokenGlobalRole = normRole(payload?.globalRole);
  const isGlobalSuper = meIsGlobalSuper || tokenGlobalRole === "superadmin" || payload?.isGlobalSuperadmin === true;

  // Legible active state
  const item = ({ isActive }) => ({
    textDecoration: "none",
    color: isActive ? ACTIVE_FG : SIDEBAR_FG,
    padding: "10px 12px",
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    gap: 12,
    fontWeight: 600,
    background: isActive ? ACTIVE_BG : "transparent",
    position: "relative",
    outline: isActive ? `1px solid rgba(20,184,166,0.25)` : "none",
  });

  const subItem = ({ isActive }) => ({
    textDecoration: "none",
    color: isActive ? ACTIVE_FG : SIDEBAR_FG,
    padding: "8px 10px",
    borderRadius: 8,
    display: "block",
    background: isActive ? ACTIVE_BG : "transparent",
  });

  function handleLogout() {
    try {
      localStorage.removeItem("token");
      sessionStorage.removeItem("token");
    } catch {
      // ignore
    }
    setToken(null);
    navigate("/login");
  }

  // ✅ Logo resolver that supports new stable URL + legacy values
  const resolveLogo = (u) => {
    const s = String(u || "").trim();
    if (!s) return "";
    if (s.startsWith("http://") || s.startsWith("https://")) return s;
    if (s.startsWith("/")) return s;

    // tolerate common legacy shapes
    if (s.startsWith("files/")) return `/${s}`;
    if (s.startsWith("uploads/")) return `/${s}`;
    if (s.startsWith("org/")) return `/files/${s}`; // -> /files/org/...
    return `/files/${s}`;
  };

  const enabled = useMemo(() => {
    if (Array.isArray(org?.modules)) return new Set(org.modules);
    if (org?.modules && typeof org.modules === "object") {
      return new Set(
        Object.entries(org.modules)
          .filter(([, v]) => !!v)
          .map(([k]) => k)
      );
    }
    return new Set(ALL_MODULES);
  }, [org?.modules]);

  // Helper to render an item with a left accent bar on active
  const withAccent = (isActive, children) => (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        position: "relative",
        width: "100%",
      }}
    >
      {isActive && (
        <span
          style={{
            position: "absolute",
            left: -12,
            top: 6,
            bottom: 6,
            width: 3,
            borderRadius: 2,
            background: ACCENT,
          }}
        />
      )}
      {children}
    </span>
  );

  return (
    <aside
      style={{
        position: "sticky",
        top: 0,
        height: "100dvh",
        width: open ? 268 : 84,
        transition: "width 160ms ease",
        background: SIDEBAR_BG,
        color: SIDEBAR_FG,
        borderRight: "1px solid rgba(255,255,255,0.06)",
        display: "flex",
        flexDirection: "column",
        zIndex: 20,
      }}
    >
      {/* HEADER: Moat logo + product name (left/top) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: 12,
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <Link
          to="/projects-dashboard"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            color: "inherit",
            textDecoration: "none",
          }}
        >
          <MoatLogo height={36} />

          {open && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  letterSpacing: 0.2,
                  textAlign: "center",
                }}
              >
                Smart Operations Suite
              </span>
            </div>
          )}
        </Link>

        <button
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
          style={{
            marginLeft: "auto",
            width: 36,
            height: 36,
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            display: "grid",
            placeItems: "center",
          }}
        >
          {open ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
        </button>
      </div>

      {/* NAV */}
      <nav
        style={{
          padding: 12,
          display: "grid",
          gap: 6,
          overflowY: "auto",
        }}
      >
        {/* Dashboard points to /projects-dashboard */}
        {enabled.has("projects") && (
          <NavLink to="/projects-dashboard" style={item} end>
            {({ isActive }) =>
              withAccent(
                isActive,
                <>
                  <LayoutDashboard size={18} />
                  {open && <span>Dashboard</span>}
                </>
              )
            }
          </NavLink>
        )}

        {enabled.has("projects") && (
          <NavLink to="/projects" style={item}>
            {({ isActive }) =>
              withAccent(
                isActive,
                <>
                  <FolderKanban size={18} />
                  {open && <span>Projects</span>}
                </>
              )
            }
          </NavLink>
        )}
        {enabled.has("tasks") && (
          <NavLink to="/tasks" style={item}>
            {({ isActive }) =>
              withAccent(
                isActive,
                <>
                  <ListChecks size={18} />
                  {open && <span>Tasks</span>}
                </>
              )
            }
          </NavLink>
        )}
        {enabled.has("users") && (
          <NavLink to="/users" style={item}>
            {({ isActive }) =>
              withAccent(
                isActive,
                <>
                  <UsersIcon size={18} />
                  {open && <span>Users</span>}
                </>
              )
            }
          </NavLink>
        )}
        {enabled.has("clockings") && (
          <NavLink to="/clockings" style={item}>
            {({ isActive }) =>
              withAccent(
                isActive,
                <>
                  <Clock3 size={18} />
                  {open && <span>Clockings</span>}
                </>
              )
            }
          </NavLink>
        )}
        {enabled.has("assets") && (
          <NavLink to="/assets" style={item}>
            {({ isActive }) =>
              withAccent(
                isActive,
                <>
                  <Boxes size={18} />
                  {open && <span>Assets</span>}
                </>
              )
            }
          </NavLink>
        )}
        {enabled.has("vehicles") && (
          <NavLink to="/vehicles" style={item}>
            {({ isActive }) =>
              withAccent(
                isActive,
                <>
                  <Truck size={18} />
                  {open && <span>Vehicles</span>}
                </>
              )
            }
          </NavLink>
        )}
        {enabled.has("invoices") && (
          <NavLink to="/invoices" style={item}>
            {({ isActive }) =>
              withAccent(
                isActive,
                <>
                  <FileText size={18} />
                  {open && <span>Invoices</span>}
                </>
              )
            }
          </NavLink>
        )}
        {enabled.has("inspections") && (
          <NavLink to="/inspections" style={item}>
            {({ isActive }) =>
              withAccent(
                isActive,
                <>
                  <FlaskConical size={18} />
                  {open && <span>Inspections</span>}
                </>
              )
            }
          </NavLink>
        )}
        {enabled.has("vault") && (
          <NavLink to="/vault" style={item}>
            {({ isActive }) =>
              withAccent(
                isActive,
                <>
                  <FileText size={18} />
                  {open && <span>Vault</span>}
                </>
              )
            }
          </NavLink>
        )}

        <div
          style={{
            height: 1,
            background: "rgba(255,255,255,0.08)",
            margin: "8px 2px",
          }}
        />

        {/* Admin group (org-scoped admin) */}
        <details ref={adminDetailsRef} open={isAdminActive} style={{ borderRadius: 8 }}>
          <summary
            role="button"
            style={{
              listStyle: "none",
              cursor: "pointer",
              padding: "10px 12px",
              borderRadius: 8,
              fontWeight: 700,
              userSelect: "none",
              background: isAdminActive ? "rgba(255,255,255,0.08)" : "transparent",
              display: "flex",
              alignItems: "center",
              gap: 12,
              color: "inherit",
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <Shield size={18} /> {open && <span>Admin</span>}
          </summary>

          <div
            style={{
              marginTop: 6,
              paddingLeft: open ? 8 : 0,
              display: "grid",
              gap: 4,
            }}
          >
            <NavLink to="/admin/users" style={subItem}>
              Users
            </NavLink>
            <NavLink to="/admin/org" style={subItem}>
              Org
            </NavLink>

            {/* 🔹 New org-scoped Billing link */}
            <NavLink to="/admin/billing" style={subItem}>
              Billing
            </NavLink>

            <NavLink to="/admin/groups" style={subItem}>
              Groups
            </NavLink>
            <div
              style={{
                height: 1,
                background: "rgba(255,255,255,0.08)",
                margin: "6px 2px",
              }}
            />
            <NavLink to="/admin/inspections/forms" style={subItem}>
              Inspection Forms
            </NavLink>
            <NavLink to="/admin/inspections/forms/new" style={subItem}>
              New Inspection Form
            </NavLink>
          </div>
        </details>

        {/* Global Super Admin section (cross-tenant) */}
        {isGlobalSuper && (
          <>
            <div
              style={{
                height: 1,
                background: "rgba(255,255,255,0.08)",
                margin: "8px 2px",
              }}
            />
            <NavLink to="/super-admin" style={item}>
              {({ isActive }) =>
                withAccent(
                  isActive,
                  <>
                    <Settings size={18} />
                    {open && <span>Super Admin</span>}
                  </>
                )
              }
            </NavLink>
            <NavLink to="/system/billing" style={item}>
              {({ isActive }) =>
                withAccent(
                  isActive,
                  <>
                    <FileText size={18} />
                    {open && <span>System Billing (global)</span>}
                  </>
                )
              }
            </NavLink>
          </>
        )}

        <div
          style={{
            height: 1,
            background: "rgba(255,255,255,0.08)",
            margin: "8px 2px",
          }}
        />
      </nav>

      {/* FOOTER: auth + ORG LOGO */}
      <div style={{ marginTop: "auto", padding: 12, display: "grid", gap: 10 }}>
        {org?.logoUrl && (
          <div
            title="Organization"
            style={{
              width: "100%",
              height: 70,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              borderRadius: 8,
              background: "rgba(255,255,255,0.04)",
            }}
          >
            <img
              src={resolveLogo(org.logoUrl)}
              alt="Organization logo"
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
                filter: "brightness(0.98)",
              }}
              onError={(e) => (e.currentTarget.style.display = "none")}
            />
          </div>
        )}

        {token ? (
          <button
            onClick={handleLogout}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 10,
              justifyContent: "center",
            }}
          >
            <LogOut size={16} /> Sign Out
          </button>
        ) : (
          <NavLink
            to="/login"
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.18)",
              textDecoration: "none",
              color: "inherit",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 10,
              justifyContent: "center",
            }}
          >
            <LogIn size={16} /> Sign In
          </NavLink>
        )}
      </div>
    </aside>
  );
}
