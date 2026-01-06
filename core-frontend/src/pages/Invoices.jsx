// src/pages/Invoices.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

/* ---------------------- helpers / small UI bits ---------------------- */
function toAbsoluteUrl(u) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  const base = (api?.defaults?.baseURL || "").replace(/\/api\/?$/i, "");
  if (u.startsWith("/")) return base + u;
  return `${base}/${u}`;
}
function pickFileUrl(inv) {
  const f = inv?.file || inv?.attachment || {};
  const candidates = [
    inv?.fileUrl,
    f?.url,
    f?.href,
    f?.downloadUrl,
    inv?.filePath,
    f?.path,
    inv?.filename,
    f?.filename,
  ].filter(Boolean);
  const first = candidates[0];
  return first ? toAbsoluteUrl(String(first)) : "";
}
function getNameFromUrl(url) {
  try {
    const u = new URL(url, "http://x");
    const p = u.pathname || "";
    return decodeURIComponent(p.split("/").pop() || "file");
  } catch {
    const p = String(url || "");
    return decodeURIComponent(p.split("/").pop() || "file");
  }
}
function fmtAmt(n, currency = "USD") {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  try { return num.toLocaleString(undefined, { style: "currency", currency }); }
  catch { return `${currency} ${num.toFixed(2)}`; }
}
function dateISO(d) {
  if (!d) return "";
  const x = new Date(d);
  if (isNaN(+x)) return "";
  return x.toISOString().slice(0, 10);
}
function addDaysISO(iso, days) {
  const d = iso ? new Date(iso) : new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function dueFromSubmitted(submittedAt, termsDays) {
  if (!submittedAt) return null;
  const iso = dateISO(submittedAt);
  if (!iso) return null;
  return addDaysISO(iso, Number(termsDays || 0));
}
function statusFromRow(row) {
  const raw = String(row.status || "").toLowerCase();
  if (raw === "void" || raw === "cancelled") return "void";
  if (raw === "paid") return "paid";
  if (raw === "outstanding") return "outstanding";
  const due = dueFromSubmitted(row.submittedAt || row.issuedAt, row.termsDays || row.terms || 0);
  if (!row.paidAt && due) {
    const d = new Date(due); d.setHours(23,59,59,999);
    if (d < new Date()) return "outstanding";
  }
  return raw || "submitted";
}
function Badge({ code }) {
  const map = {
    submitted: "bg-amber-100 text-amber-800",
    outstanding: "bg-red-100 text-red-800",
    paid: "bg-green-100 text-green-800",
    void: "bg-gray-200 text-gray-700",
  };
  const cls = map[code] || "bg-gray-100 text-gray-800";
  return <span className={`inline-block px-2 py-0.5 rounded text-xs ${cls}`}>{code}</span>;
}

/* Reasonable currency options */
const CURRENCIES = ["USD","EUR","GBP","AUD","NZD","ZAR","CAD","JPY","CNY","INR"];

/* ------------------------------ role helpers ------------------------------ */
/**
 * Keep frontend role logic aligned with backend middleware/auth.js
 */
const CANON_ROLES = ["user","group-leader","project-manager","manager","admin","superadmin"];

function normalizeRole(r) {
  if (!r) return "";
  let s = String(r).trim().toLowerCase();
  s = s.replace(/\s+/g, "-");        // "Project Manager" -> "project-manager"
  if (s === "worker" || s === "member") s = "user";
  if (s === "groupleader") s = "group-leader";
  if (s === "pm") s = "project-manager";
  if (s === "super-admin") s = "superadmin";
  return CANON_ROLES.includes(s) ? s : "";
}

const ROLE_RANK = {
  "user": 1,
  "group-leader": 2,
  "project-manager": 3,
  "manager": 4,
  "admin": 5,
  "superadmin": 6,
};
function rankOf(role) {
  return ROLE_RANK[normalizeRole(role)] || 0;
}

/* --------------------------- MAIN COMPONENT -------------------------- */
export default function Invoices() {
  const [me, setMe] = useState(null);
  const [rows, setRows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  // viewer
  const [viewerUrl, setViewerUrl] = useState("");

  // Add/Edit modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // CREATE upload
  const [fileToUpload, setFileToUpload] = useState(null);
  // EDIT upload
  const [editFileToUpload, setEditFileToUpload] = useState(null);

  // Form for create
  const [form, setForm] = useState({
    number: "",
    projectId: "",
    vendorId: "",
    newVendorName: "",
    amount: "",
    currency: "USD",
    submittedAt: new Date().toISOString().slice(0, 10),
    paidAt: "",
    termsDays: 30,
    notes: "",
    status: "submitted",
  });

  // Edit row
  const [editId, setEditId] = useState("");
  const [editForm, setEditForm] = useState({
    number: "",
    projectId: "",
    vendorId: "",
    newVendorName: "",
    amount: "",
    currency: "USD",
    submittedAt: "",
    paidAt: "",
    termsDays: 30,
    notes: "",
    status: "submitted",
  });

  // Filters
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showDeleted, setShowDeleted] = useState(false);

  /* ------------------------------ role fix ------------------------------ */
  async function getMe() {
    try {
      const { data } = await api.get("/auth/me");
      const u = data?.user || data || {};

      // Gather any plausible role fields your backend might return
      const rawPrimary =
        u.role || u.orgRole || u.globalRole || u.accountRole || u.primaryRole || "";

      const rawRolesArr = Array.isArray(u.roles) ? u.roles
        : Array.isArray(u.orgRoles) ? u.orgRoles
        : Array.isArray(u.permissions) ? u.permissions
        : [];

      const normRoles = new Set(
        [rawPrimary, ...rawRolesArr]
          .map((r) => normalizeRole(r))
          .filter(Boolean)
      );

      // If backend returns only one role but it's not canonical, keep original too (best effort)
      if (!normRoles.size && rawPrimary) {
        normRoles.add(String(rawPrimary).toLowerCase());
      }

      return { ...u, _normRoles: normRoles };
    } catch {
      return null;
    }
  }

  // Manager+ can manage invoices (and optionally project-manager if you want it)
  const canManage = useMemo(() => {
    if (!me) return false;

    const roles = me._normRoles instanceof Set ? me._normRoles : new Set();
    const maxRank = Math.max(0, ...Array.from(roles).map(rankOf));

    // ✅ If you want ONLY manager/admin/superadmin: keep as >= 4
    // ✅ If you also want project-manager to manage invoices: change threshold to >= 3
    // You said "manager to super admin", so we keep manager+:
    return maxRank >= ROLE_RANK["manager"];
  }, [me]);

  /* ------------------------------ loaders ------------------------------ */
  async function loadAll() {
    setLoading(true); setErr("");
    try {
      const params = { limit: 500, ...(showDeleted ? { includeDeleted: 1 } : {}) };
      const mep = getMe();
      const inv = api.get("/invoices", { params });
      const prj = api.get("/projects", { params: { limit: 1000 } });
      const vnd = api.get("/vendors", { params: { limit: 1000 } }).catch(() => ({ data: [] }));
      const [{ data: rowsData }, { data: projData }, { data: vendorData }, meVal] = await Promise.all([inv, prj, vnd, mep]);
      setRows(Array.isArray(rowsData) ? rowsData : []);
      setProjects(Array.isArray(projData) ? projData : []);
      setVendors(Array.isArray(vendorData) ? vendorData : []);
      setMe(meVal);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
      setRows([]); setProjects([]); setVendors([]);
    } finally { setLoading(false); }
  }
  useEffect(() => { loadAll(); }, [showDeleted]);

  /* --------------------------- label helpers --------------------------- */
  const projectLabel = (pid) => {
    if (!pid) return "—";
    const p = projects.find((x) => String(x._id) === String(pid));
    return p?.name || String(pid);
  };
  const vendorLabel = (vendor) => {
    if (!vendor) return "—";
    if (typeof vendor === "string") return vendor;
    return vendor.name || vendor.title || vendor.company || String(vendor._id || vendor.id || "—");
  };

  /* ------------------------------ create ------------------------------- */
  async function ensureVendorIdOrName(vendorId, newVendorName) {
    let vId = vendorId || "";
    let vName = "";
    if (vId && vId !== "__new__") {
      const found = vendors.find((v) => String(v._id || v.id) === String(vId));
      vName = found?.name || "";
      return { vendorId: vId, vendorName: vName || undefined };
    }
    const trimmed = (newVendorName || "").trim();
    if (trimmed) {
      const { data } = await api.post("/vendors", { name: trimmed });
      const id = data?._id || data?.id || "";
      api.get("/vendors", { params: { limit: 1000 } }).then(({ data }) => setVendors(Array.isArray(data) ? data : [])).catch(()=>{});
      return { vendorId: id || undefined, vendorName: trimmed };
    }
    throw new Error("Vendor is required (select an existing vendor or type a new one).");
  }

  async function refetchOneAndPatchList(id) {
    try {
      const { data } = await api.get(`/invoices/${id}`);
      setRows((prev) => {
        const i = prev.findIndex((r) => String(r._id || r.id) === String(id));
        if (i === -1) return [data, ...prev];
        const next = prev.slice();
        next[i] = data;
        return next;
      });
      return data;
    } catch { /* ignore */ }
    return null;
  }

  async function uploadFor(id, file) {
    const fd = new FormData();
    fd.append("file", file);
    await api.post(`/invoices/${id}/file`, fd);
    await refetchOneAndPatchList(id);
  }

  async function handleCreateInvoice(e) {
    e?.preventDefault?.();
    setErr(""); setInfo(""); setSaving(true);
    try {
      const { vendorId, vendorName } = await ensureVendorIdOrName(form.vendorId, form.newVendorName);
      const payload = {
        number: form.number || undefined,
        projectId: form.projectId || undefined,
        vendorId, vendorName,
        amount: form.amount !== "" ? Number(form.amount) : undefined,
        currency: form.currency || "USD",
        submittedAt: form.submittedAt ? new Date(form.submittedAt).toISOString() : undefined,
        paidAt: form.paidAt ? new Date(form.paidAt).toISOString() : undefined,
        termsDays: Number(form.termsDays || 0),
        notes: form.notes || "",
        status: form.status || undefined,
      };
      const { data: created } = await api.post("/invoices", payload);

      if (fileToUpload) {
        try { await uploadFor(created._id || created.id, fileToUpload); }
        catch { setInfo("Invoice saved, but file upload failed."); }
      } else {
        await refetchOneAndPatchList(created._id || created.id);
      }

      setModalOpen(false);
      setForm({
        number: "", projectId: "", vendorId: "", newVendorName: "",
        amount: "", currency: "USD",
        submittedAt: new Date().toISOString().slice(0, 10),
        paidAt: "", termsDays: 30, notes: "", status: "submitted",
      });
      setFileToUpload(null);
      if (!info) setInfo("Invoice added.");
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    } finally { setSaving(false); }
  }

  /* ------------------------------- edit -------------------------------- */
  function beginEdit(row) {
    setEditId(row._id || row.id);
    setEditForm({
      number: row.number || "",
      projectId: String(row.projectId || ""),
      vendorId: String(row.vendorId || ""),
      newVendorName: "",
      amount: row.amount ?? row.total ?? "",
      currency: row.currency || "USD",
      submittedAt: dateISO(row.submittedAt || row.issuedAt) || "",
      paidAt: dateISO(row.paidAt) || "",
      termsDays: Number(row.termsDays || row.terms || 30),
      notes: row.notes || "",
      status: String(row.status || "submitted"),
    });
    setEditFileToUpload(null);
    setModalOpen(true);
  }
  function cancelEdit() {
    setEditId("");
    setEditForm({
      number: "", projectId: "", vendorId: "", newVendorName: "",
      amount: "", currency: "USD",
      submittedAt: "", paidAt: "", termsDays: 30, notes: "", status: "submitted",
    });
    setEditFileToUpload(null);
  }
  async function saveEdit() {
    if (!editId) return;
    setErr(""); setInfo(""); setSaving(true);
    try {
      const { vendorId, vendorName } = await ensureVendorIdOrName(editForm.vendorId, editForm.newVendorName);
      const patch = {
        number: editForm.number || undefined,
        projectId: editForm.projectId || undefined,
        vendorId, vendorName,
        amount: editForm.amount !== "" ? Number(editForm.amount) : undefined,
        currency: editForm.currency || "USD",
        submittedAt: editForm.submittedAt ? new Date(editForm.submittedAt).toISOString() : undefined,
        paidAt: editForm.paidAt ? new Date(editForm.paidAt).toISOString() : undefined,
        termsDays: Number(editForm.termsDays || 0),
        notes: editForm.notes || "",
        status: editForm.status || undefined,
      };
      const { data: updated } = await api.put(`/invoices/${editId}`, patch);
      setRows((prev) => prev.map((r) => (String(r._id || r.id) === String(editId) ? updated : r)));

      if (editFileToUpload) {
        try { await uploadFor(editId, editFileToUpload); }
        catch { setInfo("Saved, but file upload failed."); }
      } else {
        await refetchOneAndPatchList(editId);
      }

      setInfo("Invoice updated.");
      setModalOpen(false);
      cancelEdit();
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    } finally { setSaving(false); }
  }
  async function del(rowId) {
    if (!confirm("Delete this invoice?")) return;
    setErr(""); setInfo("");
    try {
      await api.delete(`/invoices/${rowId}`);
      await loadAll();
      setInfo("Invoice deleted.");
    } catch (e2) { setErr(e2?.response?.data?.error || String(e2)); }
  }
  async function hardDel(rowId) {
    if (!confirm("Permanently delete this invoice? This cannot be undone.")) return;
    setErr(""); setInfo("");
    try {
      await api.delete(`/invoices/${rowId}`);
      await loadAll();
      setInfo("Invoice permanently deleted.");
    } catch (e2) { setErr(e2?.response?.data?.error || String(e2)); }
  }
  async function markVoid(rowId) {
    try {
      const { data } = await api.put(`/invoices/${rowId}`, { status: "void" });
      setRows((prev) => prev.map((r) => (String(r._id || r.id) === String(rowId) ? data : r)));
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  /* ------------------------------ viewer ------------------------------ */
  function openViewer(url) { setViewerUrl(url); }
  function closeViewer() { setViewerUrl(""); }
  async function downloadFile(url, name) {
    const res = await fetch(url, { credentials: "include" });
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = name || getNameFromUrl(url) || "file";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }

  /* ------------------------------ derived ------------------------------ */
  const filtered = useMemo(() => {
    let base = rows.slice();
    if (q.trim()) {
      const rx = new RegExp(q.trim(), "i");
      base = base.filter((r) =>
        rx.test(r.number || "") ||
        rx.test(projectLabel(r.projectId)) ||
        rx.test(vendorLabel(r.vendor || r.vendorName)) ||
        rx.test(String(r.amount ?? r.total ?? "")) ||
        rx.test(r.notes || "")
      );
    }
    if (statusFilter) base = base.filter((r) => statusFromRow(r) === statusFilter);
    return base;
  }, [rows, q, statusFilter, projects]);

  /* ------------------------------- render ------------------------------ */
  return (
    <div className="max-w-7xl mx-auto p-4">
      <style>{`
        .card{ background:#fff; border:1px solid #e5e7eb; border-radius:12px; }
        .table{ width:100%; border-collapse:collapse; }
        .table th,.table td{ padding:.5rem; border-top:1px solid #eef2f7; text-align:left; vertical-align:top; }
        .muted{ color:#64748b; }
        .btn{ border:1px solid #e5e7eb; border-radius:10px; padding:8px 12px; background:#fff; font-size:12px; line-height:18px; }
        .btn-sm{ border:1px solid #e5e7eb; border-radius:8px; padding:6px 10px; background:#fff; font-size:12px; line-height:18px; }
        .input, .select, .textarea { border:1px solid #e5e7eb; border-radius:8px; padding:8px; width:100%; font-size:12px; }
        .lightbox{ position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.5); z-index:60; }
        .panel{ background:#fff; border:1px solid #e5e7eb; border-radius:14px; padding:14px; width:100%; max-width:860px; }
        .chip{ border:1px solid #e5e7eb; border-radius:9999px; padding:2px 8px; font-size:12px; }
        .toolbar{ display:flex; align-items:center; gap:8px; white-space:nowrap; overflow-x:auto; padding:6px; border:1px solid #e5e7eb; border-radius:12px; background:#fff; }
        .toolbar > * { flex: 0 0 auto; }
        .fileFrame{ width:100%; height:70vh; border:1px solid #e5e7eb; border-radius:12px; }
      `}</style>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Invoices</h1>
        <div className="text-sm text-gray-600 mt-1">{loading ? "Loading…" : `Total: ${rows.length} • Showing: ${filtered.length}`}</div>
      </div>

      <div className="mt-3 toolbar">
        <label className="text-sm inline-flex items-center gap-2">
          <input type="checkbox" checked={showDeleted} onChange={(e)=>setShowDeleted(e.target.checked)} />
          <span>Show deleted</span>
        </label>

        <input className="input" style={{ width: 240 }} placeholder="Search…" value={q} onChange={(e)=>setQ(e.target.value)} />

        <select className="select" style={{ width: 180 }} value={statusFilter} onChange={(e)=>setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="submitted">submitted</option>
          <option value="outstanding">outstanding</option>
          <option value="paid">paid</option>
          <option value="void">void</option>
        </select>

        {canManage ? (
          <button className="btn" onClick={()=>{ setModalOpen(true); setFileToUpload(null); setEditId(""); }}>
            Add invoice
          </button>
        ) : (
          <span className="text-sm text-gray-600">Read-only (manager+ can edit)</span>
        )}
      </div>

      {err && <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-sm">{err}</div>}
      {info && <div className="mt-2 rounded border border-green-200 bg-green-100 p-2 text-sm">{info}</div>}

      {/* Table */}
      <div className="card mt-3 overflow-x-auto">
        <table className="table text-sm">
          <thead>
            <tr style={{ background: "#f9fafb" }}>
              <th>Number</th>
              <th>Project</th>
              <th>Vendor</th>
              <th>Amount</th>
              <th>Submitted</th>
              <th>Terms</th>
              <th>Due</th>
              <th>Status</th>
              <th>Paid</th>
              <th>File</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length ? (
              filtered.map((i) => {
                const code = statusFromRow(i);
                const due = dueFromSubmitted(i.submittedAt || i.issuedAt, i.termsDays || i.terms || 0);
                const fileUrl = pickFileUrl(i);
                const id = i._id || i.id;
                const currency = i.currency || "USD";
                return (
                  <tr key={id}>
                    <td className="p-2">{i.number || "—"}</td>
                    <td className="p-2">{projectLabel(i.projectId)}</td>
                    <td className="p-2">{vendorLabel(i.vendor || i.vendorName)}</td>
                    <td className="p-2">{fmtAmt(i.amount ?? i.total, currency)}</td>
                    <td className="p-2">{i.submittedAt ? new Date(i.submittedAt).toLocaleDateString() : "—"}</td>
                    <td className="p-2">{i.termsDays != null ? `${i.termsDays} days` : "—"}</td>
                    <td className="p-2">{due ? new Date(due).toLocaleDateString() : "—"}</td>
                    <td className="p-2"><Badge code={code} /></td>
                    <td className="p-2">{i.paidAt ? new Date(i.paidAt).toLocaleDateString() : "—"}</td>
                    <td className="p-2">
                      {fileUrl ? (
                        <div className="flex items-center gap-2">
                          <button type="button" className="btn-sm" onClick={() => openViewer(fileUrl)} title="View">View</button>
                        </div>
                      ) : "—"}
                    </td>
                    <td className="p-2 text-right">
                      {canManage ? (
                        <>
                          {!i?.deleted && <button className="btn-sm mr-1" onClick={()=>beginEdit(i)}>Edit</button>}
                          <button className="btn-sm mr-1" onClick={()=>del(id)}>{i?.deleted ? "Delete (soft)" : "Delete"}</button>
                          {statusFromRow(i) !== "void" && !i?.deleted && (
                            <button className="btn-sm mr-1" title="Mark void" onClick={()=>markVoid(id)}>Void</button>
                          )}
                          {i?.deleted && (
                            <button className="btn-sm" title="Hard delete" onClick={()=>hardDel(id)}>Hard delete</button>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-gray-500">No actions</span>
                      )}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td className="p-4 text-center text-gray-600" colSpan={11}>
                  No invoices found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* --------- Add/Edit Lightbox --------- */}
      {modalOpen && (
        <div className="lightbox" onClick={()=>{ setModalOpen(false); if (editId) cancelEdit(); }}>
          <div className="panel" onClick={(e)=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-lg font-semibold">{editId ? "Edit invoice" : "Add invoice"}</div>
              <button className="btn-sm" onClick={()=>{ setModalOpen(false); if (editId) cancelEdit(); }}>Close</button>
            </div>

            <form
              onSubmit={editId ? (e)=>{ e.preventDefault(); saveEdit(); } : handleCreateInvoice}
              className="grid gap-2 md:grid-cols-2"
            >
              <label className="text-sm">Number
                <input className="input"
                  value={editId ? editForm.number : form.number}
                  onChange={(e)=> editId ? setEditForm(f=>({...f, number: e.target.value})) : setForm(f=>({...f, number: e.target.value}))}
                />
              </label>

              <label className="text-sm">Project
                <select className="select"
                  value={editId ? editForm.projectId : form.projectId}
                  onChange={(e)=> editId ? setEditForm(f=>({...f, projectId: e.target.value})) : setForm(f=>({...f, projectId: e.target.value}))}
                >
                  <option value="">— none —</option>
                  {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
                </select>
              </label>

              <label className="text-sm">Vendor
                <div className="flex items-center gap-2">
                  <select className="select"
                    value={editId ? editForm.vendorId : form.vendorId}
                    onChange={(e)=> editId ? setEditForm(f=>({...f, vendorId: e.target.value})) : setForm(f=>({...f, vendorId: e.target.value}))}
                  >
                    <option value="">— select vendor —</option>
                    {vendors.map(v => <option key={v._id || v.id} value={v._id || v.id}>{v.name}</option>)}
                    <option value="__new__">+ Add new vendor…</option>
                  </select>
                  {(editId ? (editForm.vendorId === "" || editForm.vendorId === "__new__") : (form.vendorId === "" || form.vendorId === "__new__")) && (
                    <input className="input" placeholder="New vendor name"
                      value={editId ? editForm.newVendorName : form.newVendorName}
                      onChange={(e)=> editId ? setEditForm(f=>({...f, newVendorName: e.target.value})) : setForm(f=>({...f, newVendorName: e.target.value}))}
                    />
                  )}
                </div>
              </label>

              <label className="text-sm">Amount
                <input className="input" type="number" inputMode="decimal" min="0"
                  value={editId ? editForm.amount : form.amount}
                  onChange={(e)=> editId ? setEditForm(f=>({...f, amount: e.target.value})) : setForm(f=>({...f, amount: e.target.value}))}
                />
              </label>

              <label className="text-sm">Currency
                <select className="select"
                  value={editId ? editForm.currency : form.currency}
                  onChange={(e)=> editId ? setEditForm(f=>({...f, currency: e.target.value})) : setForm(f=>({...f, currency: e.target.value}))}
                >
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>

              <label className="text-sm">Date Submitted
                <input className="input" type="date" required
                  value={editId ? editForm.submittedAt : form.submittedAt}
                  onChange={(e)=> editId ? setEditForm(f=>({...f, submittedAt: e.target.value})) : setForm(f=>({...f, submittedAt: e.target.value}))}
                />
              </label>

              <label className="text-sm">Terms
                <select className="select"
                  value={editId ? editForm.termsDays : form.termsDays}
                  onChange={(e)=> editId ? setEditForm(f=>({...f, termsDays: Number(e.target.value)})) : setForm(f=>({...f, termsDays: Number(e.target.value)}))}
                >
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                  <option value={45}>45 days</option>
                  <option value={60}>60 days</option>
                </select>
              </label>

              <label className="text-sm">Date Paid
                <input className="input" type="date"
                  value={editId ? editForm.paidAt : form.paidAt}
                  onChange={(e)=> editId ? setEditForm(f=>({...f, paidAt: e.target.value})) : setForm(f=>({...f, paidAt: e.target.value}))}
                />
              </label>

              <label className="text-sm">Status
                <select className="select"
                  value={editId ? editForm.status : form.status}
                  onChange={(e)=> editId ? setEditForm(f=>({...f, status: e.target.value})) : setForm(f=>({...f, status: e.target.value}))}
                >
                  <option value="submitted">submitted</option>
                  <option value="outstanding">outstanding</option>
                  <option value="paid">paid</option>
                  <option value="void">void</option>
                </select>
              </label>

              <label className="text-sm md:col-span-2">Notes
                <input className="input"
                  value={editId ? editForm.notes : form.notes}
                  onChange={(e)=> editId ? setEditForm(f=>({...f, notes: e.target.value})) : setForm(f=>({...f, notes: e.target.value}))}
                />
              </label>

              {!editId ? (
                <label className="text-sm md:col-span-2">Upload file (PDF/image)
                  <input className="input" type="file" accept="application/pdf,image/*"
                    onChange={(e)=> setFileToUpload(e.target.files?.[0] || null)}
                  />
                </label>
              ) : (
                <div className="md:col-span-2 grid gap-2">
                  <div className="text-sm">Attach / replace file</div>
                  <input className="input" type="file" accept="application/pdf,image/*"
                    onChange={(e)=> setEditFileToUpload(e.target.files?.[0] || null)}
                  />
                  <ExistingFileHint id={editId} rows={rows} openViewer={openViewer} />
                </div>
              )}

              <div className="md:col-span-2 flex items-center justify-end gap-2 mt-1">
                <button type="button" className="btn-sm" onClick={()=>{ setModalOpen(false); if (editId) cancelEdit(); }}>Cancel</button>
                <button type="submit" className="btn-sm" disabled={saving}>
                  {saving ? "Saving…" : editId ? "Save" : "Add"}
                </button>
              </div>
            </form>

            <div className="mt-2 text-sm text-gray-600">
              {(() => {
                const s = editId ? editForm.submittedAt : form.submittedAt;
                const t = editId ? editForm.termsDays : form.termsDays;
                const due = dueFromSubmitted(s, t);
                return due ? <>Due date preview: <b>{new Date(due).toLocaleDateString()}</b></> : null;
              })()}
            </div>
          </div>
        </div>
      )}

      {/* --------- File Preview Lightbox --------- */}
      {viewerUrl && (
        <div className="lightbox" onClick={closeViewer}>
          <div className="panel" onClick={(e)=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-lg font-semibold">Document preview</div>
              <div className="flex items-center gap-2">
                <button
                  className="btn-sm"
                  onClick={() => downloadFile(viewerUrl, getNameFromUrl(viewerUrl))}
                  title="Download"
                >
                  Download
                </button>
                <button className="btn-sm" onClick={closeViewer}>Close</button>
              </div>
            </div>
            {/\.(png|jpe?g|gif|webp)$/i.test(viewerUrl) ? (
              <img src={viewerUrl} alt="Preview" style={{ maxWidth: "100%", maxHeight: "70vh", borderRadius: 12, border: "1px solid #e5e7eb" }} />
            ) : (
              <iframe className="fileFrame" src={viewerUrl} title="Preview" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- small component to show existing file in edit -------- */
function ExistingFileHint({ id, rows, openViewer }) {
  const row = rows.find((r) => String(r._id || r.id) === String(id));
  const url = pickFileUrl(row);
  if (!url) return <div className="text-xs text-gray-600">No file currently attached.</div>;
  return (
    <div className="text-xs">
      Current file:{" "}
      <button className="underline" type="button" onClick={() => openViewer(url)}>
        View
      </button>
    </div>
  );
}
