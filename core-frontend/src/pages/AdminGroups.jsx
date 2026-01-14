// src/pages/AdminGroups.jsx
import React, { useEffect, useMemo, useState } from "react";
import { useTheme } from "../ThemeContext";
import { api } from "../lib/api"; // ✅ use shared axios client (adds x-org-id, auth, aliases)

/* ----------------------------- helpers ------------------------------------ */
const normId = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return String(v._id || v.id || v.userId || "");
  return "";
};

const getLeaderIdFromGroup = (g) =>
  normId(
    g?.leaderUserId ??
      g?.leaderId ??
      g?.groupLeaderUserId ??
      g?.groupLeaderId ??
      g?.leader?._id ??
      g?.leader?.id ??
      g?.leader
  );

const upsertLeaderFields = (userId) => {
  const v = userId || null; // null clears leader server-side
  return {
    leaderUserId: v,
    leaderId: v,
    groupLeaderUserId: v,
    groupLeaderId: v,
    leader: v,
  };
};

function userDisplay(u) {
  return u?.name || u?.email || u?.username || u?._id;
}

function getOrgId() {
  try {
    return (
      localStorage.getItem("currentOrgId") ||
      localStorage.getItem("orgId") ||
      sessionStorage.getItem("currentOrgId") ||
      sessionStorage.getItem("orgId") ||
      localStorage.getItem("tenantId") ||
      sessionStorage.getItem("tenantId") ||
      null
    );
  } catch {
    return null;
  }
}

// NEW: soft-delete detector (covers common shapes)
function isDeletedGroup(g) {
  if (!g) return false;
  if (g.deleted === true || g.isDeleted === true) return true;
  if (g.deletedAt || g.removedAt) return true;
  if (String(g.status || "").toLowerCase() === "deleted") return true;
  return false;
}

/* ----------------------------- UI bits ------------------------------------ */
function Chip({ children, tone = "default" }) {
  const style =
    tone === "danger"
      ? { background: "#fee2e2", borderColor: "#fecaca", color: "#991b1b" }
      : tone === "muted"
      ? { background: "#f1f5f9", borderColor: "#e2e8f0", color: "#475569" }
      : { background: "#f8fafc", borderColor: "#e2e8f0", color: "#0f172a" };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: "1px solid #e2e8f0",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        marginRight: 6,
        marginBottom: 6,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function Modal({ open, onClose, children, width = 760, title }) {
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "grid",
        placeItems: "center",
        zIndex: 50,
      }}
      onMouseDown={onClose}
    >
      <div
        style={{
          width,
          maxWidth: "95vw",
          background: "#fff",
          borderRadius: 12,
          boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
          padding: 20,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 12,
            alignItems: "center",
          }}
        >
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button onClick={onClose} aria-label="Close" style={{ fontSize: 18 }}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------ Main page --------------------------------- */
export default function AdminGroups() {
  const { org } = useTheme();

  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // NEW: show deleted toggle
  const [showDeleted, setShowDeleted] = useState(false);

  // modal state
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null); // group doc or null

  // editor fields
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [leaderUserId, setLeaderUserId] = useState("");
  const [memberUserIds, setMemberUserIds] = useState([]);

  // filters in editor
  const [leaderFilter, setLeaderFilter] = useState("");
  const [memberFilter, setMemberFilter] = useState("");

  function resetEditor(g = null) {
    setEditing(g);
    setName(g?.name || "");
    setDescription(g?.description || "");
    setLeaderUserId(getLeaderIdFromGroup(g));
    setMemberUserIds((g?.memberUserIds || []).map(String));
    setLeaderFilter("");
    setMemberFilter("");
  }

  async function loadAll(nextShowDeleted = showDeleted) {
    setLoading(true);
    setErr("");
    try {
      if (!getOrgId()) {
        setErr('No organisation selected. Please sign in (or pick an org) so requests include header "x-org-id".');
        setGroups([]);
        setUsers([]);
        return;
      }

      // NOTE:
      // Backends differ on how they expose soft-deleted data.
      // We pass a few common flags; unknown params are ignored safely.
      const groupsParams = {
        limit: 1000,
        includeDeleted: nextShowDeleted ? 1 : 0,
        withDeleted: nextShowDeleted ? 1 : 0,
        showDeleted: nextShowDeleted ? 1 : 0,
        deleted: nextShowDeleted ? 1 : 0,
        _ts: Date.now(),
      };

      const [gs, us] = await Promise.all([
        api.get("/groups", { params: groupsParams }),
        api.get("/users", { params: { limit: 2000, _ts: Date.now() } }),
      ]);

      const gRows = Array.isArray(gs.data) ? gs.data : Array.isArray(gs.data?.rows) ? gs.data.rows : [];
      setGroups(gRows);
      setUsers(Array.isArray(us.data) ? us.data : Array.isArray(us.data?.rows) ? us.data.rows : []);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Failed to load data");
      setGroups([]);
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    // Always hide deleted unless toggle is on (even if backend returns them)
    const base = showDeleted ? groups : groups.filter((g) => !isDeletedGroup(g));

    if (!q.trim()) return base;

    const re = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return base.filter((g) => re.test(g.name) || re.test(g.description || ""));
  }, [groups, q, showDeleted]);

  function userNameById(id) {
    const u = users.find((x) => String(x._id) === String(id));
    return userDisplay(u) || id;
  }

  const leaderCandidates = useMemo(() => {
    const needle = leaderFilter.trim().toLowerCase();
    if (!needle) return users;
    return users.filter((u) => userDisplay(u).toLowerCase().includes(needle));
  }, [users, leaderFilter]);

  const memberCandidates = useMemo(() => {
    const needle = memberFilter.trim().toLowerCase();
    if (!needle) return users;
    return users.filter((u) => userDisplay(u).toLowerCase().includes(needle));
  }, [users, memberFilter]);

  const toggleMember = (id) => {
    setMemberUserIds((prev) => {
      const s = new Set(prev.map(String));
      const key = String(id);
      if (s.has(key)) s.delete(key);
      else s.add(key);
      return Array.from(s);
    });
  };

  const selectFilteredMembers = () => {
    setMemberUserIds((prev) => {
      const s = new Set(prev.map(String));
      for (const u of memberCandidates) s.add(String(u._id));
      return Array.from(s);
    });
  };
  const clearFilteredMembers = () => {
    if (!memberFilter.trim()) {
      setMemberUserIds([]);
      return;
    }
    setMemberUserIds((prev) => {
      const s = new Set(prev.map(String));
      for (const u of memberCandidates) s.delete(String(u._id));
      return Array.from(s);
    });
  };

  async function saveGroup() {
    try {
      setErr("");

      // Ensure leader (if set) is in members
      const finalMemberIds = Array.from(
        new Set((memberUserIds || []).concat(leaderUserId ? [leaderUserId] : []).map(String))
      );

      if (editing?._id) {
        const id = editing._id;

        const putPayload = {
          name,
          description,
          memberUserIds: finalMemberIds,
          ...upsertLeaderFields(leaderUserId),
        };
        await api.put(`/groups/${id}`, putPayload);

        // ensure single-leader semantics (best-effort)
        try {
          await api.post(`/groups/${id}/leader`, {
            userId: leaderUserId || null,
            ...upsertLeaderFields(leaderUserId),
          });
        } catch {}
      } else {
        const createPayload = {
          name,
          description,
          memberUserIds: finalMemberIds,
          ...upsertLeaderFields(leaderUserId),
        };
        const created = await api.post("/groups", createPayload);

        try {
          await api.post(`/groups/${created.data?._id}/leader`, {
            userId: leaderUserId || null,
            ...upsertLeaderFields(leaderUserId),
          });
        } catch {}
      }

      await loadAll(showDeleted);
      setOpen(false);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Failed to save group");
    }
  }

  async function removeGroup(id) {
    if (!window.confirm("Delete this group? (soft delete)")) return;
    try {
      await api.delete(`/groups/${id}`);
      // If showing deleted, re-fetch so the now-deleted record can still appear.
      // If not showing deleted, remove from list for instant feedback.
      if (showDeleted) await loadAll(true);
      else setGroups((xs) => xs.filter((g) => String(g._id) !== String(id)));
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || "Failed to delete group");
    }
  }

  const accent = org?.accentColor || "#2a7fff";
  const deletedCount = useMemo(() => groups.filter(isDeletedGroup).length, [groups]);

  return (
    <div className="max-w-7xl mx-auto p-4" style={{ "--accent": accent }}>
      <style>{`
        .btn{border:1px solid #e5e7eb;border-radius:10px;padding:8px 12px;background:#fff}
        .btn:hover{box-shadow:0 1px 0 rgba(0,0,0,.04)}
        .btn-sm{padding:6px 10px;border-radius:8px}
        .btn-accent{background:var(--accent,#2a7fff);color:#fff;border-color:var(--accent,#2a7fff)}
        .btn-danger{background:#b91c1c;color:#fff;border-color:#7f1d1d}
        .btn-muted{background:#f1f5f9;border-color:#e2e8f0;color:#0f172a}
        .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px}
        .muted{color:#64748b}
      `}</style>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Groups</h1>

        <div className="flex items-center gap-2 flex-wrap">
          <input
            className="input input-bordered"
            style={{ minWidth: 240 }}
            placeholder="Search groups…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />

          {/* NEW: Show deleted toggle */}
          <button
            type="button"
            className={`btn btn-sm ${showDeleted ? "btn-accent" : "btn-muted"}`}
            title="Toggle showing soft-deleted groups"
            onClick={async () => {
              const next = !showDeleted;
              setShowDeleted(next);
              await loadAll(next);
            }}
          >
            {showDeleted ? "Showing deleted" : "Show deleted"}
            {deletedCount ? <span style={{ marginLeft: 6, opacity: 0.9 }}>({deletedCount})</span> : null}
          </button>

          <button
            className="btn btn-accent"
            onClick={() => {
              resetEditor(null);
              setOpen(true);
            }}
          >
            New Group
          </button>
        </div>
      </div>

      {err && <div className="text-red-600 mt-2">Error: {err}</div>}

      {loading ? (
        <div className="mt-3">Loading…</div>
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {filtered.map((g) => {
            const leaderId = getLeaderIdFromGroup(g);
            const memberCount = (g.memberUserIds || []).length;
            const deleted = isDeletedGroup(g);

            return (
              <div
                key={g._id}
                className="card"
                style={{
                  opacity: deleted ? 0.75 : 1,
                  borderStyle: deleted ? "dashed" : "solid",
                }}
              >
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-lg flex-1 m-0">
                    {g.name} {deleted ? <Chip tone="danger">Deleted</Chip> : null}
                  </h3>

                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      resetEditor(g);
                      setOpen(true);
                    }}
                    title={deleted ? "You can still view/edit, but it is deleted" : "Edit"}
                  >
                    Edit
                  </button>

                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => removeGroup(g._id)}
                    title={deleted ? "Already deleted (will try again)" : "Soft delete"}
                  >
                    Delete
                  </button>
                </div>

                {g.description && <p className="mt-2">{g.description}</p>}

                <div className="mt-2">
                  <strong>Group Leader:</strong>{" "}
                  {leaderId ? <>{userNameById(leaderId)}</> : <em className="muted">None</em>}
                </div>

                <div className="mt-2">
                  <strong>Members ({memberCount}):</strong>
                  <div className="mt-1">
                    {(g.memberUserIds || []).map((uid) => (
                      <Chip key={normId(uid)} tone={deleted ? "muted" : "default"}>
                        {userNameById(uid)}
                      </Chip>
                    ))}
                  </div>
                </div>

                {deleted ? (
                  <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                    This group is soft-deleted. Toggle “Show deleted” to view/hide these.
                  </div>
                ) : null}
              </div>
            );
          })}

          {!filtered.length && <div className="mt-3 muted">No groups yet.</div>}
        </div>
      )}

      {/* Editor modal */}
      <Modal open={open} onClose={() => setOpen(false)} title={editing?._id ? "Edit Group" : "Create Group"}>
        <div style={{ display: "grid", gap: 12 }}>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Team A"
              style={{
                width: "100%",
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid #e2e8f0",
              }}
            />
          </label>

          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Description</div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{
                width: "100%",
                padding: 10,
                borderRadius: 8,
                border: "1px solid #e2e8f0",
              }}
            />
          </label>

          {/* Leader (with filter) */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div style={{ fontSize: 12, marginBottom: 4 }}>Group Leader</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>Select any user (optional)</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 8, alignItems: "center" }}>
              <input
                placeholder="Filter users…"
                value={leaderFilter}
                onChange={(e) => setLeaderFilter(e.target.value)}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #e2e8f0",
                }}
              />
              <select
                value={leaderUserId || ""}
                onChange={(e) => setLeaderUserId(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #e2e8f0",
                }}
              >
                <option value="">(None)</option>
                {leaderCandidates.map((u) => (
                  <option key={u._id} value={u._id}>
                    {userDisplay(u)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Members (pills in grid + filter) */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div style={{ fontSize: 12, marginBottom: 6 }}>Members</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={selectFilteredMembers}
                  style={{
                    fontSize: 12,
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1px solid #e2e8f0",
                    background: "#f8fafc",
                  }}
                  title="Add all filtered users"
                >
                  Select filtered
                </button>
                <button
                  type="button"
                  onClick={clearFilteredMembers}
                  style={{
                    fontSize: 12,
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1px solid #e2e8f0",
                    background: "#f8fafc",
                  }}
                  title="Clear filtered (or all if no filter)"
                >
                  Clear
                </button>
              </div>
            </div>

            <input
              placeholder="Filter users…"
              value={memberFilter}
              onChange={(e) => setMemberFilter(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid #e2e8f0",
                marginBottom: 8,
              }}
            />

            <div
              className="pill-grid"
              style={{
                maxHeight: 260,
                overflow: "auto",
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                padding: 10,
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 8,
              }}
            >
              {memberCandidates.map((u) => {
                const id = String(u._id);
                const active = memberUserIds.some((x) => String(x) === id);
                return (
                  <button
                    type="button"
                    key={id}
                    className={`pill ${active ? "active" : ""}`}
                    onClick={() => toggleMember(id)}
                    title={userDisplay(u)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      border: "1px solid #e2e8f0",
                      padding: "6px 10px",
                      borderRadius: 9999,
                      fontSize: 13,
                      cursor: "pointer",
                      background: active ? "var(--accent,#2a7fff)" : "#fff",
                      color: active ? "#fff" : "#111827",
                      justifyContent: "space-between",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-block",
                        maxWidth: 180,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        textAlign: "left",
                      }}
                    >
                      {userDisplay(u)}
                    </span>
                    {active && <span>✓</span>}
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 6, fontSize: 12, color: "#64748b" }}>Selected: {memberUserIds.length}</div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button onClick={() => setOpen(false)} style={{ padding: "8px 12px", borderRadius: 10 }} type="button">
              Cancel
            </button>
            <button
              onClick={saveGroup}
              className="btn"
              style={{
                padding: "8px 12px",
                borderRadius: 10,
                background: "var(--accent,#2a7fff)",
                color: "#fff",
                borderColor: "var(--accent,#2a7fff)",
              }}
              disabled={!name.trim()}
              type="button"
            >
              {editing?._id ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
