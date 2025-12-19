// core-frontend/src/pages/InspectionRun.jsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { getForm, runForm } from "../lib/inspectionApi.js";

const ROLE_RANK = {
  "user": 0,
  "group-leader": 1,
  "project-manager": 2,
  "manager": 3,
  "admin": 4,
  "superadmin": 5,
};
const MIN_PERF_RANK = ROLE_RANK["group-leader"];

function normalizeRole(r) {
  if (!r) return "user";
  const s = String(r).trim().toLowerCase().replace(/\s+/g, "-");
  if (s === "users") return "user";
  return ROLE_RANK.hasOwnProperty(s) ? s : "user";
}
function maxUserRank(u) {
  const primary = normalizeRole(u?.role);
  const extras = Array.isArray(u?.roles) ? u.roles.map(normalizeRole) : [];
  const all = [primary, ...extras];
  return Math.max(...all.map((r) => ROLE_RANK[r] ?? 0));
}

export default function InspectionRun() {
  const { formId, id } = useParams();
  const realId = formId || id;
  const nav = useNavigate();
  const me = (window.__CURRENT_USER__ || {});

  const [form, setForm] = useState(null);
  const [rows, setRows] = useState([]); // one per item
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  // org branding
  const [orgName, setOrgName] = useState("");
  const [orgLogoUrl, setOrgLogoUrl] = useState("");

  // scope links + human names
  const [links, setLinks] = useState({ projectId: "", taskId: "", milestoneId: "" });
  const [names, setNames] = useState({ project: "", task: "", milestone: "" });

  // subject (general / vehicle / asset / performance)
  const [subjectType, setSubjectType] = useState("none");
  const [subjectLocked, setSubjectLocked] = useState({ id: undefined, label: "" });
  const [subjectOptions, setSubjectOptions] = useState([]); // [{id,label}]
  const [subjectId, setSubjectId] = useState("");
  const [subjectLabel, setSubjectLabel] = useState("");

  // signoff
  const [confirmed, setConfirmed] = useState(false);
  const [signName, setSignName] = useState(me.name || me.email || "");
  const [signature, setSignature] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");

  // geolocation (auto-capture for KMZ/export)
  const [gps, setGps] = useState({ lat: null, lng: null, accuracy: null, ts: null, error: "" }); // kept harmless
  const [geo, setGeo] = useState({ lat: null, lng: null, accuracy: null, at: null });
  const [geoErr, setGeoErr] = useState("");

  // ensure inspector name from user/token
  useEffect(() => {
    if (String(signName || "").trim()) return;
    const u = (window.__CURRENT_USER__ || {});
    if (u.name || u.email) {
      setSignName(u.name || u.email);
      return;
    }
    try {
      const tok = localStorage.getItem("token");
      if (tok && tok.split(".").length === 3) {
        const payload = JSON.parse(atob(tok.split(".")[1] || ""));
        if (payload?.name || payload?.email) {
          setSignName(payload.name || payload.email);
        }
      }
    } catch {}
  }, [signName]);

  // ---------- load form ----------
  useEffect(() => {
    (async () => {
      setErr("");
      try {
        const f = await getForm(realId);
        setForm(f);

        // Subject meta (General/Vehicle/Asset/Performance + lock info)
        const st = String(f?.subject?.type || "none").toLowerCase();
        setSubjectType(st);
        if (st !== "none" && (f?.subject?.lockToId ?? "") !== "") {
          setSubjectLocked({ id: f.subject.lockToId, label: f.subject.lockLabel || "" });
          setSubjectId(String(f.subject.lockToId));
          setSubjectLabel(f.subject.lockLabel || "");
        } else {
          setSubjectLocked({ id: undefined, label: "" });
          setSubjectId("");
          setSubjectLabel("");
        }

        // If scoped, lock to form scope and fetch readable names when missing
        if (f?.scope?.type === "scoped") {
          const nextLinks = {
            projectId: f.scope.projectId || "",
            taskId: f.scope.taskId || "",
            milestoneId: f.scope.milestoneId || "",
          };
          setLinks(nextLinks);
          setNames({
            project: f.scope.projectName || "",
            task: f.scope.taskName || "",
            milestone: f.scope.milestoneName || "",
          });
          backfillNames(nextLinks);
        } else {
          const initialProject = new URLSearchParams(window.location.search).get("projectId") || "";
          setLinks({ projectId: initialProject, taskId: "", milestoneId: "" });
        }

        // rows (compact defaults)
        setRows(
          (f.items || []).map((it) => ({
            itemId: it._id, // IMPORTANT for backend validation
            label: it.label || "",
            allowPhoto: !!it.allowPhoto,
            allowScan: !!it.allowScan,
            allowNote: it.allowNote !== false,
            requireEvidenceOnFail: !!it.requireEvidenceOnFail,
            requireCorrectiveOnFail: it.requireCorrectiveOnFail !== false,
            criticalOnFail: !!it.criticalOnFail,
            result: "", // no default selected (so % is based on answered)
            evidence: { photoUrl: "", scanRef: "", note: "" },
            correctiveAction: "",
          }))
        );
      } catch (e) {
        setErr(e?.message || "Failed to load form");
      }
    })();

    // org branding, best-effort
    resolveOrgBranding().then(({ name, logo }) => {
      if (name) setOrgName(name);
      if (logo) setOrgLogoUrl(logo);
    });

    // kick off initial geolocation capture
    captureGeo(setGeo, setGeoErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realId]);

  // ---------- global pickers ----------
  useEffect(() => {
    if (!form || form?.scope?.type === "scoped") return;
    (async () => {
      try {
        const { data } = await api.get("/projects", { params: { limit: 500 } });
        setProjects(Array.isArray(data) ? data : []);
      } catch { setProjects([]); }
    })();
  }, [form]);

  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [milestones, setMilestones] = useState([]);

  useEffect(() => {
    if (!links.projectId) { setTasks([]); setMilestones([]); return; }
    (async () => {
      try {
        const { data } = await api.get("/tasks", { params: { projectId: links.projectId, limit: 1000 } });
        setTasks(Array.isArray(data) ? data : []);
      } catch {
        try {
          const { data } = await api.get(`/projects/${links.projectId}/tasks`);
          setTasks(Array.isArray(data) ? data : []);
        } catch { setTasks([]); }
      }
    })();
  }, [links.projectId]);

  useEffect(() => {
    if (!links.taskId) { setMilestones([]); return; }
    (async () => {
      try {
        const { data } = await api.get(`/tasks/${links.taskId}/milestones`);
        setMilestones(Array.isArray(data) ? data : []);
      } catch { setMilestones([]); }
    })();
  }, [links.taskId]);

  // ------- subject options (vehicle/asset/performance) filtered by current links/scope -------
  useEffect(() => {
    const st = subjectType;
    if (!form || st === "none") { setSubjectOptions([]); return; }

    const activeLinks = form?.scope?.type === "scoped"
      ? { projectId: form.scope.projectId, taskId: form.scope.taskId, milestoneId: form.scope.milestoneId }
      : links;

    // do not load options if locked
    if (subjectLocked.id) { setSubjectOptions([]); return; }

    (async () => {
      const opts = await loadSubjectOptions(st, activeLinks);
      setSubjectOptions(opts);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, subjectType, subjectLocked.id, links.projectId, links.taskId, links.milestoneId]);

  // ---------- helpers ----------
  const setRow = (i, patch) => setRows(prev => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const chooseResult = (i, result) => setRow(i, { result });

  const anyFail = useMemo(() => rows.some((r) => r.result === "fail"), [rows]);

  function labelOf(x){ return x?.name || x?.title || x?.label || x?.reg || x?.code || ""; }
  function niceCase(s){
    const t = String(s||"").toLowerCase();
    if (t === "signoff") return "Sign-off";
    if (t === "standard") return "Standard";
    return t.replace(/[-_]/g, " ").replace(/\b\w/g, m => m.toUpperCase());
  }
  // Human-readable scoring rule
  function ruleLabel(sc){
    const mode = String(sc?.mode || 'any-fail');
    if (mode === 'percent'){
      const pct = Math.max(0, Math.min(100, parseInt(sc?.minPassPercent ?? 100, 10)));
      return `≥ ${pct}% Pass (critical fail auto-fail)`;
    }
    if (mode === 'tolerance'){
      const n = Math.max(0, parseInt(sc?.maxNonCriticalFails ?? 0, 10));
      const plural = n === 1 ? '' : 's';
      return `Up to ${n} non-critical FAIL${plural} allowed (critical auto-fail)`;
    }
    return 'Any FAIL ⇒ overall FAIL (critical auto-fail)';
  }

  // Metrics + Achieved label (percent + tolerance context)
  const metrics = useMemo(() => {
    const applicable = rows.filter(r => {
      const v = (r.result || '').toLowerCase();
      return v !== 'na' && v !== "" ;
    });
    const totalApplicable = applicable.length;
    const passCount = applicable.filter(r => r.result === 'pass').length;
    const nonCriticalFailCount = applicable.filter(r => r.result === 'fail' && !r.criticalOnFail).length;
    const percent = totalApplicable ? (passCount / totalApplicable) * 100 : 100;
    return { totalApplicable, passCount, nonCriticalFailCount, percent };
  }, [rows]);

  const achievedLabel = useMemo(() => {
    const sc = form?.scoring || {};
    const pct = (Math.round(metrics.percent * 10) / 10).toFixed(1);
    if (String(sc.mode || 'any-fail') === 'tolerance') {
      const max = Number.isFinite(+sc.maxNonCriticalFails) ? +sc.maxNonCriticalFails : 0;
      return `${pct}% • Non-critical fails ${metrics.nonCriticalFailCount}/${max}`;
    }
    return `${pct}%`;
  }, [form?.scoring, metrics.percent, metrics.nonCriticalFailCount]);

  async function backfillNames({ projectId, taskId, milestoneId }){
    try {
      if (projectId && !names.project) {
        const { data } = await api.get(`/projects/${projectId}`);
        setNames((n)=>({ ...n, project: labelOf(data) || String(projectId) }));
      }
    } catch {}
    try {
      if (taskId && !names.task) {
        const { data } = await api.get(`/tasks/${taskId}`);
        setNames((n)=>({ ...n, task: labelOf(data) || String(taskId) }));
      }
    } catch {}
    try {
      if (taskId && milestoneId && !names.milestone) {
        const { data } = await api.get(`/tasks/${taskId}/milestones`);
        const m = (Array.isArray(data)?data:[]).find(x => String(x._id||x.id) === String(milestoneId));
        setNames((n)=>({ ...n, milestone: labelOf(m) || String(milestoneId) }));
      }
    } catch {}
  }

  // Per-item requirement issues (for inline warnings + global banner)
  const issues = useMemo(() => {
    return rows.map(r => {
      const msgs = [];
      if (r.result === "fail") {
        const hasAny =
          !!(r.evidence?.photoUrl || r.evidence?.scanRef || (r.evidence?.note && r.evidence.note.trim()));
        if (r.requireEvidenceOnFail && !hasAny) msgs.push("Evidence required");
        if (r.requireCorrectiveOnFail && !String(r.correctiveAction || "").trim()) msgs.push("Corrective action required");
      }
      return msgs;
    });
  }, [rows]);

  const hasIssues = useMemo(() => issues.some(arr => arr.length > 0), [issues]);
  const issueCount = useMemo(() => issues.reduce((n, arr) => n + (arr.length ? 1 : 0), 0), [issues]);

  const needsSubject =
    subjectType !== "none" &&
    !subjectLocked.id &&
    !String(subjectId || "").trim();

  function canSubmit(){
    if(!form) return false;
    if(!confirmed) return false;
    if(!String(signName||"").trim()) return false;
    if(hasIssues) return false;
    if(needsSubject) return false;
    return true;
  }

  async function onSubmit(){
    if(!canSubmit()) return;
    setSaving(true); setErr("");
    try{
      // Build a location object once and spread to multiple fields for compatibility
      const loc =
        (geo.lat != null && geo.lng != null)
          ? { lat: geo.lat, lng: geo.lng, accuracy: geo.accuracy ?? null, at: geo.at || new Date().toISOString() }
          : undefined;

      const payload = {
        links,
        // Subject at run supports vehicle/asset/performance/none
        subjectAtRun: {
          type: subjectType,
          id: subjectLocked.id ?? (subjectId || undefined),
          label: subjectLocked.id ? (subjectLocked.label || "") :
                 (subjectLabel || findLabelById(subjectOptions, subjectId) || ""),
          ...(loc ? { location: loc } : {}),          // copy coords onto subject
        },
        // Geo capture (put into multiple commonly-used fields)
        ...(loc ? { location: loc } : {}),            // existing/primary
        ...(loc ? { locationAtRun: loc } : {}),       // legacy/alt field
        items: rows.map(r => ({
          itemId: r.itemId,
          result: r.result || "na",
          evidence: r.evidence,
          correctiveAction: r.result === "fail" ? (r.correctiveAction || "") : "",
          criticalTriggered: r.result === "fail" && !!r.criticalOnFail
        })),
        followUpDate: (anyFail ? (followUpDate ? new Date(followUpDate).toISOString() : null) : null),
        signoff: {
          confirmed: true,
          name: signName,
          date: new Date().toISOString(),
          signatureDataUrl: signature || "",
        },
      };

      const sub = await runForm(realId, payload);
      nav(`/inspections/${sub._id}`);
    }catch(e){
      setErr(e?.response?.data?.error || e?.message || "Submit failed");
    }finally{
      setSaving(false);
    }
  }

  if (err) return (
    <div className="mx-auto max-w-[1200px] w-full px-3 sm:px-4 lg:px-6 py-4">
      <div className="p-4 text-red-600">{err}</div>
    </div>
  );
  if (!form) return (
    <div className="mx-auto max-w-[1200px] w-full px-3 sm:px-4 lg:px-6 py-4">
      <div className="p-4">Loading…</div>
    </div>
  );

  const isScoped = form?.scope?.type === "scoped";
  const TITLE = "Inspection Submission";
  const subjectNice =
    subjectType === "none"
      ? "General"
      : subjectType === "vehicle"
      ? "Vehicle"
      : subjectType === "asset"
      ? "Asset"
      : "Performance (User)";

  return (
    <div className="w-full">
      {/* Page container to match Vehicles layout */}
      <div className="mx-auto max-w-[1200px] w-full px-3 sm:px-4 lg:px-6 py-4 print:p-4">
        <style>{`
          .result-selected { background-color:#374151 !important; color:#fff !important; }
          :root{--border:#e5e7eb}
          .card{border:1px solid var(--border); border-radius:12px; padding:12px; background:#fff; margin-top:12px}
          .row{display:flex; align-items:center; justify-content:space-between; gap:12px}
          /* Responsive 1->2->3 columns like other pages */
          .grid-3{display:grid; grid-template-columns: repeat(1, minmax(0,1fr)); gap:10px}
          @media (min-width: 720px){ .grid-3{ grid-template-columns: repeat(2, minmax(0,1fr)); } }
          @media (min-width: 1024px){ .grid-3{ grid-template-columns: repeat(3, minmax(0,1fr)); } }
          .muted{color:#6b7280}
          /* Print adjustments aligned with standard pages */
          @media print {
            .no-print { display: none !important; }
            .print-container { padding: 0 !important; }
            .card{ break-inside: avoid; }
            .print-break-avoid{ break-inside: avoid; }
          }
        `}</style>

        {/* Header */}
        <div className="screen-header flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            {orgLogoUrl ? (
              <img
                src={orgLogoUrl}
                alt={orgName ? `${orgName} logo` : "Logo"}
                style={{ height: 32, width: "auto" }}
              />
            ) : null}
            <h1 className="text-xl font-semibold">{TITLE}</h1>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn no-print" onClick={()=>window.print()}>Print / Export PDF</button>
          </div>
        </div>

        {/* Meta card */}
        <div className="card">
          <div className="row">
            <div><b>Form</b>: {form.title || "Form"}</div>
            <div className="right">
              <small><b>Form Type:</b> {niceCase(form.formType || "standard")}</small>
            </div>
          </div>

          {/* Geo badge */}
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <b>Location:</b>{" "}
            {geo.lat != null && geo.lng != null ? (
              <>
                <span className="text-sm">
                  {geo.lat.toFixed(6)}, {geo.lng.toFixed(6)}
                  {geo.accuracy != null ? ` • ±${Math.round(geo.accuracy)}m` : ""}
                </span>
                <button className="btn btn-ghost btn-xs" onClick={() => captureGeo(setGeo, setGeoErr)}>Re-capture</button>
                <a
                  className="text-sm underline"
                  href={`https://www.google.com/maps?q=${geo.lat},${geo.lng}`}
                  target="_blank" rel="noreferrer"
                >Open in Maps</a>
              </>
            ) : (
              <>
                <span className="text-sm text-gray-500">not captured</span>
                <button className="btn btn-ghost btn-xs" onClick={() => captureGeo(setGeo, setGeoErr)}>Capture</button>
              </>
            )}
            {geoErr && <span className="text-xs text-red-600">({geoErr})</span>}
          </div>

          <div className="grid-3 mt-2">
            {isScoped ? (
              <>
                <div><b>Project</b>: {names.project || form.scope?.projectName || String(links.projectId || "—")}</div>
                <div><b>Task</b>: {names.task || form.scope?.taskName || String(links.taskId || "—")}</div>
                <div><b>Milestone</b>: {names.milestone || form.scope?.milestoneName || String(links.milestoneId || "—")}</div>
              </>
            ) : (
              <>
                <label className="block">
                  <span className="font-medium">Project</span>
                  <select
                    className="select select-bordered w-full mt-1"
                    value={links.projectId}
                    onChange={(e)=> setLinks({ projectId: e.target.value, taskId:"", milestoneId:"" })}
                  >
                    <option value="">— select project (optional) —</option>
                    {projects.map(p=>(
                      <option key={p._id||p.id} value={p._id||p.id}>{labelOf(p)}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="font-medium">Task</span>
                  <select
                    className="select select-bordered w-full mt-1"
                    value={links.taskId}
                    onChange={(e)=> setLinks({ ...links, taskId:e.target.value, milestoneId:"" })}
                    disabled={!links.projectId}
                  >
                    <option value="">— any task —</option>
                    {tasks.map(t=>(
                      <option key={t._id||t.id} value={t._id||t.id}>{labelOf(t)}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="font-medium">Milestone</span>
                  <select
                    className="select select-bordered w-full mt-1"
                    value={links.milestoneId}
                    onChange={(e)=> setLinks({ ...links, milestoneId:e.target.value })}
                    disabled={!links.taskId}
                  >
                    <option value="">— any milestone —</option>
                    {milestones.map(m=>(
                      <option key={m._id||m.id} value={m._id||m.id}>{labelOf(m)}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>

          {/* Subject selection */}
          <div className="mt-2">
            <b>Subject</b>: {subjectNice}
            {subjectType !== "none" && (
              <div className="mt-2 grid-3">
                {subjectLocked.id ? (
                  <>
                    <div><span className="muted">Locked</span><div>{subjectLocked.label || subjectLocked.id}</div></div>
                    <div className="muted">ID</div><div className="muted">{String(subjectLocked.id)}</div>
                  </>
                ) : (
                  <>
                    {subjectOptions.length > 0 ? (
                      <>
                        <label className="block">
                          <span className="font-medium">{subjectType === "performance" ? "User" : subjectNice}</span>
                          <select
                            className="select select-bordered w-full mt-1"
                            value={subjectId}
                            onChange={(e)=> {
                              const v = e.target.value;
                              setSubjectId(v);
                              const lbl = findLabelById(subjectOptions, v);
                              setSubjectLabel(lbl || "");
                            }}
                          >
                            <option value="">
                              {`— select ${subjectType === "performance" ? "user" : subjectNice.toLowerCase()} —`}
                            </option>
                            {subjectOptions.map(o=>(
                              <option key={String(o.id)} value={String(o.id)}>{o.label}</option>
                            ))}
                          </select>
                        </label>
                        <label className="block">
                          <span className="font-medium">Label (optional)</span>
                          <input
                            className="input input-bordered w-full mt-1"
                            placeholder="Override label shown on submission"
                            value={subjectLabel}
                            onChange={(e)=> setSubjectLabel(e.target.value)}
                          />
                        </label>
                        <div />
                      </>
                    ) : (
                      <>
                        <label className="block">
                          <span className="font-medium">{subjectType === "performance" ? "User ID" : `${subjectNice} ID`}</span>
                          <input
                            className="input input-bordered w-full mt-1"
                            placeholder={`Enter ${subjectType === "performance" ? "user id" : subjectNice.toLowerCase() + " id"}…`}
                            value={subjectId}
                            onChange={(e)=> setSubjectId(e.target.value)}
                          />
                        </label>
                        <label className="block">
                          <span className="font-medium">Label (optional)</span>
                          <input
                            className="input input-bordered w-full mt-1"
                            placeholder="Friendly label"
                            value={subjectLabel}
                            onChange={(e)=> setSubjectLabel(e.target.value)}
                          />
                        </label>
                        <div className="muted mt-6">No {subjectType === "performance" ? "user" : subjectNice.toLowerCase()} list available.</div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {form.description ? (
            <div className="mt-2">
              <b>Description</b>: {form.description}
            </div>
          ) : null}

          {/* Scoring rule + Achieved */}
          {form?.scoring ? (
            <div className="mt-2 row">
              <div><b>Rule</b>: {ruleLabel(form.scoring)}</div>
              <div className="right"><b>Achieved</b>: {achievedLabel}</div>
            </div>
          ) : null}

          <div className="mt-2 row">
            <div className="flex-1">
              <b>Inspector</b>:{" "}
              <input
                className="input input-bordered"
                style={{ maxWidth: 340, display: "inline-block" }}
                value={signName}
                onChange={(e)=> setSignName(e.target.value)}
              />
            </div>
            <div className="right"><b>Date</b>: {new Date().toLocaleDateString()}</div>
          </div>
        </div>

        {/* Requirement issues banner */}
        {(hasIssues || needsSubject) && (
          <div
            className="rounded-lg p-3 mt-3"
            style={{ background:"#FEF2F2", border:"1px solid #FCA5A5", color:"#991B1B" }}
          >
            {needsSubject ? (
              <>Select a <b>{subjectType === "performance" ? "user" : subjectNice.toLowerCase()}</b> for this inspection.</>
            ) : (
              <>
                <b>{issueCount}</b> item{issueCount===1?"":"s"} need attention: add the required <i>evidence</i> and/or <i>corrective action</i> for failed items.
              </>
            )}
          </div>
        )}

        {/* Items */}
        <div className="card">
          <h2 className="text-lg font-semibold">Items</h2>
          <div className="mt-2">
            {rows.map((r, i) => {
              const itemIssues = issues[i] || [];
              return (
                <div key={r.itemId || i} className="print-break-avoid" style={{padding:"10px 0", borderBottom:"1px solid var(--border)"}}>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="font-medium">{i + 1}. {r.label}</div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className={`btn btn-sm ${r.result==='pass' ? 'result-selected' : 'btn-outline'}`}
                        onClick={() => chooseResult(i, "pass")}
                      >
                        Pass
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm ${r.result==='na' ? 'result-selected' : 'btn-outline'}`}
                        onClick={() => chooseResult(i, "na")}
                      >
                        N/A
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm ${r.result==='fail' ? 'result-selected' : 'btn-outline'}`}
                        onClick={() => chooseResult(i, "fail")}
                      >
                        Fail
                      </button>
                    </div>
                  </div>

                  {/* Evidence grid */}
                  <div className="grid-3 mt-2">
                    <div>
                      <div className="muted">Photo</div>
                      {r.allowPhoto ? (
                        <>
                          <input
                            type="file" accept="image/*"
                            onChange={async (e) => {
                              const f = e.target.files?.[0];
                              if (!f) return setRow(i, { evidence: { ...r.evidence, photoUrl: "" } });
                              const dataUrl = await readAsDataURL(f);
                              setRow(i, { evidence: { ...r.evidence, photoUrl: dataUrl } });
                            }}
                            className="file-input file-input-bordered file-input-sm w-full"
                          />
                          {r.evidence.photoUrl ? (
                            <img
                              src={r.evidence.photoUrl}
                              alt="evidence"
                              style={{ maxHeight: 96, width: "auto", objectFit: "contain", borderRadius:8, border:"1px solid var(--border)" }}
                              className="mt-2"
                            />
                          ) : <div>—</div>}
                        </>
                      ) : <div>—</div>}
                    </div>
                    <div>
                      <div className="muted">Scan Ref</div>
                      {r.allowScan ? (
                        <input
                          type="text"
                          placeholder="Scan or type code…"
                          value={r.evidence.scanRef || ""}
                          onChange={(e)=> setRow(i, { evidence: { ...r.evidence, scanRef: e.target.value } })}
                          className="input input-bordered w-full"
                        />
                      ) : <div>—</div>}
                    </div>
                    <div>
                      <div className="muted">Note</div>
                      {r.allowNote ? (
                        <input
                          type="text"
                          placeholder="Optional note…"
                          value={r.evidence.note || ""}
                          onChange={(e)=> setRow(i, { evidence: { ...r.evidence, note: e.target.value } })}
                          className="input input-bordered w-full"
                        />
                      ) : <div>—</div>}
                    </div>
                  </div>

                  {/* Inline requirement warnings when FAIL */}
                  {r.result === "fail" && itemIssues.length > 0 && (
                    <div
                      className="rounded p-2 mt-2 text-sm"
                      style={{ background:"#FEF2F2", border:"1px solid #FCA5A5", color:"#991B1B" }}
                    >
                      Fail requires: {itemIssues.join(" • ")}
                    </div>
                  )}

                  {/* Corrective Action only when Fail */}
                  {r.result === "fail" && r.requireCorrectiveOnFail && (
                    <div className="mt-2">
                      <div className="muted">Corrective Action (required)</div>
                      <textarea
                        rows={2}
                        className="textarea textarea-bordered w-full"
                        value={r.correctiveAction}
                        onChange={(e)=> setRow(i, { correctiveAction: e.target.value })}
                      />
                    </div>
                  )}

                  {/* Critical fail callout */}
                  {r.criticalOnFail && r.result === "fail" && (
                    <div
                      className="rounded p-3 text-sm mt-2"
                      style={{ background:"#FEF2F2", border:"1px solid #FCA5A5", color:"#991B1B" }}
                    >
                      This is a <strong>critical failure</strong>. The inspection will auto-fail. You can set a follow-up inspection date below.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Follow-up (only when overall fail) */}
        {anyFail && (
          <div className="card print-break-avoid">
            <h2 className="text-lg font-semibold">Follow-Up</h2>
            <div className="mt-2 grid-3">
              <label className="block">
                <div className="muted">Planned follow-up inspection date</div>
                <input
                  type="date"
                  className="input input-bordered w-full mt-1"
                  value={followUpDate}
                  onChange={(e)=> setFollowUpDate(e.target.value)}
                />
              </label>
            </div>
          </div>
        )}

        {/* Inspector Sign-Off */}
        <div className="card print-break-avoid">
          <h2 className="text-lg font-semibold">Inspector Sign-Off</h2>

          <div className="mt-2">
            <div className="row" style={{ alignItems:"center" }}>
              <button
                type="button"
                className={`btn btn-sm ${confirmed ? 'btn-success' : 'btn-outline'}`}
                aria-pressed={confirmed}
                onClick={()=> setConfirmed(v=>!v)}
              >
                {confirmed ? "Confirmed" : "Confirm"}
              </button>
              <span className="ml-2">I confirm the above is accurate to the best of my knowledge.</span>
            </div>
          </div>

          <div className="grid-3 mt-2">
            <div>
              <div className="muted">Signature (optional)</div>
              <input
                type="file" accept="image/*"
                onChange={async (e)=> {
                  const f = e.target.files?.[0];
                  if(!f) return setSignature("");
                  setSignature(await readAsDataURL(f));
                }}
                className="file-input file-input-bordered file-input-sm w-full"
              />
              {signature && (
                <img
                  src={signature}
                  alt="signature"
                  style={{ maxHeight: 96, width: "auto", objectFit: "contain", borderRadius:8, border:"1px solid var(--border)" }}
                  className="mt-2"
                />
              )}
            </div>
            <div>
              <div className="muted">Name</div>
              <input
                className="input input-bordered w-full"
                value={signName}
                onChange={(e)=> setSignName(e.target.value)}
              />
            </div>
            <div>
              <div className="muted">Date</div>
              <input className="input input-bordered w-full" value={new Date().toLocaleDateString()} readOnly />
            </div>
          </div>

          {/* Global submit issues banner */}
          {!canSubmit() && (hasIssues || needsSubject) && (
            <div
              className="rounded p-2 mt-3 text-sm"
              style={{ background:"#FEF2F2", border:"1px solid #FCA5A5", color:"#991B1B" }}
            >
              {needsSubject
                ? <>Please select a <b>{subjectType === "performance" ? "user" : subjectNice.toLowerCase()}</b> before submitting.</>
                : <>You still have <b>{issueCount}</b> failed item{issueCount===1?"":"s"} missing required evidence and/or corrective actions.</>
              }
            </div>
          )}

          <div className="row mt-3">
            <button className="btn" onClick={()=> window.print()}>Print / Export PDF</button>
            <button className="btn btn-primary right" disabled={!canSubmit() || saving} onClick={onSubmit}>
              {saving ? "Submitting…" : "Submit Inspection"}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 row" style={{ fontSize: 12 }}>
          <div>© 2025 {orgName || ""}</div>
          <div className="right">Inspection powered by MOAT SmartOps</div>
        </div>
      </div>
    </div>
  );
}

/* -------------- helpers -------------- */
function findLabelById(list, id){
  const s = String(id || "");
  const row = (list || []).find(x => String(x.id) === s);
  return row?.label || "";
}

function readAsDataURL(file){
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/* Vehicle/Asset label helpers */
function vehicleReg(v){ return v?.registration || v?.reg || v?.plate || v?.vrn || ""; }
function vehicleMakeModelYear(v){
  const make = v?.make || v?.manufacturer || "";
  const model = v?.model || "";
  const year = v?.year || v?.yom || v?.manufacturedYear || "";
  return [make, model, year && String(year)].filter(Boolean).join(" ").trim();
}
function vehicleOptionText(v){
  const reg = vehicleReg(v);
  const mmY = vehicleMakeModelYear(v) || v?.name || v?.title || "";
  return reg ? `[${reg}] ${mmY}` : (mmY || "(vehicle)");
}
function assetTag(a){ return a?.tag || a?.code || a?.serial || a?.serialNumber || ""; }
function assetMakeModel(a){
  const make = a?.make || a?.manufacturer || "";
  const model = a?.model || "";
  return [make, model].filter(Boolean).join(" ").trim();
}
function assetOptionText(a){
  const tag = assetTag(a);
  const mm = assetMakeModel(a) || a?.name || a?.title || "";
  return tag ? `[${tag}] ${mm}` : (mm || "(asset)");
}

async function loadSubjectOptions(type, { projectId, taskId, milestoneId }){
  const opts = [];
  const pushVehicles = (arr) => {
    for (const v of (Array.isArray(arr)?arr:[])) {
      const id = v._id || v.id || v.code || v.reg || v.slug;
      if (!id) continue;
      opts.push({ id, label: vehicleOptionText(v) });
    }
  };
  const pushAssets = (arr) => {
    for (const a of (Array.isArray(arr)?arr:[])) {
      const id = a._id || a.id || a.code || a.tag || a.slug;
      if (!id) continue;
      opts.push({ id, label: assetOptionText(a) });
    }
  };
  const pushUsers = (arr) => {
    for (const u of (Array.isArray(arr)?arr:[])) {
      const id = u._id || u.id || u.email || u.username;
      if (!id) continue;
      const name = u?.name || u?.email || u?.username || id;
      // only include Group Leader and above
      if (maxUserRank(u) >= MIN_PERF_RANK) {
        opts.push({ id, label: name });
      }
    }
  };

  const params = {};
  if (projectId) params.projectId = projectId;
  if (taskId) params.taskId = taskId;
  if (milestoneId) params.milestoneId = milestoneId;
  params.limit = 1000;

  try {
    if (type === "vehicle") {
      if (projectId) { try { const { data } = await api.get(`/projects/${projectId}/vehicles`); pushVehicles(data); } catch {} }
      if (!opts.length) { try { const { data } = await api.get("/vehicles", { params }); pushVehicles(data); } catch {} }
    } else if (type === "asset") {
      if (projectId) { try { const { data } = await api.get(`/projects/${projectId}/assets`); pushAssets(data); } catch {} }
      if (!opts.length) { try { const { data } = await api.get("/assets", { params }); pushAssets(data); } catch {} }
      if (!opts.length) { try { const { data } = await api.get("/equipment", { params: { ...params, type: "asset" } }); pushAssets(data); } catch {} }
    } else if (type === "performance") {
      // simply load users and filter client-side by role rank
      try {
        const { data } = await api.get("/users", { params: { limit: 2000 } });
        pushUsers(data);
      } catch {}
    }
  } catch {}
  return opts;
}

async function resolveOrgBranding(){
  const w = (typeof window !== "undefined" ? window : {});
  const winCandidates = [
    w.__ORG__, w.__CURRENT_ORG__, w.__ORG_INFO__,
    (w.__CURRENT_USER__||{}).org, (w.__CURRENT_USER__||{}).organization,
  ].filter(Boolean);
  for (const c of winCandidates){
    const { name, logo } = extractOrgFields(c);
    if (name || logo) return { name, logo };
  }
  try{
    const tok = localStorage.getItem("token");
    if (tok && tok.split(".").length === 3) {
      const payload = JSON.parse(atob(tok.split(".")[1] || ""));
      const { name, logo } = extractOrgFields(payload?.org || payload?.organization || {});
      if (name || logo) return { name, logo };
      if (payload?.orgName && typeof payload.orgName === "string") {
        return { name: payload.orgName, logo: "" };
      }
    }
  }catch{}
  const endpoints = ["/org", "/admin/org", "/settings/org", "/organization", "/org/current"];
  for (const ep of endpoints){
    try{
      const { data } = await api.get(ep, { params: { _ts: Date.now() } });
      const { name, logo } = extractOrgFields(data || {});
      if (name || logo) return { name, logo };
    }catch{}
  }
  return { name: "", logo: "" };
}
function extractOrgFields(obj){
  if (!obj || typeof obj !== "object") return { name:"", logo:"" };
  const name = pickFirst(
    obj.name, obj.orgName, obj.company, obj.displayName,
    obj.settings?.name, obj.profile?.name
  );
  const logo = pickFirst(
    obj.logoUrl, obj.logo, obj.branding?.logoUrl, obj.branding?.logo,
    obj.assets?.logo, obj.images?.logo, obj.settings?.logoUrl
  );
  return { name: stringOrEmpty(name), logo: stringOrEmpty(logo) };
}
function pickFirst(...vals){ for (const v of vals){ if (typeof v === "string" && v.trim()) return v; } return ""; }
function stringOrEmpty(v){ return (typeof v === "string" && v.trim()) ? v : ""; }

/* --- geolocation capture helper --- */
function captureGeo(setGeo, setGeoErr) {
  setGeoErr("");
  if (!("geolocation" in navigator)) {
    setGeoErr("Geolocation not available");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords || {};
      setGeo({
        lat: latitude ?? null,
        lng: longitude ?? null,
        accuracy: typeof accuracy === "number" ? accuracy : null,
        at: new Date().toISOString(),
      });
    },
    (e) => {
      setGeoErr(e?.message || "Unable to capture location");
    },
    {
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: 0,
    }
  );
}
