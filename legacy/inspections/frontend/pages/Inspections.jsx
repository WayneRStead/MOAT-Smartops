// src/pages/Inspections.jsx
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, getOrg, listProjects, listProjectTasks, listTaskMilestones } from "../lib/api";

function fmt(d) { return d ? new Date(d).toLocaleString() : "—"; }
function chip(result) {
  const r = String(result || "").toLowerCase();
  if (r === "pass") return <span className="chip chip-pass">PASS</span>;
  if (r === "fail") return <span className="chip chip-fail">FAIL</span>;
  return <span className="chip chip-na">N/A</span>;
}

export default function Inspections() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [org, setOrg] = useState(null);
  const [names, setNames] = useState({ project: "", task: "", milestone: "" });
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [{ data: s }, orgData] = await Promise.all([
          api.get(`/inspections/submissions/${id}`),
          getOrg().catch(()=>null),
        ]);
        if (!alive) return;
        setData(s);
        setOrg(orgData);

        // Resolve names
        let projectName = "", taskName = "", milestoneName = "";
        try {
          if (s.projectId) {
            const ps = await listProjects({ limit: 1000 });
            projectName = ps.find(p => String(p._id||p.id) === String(s.projectId))?.name || "";
          }
          if (s.taskId && s.projectId) {
            const ts = await listProjectTasks(s.projectId, { limit: 1000 });
            taskName = ts.find(t => String(t._id||t.id) === String(s.taskId))?.title || "";
          }
          if (s.milestoneId) {
            const ms = await listTaskMilestones(s.taskId);
            milestoneName = (ms || []).find(m => String(m.id) === String(s.milestoneId))?.name || "";
          }
        } catch {}
        setNames({ project: projectName, task: taskName, milestone: milestoneName });
      } catch (e) {
        setErr(e?.response?.data?.error || e?.message || "Failed to load inspection");
      }
    })();
    return () => { alive = false; };
  }, [id]);

  const counts = useMemo(() => {
    const a = data?.answers || [];
    let pass = 0, fail = 0, na = 0;
    for (const x of a) {
      const r = String(x.result || "").toLowerCase();
      if (r === "pass") pass++;
      else if (r === "fail") fail++;
      else na++;
    }
    return { pass, fail, na, total: a.length };
  }, [data]);

  if (!data) {
    return (
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between no-print">
          <h1 className="text-xl font-semibold">Inspection</h1>
          <button className="px-3 py-2 border rounded" onClick={()=>nav(-1)}>Back</button>
        </div>
        {err ? <div className="text-red-600">{err}</div> : <div className="text-gray-600">Loading…</div>}
      </div>
    );
  }

  const title = data.templateTitle || "Inspection";
  const inspector = data.actor?.email || data.actor?.name || "—";
  const overall = counts.fail > 0 ? "Fail" : "Pass";

  return (
    <div className="p-4 print-container space-y-4">
      {/* top bar hidden in print */}
      <div className="no-print flex items-center justify-between">
        <button className="px-3 py-2 border rounded" onClick={()=>nav(-1)}>Back</button>
        <div className="flex items-center gap-2">
          <button className="px-3 py-2 border rounded" onClick={()=>window.print()}>Print / Export</button>
        </div>
      </div>

      {/* print-only watermark */}
      <div className="print-watermark">Powered by MOAT</div>

      {/* printable header (logo centered) */}
      <div className="print-header text-center space-y-2">
        {org?.logo ? (
          <img src={org.logo} alt="Org logo" style={{ height: 48, objectFit: "contain", margin: "0 auto" }} />
        ) : (
          <div className="text-xl font-semibold">{org?.name || "Organization"}</div>
        )}
        <div className="text-2xl font-bold">{title}</div>
      </div>

      {/* screen header (kept tidy) */}
      <div className="screen-header">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{title}</h1>
          {org?.logo && <img src={org.logo} alt="Org logo" style={{ height: 36, objectFit: "contain" }} />}
        </div>
      </div>

      {/* meta grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div><span className="font-semibold">Submitted:</span> {fmt(data.submittedAt)}</div>
        <div><span className="font-semibold">Project:</span> {names.project || data.projectId || "—"}</div>
        <div><span className="font-semibold">Task:</span> {names.task || data.taskId || "—"}</div>
        <div><span className="font-semibold">Milestone:</span> {names.milestone || data.milestoneId || "—"}</div>
        <div><span className="font-semibold">Inspector:</span> {inspector}</div>
        <div><span className="font-semibold">Status:</span> {overall}</div>
        <div><span className="font-semibold">Started:</span> {fmt(data.startedAt)}</div>
      </div>

      {/* summary */}
      <div className="text-sm text-gray-700">
        Checklist <span className="chip chip-pass">Pass {counts.pass}</span> · <span className="chip chip-fail">Fail {counts.fail}</span> · <span className="chip chip-na">N/A {counts.na}</span>
      </div>

      {/* items */}
      <div className="space-y-4">
        {(data.answers || []).map((a, i) => (
          <div key={a.fieldId || i} className="border rounded p-3 space-y-2 print-break-avoid">
            <div className="flex items-start justify-between gap-3">
              <div className="font-semibold">{i+1}. {a.label}</div>
              {chip(a.result)}
            </div>

            {/* Note (rename "Additional" → "Note") */}
            {a.extraText ? (
              <div><span className="font-semibold">Note:</span> {a.extraText}</div>
            ) : null}

            {/* Corrective action */}
            {String(a.result).toLowerCase() === "fail" && (a.note || a.photos?.length || a.scans?.length) ? (
              <div className="space-y-1">
                <div className="font-semibold">Corrective action:</div>
                {a.note ? <div className="whitespace-pre-wrap">{a.note}</div> : null}
              </div>
            ) : null}

            {/* Evidence: scans */}
            {(a.scans || []).length ? (
              <div className="text-sm">
                <div className="font-semibold">Evidence — Scan:</div>
                {(a.scans || []).map((s, idx)=>(
                  <div key={idx}>Scan: {s.value}</div>
                ))}
              </div>
            ) : null}

            {/* Evidence: photos */}
            {(a.photos || []).length ? (
              <div>
                <div className="font-semibold">Evidence — Photos:</div>
                <div className="flex flex-wrap gap-2 mt-2">
                  {a.photos.map((p, idx)=>(
                    <img key={idx} src={p.dataUrl || p.url} alt={p.name || `photo-${idx}`} style={{ width: 140, height: 100, objectFit: "cover", borderRadius: 8, border: "1px solid #ddd" }} />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* PM note + Sign-off */}
      <div className="space-y-3">
        <div>
          <div className="font-semibold">Project manager note</div>
          <div className="border rounded p-3 min-h-[60px]">{data.managerNote || "—"}</div>
        </div>

        <div className="space-y-1">
          <div className="font-semibold">Inspector Sign-off</div>
          <div className="text-sm text-gray-700 italic">
            I confirm the above is accurate to the best of my knowledge.
          </div>
          <div className="text-sm"><span className="font-semibold">Name:</span> {inspector}</div>
          <div className="text-sm"><span className="font-semibold">Date:</span> {fmt(data.submittedAt)}</div>
        </div>

        <div className="text-xs text-gray-500 text-center pt-2">
          © {new Date().getFullYear()} {org?.name || "Your Organization"} · Inspection powered by MOAT Technologies
        </div>
      </div>
    </div>
  );
}
