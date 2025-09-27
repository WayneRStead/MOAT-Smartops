// src/components/TaskVisibilityPanel.jsx
import React, { useEffect, useState } from "react";
import { api } from "../lib/api";

export default function TaskVisibilityPanel({ taskId, value, onSaved }) {
  // value shape expected from API:
  // { visibilityMode: 'all'|'assigned'|'custom',
  //   assignedUserIds: [], assignedGroupIds: [] }
  const [mode, setMode] = useState(value?.visibilityMode || "all");
  const [userIds, setUserIds] = useState(value?.assignedUserIds || []);
  const [groupIds, setGroupIds] = useState(value?.assignedGroupIds || []);

  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  useEffect(() => {
    setMode(value?.visibilityMode || "all");
    setUserIds(value?.assignedUserIds || []);
    setGroupIds(value?.assignedGroupIds || []);
  }, [value]);

  useEffect(() => {
    (async () => {
      try {
        const [{ data: us }, { data: gs }] = await Promise.all([
          api.get("/users", { params: { limit: 1000 } }),
          api.get("/groups"),
        ]);
        setUsers(Array.isArray(us) ? us : []);
        setGroups(Array.isArray(gs) ? gs : []);
      } catch { /* soft-fail */ }
    })();
  }, []);

  function toggle(setter, arr, id) {
    const s = new Set((arr || []).map(String));
    const k = String(id);
    s.has(k) ? s.delete(k) : s.add(k);
    setter(Array.from(s));
  }

  async function save() {
    setErr(""); setInfo("");
    try {
      const body = { visibilityMode: mode };
      if (mode !== "all") {
        body.assignedUserIds = userIds;
        body.assignedGroupIds = groupIds;
      }
      const { data } = await api.put(`/tasks/${taskId}`, body);
      setInfo("Visibility saved");
      setTimeout(()=>setInfo(""), 900);
      onSaved?.(data);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  const isRestricted = mode !== "all";

  return (
    <div className="border rounded p-3 space-y-3">
      <div className="font-semibold">Visibility</div>
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {info && <div className="text-green-700 text-sm">{info}</div>}

      <div className="flex gap-3 items-center text-sm">
        <label className="inline-flex items-center gap-2">
          <input type="radio" name="vis" checked={mode === "all"} onChange={()=>setMode("all")} />
          <span>All users in my org</span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="radio" name="vis" checked={mode === "assigned"} onChange={()=>setMode("assigned")} />
          <span>Only assigned users</span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="radio" name="vis" checked={mode === "custom"} onChange={()=>setMode("custom")} />
          <span>Custom (users + groups)</span>
        </label>
      </div>

      {isRestricted && (
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <div className="text-sm font-medium mb-1">Users</div>
            <div className="grid grid-cols-1 gap-1 max-h-56 overflow-auto pr-1">
              {users.map(u => {
                const checked = userIds.map(String).includes(String(u._id));
                const label = u.name || u.email || u.username || String(u._id);
                return (
                  <label key={u._id} className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={checked} onChange={()=>toggle(setUserIds, userIds, u._id)} />
                    <span>{label}</span>
                  </label>
                );
              })}
            </div>
          </div>
          <div>
            <div className="text-sm font-medium mb-1">Groups</div>
            <div className="grid grid-cols-1 gap-1 max-h-56 overflow-auto pr-1">
              {groups.map(g => {
                const checked = groupIds.map(String).includes(String(g._id));
                return (
                  <label key={g._id} className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={checked} onChange={()=>toggle(setGroupIds, groupIds, g._id)} />
                    <span>{g.name || g._id}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="text-right">
        <button className="px-3 py-2 border rounded" onClick={save}>Save visibility</button>
      </div>
    </div>
  );
}
