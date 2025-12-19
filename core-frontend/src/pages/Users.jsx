// src/pages/Users.jsx
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api"; // <-- use shared axios (injects x-org-id etc.)

function Pill({ children }) {
  return (
    <span className="inline-block px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-700">
      {children}
    </span>
  );
}

/* --- tiny helpers --- */
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

export default function Users() {
  const [rows, setRows] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupsByUser, setGroupsByUser] = useState(new Map());
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setErr("");
    setLoading(true);
    try {
      // Use the shared axios client so Authorization + x-org-id are present
      const [uRes, gRes] = await Promise.all([
        api.get("/users", { params: { limit: 500 } }),
        api.get("/groups", { params: { limit: 1000 } }),
      ]);
      const users = Array.isArray(uRes.data) ? uRes.data : [];
      const gs = Array.isArray(gRes.data) ? gRes.data : [];
      setRows(users);
      setGroups(gs);

      // Build userId -> [group names]
      const map = new Map();
      for (const g of gs) {
        const gname = g?.name || "";
        // members
        (g?.memberUserIds || []).forEach((uid) => {
          const key = String(uid?._id || uid || "");
          if (!key) return;
          if (!map.has(key)) map.set(key, []);
          if (gname && !map.get(key).includes(gname)) map.get(key).push(gname);
        });
        // single leader semantics (support either leaderUserIds[0] or leaderUserId)
        const leaderId =
          (g?.leaderUserIds && g.leaderUserIds[0]) || g?.leaderUserId || null;
        if (leaderId) {
          const key = String(leaderId?._id || leaderId);
          if (key) {
            if (!map.has(key)) map.set(key, []);
            if (gname && !map.get(key).includes(gname)) map.get(key).push(gname);
          }
        }
      }
      setGroupsByUser(map);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Failed to load data");
      setRows([]);
      setGroups([]);
      setGroupsByUser(new Map());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Guard: don’t hit the API if no org is selected yet
    if (!getOrgId()) {
      setLoading(false);
      setErr(
        'No organisation selected. Please sign in (or pick an org) so requests include header "x-org-id".'
      );
      return;
    }
    load();
  }, []);

  // stable rows with attached group names for clean rendering
  const rowsWithGroups = useMemo(() => {
    return (rows || []).map((u) => {
      const g = groupsByUser.get(String(u._id || u.id)) || [];
      return { ...u, _groupNames: g };
    });
  }, [rows, groupsByUser]);

  return (
    <div className="max-w-7xl mx-auto p-4">
      <style>{`
        .card{ background:#fff; border:1px solid #e5e7eb; border-radius:12px; }
        .table{ width:100%; border-collapse:collapse; }
        .table th,.table td{ padding:.5rem; border-top:1px solid #eef2f7; text-align:left; }
      `}</style>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Users</h1>
        <div className="text-sm text-gray-600">Total: {rows.length}</div>
      </div>

      {err && <div className="text-red-600 mt-2">{err}</div>}
      {loading && <div className="mt-2">Loading…</div>}

      {!loading && !err && (
        <div className="card mt-3 overflow-x-auto">
          <table className="table text-sm">
            <thead>
              <tr style={{ background: "#f9fafb" }}>
                <th>Name</th>
                <th>Role</th>
                <th>Groups</th>
                <th>Email / Username</th>
                <th>Staff #</th>
                <th>Biometric</th>
              </tr>
            </thead>
            <tbody>
              {rowsWithGroups.length ? (
                rowsWithGroups.map((u) => (
                  <tr key={u._id || u.id}>
                    <td className="p-2">{u.name || "-"}</td>
                    <td className="p-2">{u.role || "-"}</td>
                    <td className="p-2">
                      {u._groupNames?.length ? (
                        u._groupNames.join(", ")
                      ) : (
                        <span className="text-gray-500">—</span>
                      )}
                    </td>
                    <td className="p-2">{u.email || u.username || "-"}</td>
                    <td className="p-2">{u.staffNumber || "-"}</td>
                    <td className="p-2">
                      <Pill>{u?.biometric?.status || "not-enrolled"}</Pill>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="p-4 text-center text-gray-600" colSpan={6}>
                    No users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
