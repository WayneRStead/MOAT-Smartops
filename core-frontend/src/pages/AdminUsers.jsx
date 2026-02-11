// src/pages/AdminUsers.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import ResetPasswordModal from "../components/ResetPasswordModal.jsx";
import { api } from "../lib/api";

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
  { value: "worker", label: "worker" },
  { value: "group-leader", label: "group leader" },
  { value: "project-manager", label: "project manager" },
  { value: "manager", label: "manager" },
  { value: "admin", label: "admin" },
  { value: "superadmin", label: "superadmin" },
];

const STATUS_OPTIONS = [
  { value: "", label: "All biometric statuses" },
  { value: "not-enrolled", label: "not-enrolled" },
  { value: "pending", label: "pending" },
  { value: "enrolled", label: "enrolled" },
  { value: "rejected", label: "rejected" },
  { value: "revoked", label: "revoked" },
  { value: "expired", label: "expired" },
];

function Pill({ children, tone = "default" }) {
  const tones = {
    default: "bg-gray-100 text-gray-700",
    ok: "bg-green-100 text-green-700",
    warn: "bg-yellow-100 text-yellow-800",
    bad: "bg-red-100 text-red-700",
  };
  const cls = tones[tone] || tones.default;
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs ${cls}`}>
      {children}
    </span>
  );
}

/* ------------ id helpers (cope with {_id}, ObjectId, string) ------------ */
const idStr = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return String(v._id || v.id || v);
  return String(v);
};

export default function AdminUsers() {
  const [rows, setRows] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupsByUser, setGroupsByUser] = useState({}); // { [userId]: string[] }
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  // ✅ Protected thumbs: fileId -> objectURL (kept until closeEdit)
  const [thumbUrlByFileId, setThumbUrlByFileId] = useState({});
  const thumbUrlByFileIdRef = useRef({});
  useEffect(() => {
    thumbUrlByFileIdRef.current = thumbUrlByFileId;
  }, [thumbUrlByFileId]);

  // filters / search
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [missingPhotoOnly, setMissingPhotoOnly] = useState(false);

  // show deleted
  const [showDeleted, setShowDeleted] = useState(false);

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

  // Enrollment helper modal
  const [enrollModal, setEnrollModal] = useState({
    open: false,
    user: null,
    token: "",
    enrollmentId: "",
    action: "",
  });

  // ✅ Biometric requests list (pending + approved are useful for UI)
  const [bioReqs, setBioReqs] = useState([]);
  const [bioReqsLoading, setBioReqsLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [q]);

  function statusTone(s) {
    const v = String(s || "").toLowerCase();
    if (v === "enrolled") return "ok";
    if (v === "pending") return "warn";
    if (v === "rejected" || v === "revoked") return "bad";
    return "default";
  }

  function reqTone(s) {
    const v = String(s || "").toLowerCase();
    if (v === "approved") return "ok";
    if (v === "pending") return "warn";
    if (v === "rejected") return "bad";
    return "default";
  }

  /* ----------------------- data loading ----------------------- */
  async function loadUsers() {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (missingPhotoOnly) params.set("missingPhoto", "true");
    if (showDeleted) params.set("includeDeleted", "1");
    const qs = params.toString() ? `?${params.toString()}` : "";
    const { data } = await api.get(`/users${qs}`);
    return Array.isArray(data) ? data : [];
  }

  async function loadGroups() {
    const { data } = await api.get("/groups?limit=1000");
    return Array.isArray(data) ? data : [];
  }

  function buildGroupsDict(gs) {
    const dict = {};
    for (const g of gs || []) {
      const gname = (g && g.name) || "";
      if (!gname) continue;

      for (const uid of g.memberUserIds || []) {
        const key = idStr(uid);
        if (!key) continue;
        if (!dict[key]) dict[key] = [];
        if (!dict[key].includes(gname)) dict[key].push(gname);
      }

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

  // ✅ Load requests (grab both pending + approved so header can show "approved" after you approve)
  async function loadBiometricRequests() {
    setBioReqsLoading(true);
    try {
      const { data } = await api.get(
        "/mobile/biometric-requests?status=all&limit=500",
      );
      const list = Array.isArray(data?.requests) ? data.requests : [];
      setBioReqs(list);
    } catch {
      setBioReqs([]);
    } finally {
      setBioReqsLoading(false);
    }
  }

  async function load() {
    setErr("");
    setInfo("");
    try {
      const [usersData, groupsData] = await Promise.all([
        loadUsers(),
        loadGroups(),
      ]);
      setRows(usersData);
      setGroups(groupsData);
      setGroupsByUser(buildGroupsDict(groupsData));
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  useEffect(() => {
    load();
    loadBiometricRequests();
  }, []);

  useEffect(() => {
    load();
  }, [statusFilter, missingPhotoOnly, showDeleted]);

  // Refresh requests whenever opening a user (or switching users)
  useEffect(() => {
    if (editUser && !editUser?.isDeleted) loadBiometricRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editUser?._id]);

  const filtered = useMemo(() => {
    const needle = qDeb;
    return (rows || []).filter((u) => {
      const roleOk =
        !roleFilter || String(u.role || "").toLowerCase() === roleFilter;
      if (!roleOk) return false;
      if (!needle) return true;
      const gList = groupsByUser[idStr(u._id || u.id)] || [];
      const hay =
        `${u.name || ""} ${u.email || u.username || ""} ${u.staffNumber || ""} ${u.role || ""} ${gList.join(" ")}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, qDeb, roleFilter, groupsByUser]);

  // Requests for selected user
  const reqsForEditUser = useMemo(() => {
    if (!editUser?._id) return [];
    const uid = idStr(editUser._id);
    return (bioReqs || []).filter((r) => idStr(r?.targetUserId) === uid);
  }, [bioReqs, editUser?._id]);

  const pendingReqsForEditUser = useMemo(() => {
    return (reqsForEditUser || []).filter(
      (r) => String(r?.status || "").toLowerCase() === "pending",
    );
  }, [reqsForEditUser]);

  // Most recent non-pending request (so after approve, header can show "approved")
  const latestNonPendingReq = useMemo(() => {
    const nonPending = (reqsForEditUser || []).filter(
      (r) => String(r?.status || "").toLowerCase() !== "pending",
    );
    if (!nonPending.length) return null;

    const score = (r) => {
      const d =
        r?.approvedAt ||
        r?.rejectedAt ||
        r?.updatedAt ||
        r?.createdAt ||
        r?.createdAtClient ||
        null;
      const t = d ? new Date(d).getTime() : 0;
      return Number.isFinite(t) ? t : 0;
    };

    return nonPending.sort((a, b) => score(b) - score(a))[0] || null;
  }, [reqsForEditUser]);

  // ✅ Fetch protected image blob (api already has auth headers)
  async function fetchThumbObjectUrl(fileId) {
    const res = await api.get(`/mobile/offline-files/${fileId}`, {
      responseType: "blob",
    });
    const blob = res?.data;
    if (!blob) throw new Error("No blob");
    return URL.createObjectURL(blob);
  }

  // Collect fileIds we may need:
  // - pending request thumbs (panel)
  // - plus one "profile candidate" image from either pending or latest approved request
  const fileIdsNeeded = useMemo(() => {
    const set = new Set();

    // pending panel
    for (const r of pendingReqsForEditUser || []) {
      const uploaded = Array.isArray(r?.uploadedFiles) ? r.uploadedFiles : [];
      for (const f of uploaded) {
        const fid = String(f?.fileId || "").trim();
        if (fid) set.add(fid);
      }
    }

    // profile candidate from latest request (pending OR approved)
    const chooseReq =
      pendingReqsForEditUser?.[0] || latestNonPendingReq || null;
    if (chooseReq) {
      const uploaded = Array.isArray(chooseReq?.uploadedFiles)
        ? chooseReq.uploadedFiles
        : [];
      const first = String(uploaded?.[0]?.fileId || "").trim();
      if (first) set.add(first);
    }

    return Array.from(set);
  }, [pendingReqsForEditUser, latestNonPendingReq]);

  // Fetch any missing objectURLs (DO NOT revoke on effect cleanup; we revoke on closeEdit)
  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!editUser?._id) return;
      if (!fileIdsNeeded.length) return;

      const missing = fileIdsNeeded.filter(
        (fid) => !thumbUrlByFileIdRef.current[fid],
      );
      if (!missing.length) return;

      const newMap = {};
      for (const fid of missing) {
        try {
          const url = await fetchThumbObjectUrl(fid);
          newMap[fid] = url;
        } catch {
          // ignore; we show a placeholder
        }
      }

      if (!cancelled && Object.keys(newMap).length) {
        setThumbUrlByFileId((prev) => ({ ...prev, ...newMap }));
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editUser?._id, fileIdsNeeded.join("|")]);

  // --- CSV template ---
  function downloadTemplate() {
    const csv = `name,email,username,staffNumber,role,groupName
Jane Doe,jane@example.com,jane,STA-1001,worker,Group A
John Dlamini,john@example.com,john,STA-1002,group-leader,Group A
`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "users-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- Create (single) ---
  async function createSingle(e) {
    e?.preventDefault?.();
    if (creating) return;
    setErr("");
    setInfo("");
    setCreating(true);
    try {
      const payload = {
        name: (createForm.name || "").trim(),
        email: (createForm.email || "").toLowerCase().trim() || undefined,
        username: (createForm.username || "").trim() || undefined,
        staffNumber: (createForm.staffNumber || "").trim() || undefined,
        role: createForm.role || "worker",
      };
      if (
        !payload.name ||
        (!payload.email && !payload.username && !payload.staffNumber)
      ) {
        setErr(
          "Name and at least one of Email, Username, or Staff Number is required.",
        );
        return;
      }
      if (createForm.tempPassword) payload.password = createForm.tempPassword;
      await api.post("/users", payload);
      setCreateForm({
        name: "",
        email: "",
        username: "",
        staffNumber: "",
        role: "worker",
        tempPassword: "",
      });
      setShowCreate(false);
      await load();
      setInfo("User created.");
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    } finally {
      setCreating(false);
    }
  }

  // --- Bulk upload ---
  async function doBulkUpload(e) {
    e?.preventDefault?.();
    if (!bulkFile) {
      setErr("Please choose a CSV or Excel file first.");
      return;
    }
    setErr("");
    setInfo("");
    setCreating(true);
    try {
      const fd = new FormData();
      fd.append("file", bulkFile);
      const { data } = await api.post("/users/bulk-upload", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setInfo(
        `Uploaded ${data?.created ?? 0} created, ${data?.updated ?? 0} updated.`,
      );
      setBulkFile(null);
      setShowCreate(false);
      await load();
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    } finally {
      setCreating(false);
    }
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

  function revokeAllThumbUrls() {
    try {
      const map = thumbUrlByFileIdRef.current || {};
      for (const k of Object.keys(map)) {
        const u = map[k];
        if (u) URL.revokeObjectURL(u);
      }
    } catch {
      // ignore
    }
  }

  function closeEdit() {
    setEditUser(null);
    revokeAllThumbUrls();
    setThumbUrlByFileId({});
    setEditForm({
      name: "",
      email: "",
      username: "",
      staffNumber: "",
      role: "worker",
      tempPassword: "",
    });
  }

  async function saveEdit(e) {
    e?.preventDefault?.();
    if (!editUser || editing) return;
    if (editUser?.isDeleted) {
      setErr("This user is deleted. Restore them before editing.");
      return;
    }
    setErr("");
    setInfo("");
    setEditing(true);
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
    } finally {
      setEditing(false);
    }
  }

  // --- Delete (soft) ---
  async function del(id) {
    if (!confirm("Delete this user? (soft delete)")) return;
    setErr("");
    setInfo("");
    try {
      await api.delete(`/users/${id}`);
      await load();
      setInfo("User deleted.");
      if (editUser && String(editUser._id) === String(id)) {
        const updated = { ...editUser, isDeleted: true, active: false };
        setEditUser(updated);
      }
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }

  // --- Restore (soft restore) ---
  async function restore(id) {
    setErr("");
    setInfo("");
    try {
      const { data } = await api.post(`/users/${id}/restore`);
      await load();
      setInfo("User restored.");
      if (editUser && String(editUser._id) === String(id)) {
        const restoredUser = data?.user || {
          ...editUser,
          isDeleted: false,
          active: true,
        };
        setEditUser(restoredUser);
        setEditForm({
          name: restoredUser.name || "",
          email: restoredUser.email || "",
          username: restoredUser.username || "",
          staffNumber: restoredUser.staffNumber || "",
          role: restoredUser.role || "worker",
          tempPassword: "",
        });
      }
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }

  // --- Biometrics actions ---
  async function startEnrollment(u) {
    try {
      setErr("");
      setInfo("");
      const { data } = await api.post(`/users/${u._id}/biometric/start`, {
        method: "self",
      });
      setEnrollModal({
        open: true,
        user: u,
        token: data?.token || "",
        enrollmentId: "",
        action: "started",
      });
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function approveRequestById(requestId) {
    if (!requestId) return;
    if (!confirm("Approve this biometric request?")) return;
    try {
      setErr("");
      setInfo("");
      const { data } = await api.post(
        `/mobile/biometric-requests/${requestId}/approve`,
      );
      await load();
      await loadBiometricRequests();
      setInfo(
        `Approved request. Enrollment: ${data?.enrollmentId || "—"} (photos: ${data?.photosCount ?? 0}).`,
      );
      // IMPORTANT: biometric.status remains "pending" until embeddings run; that's expected.
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function rejectRequestById(requestId) {
    if (!requestId) return;
    const reason = prompt("Reason for rejection (optional):") || "";
    if (!confirm("Reject this biometric request?")) return;
    try {
      setErr("");
      setInfo("");
      await api.post(`/mobile/biometric-requests/${requestId}/reject`, {
        reason,
      });
      await load();
      await loadBiometricRequests();
      setInfo("Request rejected.");
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function revokeEnrollment(u) {
    if (!confirm("Revoke biometric enrollment for this user?")) return;
    const reason = prompt("Reason for revoke (optional):") || "";
    try {
      await api.post(`/users/${u._id}/biometric/revoke`, { reason });
      await load();
      setInfo("Enrollment revoked.");
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }

  // ✅ Profile image in Edit view:
  // Prefer user.photo.url; otherwise use the first uploaded image from pending/approved request (so you never need “Set Photo”)
  const profileFallbackFileId = useMemo(() => {
    const chooseReq =
      pendingReqsForEditUser?.[0] || latestNonPendingReq || null;
    if (!chooseReq) return "";
    const uploaded = Array.isArray(chooseReq?.uploadedFiles)
      ? chooseReq.uploadedFiles
      : [];
    return String(uploaded?.[0]?.fileId || "").trim();
  }, [pendingReqsForEditUser, latestNonPendingReq]);

  const profileSrc = editUser?.photo?.url
    ? editUser.photo.url
    : profileFallbackFileId
      ? thumbUrlByFileId[profileFallbackFileId] || ""
      : "";

  // Request status pill shown in edit header (THIS is what changes to approved/rejected)
  const requestHeaderStatus = useMemo(() => {
    if (pendingReqsForEditUser.length) return "pending";
    const s = String(latestNonPendingReq?.status || "").toLowerCase();
    if (s === "approved") return "approved";
    if (s === "rejected") return "rejected";
    return "";
  }, [pendingReqsForEditUser.length, latestNonPendingReq]);

  return (
    <div className="max-w-7xl mx-auto p-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Admin • Users</h1>

        <div className="flex items-center gap-2 flex-wrap">
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
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>

          <select
            className="select select-bordered"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            title="Filter by biometric status"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value || "all"} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={missingPhotoOnly}
              onChange={(e) => setMissingPhotoOnly(e.target.checked)}
            />
            Missing Photo only
          </label>

          <label
            className="inline-flex items-center gap-2 text-sm"
            title="Include deleted users (admins/managers only)"
          >
            <input
              type="checkbox"
              checked={showDeleted}
              onChange={(e) => setShowDeleted(e.target.checked)}
            />
            Show deleted
          </label>

          <button
            className="btn btn-sm"
            onClick={downloadTemplate}
            title="Download CSV template"
          >
            Download CSV Template
          </button>

          <button
            className="btn btn-sm"
            onClick={() => {
              setShowCreate(true);
              setCreateTab("single");
            }}
          >
            New User
          </button>
        </div>
      </div>

      {err && <div className="text-red-600 mt-2">{err}</div>}
      {info && <div className="text-green-700 mt-2">{info}</div>}

      {/* Table (✅ removed Photo column) */}
      <div className="mt-3 overflow-x-auto rounded-xl border">
        <table className="table w-full">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th>Name</th>
              <th>Email / Username</th>
              <th>Staff #</th>
              <th>Role</th>
              <th>Groups</th>
              <th>Biometric</th>
              <th>Status</th>
              <th className="text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length ? (
              filtered.map((u) => {
                const status = u?.biometric?.status || "not-enrolled";
                const gNames = groupsByUser[idStr(u._id || u.id)] || [];
                const isDel = !!u?.isDeleted;

                return (
                  <tr key={u._id}>
                    <td className="align-top">
                      <div className="flex items-center gap-2">
                        <span>{u.name || "—"}</span>
                        {isDel && <Pill tone="bad">deleted</Pill>}
                      </div>
                    </td>

                    <td className="align-top">
                      {u.email || u.username || "—"}
                    </td>
                    <td className="align-top">{u.staffNumber || "—"}</td>
                    <td className="align-top">{u.role || "—"}</td>

                    <td className="align-top">
                      {gNames.length ? (
                        gNames.join(", ")
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>

                    <td className="align-top">
                      <Pill tone={statusTone(status)}>{status}</Pill>
                    </td>

                    <td className="align-top">
                      {u?.active === false ? (
                        <Pill tone="warn">inactive</Pill>
                      ) : (
                        <Pill tone="ok">active</Pill>
                      )}
                    </td>

                    <td className="text-right align-top">
                      <button
                        className="btn btn-sm"
                        onClick={() => openEdit(u)}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td className="p-4 text-gray-600" colSpan={8}>
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add Users"
      >
        <div className="space-y-3">
          <div className="inline-flex overflow-hidden rounded">
            <button
              className={`px-3 py-2 ${createTab === "single" ? "bg-black text-white" : ""}`}
              onClick={() => setCreateTab("single")}
              type="button"
            >
              Create Individually
            </button>
            <button
              className={`px-3 py-2 ${createTab === "bulk" ? "bg-black text-white" : ""}`}
              onClick={() => setCreateTab("bulk")}
              type="button"
            >
              Bulk Upload
            </button>
          </div>

          {createTab === "single" && (
            <form onSubmit={createSingle} className="grid gap-3 md:grid-cols-2">
              <label className="text-sm md:col-span-2">
                Name
                <input
                  className="border p-2 w-full"
                  value={createForm.name}
                  onChange={(e) =>
                    setCreateForm({ ...createForm, name: e.target.value })
                  }
                  required
                />
              </label>

              <label className="text-sm">
                Email
                <input
                  className="border p-2 w-full"
                  type="email"
                  value={createForm.email}
                  onChange={(e) =>
                    setCreateForm({ ...createForm, email: e.target.value })
                  }
                  placeholder="Optional if username or staff # is provided"
                />
              </label>

              <label className="text-sm">
                Username
                <input
                  className="border p-2 w-full"
                  value={createForm.username}
                  onChange={(e) =>
                    setCreateForm({ ...createForm, username: e.target.value })
                  }
                  placeholder="Optional if email or staff # is provided"
                />
              </label>

              <label className="text-sm">
                Staff #
                <input
                  className="border p-2 w-full"
                  value={createForm.staffNumber}
                  onChange={(e) =>
                    setCreateForm({
                      ...createForm,
                      staffNumber: e.target.value,
                    })
                  }
                  placeholder="Optional if email or username is provided"
                />
              </label>

              <label className="text-sm">
                Role
                <select
                  className="border p-2 w-full"
                  value={createForm.role}
                  onChange={(e) =>
                    setCreateForm({ ...createForm, role: e.target.value })
                  }
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-sm">
                Temp password (optional)
                <input
                  className="border p-2 w-full"
                  type="text"
                  placeholder="e.g. ChangeMe!23"
                  value={createForm.tempPassword}
                  onChange={(e) =>
                    setCreateForm({
                      ...createForm,
                      tempPassword: e.target.value,
                    })
                  }
                />
              </label>

              <div className="md:col-span-2 flex items-center gap-2 pt-1">
                <button
                  className="px-3 py-2 bg-black text-white rounded disabled:opacity-60"
                  disabled={creating}
                >
                  {creating ? "Creating…" : "Create User"}
                </button>
                <button
                  type="button"
                  className="px-3 py-2 border rounded"
                  onClick={() => setShowCreate(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {createTab === "bulk" && (
            <form onSubmit={doBulkUpload} className="space-y-2">
              <label className="text-sm block">
                Choose CSV/XLSX file
                <input
                  className="border p-2 w-full"
                  type="file"
                  accept=".csv, application/vnd.ms-excel, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(e) => setBulkFile(e.target.files?.[0] || null)}
                />
              </label>

              <div className="text-xs text-gray-600">
                Accepted columns: <code>name</code>, <code>email</code>,{" "}
                <code>username</code>, <code>staffNumber</code>,{" "}
                <code>role</code>, <code>groupName</code>.
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  className="px-3 py-2 bg-black text-white rounded disabled:opacity-60"
                  disabled={creating || !bulkFile}
                >
                  {creating ? "Uploading…" : "Upload"}
                </button>
                <button
                  type="button"
                  className="px-3 py-2 border rounded"
                  onClick={downloadTemplate}
                >
                  Download CSV Template
                </button>
                <button
                  type="button"
                  className="px-3 py-2 border rounded ml-auto"
                  onClick={() => setShowCreate(false)}
                >
                  Close
                </button>
              </div>
            </form>
          )}
        </div>
      </Modal>

      {/* Edit modal */}
      <Modal
        open={!!editUser}
        onClose={closeEdit}
        title={
          editUser
            ? `Edit User • ${editUser.name || editUser.email || editUser.username || editUser._id}${
                editUser.isDeleted ? " (DELETED)" : ""
              }`
            : "Edit User"
        }
        width={940}
      >
        {editUser && (
          <div className="grid gap-4">
            {/* ✅ User header (profile photo derived from biometric photos if needed) */}
            <div className="flex items-center gap-3">
              {profileSrc ? (
                <img
                  src={profileSrc}
                  alt=""
                  className="w-20 h-20 rounded-2xl object-cover border bg-white"
                />
              ) : (
                <div className="w-20 h-20 rounded-2xl bg-gray-200 grid place-items-center text-sm text-gray-600 border">
                  —
                </div>
              )}

              <div className="text-sm">
                <div className="font-semibold">{editUser.name || "—"}</div>
                <div className="text-gray-600">
                  {editUser.email || editUser.username || "—"}
                </div>

                <div className="mt-1 flex items-center gap-2">
                  {/* Biometric status (pending until embeddings exist) */}
                  <Pill
                    tone={statusTone(
                      editUser?.biometric?.status || "not-enrolled",
                    )}
                  >
                    {editUser?.biometric?.status || "not-enrolled"}
                  </Pill>

                  {/* ✅ Request status (this is what flips to approved/rejected immediately) */}
                  {requestHeaderStatus ? (
                    <Pill tone={reqTone(requestHeaderStatus)}>
                      request: {requestHeaderStatus}
                    </Pill>
                  ) : (
                    <Pill tone="default">request: none</Pill>
                  )}

                  {bioReqsLoading && (
                    <span className="text-xs text-gray-500">
                      Loading requests…
                    </span>
                  )}
                </div>

                {requestHeaderStatus === "approved" && (
                  <div className="mt-1 text-xs text-gray-600">
                    Approved: embeddings still need to run before status becomes{" "}
                    <strong>enrolled</strong>.
                  </div>
                )}
              </div>

              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => loadBiometricRequests()}
                >
                  Refresh Requests
                </button>
              </div>
            </div>

            {/* ✅ Pending biometric requests panel */}
            {!editUser.isDeleted && (
              <div className="border rounded-xl p-3 bg-white">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-sm">
                    Pending Biometric Requests{" "}
                    <span className="text-gray-500">
                      ({pendingReqsForEditUser.length})
                    </span>
                  </div>
                  <div className="text-xs text-gray-500">
                    Requests come from mobile offline sync and include uploaded
                    photos.
                  </div>
                </div>

                {pendingReqsForEditUser.length ? (
                  <div className="mt-3 space-y-3">
                    {pendingReqsForEditUser.map((r) => {
                      const rid = idStr(r?._id);
                      const uploaded = Array.isArray(r?.uploadedFiles)
                        ? r.uploadedFiles
                        : [];
                      const thumbs = uploaded
                        .map((f) => String(f?.fileId || "").trim())
                        .filter(Boolean)
                        .slice(0, 6);

                      return (
                        <div
                          key={rid}
                          className="border rounded-xl p-3 bg-gray-50"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Pill tone="warn">pending</Pill>
                            <div className="text-xs text-gray-700">
                              Request:{" "}
                              <code className="bg-white px-1 rounded">
                                {rid}
                              </code>
                            </div>
                            <div className="ml-auto flex items-center gap-2">
                              <button
                                type="button"
                                className="btn btn-sm btn-success"
                                onClick={() => approveRequestById(rid)}
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-error"
                                onClick={() => rejectRequestById(rid)}
                              >
                                Reject
                              </button>
                            </div>
                          </div>

                          <div className="mt-2 flex flex-wrap gap-2">
                            {thumbs.length ? (
                              thumbs.map((fid) => {
                                const src = thumbUrlByFileId[fid] || "";
                                return src ? (
                                  <img
                                    key={fid}
                                    src={src}
                                    alt=""
                                    className="w-20 h-20 rounded-xl object-cover border bg-white"
                                    title={fid}
                                  />
                                ) : (
                                  <div
                                    key={fid}
                                    className="w-20 h-20 rounded-xl border bg-gray-100 grid place-items-center text-xs text-gray-500"
                                    title={`Could not load ${fid}`}
                                  >
                                    …
                                  </div>
                                );
                              })
                            ) : (
                              <div className="text-xs text-gray-600">
                                No uploaded photos attached to this request.
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="mt-2 text-sm text-gray-600">
                    No pending biometric requests found for this user.
                  </div>
                )}
              </div>
            )}

            {/* Action strip (✅ removed Set Photo entirely) */}
            <div className="flex flex-wrap items-center gap-2 border rounded-xl p-3 bg-gray-50">
              <div className="text-sm text-gray-700 mr-2">Actions:</div>

              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setTarget({ ...editUser, id: editUser._id })}
              >
                Reset Password
              </button>

              {!editUser.isDeleted && (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => startEnrollment(editUser)}
                  >
                    Start Enroll
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => revokeEnrollment(editUser)}
                  >
                    Revoke
                  </button>
                </>
              )}

              <div className="ml-auto flex items-center gap-2">
                {!editUser.isDeleted ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-error"
                    onClick={() => del(editUser._id)}
                  >
                    Delete
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm btn-success"
                    onClick={() => restore(editUser._id)}
                    disabled={!showDeleted}
                    title={
                      !showDeleted
                        ? "Turn on 'Show deleted' in the header first"
                        : "Restore this user"
                    }
                  >
                    Restore
                  </button>
                )}
              </div>
            </div>

            {editUser.isDeleted && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
                This user is currently <strong>deleted</strong>. Restore them to
                edit details or manage biometrics.
              </div>
            )}

            {/* Edit form */}
            <form onSubmit={saveEdit} className="grid gap-3 md:grid-cols-2">
              <label className="text-sm md:col-span-2">
                Name
                <input
                  className="border p-2 w-full"
                  value={editForm.name}
                  onChange={(e) =>
                    setEditForm({ ...editForm, name: e.target.value })
                  }
                  required
                  disabled={!!editUser.isDeleted}
                />
              </label>

              <label className="text-sm md:col-span-2">
                Email
                <input
                  className="border p-2 w-full"
                  type="email"
                  value={editForm.email}
                  onChange={(e) =>
                    setEditForm({ ...editForm, email: e.target.value })
                  }
                  disabled={!!editUser.isDeleted}
                />
              </label>

              <label className="text-sm">
                Username
                <input
                  className="border p-2 w-full"
                  value={editForm.username}
                  onChange={(e) =>
                    setEditForm({ ...editForm, username: e.target.value })
                  }
                  disabled={!!editUser.isDeleted}
                />
              </label>

              <label className="text-sm">
                Staff #
                <input
                  className="border p-2 w-full"
                  value={editForm.staffNumber}
                  onChange={(e) =>
                    setEditForm({ ...editForm, staffNumber: e.target.value })
                  }
                  disabled={!!editUser.isDeleted}
                />
              </label>

              <label className="text-sm">
                Role
                <select
                  className="border p-2 w-full"
                  value={editForm.role}
                  onChange={(e) =>
                    setEditForm({ ...editForm, role: e.target.value })
                  }
                  disabled={!!editUser.isDeleted}
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-sm">
                Temp password (optional)
                <input
                  className="border p-2 w-full"
                  type="text"
                  placeholder="Set a new temporary password"
                  value={editForm.tempPassword}
                  onChange={(e) =>
                    setEditForm({ ...editForm, tempPassword: e.target.value })
                  }
                  disabled={!!editUser.isDeleted}
                />
              </label>

              <div className="md:col-span-2 flex items-center gap-2 pt-1">
                <button
                  className="px-3 py-2 bg-black text-white rounded disabled:opacity-60"
                  disabled={editing || !!editUser.isDeleted}
                  title={
                    editUser.isDeleted
                      ? "Restore the user first"
                      : "Save changes"
                  }
                >
                  {editing ? "Saving…" : "Save"}
                </button>

                <button
                  type="button"
                  className="px-3 py-2 border rounded"
                  onClick={closeEdit}
                >
                  Close
                </button>
              </div>
            </form>
          </div>
        )}
      </Modal>

      {/* Enrollment helper modal */}
      <Modal
        open={enrollModal.open}
        onClose={() =>
          setEnrollModal({
            open: false,
            user: null,
            token: "",
            enrollmentId: "",
            action: "",
          })
        }
        title="Enrollment Started"
      >
        <div className="space-y-2 text-sm">
          <div>
            Use this token in the mobile app to complete self-enrollment:
          </div>
          <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto">
            {enrollModal.token || "—"}
          </pre>
          <div className="text-gray-600">
            After the mobile submits, approve/reject in the Pending Requests
            panel inside the Edit modal.
          </div>
        </div>
      </Modal>

      {/* Reset password modal */}
      {target && (
        <ResetPasswordModal
          user={target}
          onClose={() => setTarget(null)}
          onDone={() => {
            setTarget(null);
            load();
          }}
        />
      )}
    </div>
  );
}
