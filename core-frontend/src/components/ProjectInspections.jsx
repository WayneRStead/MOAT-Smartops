// core-frontend/src/components/ProjectInspections.jsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listSubmissions } from "../lib/inspectionApi.js";

export default function ProjectInspections({ projectId }) {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      setErr("");
      try {
        if (!projectId) return setRows([]);
        const data = await listSubmissions({ projectId, limit: 50 });
        setRows(Array.isArray(data) ? data : []);
      } catch (e) {
        setErr(e?.message || "Failed to load project inspections");
      }
    })();
  }, [projectId]);

  if (!projectId) return null;

  return (
    <div className="rounded-xl border mt-6">
      <div className="p-3 font-medium">Project Inspections</div>
      {err && <div className="px-3 pb-2 text-red-600">{err}</div>}
      <div className="divide-y">
        {rows.length === 0 && <div className="p-3 text-sm text-gray-500">No submissions yet.</div>}
        {rows.map((s) => (
          <div key={s._id} className="p-3 grid gap-3 sm:grid-cols-5 items-center">
            <div className="sm:col-span-2">
              <div className="font-medium">{s.formTitle}</div>
              <div className="text-xs text-gray-500">
                {new Date(s.createdAt).toLocaleString()} • {s.runBy?.name || "-"}
              </div>
            </div>
            <div className={`text-sm ${s.overallResult === "pass" ? "text-green-600" : "text-red-600"}`}>
              {s.overallResult?.toUpperCase() || "-"}
            </div>
            <div className="text-xs">
              T: {s.links?.taskId || "-"} • M: {s.links?.milestoneId || "-"}
            </div>
            <div className="flex justify-end">
              <Link className="btn btn-sm" to={`/inspections/submissions/${s._id}`}>View</Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
