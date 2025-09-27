// src/pages/AdminInspectionForms.jsx
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

function badge(color, text) {
  const cls = {
    green: "bg-green-50 text-green-700 border-green-200",
    gray: "bg-gray-50 text-gray-700 border-gray-200",
    yellow: "bg-yellow-50 text-yellow-700 border-yellow-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  }[color] || "bg-gray-50 text-gray-700 border-gray-200";
  return (
    <span className={`inline-block px-2 py-0.5 text-xs rounded-full border ${cls}`}>
      {text}
    </span>
  );
}

function fmtDate(s) {
  if (!s) return "—";
  try {
    const d = new Date(s);
    return d.toLocaleString();
  } catch {
    return String(s);
  }
}

export default function AdminInspectionForms() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // UI state
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all"); // all | active | draft | archived
  const [scope, setScope] = useState("all"); // all | global | scoped

  async function load() {
    setErr("");
    setLoading(true);
    try {
      const { data } = await api.get("/inspections/forms", { params: { limit: 1000 } });
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Failed to load forms");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items || [])
      .filter((f) => {
        // status filter
        const st = String(f.status || (f.active === false ? "archived" : "active")).toLowerCase();
        if (status !== "all" && st !== status) return false;

        // scope filter
        const sc = f.scope || {};
        const isGlobal = !!sc.isGlobal || (!Array.isArray(sc.projectIds) && !Array.isArray(sc.taskIds));
        if (scope === "global" && !isGlobal) return false;
        if (scope === "scoped" && isGlobal) return false;

        // search
        if (!needle) return true;
        const hay = [
          f.title, f.name, f.description, f.category,
          ...(f.tags || []), ...(f.labels || []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      })
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  }, [items, q, status, scope]);

  function idOf(f) {
    return f?._id || f?.id;
  }

  async function duplicateForm(f) {
    try {
      const body = {
        // keep only well-known fields
        name: `${f.name || f.title || "Form"} (copy)`,
        title: `${f.title || f.name || "Form"} (copy)`,
        description: f.description || "",
        version: (f.version ?? 1),
        fields: Array.isArray(f.fields) ? f.fields : Array.isArray(f.schema) ? f.schema : [],
        status: "draft",
        scope: f.scope || { isGlobal: true, projectIds: [], taskIds: [], roles: [] },
        category: f.category || "",
        tags: f.tags || f.labels || [],
      };
      await api.post("/inspections/forms", body);
      await load();
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || "Duplicate failed");
    }
  }

  async function toggleArchive(f) {
    const st = String(f.status || (f.active === false ? "archived" : "active")).toLowerCase();
    const next = st === "archived" ? "active" : "archived";
    try {
      await api.patch(`/inspections/forms/${idOf(f)}`, { status: next, active: next === "active" });
      await load();
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || "Update failed");
    }
  }

  async function deleteForm(f) {
    if (!confirm(`Delete form “${f.title || f.name}”? This cannot be undone.`)) return;
    try {
      await api.delete(`/inspections/forms/${idOf(f)}`);
      await load();
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || "Delete failed");
    }
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Inspection Forms</h1>
        <div className="flex items-center gap-2">
          <button
            className="px-3 py-2 border rounded"
            onClick={() => navigate("/admin/inspections/forms/new")}
          >
            New form
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search title, tags…"
          className="border p-2 rounded w-64"
        />
        <select className="border p-2 rounded" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </select>
        <select className="border p-2 rounded" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">All scopes</option>
          <option value="global">Global</option>
          <option value="scoped">Project/Task scoped</option>
        </select>
        <button className="px-3 py-2 border rounded" onClick={load}>Refresh</button>
      </div>

      {loading && <div className="text-gray-600">Loading…</div>}
      {err && <div className="text-red-600">{err}</div>}

      {!loading && !err && filtered.length === 0 && (
        <div className="text-gray-600">No forms found.</div>
      )}

      {!loading && !err && filtered.length > 0 && (
        <div className="overflow-auto">
          <table className="min-w-[800px] w-full border border-gray-200 rounded">
            <thead className="bg-gray-50">
              <tr className="text-left text-sm">
                <th className="p-2 border-b">Title</th>
                <th className="p-2 border-b">Version</th>
                <th className="p-2 border-b">Status</th>
                <th className="p-2 border-b">Scope</th>
                <th className="p-2 border-b">Updated</th>
                <th className="p-2 border-b text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((f) => {
                const st = String(f.status || (f.active === false ? "archived" : "active")).toLowerCase();
                const sc = f.scope || {};
                const isGlobal = !!sc.isGlobal || (!Array.isArray(sc.projectIds) && !Array.isArray(sc.taskIds));
                return (
                  <tr key={idOf(f)} className="text-sm odd:bg-white even:bg-gray-50">
                    <td className="p-2 border-b">
                      <div className="font-medium">{f.title || f.name || "Untitled"}</div>
                      {f.description && <div className="text-xs text-gray-600 line-clamp-1">{f.description}</div>}
                    </td>
                    <td className="p-2 border-b">{f.version ?? 1}</td>
                    <td className="p-2 border-b">
                      {st === "active"   && badge("green", "Active")}
                      {st === "draft"    && badge("yellow", "Draft")}
                      {st === "archived" && badge("gray", "Archived")}
                      {!["active", "draft", "archived"].includes(st) && badge("blue", st)}
                    </td>
                    <td className="p-2 border-b">
                      {isGlobal
                        ? badge("blue", "Global")
                        : (
                          <div className="flex flex-col gap-1">
                            {Array.isArray(sc.projectIds) && sc.projectIds.length > 0 && (
                              <div className="text-xs text-gray-700">Projects: {sc.projectIds.length}</div>
                            )}
                            {Array.isArray(sc.taskIds) && sc.taskIds.length > 0 && (
                              <div className="text-xs text-gray-700">Tasks: {sc.taskIds.length}</div>
                            )}
                          </div>
                        )
                      }
                    </td>
                    <td className="p-2 border-b">{fmtDate(f.updatedAt || f.createdAt)}</td>
                    <td className="p-2 border-b">
                      <div className="flex items-center gap-2 justify-end">
                        <button
                          className="px-2 py-1 border rounded"
                          onClick={() => navigate(`/admin/inspections/forms/${idOf(f)}`)}
                          title="Edit"
                        >
                          Edit
                        </button>
                        <button
                          className="px-2 py-1 border rounded"
                          onClick={() => duplicateForm(f)}
                          title="Duplicate"
                        >
                          Duplicate
                        </button>
                        <button
                          className="px-2 py-1 border rounded"
                          onClick={() => toggleArchive(f)}
                          title={String(f.status).toLowerCase() === "archived" ? "Activate" : "Archive"}
                        >
                          {String(f.status || "").toLowerCase() === "archived" ? "Activate" : "Archive"}
                        </button>
                        <button
                          className="px-2 py-1 border rounded text-red-700 border-red-300"
                          onClick={() => deleteForm(f)}
                          title="Delete"
                        >
                          Delete
                        </button>
                        <button
                          className="px-2 py-1 border rounded"
                          onClick={() => navigate(`/inspections/forms/${idOf(f)}/open`)}
                          title="Open to test"
                        >
                          Open
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
