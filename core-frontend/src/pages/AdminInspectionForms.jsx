// core-frontend/src/pages/AdminInspectionForms.jsx
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  listForms,
  softDeleteForm,
  hardDeleteForm,
  restoreForm,
} from "../lib/inspectionApi.js";
import { useTheme } from "../ThemeContext";

export default function AdminInspectionForms() {
  const nav = useNavigate();
  const { org } = useTheme();
  const accent = org?.accentColor || "#2a7fff";

  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);

  // client-side search
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [q]);

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const data = await listForms({ includeDeleted });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Failed to load forms");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDeleted]);

  async function onSoftDelete(id) {
    if (!window.confirm("Soft delete this form?")) return;
    try {
      await softDeleteForm(id);
      await load();
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || "Soft delete failed");
    }
  }

  async function onRestore(id) {
    try {
      await restoreForm(id);
      await load();
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || "Restore failed");
    }
  }

  async function onHardDelete(id) {
    if (!window.confirm("HARD delete this form permanently?")) return;
    try {
      await hardDeleteForm(id);
      await load();
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || "Hard delete failed");
    }
  }

  const pill = (on) => `pill ${on ? "active" : ""}`;

  function niceCase(s) {
    const t = String(s || "").toLowerCase();
    if (t === "signoff") return "Sign-off";
    if (t === "standard") return "Standard";
    return t.replace(/[-_]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function subjectLabel(subj) {
    const t = String(subj?.type || "none").toLowerCase();
    if (t === "vehicle") {
      const lock = subj?.lockLabel || subj?.lockToId || "";
      return lock ? `Vehicle — ${lock}` : "Vehicle";
    }
    if (t === "asset") {
      const lock = subj?.lockLabel || subj?.lockToId || "";
      return lock ? `Asset — ${lock}` : "Asset";
    }
    return "General";
  }

  const filteredRows = useMemo(() => {
    if (!qDeb) return rows;
    return rows.filter((f) => {
      const scope = f?.scope?.type === "scoped" ? "scoped" : "global";
      const subj = subjectLabel(f.subject);
      const text = `${f.title || ""} ${f.formType || ""} ${scope} ${subj}`.toLowerCase();
      return text.includes(qDeb);
    });
  }, [rows, qDeb]);

  return (
    <div className="max-w-7xl mx-auto p-4" style={{ "--accent": accent }}>
      {/* local styles for standardized look */}
      <style>{`
        .btn{border:1px solid #e5e7eb;border-radius:10px;padding:8px 12px;background:#fff}
        .btn:hover{box-shadow:0 1px 0 rgba(0,0,0,.04)}
        .btn-sm{padding:6px 10px;border-radius:8px}
        .btn-accent{background:var(--accent,#2a7fff);color:#fff;border-color:var(--accent,#2a7fff)}
        .btn-danger{background:#b91c1c;color:#fff;border-color:#7f1d1d}
        .pill{
          border:1px solid var(--border,#e5e7eb);
          padding:.35rem .7rem;border-radius:9999px;cursor:pointer;
          font-weight:600;background:#fff;color:#111827;
          transition: background .12s ease,border-color .12s ease,color .12s ease;
          white-space:nowrap;
        }
        .pill.active{
          background:var(--accent,#2a7fff);border-color:var(--accent,#2a7fff);color:#fff;
        }
        .table{width:100%;border-collapse:collapse}
        .table th,.table td{padding:.5rem;border-top:1px solid #eef2f7;text-align:left}
        .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px}
        .muted{color:#64748b}
      `}</style>

      {/* Title row */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Inspection Forms</h1>
      </div>

      {/* Toolbar split: left (search + pills) | right (new form) */}
      <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
        {/* LEFT group */}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            className="input input-bordered"
            style={{ minWidth: 280 }}
            placeholder="Search title, type, subject, scope…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className={pill(!includeDeleted)}
              onClick={() => setIncludeDeleted(false)}
              title="Hide deleted forms"
            >
              Active
            </button>
            <button
              type="button"
              className={pill(includeDeleted)}
              onClick={() => setIncludeDeleted(true)}
              title="Show deleted forms"
            >
              Show deleted
            </button>
          </div>
        </div>

        {/* RIGHT group */}
        <div className="flex items-center">
          <button
            className="btn btn-accent"
            onClick={() => nav("/admin/inspections/forms/new")}
          >
            New form
          </button>
        </div>
      </div>

      {err && <div className="text-red-600 mt-2">{err}</div>}

      <div className="mt-3 card overflow-x-auto">
        {loading ? (
          <div className="p-3">Loading…</div>
        ) : filteredRows.length ? (
          <table className="table">
            <thead>
              <tr style={{ background: "#f9fafb" }}>
                <th>Title</th>
                <th>Type</th>
                <th>Subject</th>
                <th>Scope</th>
                <th>Updated</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((f) => {
                const id = f._id || f.id;
                const scoped = f?.scope?.type === "scoped";
                const updated = f.updatedAt
                  ? new Date(f.updatedAt).toLocaleString()
                  : "—";
                const isDel = !!f.isDeleted;
                return (
                  <tr key={id} className={isDel ? "opacity-70" : ""}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span>{f.title || "Untitled form"}</span>
                        {isDel && (
                          <span className="px-2 py-0.5 rounded-full text-xs border bg-amber-50 text-amber-800 border-amber-200">
                            deleted
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="capitalize">{niceCase(f.formType || "standard")}</td>
                    <td>{subjectLabel(f.subject)}</td>
                    <td className="capitalize">{scoped ? "Scoped" : "Global"}</td>
                    <td>{updated}</td>
                    <td>
                      <div className="flex justify-end gap-2">
                        {!isDel && (
                          <>
                            <Link className="btn btn-sm" to={`/admin/inspections/forms/${id}`}>
                              Edit
                            </Link>
                            <button
                              className="btn btn-sm"
                              onClick={() => nav(`/inspections/forms/${id}/open`)}
                            >
                              Run
                            </button>
                            <button className="btn btn-sm" onClick={() => onSoftDelete(id)}>
                              Delete
                            </button>
                          </>
                        )}
                        {isDel && (
                          <>
                            <button className="btn btn-sm" onClick={() => onRestore(id)}>
                              Restore
                            </button>
                            <button className="btn btn-sm btn-danger" onClick={() => onHardDelete(id)}>
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="p-3 muted">No forms found.</div>
        )}
      </div>
    </div>
  );
}
