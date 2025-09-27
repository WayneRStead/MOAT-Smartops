// src/pages/AdminGroups.jsx
import React, { useEffect, useMemo, useState } from "react";

/* ----------------------------- tiny API helper ----------------------------- */
function getToken() {
  return (
    localStorage.getItem("jwt") ||
    localStorage.getItem("token") ||
    sessionStorage.getItem("jwt") ||
    sessionStorage.getItem("token") ||
    ""
  );
}
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ----------------------------- UI components ------------------------------ */

function Chip({ children }) {
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
        background: "#f8fafc",
      }}
    >
      {children}
    </span>
  );
}

function Modal({ open, onClose, children, width = 640, title }) {
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
          maxWidth: "90vw",
          background: "#fff",
          borderRadius: 12,
          boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
          padding: 20,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button onClick={onClose} aria-label="Close" style={{ fontSize: 18 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------ Main page --------------------------------- */

export default function AdminGroups() {
  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // modal state
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null); // group doc or null

  // editor fields
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [leaderUserId, setLeaderUserId] = useState("");
  const [memberUserIds, setMemberUserIds] = useState([]);

  function resetEditor(g = null) {
    setEditing(g);
    setName(g?.name || "");
    setDescription(g?.description || "");
    setLeaderUserId(g?.leaderUserId || "");
    setMemberUserIds(g?.memberUserIds || []);
  }

  async function loadAll() {
    setLoading(true);
    setErr("");
    try {
      const [gs, us] = await Promise.all([
        api("GET", "/api/groups?limit=1000"),
        api("GET", "/api/users?limit=1000"), // admin will see all; non-admin will just see visible
      ]);
      setGroups(gs || []);
      setUsers(us || []);
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  const filtered = useMemo(() => {
    if (!q.trim()) return groups;
    const re = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return groups.filter((g) => re.test(g.name) || re.test(g.description || ""));
  }, [groups, q]);

  function userName(id) {
    const u = users.find((x) => String(x._id) === String(id));
    return u ? (u.name || u.email || u.username || u._id) : id;
  }

  async function saveGroup() {
    try {
      setErr("");
      const payload = {
        name,
        description,
        leaderUserId: leaderUserId || undefined,
        memberUserIds,
      };
      if (editing?._id) {
        const saved = await api("PUT", `/api/groups/${editing._id}`, payload);
        setGroups((xs) => xs.map((g) => (String(g._id) === String(saved._id) ? saved : g)));
      } else {
        const created = await api("POST", "/api/groups", payload);
        setGroups((xs) => [created, ...xs]);
      }
      setOpen(false);
    } catch (e) {
      setErr(String(e.message || e));
    }
  }

  async function removeGroup(id) {
    if (!window.confirm("Delete this group? (soft delete)")) return;
    try {
      await api("DELETE", `/api/groups/${id}`);
      setGroups((xs) => xs.filter((g) => String(g._id) !== String(id)));
    } catch (e) {
      alert(e.message || e);
    }
  }

  async function addMember(g, uid) {
    try {
      const updated = await api("POST", `/api/groups/${g._id}/members`, { userId: uid });
      setGroups((xs) => xs.map((x) => (String(x._id) === String(g._id) ? updated : x)));
    } catch (e) {
      alert(e.message || e);
    }
  }

  async function removeMember(g, uid) {
    try {
      const updated = await api("DELETE", `/api/groups/${g._id}/members/${uid}`);
      setGroups((xs) => xs.map((x) => (String(x._id) === String(g._id) ? updated : x)));
    } catch (e) {
      alert(e.message || e);
    }
  }

  async function setLeader(g, uid) {
    try {
      const updated = await api("POST", `/api/groups/${g._id}/leader`, { userId: uid || null });
      setGroups((xs) => xs.map((x) => (String(x._id) === String(g._id) ? updated : x)));
    } catch (e) {
      alert(e.message || e);
    }
  }

  return (
    <div style={{ padding: 20 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, flex: 1 }}>Groups</h2>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search groups…"
          style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #e2e8f0", minWidth: 220 }}
        />
        <button
          onClick={() => { resetEditor(null); setOpen(true); }}
          style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #0ea5e9", background: "#0ea5e9", color: "#fff" }}
        >
          + New Group
        </button>
      </header>

      {err && <div style={{ color: "#b91c1c", marginBottom: 12 }}>Error: {err}</div>}
      {loading ? (
        <div>Loading…</div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {filtered.map((g) => (
            <div key={g._id} style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <h3 style={{ margin: 0, flex: 1 }}>{g.name}</h3>
                <button onClick={() => { resetEditor(g); setOpen(true); }} style={{ padding: "6px 10px", borderRadius: 8 }}>Edit</button>
                <button onClick={() => removeGroup(g._id)} style={{ padding: "6px 10px", borderRadius: 8, color: "#b91c1c" }}>
                  Delete
                </button>
              </div>

              {g.description && <p style={{ marginTop: 8 }}>{g.description}</p>}

              <div style={{ marginTop: 8 }}>
                <strong>Leader:</strong>{" "}
                {g.leaderUserId ? (
                  <>
                    {userName(g.leaderUserId)}{" "}
                    <button onClick={() => setLeader(g, null)} style={{ marginLeft: 8, fontSize: 12 }}>Clear</button>
                  </>
                ) : (
                  <em>None</em>
                )}
              </div>

              <div style={{ marginTop: 8 }}>
                <strong>Members ({(g.memberUserIds || []).length}):</strong>
                <div style={{ marginTop: 6 }}>
                  {(g.memberUserIds || []).map((uid) => (
                    <Chip key={uid}>
                      {userName(uid)}
                      <button
                        onClick={() => removeMember(g, uid)}
                        title="Remove"
                        style={{ marginLeft: 6, border: "none", background: "transparent", cursor: "pointer" }}
                      >
                        ×
                      </button>
                    </Chip>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select
                  onChange={(e) => setLeader(g, e.target.value)}
                  defaultValue=""
                  style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #e2e8f0" }}
                >
                  <option value="">— Set Leader —</option>
                  {users.map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.name || u.email || u.username}
                    </option>
                  ))}
                </select>

                <select
                  onChange={(e) => {
                    const uid = e.target.value;
                    if (uid) addMember(g, uid);
                    e.target.value = "";
                  }}
                  defaultValue=""
                  style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #e2e8f0" }}
                >
                  <option value="">— Add Member —</option>
                  {users
                    .filter((u) => !(g.memberUserIds || []).some((m) => String(m) === String(u._id)))
                    .map((u) => (
                      <option key={u._id} value={u._id}>
                        {u.name || u.email || u.username}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          ))}

          {!filtered.length && <div style={{ opacity: 0.7 }}>No groups yet.</div>}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing?._id ? "Edit Group" : "Create Group"}
      >
        <div style={{ display: "grid", gap: 10 }}>
          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Team A"
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #e2e8f0" }}
            />
          </label>

          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Description</div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #e2e8f0" }}
            />
          </label>

          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Leader</div>
            <select
              value={leaderUserId || ""}
              onChange={(e) => setLeaderUserId(e.target.value)}
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #e2e8f0" }}
            >
              <option value="">(None)</option>
              {users.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.name || u.email || u.username}
                </option>
              ))}
            </select>
          </label>

          <label>
            <div style={{ fontSize: 12, marginBottom: 4 }}>Members</div>
            <div
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                padding: 10,
                maxHeight: 210,
                overflow: "auto",
              }}
            >
              {users.map((u) => {
                const id = String(u._id);
                const checked = memberUserIds.some((x) => String(x) === id);
                return (
                  <label key={id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) setMemberUserIds((xs) => Array.from(new Set([...xs, id])));
                        else setMemberUserIds((xs) => xs.filter((x) => String(x) !== id));
                      }}
                    />
                    <span>{u.name || u.email || u.username}</span>
                  </label>
                );
              })}
            </div>
          </label>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button onClick={() => setOpen(false)} style={{ padding: "8px 12px", borderRadius: 10 }}>
              Cancel
            </button>
            <button
              onClick={saveGroup}
              style={{ padding: "8px 12px", borderRadius: 10, background: "#16a34a", color: "#fff", border: "1px solid #16a34a" }}
              disabled={!name.trim()}
            >
              {editing?._id ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
