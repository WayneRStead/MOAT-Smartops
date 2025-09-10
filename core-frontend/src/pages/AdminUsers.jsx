// src/pages/AdminUsers.jsx
import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import ResetPasswordModal from "../components/ResetPasswordModal.jsx";

export default function AdminUsers() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ name: "", email: "", role: "worker", tempPassword: "" });
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [file, setFile] = useState(null);
  const [target, setTarget] = useState(null); // for ResetPasswordModal

  async function load() {
    setErr(""); setInfo("");
    try {
      const { data } = await api.get("/users");
      setRows(data || []);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    setErr(""); setInfo("");

    try {
      const payload = {
        name: form.name,
        email: form.email?.toLowerCase().trim(),
        role: form.role || "worker",
      };
      if (form.tempPassword) payload.password = form.tempPassword; // triggers pre-save hash
      await api.post("/users", payload);

      setForm({ name: "", email: "", role: "worker", tempPassword: "" });
      setEditing(null);
      await load();
      setInfo("User created.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function update(e) {
    e.preventDefault();
    setErr(""); setInfo("");

    try {
      const payload = {
        name: form.name,
        email: form.email?.toLowerCase().trim(),
        role: form.role || "worker",
      };
      // Optionally allow setting a new password in the edit form too
      if (form.tempPassword) payload.password = form.tempPassword;

      await api.put(`/users/${editing._id}`, payload);

      setForm({ name: "", email: "", role: "worker", tempPassword: "" });
      setEditing(null);
      await load();
      setInfo("User updated.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function del(id) {
    if (!confirm("Delete this user?")) return;
    setErr(""); setInfo("");
    try {
      await api.delete(`/users/${id}`);
      await load();
      setInfo("User deleted.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  function startEdit(u) {
    setEditing(u);
    setForm({
      name: u.name || "",
      email: u.email || "",
      role: u.role || "worker",
      tempPassword: "",
    });
  }

  async function doBulkUpload() {
    setErr(""); setInfo("");
    if (!file) { setErr("Please choose a CSV or Excel file first."); return; }
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { data } = await api.post("/users/bulk-upload", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setInfo(`Uploaded ${data?.count ?? 0} users.`);
      setFile(null);
      await load();
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  function downloadTemplate() {
    const csv = "name,email,role\nJane Doe,jane@example.com,manager\nJohn Dlamini,john@example.com,worker\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "users-template.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-4">
      <h2 className="text-xl font-semibold mb-3">Admin • Users</h2>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {info && <p style={{ color: "seagreen" }}>{info}</p>}

      {/* Bulk upload */}
      <fieldset style={{ border: "1px solid var(--border)", padding: 12, borderRadius: 8, marginBottom: 12 }}>
        <legend>Bulk upload</legend>
        <div className="row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="file"
            accept=".csv, application/vnd.ms-excel, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
          <button className="btn-primary" onClick={doBulkUpload}>Upload</button>
          <button type="button" onClick={downloadTemplate}>Download CSV template</button>
        </div>
        <small className="muted">
          Accepted columns: <code>name</code>, <code>email</code>, <code>role</code> (optional extra fields ignored). File types: CSV/XLSX.
        </small>
      </fieldset>

      {/* Create / Edit form */}
      <form onSubmit={editing ? update : create} style={{ display: "grid", gap: 8, maxWidth: 520, marginBottom: 16 }}>
        <label> Name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label> Email
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </label>
        <label> Role
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="worker">worker</option>
            <option value="manager">manager</option>
            <option value="admin">admin</option>
            <option value="superadmin">superadmin</option>
          </select>
        </label>

        {/* Temp password (create; allowed in edit too if you want) */}
        <label>Temp password (optional)
          <input
            type="text"
            placeholder="e.g. ChangeMe!23"
            value={form.tempPassword}
            onChange={(e) => setForm({ ...form, tempPassword: e.target.value })}
          />
        </label>

        <div className="row" style={{ display: "flex", gap: 8 }}>
          <button className="btn-primary">{editing ? "Update user" : "Create user"}</button>
          {editing && (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setForm({ name: "", email: "", role: "worker", tempPassword: "" });
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      {/* Users table */}
      <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 8 }}>Name</th>
            <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 8 }}>Email</th>
            <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 8 }}>Role</th>
            <th style={{ textAlign: "right", borderBottom: "1px solid #eee", padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u._id}>
              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{u.name || "-"}</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{u.email || u.username}</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{u.role}</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3", textAlign: "right" }}>
                <button onClick={() => setTarget({ ...u, id: u._id })} style={{ marginRight: 8 }}>
                  Reset Password
                </button>
                <button onClick={() => startEdit(u)} style={{ marginRight: 8 }}>
                  Edit
                </button>
                <button onClick={() => del(u._id)}>Delete</button>
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={4} style={{ opacity: 0.7, padding: 12 }}>No users yet.</td>
            </tr>
          )}
        </tbody>
      </table>

      {target && (
        <ResetPasswordModal
          user={target}
          onClose={() => setTarget(null)}
          onDone={() => { setTarget(null); load(); }}
        />
      )}
    </div>
  );
}
