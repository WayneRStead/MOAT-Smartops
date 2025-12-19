// core-frontend/src/pages/InspectionSubmissionView.jsx
import { useEffect, useMemo, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import {
  getSubmission,
  addSubmissionComment,
  getForm,
  // submission admin actions
  softDeleteSubmission,
  hardDeleteSubmission,
  restoreSubmission,
} from "../lib/inspectionApi";

/* ===== Robust role handling (window + JWT + synonyms) ===== */
const CANON_ROLES = ["user","group-leader","project-manager","manager","admin","superadmin"];
function normalizeRole(r){
  if (!r) return "";
  let s = String(r).trim().toLowerCase();
  s = s.replace(/[_\s]+/g, "-"); // "Project Manager" -> "project-manager"
  if (s === "groupleader") s = "group-leader";
  if (s === "pm") s = "project-manager";
  if (s === "super-admin") s = "superadmin";
  if (s === "administrator") s = "admin";
  if (s === "owner") s = "admin";
  return CANON_ROLES.includes(s) ? s : "";
}
function uniq(arr){ return Array.from(new Set(arr)); }
function getCurrentUserSafe(){
  // 1) Window
  let u = (window.__CURRENT_USER__ || {});
  // 2) JWT fallback if window user looks empty
  if (!u || (!u._id && !u.id && !u.userId && !u.email && !u.name)) {
    try {
      const tok = localStorage.getItem("token");
      if (tok && tok.split(".").length === 3) {
        const payload = JSON.parse(atob(tok.split(".")[1] || ""));
        const maybe = payload?.user || payload || {};
        u = {
          _id: maybe?._id || maybe?.id || maybe?.userId,
          id: maybe?.id,
          userId: maybe?.userId,
          email: maybe?.email,
          name: maybe?.name,
          role: maybe?.role,
          roles: maybe?.roles || [],
          isAdmin: !!maybe?.isAdmin,
        };
      }
    } catch {}
  }
  // 3) Normalize roles
  const rawRoles = []
    .concat(u?.role ? [u.role] : [])
    .concat(Array.isArray(u?.roles) ? u.roles : [])
    .concat(u?.isAdmin ? ["admin"] : []);
  const roles = uniq(rawRoles.flatMap(v => String(v).split(",")).map(normalizeRole).filter(Boolean));
  return { ...(u || {}), roles };
}
function isElevated(u){
  return (u?.roles || []).some(r => ["project-manager","manager","admin","superadmin"].includes(r));
}

/* ---- small helpers ---- */
function hasLocation(sub){
  const loc = sub?.location || {};
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  return Number.isFinite(lat) && Number.isFinite(lng);
}
function locationText(sub){
  if (!hasLocation(sub)) return "";
  const { lat, lng, accuracy } = sub.location;
  const acc = Number.isFinite(+accuracy) ? ` ±${Math.round(+accuracy)}m` : "";
  return `${(+lat).toFixed(6)}, ${(+lng).toFixed(6)}${acc}`;
}
function mapsHref(sub){
  if (!hasLocation(sub)) return "#";
  const { lat, lng } = sub.location;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}
function subjectNiceParts(sub){
  const t = String(sub?.subjectAtRun?.type || "none").toLowerCase();
  const type =
    t === "vehicle" ? "Vehicle" :
    t === "asset" ? "Asset" :
    t === "performance" ? "Performance" :
    "General";
  const id = sub?.subjectAtRun?.id || "";
  const label = sub?.subjectAtRun?.label || (id ? String(id) : "");
  return { type, id, label };
}

export default function InspectionSubmissionView(){
  const { subId, id } = useParams();
  const realId = subId || id;
  const TITLE = "Inspection Submission";
  const nav = useNavigate();

  const [sub, setSub] = useState(null);
  const [formMeta, setFormMeta] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  // backfill names (project/task/milestone)
  const [names, setNames] = useState({ project:"", task:"", milestone:"" });

  // manager comment draft
  const [mgrNote, setMgrNote] = useState("");
  const [savingComment, setSavingComment] = useState(false);
  const [commentErr, setCommentErr] = useState("");

  // org branding (logo + name)
  const [orgName, setOrgName] = useState("");
  const [orgLogoUrl, setOrgLogoUrl] = useState("");

  // current user + permissions
  const me = getCurrentUserSafe();
  const canComment = isElevated(me);
  const canAdminSub = canComment; // same gate for delete/restore

  // lightbox
  const [lightboxUrl, setLightboxUrl] = useState("");

  useEffect(()=>{ load(); /* eslint-disable-next-line */ }, [realId]);

  useEffect(()=>{
    resolveOrgBranding().then(({ name, logo }) => {
      if (name) setOrgName(name);
      if (logo) setOrgLogoUrl(logo);
    });
  },[]);

  async function load(){
    setLoading(true); setErr("");
    try {
      const data = await getSubmission(realId);
      setSub(data || null);

      if (data?.formId) {
        try {
          const fm = await getForm(data.formId);
          setFormMeta(fm || null);
        } catch {}
      }

      backfillNames(data?.links || {});
    } catch(e) {
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function backfillNames({ projectId, taskId, milestoneId }){
    try{
      if(projectId){
        const { data } = await api.get(`/projects/${projectId}`);
        setNames(n=>({ ...n, project: labelOf(data) || String(projectId) }));
      }
    }catch{}
    try{
      if(taskId){
        const { data } = await api.get(`/tasks/${taskId}`);
        setNames(n=>({ ...n, task: labelOf(data) || String(taskId) }));
      }
    }catch{}
    try{
      if(taskId && milestoneId){
        const { data } = await api.get(`/tasks/${taskId}/milestones`);
        const m = (Array.isArray(data)?data:[]).find(x => String(x._id||x.id)===String(milestoneId));
        setNames(n=>({ ...n, milestone: labelOf(m) || String(milestoneId) }));
      }
    }catch{}
  }

  async function saveComment(){
    if(!mgrNote.trim()) return;
    setSavingComment(true); setCommentErr(""); setErr("");
    try{
      await addSubmissionComment(realId, mgrNote.trim());
      setMgrNote("");
      await load();
    }catch(e){
      const m = e?.response?.data?.error || e?.response?.data?.message || e?.message || "Failed to save comment";
      setCommentErr(m);
    }finally{
      setSavingComment(false);
    }
  }

  // delete / restore actions
  async function onSoftDelete(){
    if(!sub?._id) return;
    if(!confirm("Soft delete this submission?")) return;
    try{ await softDeleteSubmission(sub._id); nav("/inspections"); }catch(e){ alert(e?.response?.data?.error||e.message); }
  }
  async function onHardDelete(){
    if(!sub?._id) return;
    if(!confirm("This will permanently delete the submission. Continue?")) return;
    try{ await hardDeleteSubmission(sub._id); nav("/inspections"); }catch(e){ alert(e?.response?.data?.error||e.message); }
  }
  async function onRestore(){
    if(!sub?._id) return;
    try{ await restoreSubmission(sub._id); await load(); }catch(e){ alert(e?.response?.data?.error||e.message); }
  }

  function downloadJson(){
    if (!sub) return;
    const blob = new Blob([JSON.stringify(sub, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inspection-${sub._id || realId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const chip = useMemo(()=>{
    const r = String(sub?.overallResult || "").toLowerCase();
    return r==="fail" ? "chip chip-fail" : r==="pass" ? "chip chip-pass" : "chip chip-na";
  },[sub]);

  // Unified comments (managerComments preferred; legacy comments fallback)
  const comments = useMemo(() => {
    if (!sub) return [];
    if (Array.isArray(sub.managerComments) && sub.managerComments.length) return sub.managerComments;
    if (Array.isArray(sub.comments)) {
      return sub.comments.map(c => ({
        comment: c.comment,
        at: c.createdAt || c.at || c.date,
        by: { name: c.name || c.by?.name || "Manager" },
      }));
    }
    return [];
  }, [sub]);

  // Friendly scoring rule label
  const ruleLabel = (sc) => {
    if (!sc) return "";
    const mode = String(sc.mode || "any-fail");
    if (mode === "percent") {
      const pct = Math.max(0, Math.min(100, parseInt(sc.minPassPercent ?? 100, 10)));
      return `≥ ${pct}% Pass (critical fail auto-fail)`;
    }
    if (mode === "tolerance") {
      const n = Math.max(0, parseInt(sc.maxNonCriticalFails ?? 0, 10));
      return `Up to ${n} non-critical FAIL${n===1?"":"s"} allowed (critical auto-fail)`;
    }
    return "Any FAIL ⇒ overall FAIL (critical auto-fail)";
  };

  // Achieved score label
  const achievedLabel = useMemo(() => {
    if (!sub) return "";
    if (sub.scoringSummary?.percentScore != null) {
      const pct = (Math.round(sub.scoringSummary.percentScore * 10) / 10).toFixed(1);
      if (formMeta?.scoring?.mode === "tolerance") {
        const max = Number.isFinite(+formMeta.scoring.maxNonCriticalFails) ? +formMeta.scoring.maxNonCriticalFails : 0;
        return `${pct}% • Non-critical fails ${sub.scoringSummary.counts?.nonCriticalFails ?? "0"}/${max}`;
      }
      return `${pct}%`;
    }
    // fallback compute
    const items = Array.isArray(sub.items) ? sub.items : [];
    const applicable = items.filter(r => (r.result || '').toLowerCase() !== 'na');
    const totalApplicable = applicable.length;
    const passCount = applicable.filter(r => r.result === 'pass').length;
    const nonCriticalFailCount = applicable.filter(r => r.result === 'fail' && !r.criticalTriggered).length;
    const percent = totalApplicable ? (passCount / totalApplicable) * 100 : 100;
    const pct = (Math.round(percent * 10) / 10).toFixed(1);
    if (formMeta?.scoring?.mode === 'tolerance') {
      const max = Number.isFinite(+formMeta.scoring.maxNonCriticalFails) ? +formMeta.scoring.maxNonCriticalFails : 0;
      return `${pct}% • Non-critical fails ${nonCriticalFailCount}/${max}`;
    }
    return `${pct}%`;
  }, [sub, formMeta]);

  if (loading) return <div className="p-4">Loading…</div>;
  if (err) return <div className="p-4 text-red-600">{err}</div>;
  if (!sub) return <div className="p-4">Not found.</div>;

  const links = sub.links || {};
  const headerProject = names.project || links.projectId || "—";
  const headerTask = names.task || links.taskId || "—";
  const headerMilestone = names.milestone || links.milestoneId || "—";
  const formTypeRaw = (sub.formType || formMeta?.formType || "standard");
  const formTypeNice = niceCase(formTypeRaw);
  const description = formMeta?.description || "";
  const scoringRule = formMeta?.scoring ? ruleLabel(formMeta.scoring) : "";

  const subj = subjectNiceParts(sub);
  const locTxt = locationText(sub);
  const isDeleted = !!sub.isDeleted;

  return (
    <div className="max-w-7xl mx-auto p-4 print-container">
      {/* Local styles — screen unchanged; print-only adjusts layout */}
      <style>{`
        :root{--border:#e5e7eb;--muted:#6b7280}
        .card{border:1px solid var(--border); border-radius:12px; padding:12px; background:#fff}
        .row{display:flex; align-items:center; justify-content:space-between; gap:12px}
        .grid-3{display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap:10px}
        .grid-2{display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px}
        @media (max-width: 860px){
          .grid-3{ grid-template-columns: 1fr; }
          .grid-2{ grid-template-columns: 1fr; }
        }
        .muted{color:var(--muted)}
        .chip{display:inline-flex;align-items:center;gap:6px;padding:.25rem .5rem;border-radius:999px;font-weight:600;border:1px solid var(--border)}
        .chip-pass{background:#ecfdf5;border-color:#10b981;color:#065f46}
        .chip-fail{background:#fef2f2;border-color:#ef4444;color:#7f1d1d}
        .chip-na{background:#f3f4f6;border-color:#9ca3af;color:#374151}
        .btn{padding:.5rem .75rem;border:1px solid var(--border);border-radius:8px;background:#fff}
        .btn:hover{box-shadow:0 1px 0 rgba(0,0,0,.04)}
        .btn-error{border-color:#ef4444;color:#991b1b;background:#fff0f0}
        .btn-primary{border-color:#111827;background:#111827;color:#fff;border-radius:8px;padding:.5rem .75rem}
        .pill{display:inline-flex;align-items:center;font-size:12px;border:1px solid var(--border);padding:2px 6px;border-radius:9999px;color:#374151;background:#f9fafb}
        .no-print {}
        .print-header{ display:none }

@media print {
  @page { margin: 10mm; }
  html, body { font-size: 11.5px; }
  .no-print{ display: none !important; }
  .print-header{ display: block; margin-bottom: 10px; }

  .card{
    page-break-inside: avoid;
    break-inside: avoid;
    padding: 10px !important;
  }
  .mt-3{ margin-top: 6px !important; }

  .grid-3{ grid-template-columns: repeat(3, minmax(0,1fr)) !important; }
  h1, h2 { margin: 6px 0 !important; }
  .row { gap: 8px !important; }

  .items-evidence img { max-height: 84px !important; }

  .card:first-of-type{ page-break-after: avoid; break-after: avoid-page; }
  .card:nth-of-type(2){ page-break-before: avoid; break-before: avoid-page; }

  .print-container{ padding: 0 !important; }
}
      `}</style>

      {/* Title row (hide whole bar on print to avoid duplicate) */}
      <div className="row no-print">
        <div className="flex items-center gap-3">
          <Link to="/inspections" className="btn" title="Back to list">← Back</Link>
          {orgLogoUrl ? (
            <img
              src={orgLogoUrl}
              alt={orgName ? `${orgName} logo` : "Logo"}
              style={{ height: 28, width: "auto" }}
            />
          ) : null}
          <h1 className="text-2xl font-semibold">{TITLE}</h1>
          {isDeleted && (
            <span className="pill" title="This submission is deleted">deleted</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {locTxt && <span className="pill" title={locTxt}>📍</span>}
          <span className="muted text-sm">{formTypeNice}</span>
          <div className={chip} title="Outcome">{(sub.overallResult || "—").toUpperCase()}</div>
          <button className="btn" onClick={()=>window.print()}>Print / PDF</button>
          <button className="btn" onClick={downloadJson} title="Download raw JSON">Download JSON</button>
        </div>
      </div>

      {/* Print header */}
      <div className="print-header">
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
          <div style={{display:"flex", alignItems:"center", gap:12}}>
            {orgLogoUrl ? (
              <img
                src={orgLogoUrl}
                alt={orgName ? `${orgName} logo` : "Logo"}
                style={{ height: 24, width: "auto" }}
              />
            ) : null}
            <div style={{fontSize:20, fontWeight:700}}>{TITLE}</div>
          </div>
          <div className={chip} style={{fontSize:12}}>{(sub.overallResult || "—").toUpperCase()}</div>
        </div>
      </div>

      {/* Meta card */}
      <div className="card mt-3">
        <div className="row" style={{ alignItems:"flex-start" }}>
          <div>
            <div className="font-medium">
              <b>Form</b>: {sub.formTitle || "Form"}
            </div>
            <div className="muted text-sm meta-type">
              <b>Type</b>: {formTypeNice}
            </div>
          </div>
          <div className="text-right">
            <div><b>Submitted:</b> {sub.createdAt ? new Date(sub.createdAt).toLocaleString() : "—"}</div>
          </div>
        </div>

        {/* Scope */}
        <div className="grid-3 mt-3">
          <div><b>Project</b>: {headerProject}</div>
          <div><b>Task</b>: {headerTask}</div>
          <div><b>Milestone</b>: {headerMilestone}</div>
        </div>

        {/* Subject + Label + ID */}
        <div className="grid-3 mt-3">
          <div><b>Subject</b>: {subj.type}</div>
          <div><b>Label</b>: {subj.type !== "General" ? (subj.label || "—") : "—"}</div>
          <div><b>ID</b>: {subj.type !== "General" ? (subj.id || "—") : "—"}</div>
        </div>

        {/* Location (if available) */}
        {locTxt && (
          <div className="mt-3">
            <b>Location</b>: <span className="pill" title={locTxt}>📍 {locTxt}</span>{" "}
            <a className="muted" href={mapsHref(sub)} target="_blank" rel="noreferrer">Open in Maps</a>
          </div>
        )}

        {description ? (
          <div className="mt-3">
            <b>Description</b>: {description}
          </div>
        ) : null}

        {/* Scoring rule + Achieved */}
        {formMeta?.scoring ? (
          <div className="mt-3 row">
            <div><b>Rule</b>: {scoringRule}</div>
            <div className="right"><b>Achieved</b>: {achievedLabel}</div>
          </div>
        ) : null}

        <div className="mt-3 row">
          <div><b>Inspector</b>: {sub.runBy?.name || "—"}</div>
          <div className="right hide-outcome-on-print">
            <b>Outcome</b>: <span className={chip}>{(sub.overallResult || "—").toUpperCase()}</span>
          </div>
        </div>

        {/* Admin actions: delete/restore (screen only) */}
        {canAdminSub && (
          <div className="mt-3 row no-print">
            <div className="muted">Admin</div>
            <div className="right flex gap-2">
              {!sub.isDeleted && (
                <>
                  <button className="btn" onClick={onSoftDelete}>Soft Delete</button>
                  <button className="btn btn-error" onClick={onHardDelete}>Hard Delete</button>
                </>
              )}
              {sub.isDeleted && (
                <button className="btn btn-primary" onClick={onRestore}>Restore</button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Items */}
      <div className="card mt-3">
        <h2 className="text-lg font-semibold">Items</h2>
        <div className="mt-2">
          {(sub.items||[]).map((it, idx)=>(
            <div key={it.itemId || idx} style={{padding:"10px 0", borderBottom:"1px solid var(--border)"}}>
              <div className="row">
                <div className="font-medium">{idx+1}. {it.label}</div>
                <div className={ badgeFor(it.result) }>{(it.result||"NA").toUpperCase()}</div>
              </div>

              {/* Evidence (screen unchanged; print moves note under the two cols) */}
              <div className="grid-3 items-evidence mt-2">
                <div className="ev-photo">
                  <div className="muted">Photo</div>
                  {it.evidence?.photoUrl ? (
                    <img
                      src={it.evidence.photoUrl}
                      alt="evidence"
                      onClick={()=> setLightboxUrl(it.evidence.photoUrl)}
                      style={{ maxHeight: 96, width: "auto", objectFit: "contain", borderRadius:8, border:"1px solid var(--border)", cursor:"zoom-in" }}
                      title="Click to enlarge"
                    />
                  ) : <div>—</div>}
                </div>
                <div className="ev-scan">
                  <div className="muted">Scan Ref</div>
                  <div>{it.evidence?.scanRef || "—"}</div>
                </div>
                <div className="ev-note">
                  <div className="muted">Note</div>
                  <div>{it.evidence?.note || "—"}</div>
                </div>
              </div>

              {it.result === "fail" && (
                <div className="mt-2">
                  <div className="muted">Corrective Action</div>
                  <div>{it.correctiveAction || "—"}</div>
                </div>
              )}
              {it.criticalTriggered && (
                <div className="mt-2 text-sm" style={{ color:"#991B1B" }}>
                  Critical failure
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Inspector Sign-Off */}
      <div className="card mt-3">
        <h2 className="text-lg font-semibold">Inspector Sign-Off</h2>
        <div className="mt-2">
          <div className="muted">Confirmation</div>
          <div>I confirm the above is accurate to the best of my knowledge.</div>
        </div>
        <div className="grid-3 mt-2">
          <div>
            <div className="muted">Signature</div>
            {sub.signoff?.signatureDataUrl ? (
              <img
                src={sub.signoff.signatureDataUrl}
                alt="signature"
                style={{ maxHeight: 96, width: "auto", objectFit: "contain", borderRadius:8, border:"1px solid var(--border)" }}
              />
            ) : <div>—</div>}
          </div>
          <div>
            <div className="muted">Name</div>
            <div>{sub.signoff?.name || sub.runBy?.name || "—"}</div>
          </div>
          <div>
            <div className="muted">Date</div>
            <div>{sub.signoff?.date ? new Date(sub.signoff.date).toLocaleDateString() : "—"}</div>
          </div>
        </div>
        {String(sub.overallResult || "").toLowerCase()==="fail" && (
          <div className="mt-2">
            <div className="muted">Follow-up inspection date</div>
            <div>{sub.followUpDate ? new Date(sub.followUpDate).toLocaleDateString() : "—"}</div>
          </div>
        )}
      </div>

      {/* Project Manager Comments */}
      <div className="card mt-3">
        <h2 className="text-lg font-semibold">Project Manager Comments</h2>

        {/* Existing comments */}
        {comments.length ? (
          <div className="mt-2">
            {comments.map((c, i)=>(
              <div key={i} style={{padding:"8px 0", borderBottom:"1px solid var(--border)"}}>
                <div>
                  <b>{c.by?.name || "Manager"}</b>{" "}
                  <small className="muted">({c.at ? new Date(c.at).toLocaleString() : "—"})</small>
                </div>
                <div className="mt-1">{c.comment}</div>
              </div>
            ))}
          </div>
        ) : <div className="muted mt-1">No comments yet.</div>}

        {/* Add new (screen only) */}
        <div className="mt-3 no-print">
          {commentErr ? <div className="text-red-600 mb-2">{commentErr}</div> : null}
          <textarea
            className="w-full"
            rows={3}
            placeholder={canComment ? "Add a manager note…" : "You don’t have permission to comment"}
            value={mgrNote}
            onChange={(e)=>setMgrNote(e.target.value)}
            disabled={!canComment}
            style={{border:"1px solid var(--border)", borderRadius:8, padding:10}}
          />
          <div className="row mt-2">
            <Link to="/inspections" className="muted">Back to list</Link>
            <button
              className="btn-primary"
              onClick={saveComment}
              disabled={!mgrNote.trim() || savingComment || !canComment}
              title={canComment ? "" : "You need project-manager/manager/admin role to add comments"}
            >
              {savingComment ? "Saving…" : "Save comment"}
            </button>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-6 row" style={{ fontSize: 12 }}>
        <div>© {new Date().getFullYear()} {orgName || ""}</div>
        <div className="right">Inspection powered by MOAT SmartOps</div>
      </div>

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="no-print"
          onClick={()=> setLightboxUrl("")}
          style={{
            position:"fixed", inset:0, background:"rgba(0,0,0,.75)",
            display:"flex", alignItems:"center", justifyContent:"center", zIndex:50, cursor:"zoom-out"
          }}
        >
          <img
            src={lightboxUrl}
            alt="preview"
            style={{ maxWidth:"92vw", maxHeight:"92vh", objectFit:"contain", borderRadius:12, boxShadow:"0 10px 40px rgba(0,0,0,.5)" }}
          />
        </div>
      )}
    </div>
  );
}

/* helpers */
function labelOf(x){ return x?.name || x?.title || x?.label || ""; }
function badgeFor(result){
  const r = String(result||"").toLowerCase();
  return r==="fail" ? "chip chip-fail" : r==="pass" ? "chip chip-pass" : "chip chip-na";
}
function niceCase(s){
  const t = String(s||"").toLowerCase();
  if (t === "signoff") return "Sign-off";
  if (t === "standard") return "Standard";
  return t.replace(/[-_]/g, " ").replace(/\b\w/g, m => m.toUpperCase());
}

/** Try to resolve org branding from window, token, or API (best-effort, safe failures). */
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
function pickFirst(...vals){
  for (const v of vals){
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
function stringOrEmpty(v){ return (typeof v === "string" && v.trim()) ? v : ""; }
