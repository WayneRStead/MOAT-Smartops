// core-frontend/src/pages/AdminInspectionSubmissions.jsx
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listSubmissions } from "../lib/inspectionApi.js";

const SUBJECT_TYPES = [
  { key: "", label: "All subjects" },
  { key: "none", label: "General" },
  { key: "vehicle", label: "Vehicle" },
  { key: "asset", label: "Asset" },
  { key: "performance", label: "Performance" },
];

function Chip({ children, tone = "muted" }) {
  const cls =
    tone === "ok"
      ? "bg-green-50 border-green-200 text-green-700"
      : tone === "bad"
      ? "bg-red-50 border-red-200 text-red-700"
      : "bg-gray-50 border-gray-200 text-gray-700";
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded border ${cls}`}>
      {children}
    </span>
  );
}

export default function AdminInspectionSubmissions() {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState({
    projectId: "",
    taskId: "",
    milestoneId: "",
    subjectType: "",   // NEW
    subjectId: "",     // NEW
  });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = async () => {
    setErr("");
    setLoading(true);
    try {
      const params = {};
      if (q.projectId) params.projectId = q.projectId.trim();
      if (q.taskId) params.taskId = q.taskId.trim();
      if (q.milestoneId) params.milestoneId = q.milestoneId.trim();
      if (q.subjectType) params.subjectType = q.subjectType.trim().toLowerCase(); // backend expects lower
      if (q.subjectId) params.subjectId = q.subjectId.trim();
      const data = await listSubmissions(params);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.message || "Failed to load submissions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* initial */ }, []);

  const countText = useMemo(() => {
    const n = rows.length || 0;
    return n === 1 ? "1 result" : `${n} results`;
  }, [rows.length]);

  const subjectBadge = (s) => {
    const t = s?.subjectAtRun?.type || "none";
    const label = s?.subjectAtRun?.label || "";
    const id = s?.subjectAtRun?.id || "";
    if (t === "vehicle") {
      return <Chip>{`Vehicle: ${label || id || "-"}`}</Chip>;
    }
    if (t === "asset") {
      return <Chip>{`Asset: ${label || id || "-"}`}</Chip>;
    }
    if (t === "performance") {
      return <Chip>{`User: ${label || id || "-"}`}</Chip>;
    }
    return <Chip>General</Chip>;
  };

  const scoringBadges = (s) => {
    const sc = s?.scoringSummary;
    if (!sc) return null;
    const c = sc.counts || {};
    const pct =
      typeof sc.percentScore === "number"
        ? Math.round(sc.percentScore)
        : null;
    return (
      <div className="flex flex-wrap gap-1 mt-1">
        {pct != null && <Chip tone={pct >= 100 ? "ok" : pct >= 50 ? "muted" : "bad"}>{`Score: ${pct}%`}</Chip>}
        <Chip>{`Pass: ${c.pass ?? 0}/${c.considered ?? 0}`}</Chip>
        {((c.fail ?? 0) > 0) && <Chip tone="bad">{`Fail: ${c.fail}`}</Chip>}
        {(c.criticalFails ?? 0) > 0 && <Chip tone="bad">{`Critical: ${c.criticalFails}`}</Chip>}
      </div>
    );
  };

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Inspection Submissions</h1>
        <div className="flex items-center gap-2">
          <button className="btn btn-ghost btn-sm" onClick={load}>Reload</button>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border p-3 grid gap-2 sm:grid-cols-6">
        <input
          className="input input-bordered"
          placeholder="Project ID"
          value={q.projectId}
          onChange={(e) => setQ({ ...q, projectId: e.target.value })}
        />
        <input
          className="input input-bordered"
          placeholder="Task ID"
          value={q.taskId}
          onChange={(e) => setQ({ ...q, taskId: e.target.value })}
        />
        <input
          className="input input-bordered"
          placeholder="Milestone ID"
          value={q.milestoneId}
          onChange={(e) => setQ({ ...q, milestoneId: e.target.value })}
        />

        {/* NEW: subjectType + subjectId */}
        <select
          className="select select-bordered"
          value={q.subjectType}
          onChange={(e) => setQ({ ...q, subjectType: e.target.value })}
        >
          {SUBJECT_TYPES.map((opt) => (
            <option key={opt.key} value={opt.key}>{opt.label}</option>
          ))}
        </select>

        <input
          className="input input-bordered"
          placeholder={q.subjectType ? `${q.subjectType} id…` : "Subject ID…"}
          value={q.subjectId}
          onChange={(e) => setQ({ ...q, subjectId: e.target.value })}
          disabled={!q.subjectType}
        />

        <div className="flex gap-2">
          <button className="btn" onClick={load}>Apply</button>
          <button
            className="btn btn-ghost"
            onClick={() => { setQ({ projectId:"", taskId:"", milestoneId:"", subjectType:"", subjectId:"" }); }}
          >
            Clear
          </button>
        </div>
      </div>

      {loading && <div>Loading…</div>}
      {err && <div className="text-red-600">{err}</div>}

      <div className="rounded-xl border">
        <div className="p-3 font-medium flex items-center justify-between">
          <span>Results</span>
          <span className="text-sm text-gray-600">{countText}</span>
        </div>
        <div className="divide-y">
          {rows.length === 0 && (
            <div className="p-3 text-sm text-gray-500">No submissions found.</div>
          )}
          {rows.map((s) => {
            const when = s.createdAt ? new Date(s.createdAt).toLocaleString() : "-";
            const overallTone = s.overallResult === "pass" ? "text-green-600" : "text-red-600";
            const signed = s?.signoff?.confirmed === true;

            return (
              <div key={s._id} className="p-3 grid gap-3 sm:grid-cols-6 items-start">
                {/* Title + meta */}
                <div className="sm:col-span-3">
                  <div className="font-medium">{s.formTitle}</div>
                  <div className="text-xs text-gray-500">
                    {when} • {s.runBy?.name || s.runBy?.email || "-"}
                  </div>

                  {/* Subject badge + scoring chips */}
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    {subjectBadge(s)}
                    {signed ? <Chip tone="ok">Signed</Chip> : <Chip tone="bad">Not signed</Chip>}
                  </div>
                  {scoringBadges(s)}
                </div>

                {/* Overall */}
                <div className={`text-sm font-semibold ${overallTone}`}>
                  {s.overallResult?.toUpperCase() || "-"}
                </div>

                {/* Links (IDs; names are not returned in list API) */}
                <div className="text-xs text-gray-700">
                  <div>P: {s.links?.projectId || "—"}</div>
                  <div>T: {s.links?.taskId || "—"}</div>
                  <div>M: {s.links?.milestoneId || "—"}</div>
                </div>

                {/* Actions */}
                <div className="flex justify-end items-start">
                  <Link className="btn btn-sm" to={`/inspections/submissions/${s._id}`}>View</Link>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
