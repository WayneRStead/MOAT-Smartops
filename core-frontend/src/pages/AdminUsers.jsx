// src/pages/AdminUsers.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import ResetPasswordModal from "../components/ResetPasswordModal.jsx";

/* ---- Small shared modal ---- */
function Modal({ open, onClose, title, children, width = 720 }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[200] bg-black/50 grid place-items-center p-4"
      onMouseDown={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-h-[90vh] w-full"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold m-0">{title}</h3>
          <button className="btn btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="p-4 overflow-auto">{children}</div>
      </div>
    </div>
  );
}

const ROLE_OPTIONS = [
  { value: "worker",          label: "worker" },
  { value: "group-leader",    label: "group leader" },
  { value: "project-manager", label: "project manager" },
  { value: "manager",         label: "manager" },
  { value: "admin",           label: "admin" },
  { value: "superadmin",      label: "superadmin" },
];

const STATUS_OPTIONS = [
  { value: "",            label: "All biometric statuses" },
  { value: "not-enrolled",label: "not-enrolled" },
  { value: "pending",     label: "pending" },
  { value: "enrolled",    label: "enrolled" },
  { value: "rejected",    label: "rejected" },
  { value: "revoked",     label: "revoked" },
  { value: "expired",     label: "expired" },
];

function Pill({ children, tone = "default" }) {
  const tones = {
    default: "bg-gray-100 text-gray-700",
    ok: "bg-green-100 text-green-700",
    warn: "bg-yellow-100 text-yellow-800",
    bad: "bg-red-100 text-red-700",
  };
  const cls = tones[tone] || tones.default;
  return <span className={`inline-block px-2 py-0.5 rounded text-xs ${cls}`}>{children}</span>;
}

/* ------------ id helpers (cope with {_id}, ObjectId, string) ------------ */
const idStr = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return String(v._id || v.id || v); // v might be ObjectId
  return String(v);
};

export default function AdminUsers() {
  const [rows, setRows] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupsByUser, setGroupsByUser] = useState({}); // { [userId]: string[] }
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  // filters / search
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [missingPhotoOnly, setMissingPhotoOnly] = useState(false);

  // reset password modal target
  const [target, setTarget] = useState(null);

  // Create/Edit modals
  const [showCreate, setShowCreate] = useState(false);
  const [createTab, setCreateTab] = useState("single"); // "single" | "bulk"
  const [createForm, setCreateForm] = useState({
    name: "",
    email: "",
    username: "",
    staffNumber: "",
    role: "worker",
    tempPassword: "",
  });
  const [bulkFile, setBulkFile] = useState(null);
  const [creating, setCreating] = useState(false);

  const [editUser, setEditUser] = useState(null);
  const [editForm, setEditForm] = useState({
    name: "",
    email: "",
    username: "",
    staffNumber: "",
    role: "worker",
    tempPassword: "",
  });
  const [editing, setEditing] = useState(false);

  // Photo + biometric quick modals
  const [photoModal, setPhotoModal] = useState({ open: false, user: null, objectId: "", url: "" });
  const [enrollModal, setEnrollModal] = useState({ open: false, user: null, token: "", enrollmentId: "", action: "" });

  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [q]);

  /* ----------------------- data loading (consistent) ----------------------- */
  async function loadUsers() {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (missingPhotoOnly) params.set("missingPhoto", "true");
    const qs = params.toString() ? `?${params.toString()}` : "";
    const { data } = await api.get(`/users${qs}`);
    return Array.isArray(data) ? data : [];
  }
  async function loadGroups() {
    const { data } = await api.get("/groups?limit=1000"); // use same api client
    return Array.isArray(data) ? data : [];
  }

  function buildGroupsDict(gs) {
    const dict = {}; // { userId: [groupName, ...] }
    for (const g of gs || []) {
      const gname = (g && g.name) || "";
      if (!gname) continue;

      // members
      for (const uid of g.memberUserIds || []) {
        const key = idStr(uid);
        if (!key) continue;
        if (!dict[key]) dict[key] = [];
        if (!dict[key].includes(gname)) dict[key].push(gname);
      }

      // leader (ensure included)
      const leaderId =
        (Array.isArray(g.leaderUserIds) && g.leaderUserIds[0]) ||
        g.leaderUserId ||
        null;
      const lkey = idStr(leaderId);
      if (lkey) {
        if (!dict[lkey]) dict[lkey] = [];
        if (!dict[lkey].includes(gname)) dict[lkey].push(gname);
      }
    }
    return dict;
  }

  async function load() {
    setErr(""); setInfo("");
    try {
      const [usersData, groupsData] = await Promise.all([loadUsers(), loadGroups()]);
      setRows(usersData);
      setGroups(groupsData);
      setGroupsByUser(buildGroupsDict(groupsData)); // plain object -> guaranteed rerender
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => { load(); }, [statusFilter, missingPhotoOnly]);

  const filtered = useMemo(() => {
    const needle = qDeb;
    return (rows || []).filter(u => {
      const roleOk = !roleFilter || String(u.role || "").toLowerCase() === roleFilter;
      if (!roleOk) return false;
      if (!needle) return true;
      const gList = groupsByUser[idStr(u._id || u.id)] || [];
      const hay = `${u.name || ""} ${u.email || u.username || ""} ${u.staffNumber || ""} ${u.role || ""} ${gList.join(" ")}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, qDeb, roleFilter, groupsByUser]);

  // --- CSV template (includes groupName) ---
  function downloadTemplate() {
    const csv =
`name,email,username,staffNumber,role,groupName
Jane Doe,jane@example.com,jane,STA-1001,worker,Group A
John Dlamini,john@example.com,john,STA-1002,group-leader,Group A
`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "users-template.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  // --- Create (single) ---
  async function createSingle(e) {
    e?.preventDefault?.();
    if (creating) return;
    setErr(""); setInfo(""); setCreating(true);
    try {
      const payload = {
        name: (createForm.name || "").trim(),
        email: (createForm.email || "").toLowerCase().trim() || undefined,
        username: (createForm.username || "").trim() || undefined,
        staffNumber: (createForm.staffNumber || "").trim() || undefined,
        role: createForm.role || "worker",
      };
      if (!payload.name || (!payload.email && !payload.username && !payload.staffNumber)) {
        setErr("Name and at least one of Email, Username, or Staff Number is required.");
        return;
      }
      if (createForm.tempPassword) payload.password = createForm.tempPassword;
      await api.post("/users", payload);
      setCreateForm({ name: "", email: "", username: "", staffNumber: "", role: "worker", tempPassword: "" });
      setShowCreate(false);
      await load();
      setInfo("User created.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally { setCreating(false); }
  }

  // --- Bulk upload ---
  async function doBulkUpload(e) {
    e?.preventDefault?.();
    if (!bulkFile) { setErr("Please choose a CSV or Excel file first."); return; }
    setErr(""); setInfo(""); setCreating(true);
    try {
      const fd = new FormData();
      fd.append("file", bulkFile);
      const { data } = await api.post("/users/bulk-upload", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setInfo(`Uploaded ${data?.count ?? data?.created ?? 0} users.`);
      setBulkFile(null);
      setShowCreate(false);
      await load();
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    } finally { setCreating(false); }
  }

  // --- Edit user ---
  function openEdit(u) {
    setEditUser(u);
    setEditForm({
      name: u.name || "",
      email: u.email || "",
      username: u.username || "",
      staffNumber: u.staffNumber || "",
      role: u.role || "worker",
      tempPassword: "",
    });
  }
  function closeEdit() {
    setEditUser(null);
    setEditForm({ name: "", email: "", username: "", staffNumber: "", role: "worker", tempPassword: "" });
  }

  async function saveEdit(e) {
    e?.preventDefault?.();
    if (!editUser || editing) return;
    setErr(""); setInfo(""); setEditing(true);
    try {
      const payload = {
        name: (editForm.name || "").trim(),
        email: (editForm.email || "").toLowerCase().trim() || undefined,
        username: (editForm.username || "").trim() || undefined,
        staffNumber: (editForm.staffNumber || "").trim() || undefined,
        role: editForm.role || "worker",
      };
      if (!payload.name) {
        setErr("Name is required.");
        return;
      }
      if (editForm.tempPassword) payload.password = editForm.tempPassword;
      await api.put(`/users/${editUser._id}`, payload);
      closeEdit();
      await load();
      setInfo("User updated.");
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    } finally { setEditing(false); }
  }

  // --- Delete (soft) ---
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

  // --- Photo: set via objectId (simple for now) ---
  function openPhotoModal(u) {
    setPhotoModal({ open: true, user: u, objectId: "", url: "" });
  }
  function closePhotoModal() { setPhotoModal({ open: false, user: null, objectId: "", url: "" }); }

  async function confirmPhoto() {
    if (!photoModal.user || !photoModal.objectId) { setErr("objectId is required"); return; }
    try {
      setErr(""); setInfo("");
      await api.post(`/users/${photoModal.user._id}/photo/confirm`, {
        objectId: photoModal.objectId,
        url: photoModal.url || undefined,
      });
      closePhotoModal();
      await load();
      setInfo("Photo attached.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  // --- Biometrics actions ---
  async function startEnrollment(u) {
    try {
      setErr(""); setInfo("");
      const { data } = await api.post(`/users/${u._id}/biometric/start`, { method: "self" });
      setEnrollModal({ open: true, user: u, token: data?.token || "", enrollmentId: "", action: "started" });
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function approveEnrollment(u) {
    const enrollmentId = prompt("Enter enrollmentId to approve:");
    if (!enrollmentId) return;
    try {
      await api.post(`/users/${u._id}/biometric/approve`, { enrollmentId });
      await load();
      setInfo("Enrollment approved.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function rejectEnrollment(u) {
    const enrollmentId = prompt("Enter enrollmentId to reject:");
    if (!enrollmentId) return;
    const reason = prompt("Reason for rejection (optional):") || "";
    try {
      await api.post(`/users/${u._id}/biometric/reject`, { enrollmentId, reason });
      await load();
      setInfo("Enrollment rejected.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function revokeEnrollment(u) {
    if (!confirm("Revoke biometric enrollment for this user?")) return;
    const reason = prompt("Reason for revoke (optional):") || "";
    try {
      await api.post(`/users/${u._id}/biometric/revoke`, { reason });
      await load();
      setInfo("Enrollment revoked.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  function statusTone(s) {
    if (s === "enrolled") return "ok";
    if (s === "pending") return "warn";
    if (s === "rejected" || s === "revoked") return "bad";
    return "default";
  }

  return (
    <div className="max-w-7xl mx-auto p-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Admin • Users</h1>
        <div className="flex items-center gap-2">
          <input
            className="input input-bordered"
            style={{ minWidth: 260 }}
            placeholder="Search name, email, username, staff #, group…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="select select-bordered"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            title="Filter by role"
          >
            <option value="">All roles</option>
            {ROLE_OPTIONS.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <select
            className="select select-bordered"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            title="Filter by biometric status"
          >
            {STATUS_OPTIONS.map(s => (
              <option key={s.value || "all"} value={s.value}>{s.label}</option>
            ))}
          </select>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={missingPhotoOnly}
              onChange={e => setMissingPhotoOnly(e.target.checked)}
            />
            Missing Photo only
          </label>
          <button className="btn btn-sm" onClick={downloadTemplate} title="Download CSV template">
            Download CSV Template
          </button>
          <button className="btn btn-sm" onClick={() => { setShowCreate(true); setCreateTab("single"); }}>
            New User
          </button>
        </div>
      </div>

      {err && <div className="text-red-600 mt-2">{err}</div>}
      {info && <div className="text-green-700 mt-2">{info}</div>}

      {/* Table */}
      <div className="mt-3 overflow-x-auto rounded-xl border">
        <table className="table w-full">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th>Photo</th>
              <th>Name</th>
              <th>Email / Username</th>
              <th>Staff #</th>
              <th>Role</th>
              <th>Groups</th>
              <th>Biometric</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length ? (
              filtered.map((u) => {
                const photoUrl = u?.photo?.url;
                const status = u?.biometric?.status || "not-enrolled";
                const gNames = groupsByUser[idStr(u._id || u.id)] || [];
                return (
                  <tr key={u._id}>
                    <td className="align-top">
                      {photoUrl ? (
                        <img src={photoUrl} alt="" className="w-10 h-10 rounded-full object-cover" />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-gray-200 grid place-items-center text-xs text-gray-600">—</div>
                      )}
                    </td>
                    <td className="align-top">{u.name || "—"}</td>
                    <td className="align-top">{u.email || u.username || "—"}</td>
                    <td className="align-top">{u.staffNumber || "—"}</td>
                    <td className="align-top">{u.role || "—"}</td>
                    <td className="align-top">
                      {gNames.length ? gNames.join(", ") : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="align-top">
                      <Pill tone={statusTone(status)}>{status}</Pill>
                    </td>
                    <td className="text-right align-top">
                      <div className="flex flex-wrap gap-2 justify-end">
                        <button className="btn btn-sm" onClick={() => setTarget({ ...u, id: u._id })}>
                          Reset Password
                        </button>
                        <button className="btn btn-sm" onClick={() => openEdit(u)}>
                          Edit
                        </button>
                        <button className="btn btn-sm" onClick={() => del(u._id)}>
                          Delete
                        </button>
                        <button className="btn btn-sm" onClick={() => openPhotoModal(u)}>
                          Set Photo
                        </button>
                        <button className="btn btn-sm" onClick={() => startEnrollment(u)}>
                          Start Enroll
                        </button>
                        <button className="btn btn-sm" onClick={() => approveEnrollment(u)}>
                          Approve
                        </button>
                        <button className="btn btn-sm" onClick={() => rejectEnrollment(u)}>
                          Reject
                        </button>
                        <button className="btn btn-sm" onClick={() => revokeEnrollment(u)}>
                          Revoke
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td className="p-4 text-gray-600" colSpan={8}>No users found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create modal: single / bulk */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Add Users">
        <div className="space-y-3">
          {/* Tabs */}
          <div className="inline-flex overflow-hidden rounded">
            <button
              className={`px-3 py-2 ${createTab === "single" ? "bg-black text-white" : ""}`}
              onClick={() => setCreateTab("single")}
            >
              Create Individually
            </button>
            <button
              className={`px-3 py-2 ${createTab === "bulk" ? "bg-black text-white" : ""}`}
              onClick={() => setCreateTab("bulk")}
            >
              Bulk Upload
            </button>
          </div>

          {createTab === "single" && (
            <form onSubmit={createSingle} className="grid gap-3 md:grid-cols-2">
              <label className="text-sm md:col-span-2">Name
                <input
                  className="border p-2 w-full"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  required
                />
              </label>
              <label className="text-sm">Email
                <input
                  className="border p-2 w-full"
                  type="email"
                  value={createForm.email}
                  onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                  placeholder="Optional if username or staff # is provided"
                />
              </label>
              <label className="text-sm">Username
                <input
                  className="border p-2 w-full"
                  value={createForm.username}
                  onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                  placeholder="Optional if email or staff # is provided"
                />
              </label>
              <label className="text-sm">Staff #
                <input
                  className="border p-2 w-full"
                  value={createForm.staffNumber}
                  onChange={(e) => setCreateForm({ ...createForm, staffNumber: e.target.value })}
                  placeholder="Optional if email or username is provided"
                />
              </label>
              <label className="text-sm">Role
                <select
                  className="border p-2 w-full"
                  value={createForm.role}
                  onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}
                >
                  {ROLE_OPTIONS.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">Temp password (optional)
                <input
                  className="border p-2 w-full"
                  type="text"
                  placeholder="e.g. ChangeMe!23"
                  value={createForm.tempPassword}
                  onChange={(e) => setCreateForm({ ...createForm, tempPassword: e.target.value })}
                />
              </label>

              <div className="md:col-span-2 flex items-center gap-2 pt-1">
                <button className="px-3 py-2 bg-black text-white rounded disabled:opacity-60" disabled={creating}>
                  {creating ? "Creating…" : "Create User"}
                </button>
                <button type="button" className="px-3 py-2 border rounded" onClick={() => setShowCreate(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {createTab === "bulk" && (
            <form onSubmit={doBulkUpload} className="space-y-2">
              <label className="text-sm block">Choose CSV/XLSX file
                <input
                  className="border p-2 w-full"
                  type="file"
                  accept=".csv, application/vnd.ms-excel, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(e) => setBulkFile(e.target.files?.[0] || null)}
                />
              </label>
              <div className="text-xs text-gray-600">
                Accepted columns: <code>name</code>, <code>email</code>, <code>username</code>, <code>staffNumber</code>, <code>role</code>, <code>groupName</code>.
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button className="px-3 py-2 bg-black text-white rounded disabled:opacity-60" disabled={creating || !bulkFile}>
                  {creating ? "Uploading…" : "Upload"}
                </button>
                <button
                  type="button"
                  className="px-3 py-2 border rounded"
                  onClick={downloadTemplate}
                  title="Download CSV template"
                >
                  Download CSV Template
                </button>
                <button type="button" className="px-3 py-2 border rounded ml-auto" onClick={() => setShowCreate(false)}>
                  Close
                </button>
              </div>
            </form>
          )}
        </div>
      </Modal>

      {/* Edit modal */}
      <Modal open={!!editUser} onClose={closeEdit} title="Edit User">
        {editUser && (
          <form onSubmit={saveEdit} className="grid gap-3 md:grid-cols-2">
            <label className="text-sm md:col-span-2">Name
              <input
                className="border p-2 w-full"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                required
              />
            </label>
            <label className="text-sm md:col-span-2">Email
              <input
                className="border p-2 w-full"
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                placeholder="Leave blank to keep unchanged"
              />
            </label>
            <label className="text-sm">Username
              <input
                className="border p-2 w-full"
                value={editForm.username}
                onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
                placeholder="Optional"
              />
            </label>
            <label className="text-sm">Staff #
              <input
                className="border p-2 w-full"
                value={editForm.staffNumber}
                onChange={(e) => setEditForm({ ...editForm, staffNumber: e.target.value })}
                placeholder="Optional"
              />
            </label>
            <label className="text-sm">Role
              <select
                className="border p-2 w-full"
                value={editForm.role}
                onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
              >
                {ROLE_OPTIONS.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">Temp password (optional)
              <input
                className="border p-2 w-full"
                type="text"
                placeholder="Set a new temporary password"
                value={editForm.tempPassword}
                onChange={(e) => setEditForm({ ...editForm, tempPassword: e.target.value })}
              />
            </label>

            <div className="md:col-span-2 flex items-center gap-2 pt-1">
              <button className="px-3 py-2 bg-black text-white rounded disabled:opacity-60" disabled={editing}>
                {editing ? "Saving…" : "Save"}
              </button>
              <button type="button" className="px-3 py-2 border rounded" onClick={closeEdit}>
                Cancel
              </button>
              <div className="ml-auto">
                <button
                  type="button"
                  className="px-3 py-2 border rounded"
                  onClick={() => { setTarget({ ...editUser, id: editUser._id }); }}
                >
                  Reset Password
                </button>
              </div>
            </div>
          </form>
        )}
      </Modal>

      {/* Photo modal */}
      <Modal
        open={photoModal.open}
        onClose={closePhotoModal}
        title={`Set Photo${photoModal?.user ? ` • ${photoModal.user.name}` : ""}`}
      >
        <div className="space-y-3">
          <div className="text-sm text-gray-700">
            Paste the storage <code>objectId</code> (can be obtained via <em>upload-init</em>).
          </div>
          <label className="text-sm block">
            objectId
            <input
              className="border p-2 w-full"
              value={photoModal.objectId}
              onChange={(e) => setPhotoModal({ ...photoModal, objectId: e.target.value })}
              placeholder="e.g. 652b.../1698595589.jpg"
            />
          </label>
          <label className="text-sm block">
            Temporary URL (optional, for preview)
            <input
              className="border p-2 w-full"
              value={photoModal.url}
              onChange={(e) => setPhotoModal({ ...photoModal, url: e.target.value })}
              placeholder="e.g. https://signed-url"
            />
          </label>
          <div className="flex items-center justify-end gap-2">
            <button className="px-3 py-2 border rounded" onClick={closePhotoModal}>Cancel</button>
            <button className="px-3 py-2 bg-black text-white rounded" onClick={confirmPhoto}>Confirm</button>
          </div>
        </div>
      </Modal>

      {/* Enrollment helper modal */}
      <Modal
        open={enrollModal.open}
        onClose={() => setEnrollModal({ open: false, user: null, token: "", enrollmentId: "", action: "" })}
        title={`Enrollment ${enrollModal.action === "started" ? "Started" : ""}`}
      >
        <div className="space-y-2 text-sm">
          <div>Use this token in the mobile app to complete self-enrollment:</div>
          <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto">{enrollModal.token || "—"}</pre>
          <div className="text-gray-600">
            After the mobile submits, approve or reject using the buttons in the table row.
          </div>
        </div>
      </Modal>

      {/* Reset password modal */}
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
