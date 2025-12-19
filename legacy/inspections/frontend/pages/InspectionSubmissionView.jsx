// src/pages/InspectionView.jsx
import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, getOrg, getProject } from "../lib/api";

async function getTask(taskId) {
  try { const { data } = await api.get(`/tasks/${taskId}`); return data || null; } catch { return null; }
}
function pill(result) {
  const base = "px-2 py-1 rounded text-xs border";
  if (result === "fail") return `${base} bg-red-50 text-red-700 border-red-200`;
  if (result === "na")   return `${base} bg-amber-50 text-amber-700 border-amber-200`;
  return `${base} bg-green-50 text-green-700 border-green-200`;
}

export default function InspectionView() {
  const { id } = useParams();
  const [sub, setSub] = useState(null);
  const [org, setOrg] = useState(null);
  const [projectName, setProjectName] = useState("");
  const [taskName, setTaskName] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      setErr("");
      try {
        const [{ data: s }, { logoUrl, name }] = await Promise.all([
          api.get(`/inspections/submissions/${id}`),
          getOrg().catch(() => ({})),
        ]);
        if (!alive) return;
        setSub(s);
        setOrg({ name, logoUrl });

        if (s?.projectId) {
          try {
            const p = await getProject(s.projectId);
            if (!alive) return;
            setProjectName(p?.name || p?.title || String(s.projectId));
          } catch { setProjectName(String(s.projectId)); }
        }
        if (s?.taskId) {
          try {
            const t = await getTask(s.taskId);
            if (!alive) return;
            setTaskName(t?.title || t?.name || String(s.taskId));
          } catch { setTaskName(String(s.taskId)); }
        }
      } catch (e) {
        if (!alive) return;
        setErr(e?.response?.data?.error || e?.message || "Failed to load inspection");
      }
    })();
    return () => { alive = false; };
  }, [id]);

  if (err) return <div className="p-4 text-red-600">{err}</div>;
  if (!sub) return <div className="p-4 text-gray-600">Loading…</div>;

  const submittedAt = sub.submittedAt ? new Date(sub.submittedAt).toLocaleString() : "—";
  const startedAt = sub.startedAt ? new Date(sub.startedAt).toLocaleString() : "—";
  const inspector = sub.actor?.email || sub.actor?.name || sub.actor?.userId || "—";

  return (
    <div className="print-container p-4 space-y-4">
      {/* toolbar (hidden when printing) */}
      <div className="no-print flex items-center gap-2">
        <Link to="/inspections" className="px-3 py-2 border rounded">Back</Link>
        <button className="px-3 py-2 border rounded" onClick={() => window.print()}>Print / Export</button>
      </div>

      {/* header */}
      <div className="flex items-center justify-center">
        {org?.logoUrl ? (
          <img src={org.logoUrl} alt={org?.name || "Org"} style={{ height: 56 }} />
        ) : (
          <div className="text-xl font-semibold">{org?.name || "Organisation"}</div>
        )}
      </div>
      <h1 className="text-2xl font-bold text-center">{sub.templateTitle || "Inspection"}</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 border rounded p-3">
        <div><span className="font-medium">Submitted:</span> {submittedAt}</div>
        <div><span className="font-medium">Project:</span> {projectName || "—"}</div>
        <div><span className="font-medium">Task:</span> {taskName || "—"}</div>
        {sub.milestoneId && (
          <div><span className="font-medium">Milestone:</span> {sub.milestoneId}</div>
        )}
        <div><span className="font-medium">Inspector:</span> {inspector}</div>
        <div><span className="font-medium">Status:</span> {sub.status || "submitted"}</div>
        <div><span className="font-medium">Started:</span> {startedAt}</div>
      </div>

      {/* items */}
      <div className="space-y-4">
        {Array.isArray(sub.answers) && sub.answers.map((a, i) => (
          <div key={i} className="border rounded p-3">
            <div className="flex items-center justify-between">
              <div className="font-medium">{a.label || `Item ${i + 1}`}</div>
              <div className={pill(a.result || (a.pass === false ? "fail" : "pass"))}>
                {(a.result || (a.pass === false ? "fail" : "pass"))?.toUpperCase?.() || "—"}
              </div>
            </div>

            {/* Additional free text (if provided) */}
            {a.extraText ? (
              <div className="mt-2 text-sm">
                <span className="font-medium">Note:</span> {a.extraText}
              </div>
            ) : null}

            {/* Value (number/text) */}
            {a.value != null && String(a.value).trim() !== "" && (
              <div className="mt-2 text-sm">
                <span className="font-medium">Value:</span> {String(a.value)}
              </div>
            )}

            {/* Scans */}
            {Array.isArray(a.scans) && a.scans.length > 0 && (
              <div className="mt-2 text-sm">
                <div className="font-medium mb-1">Scans:</div>
                <ul className="list-disc ml-5">
                  {a.scans.map((s, j) => (
                    <li key={j}>
                      [{s.type || "code"}] {s.value} {s.at ? `· ${new Date(s.at).toLocaleString()}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Photos */}
            {Array.isArray(a.photos) && a.photos.length > 0 && (
              <div className="mt-2">
                <div className="font-medium text-sm mb-1">Photos:</div>
                <div className="flex flex-wrap gap-2">
                  {a.photos.map((p, j) => (
                    <img
                      key={j}
                      src={p.dataUrl || p.url}
                      alt={p.name || `photo-${j}`}
                      style={{ width: 160, height: 120, objectFit: "cover", borderRadius: 6, border: "1px solid #ddd" }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Corrective action (failure note) */}
            {a.note && (
              <div className="mt-2 text-sm">
                <div className="font-medium">Corrective action:</div>
                <div className="border rounded p-2 mt-1 bg-gray-50">{a.note}</div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* PM note & signoff */}
      {sub.managerNote && (
        <div className="space-y-2">
          <div className="font-medium">Project manager note:</div>
          <div className="border rounded p-2 bg-gray-50">{sub.managerNote}</div>
        </div>
      )}

      <div className="mt-6 border-t pt-3">
        <div className="font-medium">Inspector sign off:</div>
        <div className="text-sm text-gray-700">I confirm the above is accurate to the best of my knowledge.</div>
        <div className="text-sm mt-2"><span className="font-medium">Inspector:</span> {inspector}</div>
        <div className="text-sm"><span className="font-medium">Submitted:</span> {submittedAt}</div>
      </div>

      {/* print helpers */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-container { margin: 0; padding: 0; }
          img { page-break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}
