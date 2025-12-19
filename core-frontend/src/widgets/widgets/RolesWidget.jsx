import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";

export const id = "roles";
export const title = "Roles";

/* Optional FilterContext (selection sync; counts are org-wide) */
function useOptionalFilters() {
  let ctx = null;
  try { ctx = require("../FilterContext"); } catch {}
  if (ctx && ctx.useFilters) {
    const slice = ctx.useFilters(["rag", "dr", "context"]);
    return {
      rag: slice.rag || "",
      dr: slice.dr || {},
      context: slice.context || {},
      setFilters: ctx.setFilters,
      emitDelta: ctx.emit || ((delta) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: delta }))),
    };
  }
  return {
    rag: "", dr: {}, context: {},
    setFilters: () => {},
    emitDelta: (delta) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: delta })),
  };
}

/* ---------- role helpers ---------- */
function normalizeRole(r) {
  if (!r) return "";
  let s = String(r).trim().toLowerCase();
  s = s.replace(/[_\s]+/g, "-");
  if (s === "groupleader") s = "group-leader";
  if (s === "pm") s = "project-manager";
  if (s === "super-admin" || s === "superadministrator") s = "superadmin";
  if (s === "administrator" || s === "owner") s = "admin";
  if (s === "worker") s = "user"; // folded out (not shown)
  return s;
}
function rolesOfUser(u) {
  const raw = []
    .concat(u?.role ? [u.role] : [])
    .concat(Array.isArray(u?.roles) ? u.roles : [])
    .concat(u?.isAdmin ? ["admin"] : []);
  const set = new Set(
    raw
      .flatMap(v => String(v).split(","))
      .map(normalizeRole)
      .filter(Boolean)
  );
  if (set.has("superadmin")) { set.delete("superadmin"); set.add("admin"); }
  set.delete("user");
  return Array.from(set);
}

const ORDER = ["group-leader", "project-manager", "manager", "admin"];
const LABEL = {
  "group-leader": "Group Leader",
  "project-manager": "Project Manager",
  "manager": "Manager",
  "admin": "Admin",
};

export default function RolesWidget({ bare, compact }) {
  const { rag, /*dr, context,*/ setFilters, emitDelta } = useOptionalFilters();

  const [users, setUsers] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  // single-select: store one role in the global filters
  const [selected, setSelected] = useState("");

  /* fetch users (robust fallbacks) */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr("");
      const win = typeof window !== "undefined" ? window : {};
      const local =
        (Array.isArray(win.__USERS__) && win.__USERS__) ||
        (Array.isArray(win.__ORG_USERS__) && win.__ORG_USERS__);
      if (local) { if (!cancelled) { setUsers(local); setLoading(false); } return; }

      const endpoints = [
        { url: "/users",      params: { limit: 2000 } },
        { url: "/org/users",  params: { limit: 2000 } },
        { url: "/people",     params: { limit: 2000 } },
        { url: "/team",       params: { limit: 2000 } },
      ];
      for (const ep of endpoints) {
        try {
          const r = await api.get(ep.url, { params: { ...ep.params, _ts: Date.now() }, timeout: 10000 });
          if (cancelled) return;
          const list = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.rows) ? r.data.rows : [];
          if (list.length) { setUsers(list); setLoading(false); return; }
        } catch {}
      }
      if (!cancelled) { setUsers([]); setErr("No users found"); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  /* build counts per role (org-wide; RAG is highlight-only, not filtering) */
  const counts = useMemo(() => {
    const c = { "group-leader": 0, "project-manager": 0, "manager": 0, "admin": 0 };
    for (const u of users) {
      for (const r of rolesOfUser(u)) if (r in c) c[r] += 1;
    }
    return c;
  }, [users]);

  const tiles = ORDER.map(key => ({ key, label: LABEL[key], count: counts[key] || 0 }));

  // RAG highlight (visual only)
  const ragHighlight = (rag === "red" || rag === "amber" || rag === "green") ? "" : ""; // no specific mapping here

  function publish(roleOrEmpty) {
    const roles = roleOrEmpty ? [roleOrEmpty] : [];
    setSelected(roleOrEmpty || "");
    try { setFilters?.((prev) => ({ ...prev, roles })); } catch {}
    emitDelta({ roles });
  }
  function onTileClick(k) { publish(selected === k ? "" : k); }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2">
      {!bare && <div className="font-semibold">Roles</div>}

      <style>{`
        .tile-grid{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; margin-top:6px; }
        .tile{
          border:1px solid #e5e7eb; border-radius:10px; padding:8px 10px;
          text-align:center; cursor:pointer; user-select:none;
          transition: box-shadow .15s ease, background .15s ease, border-color .15s ease, color .15s ease;
        }
        .tile .lbl{ display:block; font-size:12px; line-height:14px; color:#374151; }
        .tile .val{ display:block; margin-top:4px; font-weight:700; font-size:11px; line-height:12px; }
        .tile:hover{ box-shadow:0 0 0 3px rgba(37,99,235,0.12); }
        .tile.active{ background:#f1f5f9; border-color:#2563eb; box-shadow:0 0 0 3px rgba(37,99,235,0.22); }
        .tile.halo{ box-shadow:0 0 0 3px rgba(2,132,199,0.18); }
      `}</style>

      {err && <div className="text_sm text-red-600 mt-1">{err}</div>}
      {loading && !users.length && <div className="text_sm text-gray-500 mt-1">Loading…</div>}
      {!loading && !users.length && !err && <div className="text_sm text-gray-500 mt-1">No roles found</div>}

      <div className="tile-grid">
        {tiles.map(t => {
          const isActive = selected === t.key || (!selected && ragHighlight === t.key);
          const halo = t.count > 0 ? "halo" : "";
          return (
            <div
              key={t.key}
              className={`tile ${isActive ? "active" : ""} ${halo}`}
              onClick={() => onTileClick(t.key)}
              role="button"
              tabIndex={0}
              onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" ") onTileClick(t.key); }}
              title={isActive ? "Selected (click to clear)" : `Filter: ${t.label}`}
            >
              <span className="lbl">{t.label}</span>
              <span className="val">{t.count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
