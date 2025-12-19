// src/components/InspectionRunner.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api, listProjects, listProjectTasks, listTaskMilestones } from "../lib/api";

// feature detection
const hasBarcode = typeof window !== "undefined" && "BarcodeDetector" in window;
const hasNfc = typeof window !== "undefined" && "NDEFReader" in window;

function normalizeTemplate(tpl) {
  if (!tpl) return null;
  const fields = Array.isArray(tpl.fields) ? tpl.fields : [];

  const norm = fields.map((f, idx) => {
    const baseType  = String(f.type || "passfail").toLowerCase();
    const valueType = baseType === "number" ? "number" : baseType === "text" ? "text" : null;

    const allowPhoto = !!(f.allowPhoto || f.photo);
    const allowScan  = !!(f.allowScan  || f.scan  || f.type === "scan");
    const allowText  = !!(f.allowText  || f.text);

    const reqOnFail = {
      note:  !!(f.failReqNote  || f.requireOnFailNote  || f.requireNoteOnFail  || f.reqOnFailNote  || (f.failReqs?.note)),
      photo: !!(f.failReqPhoto || f.requireOnFailPhoto || f.requirePhotoOnFail || f.reqOnFailPhoto || (f.failReqs?.photo)),
      scan:  !!(f.failReqScan  || f.requireOnFailScan  || f.requireScanOnFail  || f.reqOnFailScan  || (f.failReqs?.scan)),
      value: !!(f.failReqValue || f.requireOnFailValue || f.requireValueOnFail || f.reqOnFailValue || (f.failReqs?.value)),
    };

    const critical = !!(f.critical || f.isCritical);

    return {
      id: String(f.id || f._id || idx),
      label: f.label || f.title || `Question ${idx + 1}`,
      type: "passfail",
      required: !!f.required,
      allowPhoto,
      allowScan,
      allowText,
      valueType,
      reqOnFail,
      critical,
      meta: f.meta || {},
    };
  });

  const formType = (tpl.formType || tpl.type || "standard").toLowerCase();
  return { ...tpl, fields: norm, formType };
}

function readFilesAsDataURLs(files) {
  const list = Array.from(files || []);
  return Promise.all(
    list.map(
      (file) =>
        new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res({ name: file.name, type: file.type, dataUrl: r.result });
          r.onerror = rej;
          r.readAsDataURL(file);
        })
    )
  );
}

export default function InspectionRunner({
  template,
  projectId: projectIdProp,
  taskId: taskIdProp,
  onSaved,
  pmNoteEnabled = true,
}) {
  const tpl = useMemo(() => normalizeTemplate(template), [template]);

  const blankAns = { result: null, pass: null, note: "", scans: [], photos: [], value: "", extraText: "" };
  const [answers, setAnswers] = useState(() => new Map());

  // Header selections
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [milestones, setMilestones] = useState([]);

  const scopedProjectId = String(tpl?.scope?.projectIds?.[0] ?? "") || null;
  const scopedTaskId = String(tpl?.scope?.taskIds?.[0] ?? "") || null;
  const isGlobal = !!tpl?.scope?.isGlobal || (!scopedProjectId && !scopedTaskId);

  const [projectId, setProjectId] = useState(projectIdProp || scopedProjectId || "");
  const [taskId, setTaskId] = useState(taskIdProp || scopedTaskId || "");
  const [milestoneId, setMilestoneId] = useState("");

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [pmNote, setPmNote] = useState("");
  const [startedAt] = useState(() => new Date().toISOString());
  const [followUpAt, setFollowUpAt] = useState(""); // required when signoff + critical failure

  // init answers
  useEffect(() => {
    const m = new Map();
    tpl?.fields.forEach((f) => m.set(f.id, { ...blankAns }));
    setAnswers(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpl]);

  // load projects for global forms
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!isGlobal) return;
      try { const ps = await listProjects({ limit: 1000 }); if (alive) setProjects(ps); } catch {}
    })();
    return () => { alive = false; };
  }, [isGlobal]);

  // load tasks by project
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!projectId) { setTasks([]); setTaskId(""); return; }
        const ts = await listProjectTasks(projectId, { limit: 1000 });
        if (alive) setTasks(ts);
      } catch { if (alive) setTasks([]); }
    })();
    return () => { alive = false; };
  }, [projectId]);

  // load milestones by task
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!taskId) { setMilestones([]); setMilestoneId(""); return; }
        const ms = await listTaskMilestones(taskId);
        if (alive) setMilestones(ms);
      } catch { if (alive) setMilestones([]); }
    })();
    return () => { alive = false; };
  }, [taskId]);

  if (!tpl) return <div className="text-gray-600">Loading…</div>;

  function setResult(id, result) {
    setAnswers((prev) => {
      const next = new Map(prev);
      const cur = next.get(id) || { ...blankAns };
      let passVal = null;
      if (result === "pass") passVal = true;
      if (result === "fail") passVal = false;
      next.set(id, { ...cur, result, pass: passVal });
      return next;
    });
  }

  function upd(id, patch) {
    setAnswers((prev) => {
      const next = new Map(prev);
      const cur = next.get(id) || { ...blankAns };
      next.set(id, { ...cur, ...patch });
      return next;
    });
  }

  async function doScan(id) {
    setErr("");
    try {
      if (hasBarcode) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        const track = stream.getVideoTracks()[0];
        if (typeof ImageCapture === "undefined") {
          track.stop();
          throw new Error("Camera capture not supported by this browser.");
        }
        const imageCapture = new ImageCapture(track);
        const det = new window.BarcodeDetector({
          formats: ["qr_code", "code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e"],
        });
        const photo = await imageCapture.grabFrame();
        track.stop();
        const codes = await det.detect(photo);
        if (codes && codes.length) {
          const val = codes.map((c) => c.rawValue).join(", ");
          upd(id, { scans: [ ...(answers.get(id)?.scans || []), { type: "barcode", value: val, at: new Date().toISOString() } ] });
          return;
        }
        setErr("Nothing detected from camera. Try again or use manual entry.");
        return;
      }
      if (hasNfc) {
        const reader = new window.NDEFReader();
        await reader.scan();
        reader.onreading = (event) => {
          let text = "";
          for (const rec of event.message.records) {
            try { text += new TextDecoder().decode(rec.data); } catch {}
          }
          upd(id, { scans: [ ...(answers.get(id)?.scans || []), { type: "nfc", value: text || "(nfc tag)", at: new Date().toISOString() } ] });
        };
        return;
      }
      setErr("Scanning not supported on this device/browser.");
    } catch (e) {
      setErr(e?.message || "Scan failed");
    }
  }

  // validation
  function validateBeforeSave() {
    for (const f of tpl.fields) {
      const a = answers.get(f.id);
      if (f.required && (!a || a.result == null)) {
        return `Please answer: ${f.label}`;
      }
    }

    const criticalFailed = tpl.fields.some((f) => {
      const a = answers.get(f.id);
      return f.critical && a?.result === "fail";
    });

    for (const f of tpl.fields) {
      const a = answers.get(f.id) || {};
      if (a.result !== "fail") continue;

      if (f.reqOnFail?.note && !a.note?.trim())             return `Corrective action required for: ${f.label}`;
      if (f.reqOnFail?.photo && !(Array.isArray(a.photos) && a.photos.length)) return `At least one photo is required for: ${f.label}`;
      if (f.reqOnFail?.scan &&  !(Array.isArray(a.scans)  && a.scans.length))  return `A scan/code is required for: ${f.label}`;
      if (f.reqOnFail?.value) {
        if (f.valueType === "number") {
          if (!Number.isFinite(Number(a.value))) return `A numeric value is required for: ${f.label}`;
        } else if (!String(a.value ?? "").trim()) return `A value is required for: ${f.label}`;
      }
    }

    if (tpl.formType === "signoff" && criticalFailed && !followUpAt) {
      return "Follow-up date is required when a critical item fails.";
    }
    return "";
  }

  async function attachPhotos(id, files) {
    try {
      const arr = await readFilesAsDataURLs(files);
      const prev = answers.get(id)?.photos || [];
      upd(id, { photos: [...prev, ...arr] });
    } catch (e) {
      setErr(e?.message || "Failed to read photos");
    }
  }

  async function save() {
    setErr("");
    const v = validateBeforeSave();
    if (v) { setErr(v); return; }

    setSaving(true);
    try {
      const now = new Date().toISOString();
      const criticalFailed = tpl.fields.some((f) => {
        const a = answers.get(f.id);
        return f.critical && a?.result === "fail";
      });

      const payload = {
        templateId: tpl._id || tpl.id,
        templateTitle: tpl.title || tpl.name,
        formType: tpl.formType, // "standard" | "signoff"
        projectId: projectId || null,
        taskId: taskId || null,
        milestoneId: milestoneId || "",
        startedAt,
        submittedAt: now,
        managerNote: pmNote || "",
        status: (tpl.formType === "signoff" && criticalFailed) ? "needs-follow-up" : "submitted",
        signoff: (tpl.formType === "signoff") ? {
          criticalFailed,
          followUpAt: criticalFailed ? followUpAt : null,
        } : undefined,
        answers: tpl.fields.map((f) => {
          const a = answers.get(f.id) || {};
          return {
            fieldId: f.id,
            label: f.label,
            result: a.result ?? null,
            pass: a.pass,
            note: a.note || "",
            scans: a.scans || [],
            photos: a.photos || [],
            value: a.value ?? "",
            extraText: a.extraText ?? "",
            critical: !!f.critical,
          };
        }),
      };

      const { data } = await api.post("/inspections/submissions", payload);
      onSaved?.(data);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const pillBase = "px-3 py-1 rounded-full border text-sm cursor-pointer select-none";
  const pillSelected = { background: "#0f172a", color: "white", borderColor: "#0f172a" };
  const pillNeutral  = { background: "#f3f4f6", color: "#111827", borderColor: "#9ca3af" };

  return (
    <div className="print-container space-y-4">
      {/* Top bar (hidden on print) */}
      <div className="no-print flex items-center gap-2">
        <button type="button" className="px-3 py-2 border rounded" onClick={() => window.print()}>
          Print / Export
        </button>
        <button disabled={saving} className="px-3 py-2 border rounded disabled:opacity-50" onClick={save}>
          {saving ? "Saving…" : "Save inspection"}
        </button>
      </div>

      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold">{tpl.title || tpl.name}</h2>
        <div className="text-sm text-gray-600">
          Version {tpl.version ?? 1} · {isGlobal ? "Global form" : "Scoped form"} · Started {new Date(startedAt).toLocaleString()}
        </div>
      </div>

      {/* Project / Task / Milestone */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="text-sm block">
          Project
          {isGlobal ? (
            <select className="border p-2 w-full mt-1" value={projectId} onChange={(e)=>setProjectId(e.target.value)}>
              <option value="">— Select project —</option>
              {projects.map((p) => (
                <option key={p._id || p.id} value={p._id || p.id}>{p.name || p.title || p._id || p.id}</option>
              ))}
            </select>
          ) : (
            <input className="border p-2 w-full mt-1" disabled value={projectId || ""} />
          )}
        </label>

        <label className="text-sm block">
          Task
          {isGlobal ? (
            <select className="border p-2 w-full mt-1" value={taskId} onChange={(e)=>setTaskId(e.target.value)} disabled={!projectId}>
              <option value="">— Select task —</option>
              {tasks.map((t) => (
                <option key={t._id || t.id} value={t._id || t.id}>{t.title || t.name || t._id || t.id}</option>
              ))}
            </select>
          ) : (
            <input className="border p-2 w-full mt-1" disabled value={taskId || ""} />
          )}
        </label>

        <label className="text-sm block">
          Milestone
          <select className="border p-2 w-full mt-1" value={milestoneId} onChange={(e)=>setMilestoneId(e.target.value)} disabled={!taskId || milestones.length === 0}>
            <option value="">{milestones.length ? "— Select milestone —" : "No milestones"}</option>
            {milestones.map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
          </select>
        </label>
      </div>

      {err && <div className="text-red-600">{err}</div>}

      {/* Checklist */}
      <div className="space-y-3">
        {tpl.fields.map((f) => {
          const a = answers.get(f.id) || { ...blankAns };
          const failing = a.result === "fail";

          const needs = {
            note:  failing && f.reqOnFail?.note  && !(a.note || "").trim(),
            photo: failing && f.reqOnFail?.photo && !(Array.isArray(a.photos) && a.photos.length),
            scan:  failing && f.reqOnFail?.scan  && !(Array.isArray(a.scans)  && a.scans.length),
            value: failing && f.reqOnFail?.value && (f.valueType === "number" ? !Number.isFinite(Number(a.value)) : !String(a.value ?? "").trim()),
          };

          return (
            <div key={f.id} className="border rounded p-3 space-y-3 print-break-avoid">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium">
                  {f.label} {f.critical && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">CRITICAL</span>}
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <button type="button" className={pillBase} style={a.result === "pass" ? pillSelected : pillNeutral} onClick={()=>setResult(f.id,"pass")}>Pass</button>
                  <button type="button" className={pillBase} style={a.result === "fail" ? pillSelected : pillNeutral} onClick={()=>setResult(f.id,"fail")}>Fail</button>
                  <button type="button" className={pillBase} style={a.result === "na"   ? pillSelected : pillNeutral} onClick={()=>setResult(f.id,"na")}>N/A</button>
                </div>
              </div>

              {/* Optional extra text (independent of fail) */}
              {f.allowText && (
                <label className="text-sm block">
                  Additional text
                  <input className="border p-2 w-full mt-1" type="text" value={a.extraText || ""} onChange={(e)=>upd(f.id,{extraText:e.target.value})} placeholder="Enter details…" />
                </label>
              )}

              {/* Evidence — now ONLY visible when the item FAILS */}
              {failing && (f.allowScan || f.allowPhoto || f.valueType) && (
                <div className="space-y-3">
                  {/* Value */}
                  {f.valueType && (
                    <label className="text-sm block">
                      {f.valueType === "number" ? "Measured value" : "Value"}
                      <input
                        className="border p-2 w-full mt-1"
                        type={f.valueType === "number" ? "number" : "text"}
                        value={a.value ?? ""}
                        onChange={(e)=>upd(f.id,{value:e.target.value})}
                        placeholder={f.valueType === "number" ? "0.0" : "Type a value…"}
                      />
                      {needs.value && <div className="text-xs text-red-600 mt-1">Required on fail</div>}
                    </label>
                  )}

                  {/* Scan */}
                  {f.allowScan && (
                    <div className="flex items-end gap-2">
                      <label className="text-sm flex-1">
                        Scan / code value (manual)
                        <input
                          className="border p-2 w-full mt-1"
                          value={a.scans?.[a.scans.length - 1]?.value || ""}
                          onChange={(e)=>{
                            const last = { type: "manual", value: e.target.value, at: new Date().toISOString() };
                            const prev = (a.scans || []).filter((s)=>s.type!=="manual");
                            upd(f.id, { scans: [...prev, last] });
                          }}
                          placeholder="Scan result or enter value…"
                        />
                        {needs.scan && <div className="text-xs text-red-600 mt-1">Required on fail</div>}
                      </label>
                      <button type="button" className="px-3 py-2 border rounded" onClick={()=>doScan(f.id)} title="Use device camera / NFC when supported">Scan</button>
                    </div>
                  )}

                  {/* Photos */}
                  {f.allowPhoto && (
                    <div className="text-sm">
                      <label className="block">
                        Add photos
                        <input className="border p-2 w-full mt-1" type="file" accept="image/*" multiple onChange={(e)=>attachPhotos(f.id, e.target.files)} />
                      </label>
                      {(a.photos || []).length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-2">
                          {a.photos.map((p, i)=>(
                            <img key={i} src={p.dataUrl} alt={p.name} title={p.name} style={{ width:120, height:90, objectFit:"cover", borderRadius:6, border:"1px solid #ddd" }} />
                          ))}
                        </div>
                      )}
                      {needs.photo && <div className="text-xs text-red-600 mt-1">At least one photo required on fail</div>}
                    </div>
                  )}

                  {/* Corrective action */}
                  <label className="text-sm block">
                    Corrective action
                    <textarea className="border p-2 w-full mt-1" rows={3} value={a.note || ""} onChange={(e)=>upd(f.id,{note:e.target.value})} placeholder="Describe the corrective action…" />
                    {needs.note && <div className="text-xs text-red-600 mt-1">Required on fail</div>}
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* PM section + follow-up for sign-off failures */}
      {pmNoteEnabled && (
        <div className="space-y-3">
          {tpl.formType === "signoff" && tpl.fields.some(f => f.critical && (answers.get(f.id)?.result === "fail")) && (
            <label className="text-sm block">
              Follow-up inspection date (required — critical item failed)
              <input className="border p-2 w-full mt-1" type="date" value={followUpAt} onChange={(e)=>setFollowUpAt(e.target.value)} />
            </label>
          )}
          <label className="text-sm block">
            Project manager note (optional)
            <textarea className="border p-2 w-full mt-1" rows={3} value={pmNote} onChange={(e)=>setPmNote(e.target.value)} placeholder="PM commentary…" />
          </label>
        </div>
      )}
    </div>
  );
}
