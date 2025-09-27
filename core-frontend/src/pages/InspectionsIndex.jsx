// src/pages/InspectionsIndex.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, getProject } from "../lib/api";

// quick task fetcher (kept local to avoid changing lib/api right now)
async function getTask(taskId) {
  try { const { data } = await api.get(`/tasks/${taskId}`); return data || null; } catch { return null; }
}

// derive status: failed if ANY answer is "fail"
function deriveOutcome(sub) {
  const failed = Array.isArray(sub.answers) && sub.answers.some(a => a?.result === "fail" || a?.pass === false);
  return failed ? "Failed" : "Passed";
}

export default function InspectionsIndex() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // name caches
  const [projects, setProjects] = useState({});
  const [tasks, setTasks] = useState({});

  useEffect(() => {
    let alive = true;
    (async () => {
      setErr(""); setLoading(true);
      try {
        const { data } = await api.get("/inspections/submissions", { params: { limit: 200 } });
        if (!alive) return;
        setRows(Array.isArray(data) ? data : []);
      } catch (e) {
        if (!alive) return;
        setErr(e?.response?.data?.error || e?.message || "Failed to load inspections");
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  // fetch project/task names lazily for anything we don't have cached
  useEffect(() => {
    let alive = true;
    (async () => {
      const needP = new Set();
      const needT = new Set();
      rows.forEach(r => {
        if (r.projectId && !projects[String(r.projectId)]) needP.add(String(r.projectId));
        if (r.taskId && !tasks[String(r.taskId)]) needT.add(String(r.taskId));
      });

      // projects
      for (const pid of needP) {
        try {
          const p = await getProject(pid);
          if (!alive) return;
          setProjects(prev => ({ ...prev, [pid]: p?.name || p?.title || pid }));
        } catch {
          if (!alive) return;
          setProjects(prev => ({ ...prev, [pid]: pid }));
        }
      }
      // tasks
      for (const tid of needT) {
        try {
          const t = await getTask(tid);
          if (!alive) return;
          setTasks(prev => ({ ...prev, [tid]: t?.title || t?.name || tid }));
        } catch {
          if (!alive) return;
          setTasks(prev => ({ ...prev, [tid]: tid }));
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const list = useMemo(() => {
    return rows.map(r => ({
      id: r._id || r.id,
      template: r.templateTitle || r.templateName || "Inspection",
      submittedAt: r.submittedAt ? new Date(r.submittedAt) : null,
      projectName: r.projectId ? (projects[String(r.projectId)] || r.projectId) : "—",
      taskName: r.taskId ? (tasks[String(r.taskId)] || r.taskId) : "—",
      inspector: r.actor?.email || r.actor?.name || r.actor?.userId || "—",
      outcome: deriveOutcome(r),
    }));
  }, [rows, projects, tasks]);

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Recent Inspections</h1>
        <Link className="px-3 py-2 border rounded" to="/inspections/forms">Run a form</Link>
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {loading && <div className="text-gray-600">Loading…</div>}

      {!loading && list.length === 0 && (
        <div className="text-gray-600">No inspections yet.</div>
      )}

      {list.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full border">
            <thead className="bg-gray-50">
              <tr className="[&>th]:p-2 [&>th]:text-left [&>th]:text-sm [&>th]:font-medium">
                <th>When</th>
                <th>Result</th>
                <th>Form</th>
                <th>Project</th>
                <th>Task</th>
                <th>Inspector</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="[&>tr>td]:p-2 [&>tr>td]:text-sm">
              {list.map((r) => (
                <tr key={r.id} className="border-t">
                  <td>{r.submittedAt ? r.submittedAt.toLocaleString() : "—"}</td>
                  <td>
                    <span className={`px-2 py-1 rounded text-xs border ${r.outcome === "Failed"
                      ? "bg-red-50 text-red-700 border-red-200"
                      : "bg-green-50 text-green-700 border-green-200"
                    }`}>
                      {r.outcome}
                    </span>
                  </td>
                  <td>{r.template}</td>
                  <td>{r.projectName}</td>
                  <td>{r.taskName}</td>
                  <td>{r.inspector}</td>
                  <td>
                    <Link className="px-2 py-1 border rounded" to={`/inspections/submissions/${r.id}`}>
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
