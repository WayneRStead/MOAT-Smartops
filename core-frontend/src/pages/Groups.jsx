// src/pages/Groups.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

/* ---- helpers: tolerant leader read/write ---- */
const first = (a) => (Array.isArray(a) && a.length ? a[0] : "");
const normId = (v) =>
  !v ? "" : typeof v === "string" ? v : String(v._id || v.id || v.userId || "");

const getLeaderIdFromGroup = (g) =>
  // preferred field is an array:
  normId(first(g?.leaderUserIds)) ||
  // legacy/single fields:
  normId(g?.leaderUserId) ||
  normId(g?.leaderId) ||
  normId(g?.groupLeaderUserId) ||
  normId(g?.groupLeaderId) ||
  normId(g?.leader);

/** Set a single leader by replacing the array. Clears when uid is falsy. */
async function setSingleLeader(groupId, uid) {
  // best: replace array with one value (or empty to clear)
  try {
    await api.put(`/groups/${groupId}`, {
      leaderUserIds: uid ? [uid] : [],
    });
    return;
  } catch (e) {
    // fallback: use the helper endpoint; clear then add to emulate "set"
    try {
      // clear
      await api.post(`/groups/${groupId}/leader`, { userId: null });
      if (uid) await api.post(`/groups/${groupId}/leader`, { userId: uid });
    } catch (e2) {
      throw e2 || e;
    }
  }
}

export default function Groups() {
  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ name: "", description: "" });

  async function load() {
    setErr("");
    try {
      const [g, u] = await Promise.all([
        api.get("/groups"),
        api.get("/users", { params: { limit: 2000 } }), // allow ANY user to be selected as leader
      ]);
      setGroups(Array.isArray(g.data) ? g.data : []);
      setUsers(Array.isArray(u.data) ? u.data : []);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function create(e) {
    e?.preventDefault?.();
    setErr("");
    try {
      await api.post("/groups", { name: form.name, description: form.description });
      setForm({ name: "", description: "" });
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function addMember(gid, uid) {
    try {
      await api.post(`/groups/${gid}/members`, { userId: uid });
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function removeMember(gid, uid) {
    try {
      await api.delete(`/groups/${gid}/members/${uid}`);
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function setLeader(gid, uidOrNull) {
    setErr("");
    try {
      await setSingleLeader(gid, uidOrNull || null);
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function delGroup(gid) {
    if (!window.confirm("Delete group?")) return;
    try {
      await api.delete(`/groups/${gid}`);
      load();
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  const userMap = useMemo(
    () => Object.fromEntries(users.map((u) => [String(u._id), u])),
    [users]
  );
  const userLabel = (id) => {
    const u = userMap[String(id)];
    return u ? u.name || u.email || u.username || id : id;
  };

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">Groups</h1>
      {err && <div className="text-red-600">{err}</div>}

      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input
          className="border p-2"
          placeholder="Group name"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
        <input
          className="border p-2"
          placeholder="Description"
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        />
        <button className="px-3 py-2 border rounded">Create</button>
      </form>

      <div className="grid md:grid-cols-2 gap-3">
        {groups.map((g) => {
          const leaderId = getLeaderIdFromGroup(g);
          return (
            <div key={g._id} className="border rounded p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{g.name}</div>
                  <div className="text-sm text-gray-600">{g.description || "—"}</div>
                </div>
                <button className="px-2 py-1 border rounded" onClick={() => delGroup(g._id)}>
                  Delete
                </button>
              </div>

              <div className="mt-2 text-sm">
                Leader:&nbsp;
                <select
                  className="border p-1"
                  value={leaderId || ""}
                  onChange={(e) => setLeader(g._id, e.target.value || null)}
                  title={leaderId ? `Current: ${userLabel(leaderId)}` : "No leader"}
                >
                  <option value="">— none —</option>
                  {/* ANY user can be selected as leader */}
                  {users.map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.name || u.email || u.username || u._id}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-2">
                <div className="text-sm font-medium">Members</div>
                <div className="flex flex-wrap gap-2 mt-1">
                  {(g.memberUserIds || []).map((uid) => (
                    <span
                      key={uid}
                      className="inline-flex items-center gap-1 border rounded px-2 py-1 text-sm"
                    >
                      {userLabel(uid)}
                      <button
                        className="text-red-700"
                        onClick={() => removeMember(g._id, uid)}
                        title="Remove"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <select className="border p-2" id={`add-${g._id}`}>
                    {users
                      .filter(
                        (u) =>
                          !(g.memberUserIds || []).some(
                            (id) => String(id) === String(u._id)
                          )
                      )
                      .map((u) => (
                        <option key={u._id} value={u._id}>
                          {u.name || u.email || u._id}
                        </option>
                      ))}
                  </select>
                  <button
                    className="px-3 py-2 border rounded"
                    onClick={() => {
                      const el = document.getElementById(`add-${g._id}`);
                      if (el?.value) addMember(g._id, el.value);
                    }}
                  >
                    Add member
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
