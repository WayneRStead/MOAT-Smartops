// src/components/Navbar.jsx
import { NavLink, Link, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../ThemeContext";
import MoatLogo from "./MoatLogo";

const ALL_MODULES = [
  "projects","tasks","users","clockings","assets","vehicles",
  "invoices","inspections","vault"
];

export default function Navbar() {
  const { org } = useTheme();
  const [token, setToken] = useState(() => localStorage.getItem("token"));
  const location = useLocation();
  const navigate = useNavigate();
  const adminDetailsRef = useRef(null);

  useEffect(() => { setToken(localStorage.getItem("token")); }, [location]);

  // Close the Admin dropdown on route change
  useEffect(() => {
    if (adminDetailsRef.current) adminDetailsRef.current.open = false;
  }, [location]);

  const isAdminActive = location.pathname.startsWith("/admin");

  const link = ({ isActive }) => ({
    textDecoration: "none",
    color: "inherit",
    borderBottom: isActive ? "2px solid currentColor" : "2px solid transparent",
    padding: "6px 8px",
  });

  const menuLink = ({ isActive }) => ({
    textDecoration: "none",
    color: "inherit",
    padding: "8px 10px",
    borderRadius: 6,
    display: "block",
    background: isActive ? "var(--hover, rgba(0,0,0,0.06))" : "transparent",
  });

  function handleLogout() {
    localStorage.removeItem("token");
    setToken(null);
    navigate("/login");
  }

  const resolveLogo = (u) => {
    if (!u) return "";
    if (u.startsWith("http")) return u;
    if (u.startsWith("/")) return u;
    return `/files/${u}`;
  };

  const enabled = useMemo(() => {
    if (Array.isArray(org?.modules)) return new Set(org.modules);
    if (org?.modules && typeof org.modules === "object") {
      return new Set(Object.entries(org.modules).filter(([,v])=>!!v).map(([k])=>k));
    }
    return new Set(ALL_MODULES);
  }, [org?.modules]);

  return (
    <nav className="navbar" style={{ display: "flex", alignItems: "center", gap: 12, padding: 12 }}>
      <Link to="/"><MoatLogo height={38} /></Link>

      <div style={{ display: "flex", gap: 12, marginLeft: 16, flexWrap: "wrap", alignItems: "center" }}>
        {enabled.has("projects") && <NavLink to="/projects" style={link}>Projects</NavLink>}
        {enabled.has("tasks") && <NavLink to="/tasks" style={link}>Tasks</NavLink>}
        {enabled.has("users") && <NavLink to="/users" style={link}>Users</NavLink>}
        {enabled.has("clockings") && <NavLink to="/clockings" style={link}>Clockings</NavLink>}
        {enabled.has("assets") && <NavLink to="/assets" style={link}>Assets</NavLink>}
        {enabled.has("vehicles") && <NavLink to="/vehicles" style={link}>Vehicles</NavLink>}
        {enabled.has("invoices") && <NavLink to="/invoices" style={link}>Invoices</NavLink>}
        {enabled.has("inspections") && <NavLink to="/inspections" style={link}>Inspections</NavLink>}
        {enabled.has("vault") && <NavLink to="/vault" style={link}>Vault</NavLink>}

        {/* Admin dropdown */}
        <details ref={adminDetailsRef} style={{ position: "relative" }}>
          <summary
            role="button"
            style={{
              cursor: "pointer",
              padding: "6px 8px",
              borderBottom: isAdminActive ? "2px solid currentColor" : "2px solid transparent",
              listStyle: "none",
              userSelect: "none",
            }}
            onMouseDown={(e) => e.preventDefault()} // prevent text selection on click
          >
            Admin ▾
          </summary>
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: 0,
              background: "var(--bg, #fff)",
              color: "inherit",
              border: "1px solid var(--border, rgba(0,0,0,0.15))",
              borderRadius: 8,
              minWidth: 240,
              padding: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
              zIndex: 1000,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <NavLink to="/admin/users" style={menuLink}>Users</NavLink>
              <NavLink to="/admin/org" style={menuLink}>Org</NavLink>
              <NavLink to="/admin/groups" style={menuLink}>Groups</NavLink>
              <div style={{ height: 1, background: "var(--border, rgba(0,0,0,0.1))", margin: "6px 2px" }} />
              {/* Inspection Form Builder links */}
              <NavLink to="/admin/inspections/forms" style={menuLink}>Inspection Forms</NavLink>
              <NavLink to="/admin/inspections/forms/new" style={menuLink}>New Inspection Form</NavLink>
            </div>
          </div>
        </details>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
        {token ? (
          <button onClick={handleLogout} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "inherit", cursor: "pointer" }}>
            Sign Out
          </button>
        ) : (
          <NavLink to="/login" style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)" }}>
            Sign In
          </NavLink>
        )}
        {org?.logoUrl && (
          <div title="Customer" style={{ width: 140, height: 44, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", borderRadius: 6 }}>
            <img
              src={resolveLogo(org.logoUrl)}
              alt="Customer logo"
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
              onError={(e) => (e.currentTarget.style.display = "none")}
            />
          </div>
        )}
      </div>
    </nav>
  );
}
