import { NavLink, Link, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
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

  useEffect(() => { setToken(localStorage.getItem("token")); }, [location]);

  const link = ({ isActive }) => ({
    textDecoration: "none",
    color: "inherit",
    borderBottom: isActive ? "2px solid currentColor" : "2px solid transparent",
    padding: "6px 8px",
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

      <div style={{ display: "flex", gap: 12, marginLeft: 16, flexWrap: "wrap" }}>
        {enabled.has("projects") && <NavLink to="/projects" style={link}>Projects</NavLink>}
        {enabled.has("tasks") && <NavLink to="/tasks" style={link}>Tasks</NavLink>} {/* ✅ */}
        {enabled.has("users") && <NavLink to="/users" style={link}>Users</NavLink>}
        {enabled.has("clockings") && <NavLink to="/clockings" style={link}>Clockings</NavLink>}
        {enabled.has("assets") && <NavLink to="/assets" style={link}>Assets</NavLink>}
        {enabled.has("vehicles") && <NavLink to="/vehicles" style={link}>Vehicles</NavLink>}
        {enabled.has("invoices") && <NavLink to="/invoices" style={link}>Invoices</NavLink>}
        {enabled.has("inspections") && <NavLink to="/inspections" style={link}>Inspections</NavLink>}
        {enabled.has("vault") && <NavLink to="/vault" style={link}>Vault</NavLink>}
        <NavLink to="/admin/users" style={link}>Admin: Users</NavLink>
        <NavLink to="/admin/org" style={link}>Admin: Org</NavLink>
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
