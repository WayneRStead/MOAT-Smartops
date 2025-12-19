// core-frontend/src/components/InspectionRunner.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { runForm as apiRunForm } from "../lib/inspectionApi.js";

// ---------- EDIT THESE IF YOUR API PATHS DIFFER ----------
const ENDPOINTS = {
  projects: "/api/projects",
  tasks: "/api/tasks", // prefer ?projectId=.. ; fallback /projects/:id/tasks
  milestonesQ: "/api/milestones", // optional fallback: ?taskId=...
  assessedUsers: "/api/inspections/candidates/assessed-users", // GL+ candidates
  assets: "/api/assets",
};
// --------------------------------------------------------

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const hasBarcodeDetector = () =>
  typeof window !== "undefined" && "BarcodeDetector" in window;

function dateValue(d) {
  try {
    if (!d) return "";
    const dt = typeof d === "string" ? new Date(d) : d;
    return dt.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function authedHeaders() {
  const token = localStorage.getItem("token");
  const orgId = localStorage.getItem("orgId");
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(orgId ? { "X-Org-Id": orgId } : {}),
  };
}

async function authedJsonGET(url, params) {
  const qs = params
    ? "?" +
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")
    : "";
  const res = await fetch(url + qs, {
    method: "GET",
    credentials: "include",
    headers: authedHeaders(),
  });
  if (!res.ok) throw new Error(`GET ${url}${qs} -> ${res.status}`);
  return res.json();
}

async function lookupAssetByQuery(q) {
  if (!q) return null;
  try {
    const rows = await authedJsonGET(ENDPOINTS.assets, { q });
    if (Array.isArray(rows) && rows.length) return rows[0];
  } catch {}
  return null;
}

function labelOf(obj) {
  return obj?.name || obj?.title || obj?.label || obj?.email || obj?.username || obj?._id || "";
}

function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function InspectionRunner({ form, onSubmit, onSaved }) {
  const subjectType = String(form?.subject?.type || "none").toLowerCase(); // none | vehicle | asset | performance
  const subjectLocked = !!form?.subject?.lockToId;
  const lockedLabel = form?.subject?.lockLabel || "";

  /* ----------------------------- item state ---------------------------- */
  const [items, setItems] = useState(() =>
    (form?.items || []).map((it) => ({
      tpl: {
        allowPhoto: !!it.allowPhoto,
        allowScan: !!it.allowScan,
        allowNote: it.allowNote !== undefined ? !!it.allowNote : true,
        requireEvidenceOnFail: !!it.requireEvidenceOnFail,
        requireCorrectiveOnFail:
          it.requireCorrectiveOnFail !== undefined ? !!it.requireCorrectiveOnFail : true,
        criticalOnFail: !!it.criticalOnFail,
      },
      label: it.label || "",
      result: "na",
      evidence: { photoUrl: "", scanRef: "", note: "" },
      correctiveAction: "",
      criticalTriggered: false,
      assetMatch: null,
      scanning: false,
    }))
  );

  useEffect(() => {
    setItems(
      (form?.items || []).map((it) => ({
        tpl: {
          allowPhoto: !!it.allowPhoto,
          allowScan: !!it.allowScan,
          allowNote: it.allowNote !== undefined ? !!it.allowNote : true,
          requireEvidenceOnFail: !!it.requireEvidenceOnFail,
          requireCorrectiveOnFail:
            it.requireCorrectiveOnFail !== undefined ? !!it.requireCorrectiveOnFail : true,
          criticalOnFail: !!it.criticalOnFail,
        },
        label: it.label || "",
        result: "na",
        evidence: { photoUrl: "", scanRef: "", note: "" },
        correctiveAction: "",
        criticalTriggered: false,
        assetMatch: null,
        scanning: false,
      }))
    );
  }, [form?._id]);

  /* ----------------------------- link state ---------------------------- */
  const isScoped = form?.scope?.type === "scoped";
  const [links, setLinks] = useState({
    projectId: isScoped ? form?.scope?.projectId || "" : "",
    taskId: isScoped ? form?.scope?.taskId || "" : "",
    milestoneId: isScoped ? form?.scope?.milestoneId || "" : "",
  });

  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [milestones, setMilestones] = useState([]);

  // Human-readable labels (so scoped renders actual names, not placeholders)
  const [selLabels, setSelLabels] = useState({ project: "", task: "", milestone: "" });

  // Load projects once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await authedJsonGET(ENDPOINTS.projects);
        if (!cancelled) setProjects(Array.isArray(p) ? p : []);
      } catch {
        if (!cancelled) setProjects([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load tasks when project changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!links.projectId) {
        if (!isScoped) setTasks([]);
        setMilestones([]);
        return;
      }
      try {
        const t = await authedJsonGET(ENDPOINTS.tasks, { projectId: links.projectId });
        if (!cancelled) setTasks(Array.isArray(t) ? t : []);
      } catch {
        try {
          const t2 = await authedJsonGET(`${ENDPOINTS.projects}/${links.projectId}/tasks`);
          if (!cancelled) setTasks(Array.isArray(t2) ? t2 : []);
        } catch {
          if (!cancelled) setTasks([]);
        }
      } finally {
        if (!cancelled) setMilestones([]);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links.projectId]);

  // Load milestones when task changes (with fallback)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!links.taskId) {
        if (!isScoped) setMilestones([]);
        return;
      }
      try {
        const m2 = await authedJsonGET(`${ENDPOINTS.tasks}/${links.taskId}/milestones`);
        if (!cancelled) setMilestones(Array.isArray(m2) ? m2 : []);
      } catch {
        try {
          const mQ = await authedJsonGET(ENDPOINTS.milestonesQ, { taskId: links.taskId });
          if (!cancelled) setMilestones(Array.isArray(mQ) ? mQ : []);
        } catch {
          if (!cancelled) setMilestones([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [links.taskId, isScoped]);

  // Resolve labels for scoped values or single fetch
  useEffect(() => {
    let cancelled = false;

    const currentProject = projects.find((p) => (p._id || p.id) === links.projectId) || null;
    const currentTask = tasks.find((t) => (t._id || t.id) === links.taskId) || null;
    const currentMilestone = milestones.find((m) => (m._id || m.id) === links.milestoneId) || null;

    const nextLabels = {
      project: labelOf(currentProject),
      task: labelOf(currentTask),
      milestone: labelOf(currentMilestone),
    };
    setSelLabels(nextLabels);

    (async () => {
      try {
        if (!isScoped) return;
        if (!nextLabels.project && links.projectId) {
          const p = await authedJsonGET(`${ENDPOINTS.projects}/${links.projectId}`);
          if (!cancelled) setSelLabels((s) => ({ ...s, project: labelOf(p) }));
        }
        if (!nextLabels.task && links.taskId) {
          const t = await authedJsonGET(`${ENDPOINTS.tasks}/${links.taskId}`);
          if (!cancelled) setSelLabels((s) => ({ ...s, task: labelOf(t) }));
        }
        if (!nextLabels.milestone && links.taskId && links.milestoneId) {
          try {
            const mlist = await authedJsonGET(`${ENDPOINTS.tasks}/${links.taskId}/milestones`);
            const m = Array.isArray(mlist) ? mlist.find((x) => (x._id || x.id) === links.milestoneId) : null;
            if (!cancelled && m) setSelLabels((s) => ({ ...s, milestone: labelOf(m) }));
          } catch {
            try {
              const mQ = await authedJsonGET(ENDPOINTS.milestonesQ, { taskId: links.taskId });
              const m = Array.isArray(mQ) ? mQ.find((x) => (x._id || x.id) === links.milestoneId) : null;
              if (!cancelled && m) setSelLabels((s) => ({ ...s, milestone: labelOf(m) }));
            } catch {}
          }
        }
      } catch {}
    })();

    return () => { cancelled = true; };
  }, [projects, tasks, milestones, links, isScoped]);

  /* ----------------------------- SUBJECT UI ----------------------------- */
  // Vehicle/Asset dynamic choice (when not locked)
  const [subjectId, setSubjectId] = useState("");        // free text id/code
  const [subjectLabel, setSubjectLabel] = useState("");  // friendly label
  const [assetLookupBusy, setAssetLookupBusy] = useState(false);

  // Performance assessed user (when not locked)
  const [assessedQuery, setAssessedQuery] = useState("");
  const debQ = useDebounced(assessedQuery, 250);
  const [assessedOptions, setAssessedOptions] = useState([]);
  const [assessedId, setAssessedId] = useState("");      // selected user id
  const [assessedName, setAssessedName] = useState("");  // selected name/email label

  // If locked in form, pre-populate subject fields
  useEffect(() => {
    if (subjectLocked) {
      setSubjectId(String(form?.subject?.lockToId || ""));
      setSubjectLabel(lockedLabel || String(form?.subject?.lockToId || ""));
      setAssessedId(String(form?.subject?.lockToId || ""));
      setAssessedName(lockedLabel || String(form?.subject?.lockToId || ""));
    } else {
      // clear on form change
      setSubjectId("");
      setSubjectLabel("");
      setAssessedId("");
      setAssessedName("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?._id, subjectLocked]);

  // Search GL+ users for Performance
  useEffect(() => {
    let cancelled = false;
    if (subjectType !== "performance" || subjectLocked) return;
    (async () => {
      try {
        const rows = await authedJsonGET(ENDPOINTS.assessedUsers, {
          minRole: "group-leader",
          q: debQ || "",
          limit: 50,
        });
        if (!cancelled) setAssessedOptions(Array.isArray(rows) ? rows : []);
      } catch {
        if (!cancelled) setAssessedOptions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [debQ, subjectType, subjectLocked]);

  async function tryAssetLookup() {
    if (!subjectId || subjectType === "performance" || subjectLocked) return;
    setAssetLookupBusy(true);
    try {
      const asset = await lookupAssetByQuery(subjectId.trim());
      if (asset) {
        setSubjectLabel(labelOf(asset));
      } else {
        // keep whatever was typed
        if (!subjectLabel) setSubjectLabel(subjectId.trim());
      }
    } finally {
      setAssetLookupBusy(false);
    }
  }

  /* ------------------------- GEO (lat/lng capture) ------------------------- */
  const [geo, setGeo] = useState({ lat: null, lng: null, status: "idle" }); // idle | ok | denied | error
  useEffect(() => {
    let mounted = true;
    if (!navigator.geolocation) {
      if (mounted) setGeo((g) => ({ ...g, status: "error" }));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!mounted) return;
        const { latitude, longitude } = pos.coords || {};
        setGeo({ lat: latitude ?? null, lng: longitude ?? null, status: "ok" });
      },
      () => {
        if (!mounted) setGeo((g) => ({ ...g, status: "error" }));
        else setGeo((g) => ({ ...g, status: "denied" }));
      },
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 60000 }
    );
    return () => { mounted = false; };
  }, []);

  /* --------------------- follow-up / signature / save -------------------- */
  const [followUpDate, setFollowUpDate] = useState(null);
  const [confirmNote, setConfirmNote] = useState(false);
  const currentUser = window.__CURRENT_USER__ || { name: "Inspector", email: "", roles: ["user"] };
  const [signName, setSignName] = useState(currentUser.name || currentUser.email || "");
  const [signatureDataUrl, setSignatureDataUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    let drawing = false;
    function start(e) {
      drawing = true;
      const rect = canvas.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
      ctx.beginPath();
      ctx.moveTo(x, y);
    }
    function move(e) {
      if (!drawing) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    function end() {
      drawing = false;
      setSignatureDataUrl(canvas.toDataURL("image/png"));
    }
    canvas.addEventListener("mousedown", start);
    canvas.addEventListener("mousemove", move);
    canvas.addEventListener("mouseup", end);
    canvas.addEventListener("mouseleave", end);
    canvas.addEventListener("touchstart", start, { passive: true });
    canvas.addEventListener("touchmove", move, { passive: true });
    canvas.addEventListener("touchend", end);
    return () => {
      canvas.removeEventListener("mousedown", start);
      canvas.removeEventListener("mousemove", move);
      canvas.removeEventListener("mouseup", end);
      canvas.removeEventListener("mouseleave", end);
      canvas.removeEventListener("touchstart", start);
      canvas.removeEventListener("touchmove", move);
      canvas.removeEventListener("touchend", end);
    };
  }, []);

  const setItem = (idx, patch) => {
    setItems((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const setItemEvidence = (idx, evPatch) => {
    setItems((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, evidence: { ...r.evidence, ...evPatch } } : r))
    );
  };

  const handleResult = (idx, val) => {
    const tpl = items[idx].tpl;
    const isFail = val === "fail";
    setItem(idx, {
      result: val,
      criticalTriggered: isFail && tpl.criticalOnFail ? true : false,
    });
  };

  async function handlePhoto(idx, file) {
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    setItemEvidence(idx, { photoUrl: dataUrl });
  }

  async function handleScanLookup(idx) {
    const code = items[idx]?.evidence?.scanRef || "";
    if (!code.trim()) return;
    try {
      const asset = await lookupAssetByQuery(code.trim());
      setItem(idx, { assetMatch: asset || null });
    } catch {
      setItem(idx, { assetMatch: null });
    }
  }

  function Scanner({ onClose, onDetected }) {
    const videoRef = useRef(null);
    const rafRef = useRef(0);
    const [err, setErr] = useState("");
    useEffect(() => {
      let stream;
      let detector;
      let cancelled = false;
      const start = async () => {
        try {
          if (!hasBarcodeDetector()) {
            setErr("This browser doesn't support camera barcode scanning. Type the code manually.");
            return;
          }
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false,
          });
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            await videoRef.current.play();
          }
          detector = new window.BarcodeDetector({
            formats: ["qr_code", "code_128", "ean_13", "upc_a"],
          });
          const tick = async () => {
            if (cancelled) return;
            try {
              const bitmap = await createImageBitmap(videoRef.current);
              const codes = await detector.detect(bitmap);
              if (codes && codes.length) {
                onDetected(codes[0].rawValue || "");
                return;
              }
            } catch {}
            rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
        } catch {
          setErr("Unable to access camera. Type the code manually.");
        }
      };
      start();
      return () => {
        cancelled = true;
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        if (videoRef.current) videoRef.current.pause();
        if (stream) stream.getTracks().forEach((t) => t.stop());
      };
    }, [onDetected]);
    return (
      <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center">
        <div className="bg-white rounded-xl p-4 w/full max-w-md">
          <div className="flex items-center justify-between mb-2">
            <div className="font-medium">Scan code</div>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
          </div>
          {err ? <div className="text-sm text-red-600">{err}</div> : <video ref={videoRef} className="w-full rounded" />}
          <p className="mt-2 text-xs text-gray-500">
            Point the camera at a QR/barcode. If nothing happens, type the code manually.
          </p>
        </div>
      </div>
    );
  }
  const [scannerForIdx, setScannerForIdx] = useState(null);

  // Photo lightbox
  const [lightboxUrl, setLightboxUrl] = useState("");

  function validateBeforeSave() {
    let needsFollowUp = false;
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      if (r.result === "fail") {
        if (r.tpl.requireEvidenceOnFail) {
          const hasAny = !!(r.evidence.photoUrl || r.evidence.scanRef || r.evidence.note);
          if (!hasAny) return { ok: false, message: `Item ${i + 1} requires evidence on Fail.` };
        }
        if (r.tpl.requireCorrectiveOnFail) {
          if (!String(r.correctiveAction || "").trim()) {
            return { ok: false, message: `Item ${i + 1} requires a corrective action on Fail.` };
          }
        }
        if (r.tpl.criticalOnFail) needsFollowUp = true;
      }
    }
    if (needsFollowUp && !followUpDate) {
      return { ok: false, message: "A follow-up date is required due to critical failures." };
    }
    if (!confirmNote) return { ok: false, message: "Please confirm the accuracy note before saving." };
    if (!signName.trim()) return { ok: false, message: "Inspector name is required." };

    // Subject validations when not locked:
    if (!subjectLocked) {
      if (subjectType === "performance") {
        if (!assessedId) return { ok: false, message: "Please select a user to assess." };
      } else if (subjectType === "vehicle" || subjectType === "asset") {
        if (!subjectId) return { ok: false, message: `Please select a ${subjectType}.` };
      }
    }
    return { ok: true };
  }

  async function handleSave() {
    setError("");
    const chk = validateBeforeSave();
    if (!chk.ok) { setError(chk.message); return; }
    setSaving(true);
    try {
      // subjectAtRun
      let subjectAtRun = { type: "none" };
      if (subjectType !== "none") {
        if (subjectLocked) {
          subjectAtRun = {
            type: subjectType,
            id: form?.subject?.lockToId,
            label: lockedLabel || "",
          };
        } else if (subjectType === "performance") {
          subjectAtRun = { type: "performance", id: assessedId, label: assessedName || "" };
        } else {
          // vehicle/asset
          subjectAtRun = { type: subjectType, id: subjectId, label: subjectLabel || subjectId };
        }
      }

      const payload = {
        links,
        subjectAtRun,
        // include location for backend KMZ/geo
        ...(Number.isFinite(+geo.lat) && Number.isFinite(+geo.lng)
          ? { lat: +geo.lat, lng: +geo.lng }
          : {}),
        items: items.map((r, idx) => ({
          // send itemId so backend can match template exactly
          itemId: form?.items?.[idx]?._id,
          label: r.label,
          result: r.result,
          evidence: {
            photoUrl: r.evidence.photoUrl || "",
            scanRef: r.evidence.scanRef || "",
            note: r.evidence.note || "",
          },
          correctiveAction: r.correctiveAction || "",
          criticalOnFail: !!r.tpl.criticalOnFail,
        })),
        followUpDate: followUpDate || null,
        signoff: {
          confirmed: true,
          name: signName,
          date: new Date().toISOString(),
          signatureDataUrl: signatureDataUrl || "",
        },
      };

      const submission = onSubmit
        ? await onSubmit(payload)
        : await apiRunForm(form._id, payload);

      if (onSaved) onSaved(submission);
      alert("Inspection saved.");
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const overall = useMemo(() => {
    let hasFail = false;
    for (const it of items) if (it.result === "fail") { hasFail = true; break; }
    return hasFail ? "fail" : "pass";
  }, [items]);

  // Selected state: dark gray + white text
  const choiceBtn = (Type, current) =>
    `btn btn-xs ${
      current === Type
        ? "bg-gray-800 text-white border-gray-800 hover:bg-gray-700 hover:border-gray-700"
        : "btn-outline"
    }`;

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="rounded-xl border p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-medium">{form?.title}</div>
            {form?.description && <div className="text-sm text-gray-600">{form.description}</div>}
          </div>
          <div className={`text-sm font-semibold ${overall === "pass" ? "text-green-600" : "text-red-600"}`}>
            {overall.toUpperCase()}
          </div>
        </div>

        {/* Links (scoped shows resolved names) */}
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {/* Project */}
          <label className="block">
            <div className="text-sm font-medium">Project</div>
            {isScoped ? (
              <div className="input input-bordered bg-gray-50">{selLabels.project || "—"}</div>
            ) : (
              <select
                className="select select-bordered w-full"
                value={links.projectId}
                onChange={(e) => setLinks({ projectId: e.target.value, taskId: "", milestoneId: "" })}
              >
                <option value="">- Select project -</option>
                {projects.map((p) => (
                  <option key={p._id || p.id} value={p._id || p.id}>
                    {labelOf(p)}
                  </option>
                ))}
              </select>
            )}
          </label>

          {/* Task */}
          <label className="block">
            <div className="text-sm font-medium">Task</div>
            {isScoped ? (
              <div className="input input-bordered bg-gray-50">{selLabels.task || "—"}</div>
            ) : (
              <select
                className="select select-bordered w-full"
                value={links.taskId}
                onChange={(e) => setLinks((l) => ({ ...l, taskId: e.target.value, milestoneId: "" }))}
                disabled={!links.projectId}
              >
                <option value="">{links.projectId ? "- Select task -" : "- Select project first -"}</option>
                {tasks.map((t) => (
                  <option key={t._id || t.id} value={t._id || t.id}>
                    {labelOf(t)}
                  </option>
                ))}
              </select>
            )}
          </label>

          {/* Milestone */}
          <label className="block">
            <div className="text-sm font-medium">Milestone</div>
            {isScoped ? (
              <div className="input input-bordered bg-gray-50">{selLabels.milestone || "—"}</div>
            ) : (
              <select
                className="select select-bordered w-full"
                value={links.milestoneId}
                onChange={(e) => setLinks((l) => ({ ...l, milestoneId: e.target.value }))}
                disabled={!links.taskId}
              >
                <option value="">{links.taskId ? "- Select milestone -" : "- Select task first -"}</option>
                {milestones.map((m) => (
                  <option key={m._id || m.id} value={m._id || m.id}>
                    {labelOf(m)}
                  </option>
                ))}
              </select>
            )}
          </label>
        </div>

        {/* Subject selector */}
        {subjectType !== "none" && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-sm font-medium capitalize">
                {subjectType === "performance" ? "Assessed User (GL+)" : subjectType}
              </div>

              {/* Locked subject */}
              {subjectLocked ? (
                <div className="input input-bordered bg-gray-50">{lockedLabel || subjectId || "Locked"}</div>
              ) : subjectType === "performance" ? (
                <>
                  <input
                    className="input input-bordered w-full mb-2"
                    placeholder="Search name or email…"
                    value={assessedQuery}
                    onChange={(e) => setAssessedQuery(e.target.value)}
                  />
                  <select
                    className="select select-bordered w-full"
                    value={assessedId}
                    onChange={(e) => {
                      const val = e.target.value;
                      setAssessedId(val);
                      const opt = assessedOptions.find((x) => String(x._id) === String(val));
                      setAssessedName(opt ? (opt.name || opt.email || opt.username || val) : "");
                    }}
                  >
                    <option value="">- Select user -</option>
                    {assessedOptions.map((u) => (
                      <option key={u._id} value={u._id}>
                        {u.name || u.email || u.username || u._id}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <>
                  <div className="flex gap-2">
                    <input
                      className="input input-bordered w-full"
                      placeholder={`Enter ${subjectType} id / code / name…`}
                      value={subjectId}
                      onChange={(e) => setSubjectId(e.target.value)}
                      onBlur={tryAssetLookup}
                    />
                    <button
                      type="button"
                      className={`btn btn-outline ${assetLookupBusy ? "loading" : ""}`}
                      onClick={tryAssetLookup}
                      disabled={!subjectId}
                    >
                      Lookup
                    </button>
                  </div>
                  {subjectLabel ? (
                    <div className="text-xs text-gray-600 mt-1">Selected: {subjectLabel}</div>
                  ) : (
                    <div className="text-xs text-gray-400 mt-1">Will use the typed value if not found.</div>
                  )}
                </>
              )}
            </div>

            {/* Geo display */}
            <div>
              <div className="text-sm font-medium">Location (auto)</div>
              <div className="input input-bordered bg-gray-50">
                {geo.status === "ok" && Number.isFinite(+geo.lat) && Number.isFinite(+geo.lng)
                  ? `${geo.lat.toFixed(6)}, ${geo.lng.toFixed(6)}`
                  : geo.status === "denied"
                  ? "Permission denied (location optional)"
                  : "Capturing…"}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Items */}
      <div className="space-y-3">
        {items.map((r, idx) => (
          <div key={idx} className="rounded-xl border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="font-medium">
                {idx + 1}. {r.label || `Item ${idx + 1}`}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className={choiceBtn("pass", r.result)} aria-pressed={r.result === "pass"} onClick={() => handleResult(idx, "pass")}>
                  Pass
                </button>
                <button type="button" className={choiceBtn("na", r.result)} aria-pressed={r.result === "na"} onClick={() => handleResult(idx, "na")}>
                  N/A
                </button>
                <button type="button" className={choiceBtn("fail", r.result)} aria-pressed={r.result === "fail"} onClick={() => handleResult(idx, "fail")}>
                  Fail
                </button>
              </div>
            </div>

            {/* Evidence */}
            <div className="grid gap-3 sm:grid-cols-3">
              {r.tpl.allowPhoto && (
                <div>
                  <div className="text-sm font-medium">Photo</div>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="file-input file-input-bordered file-input-sm w-full"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) await handlePhoto(idx, f);
                    }}
                  />
                  {r.evidence.photoUrl && (
                    <img
                      src={r.evidence.photoUrl}
                      alt="evidence"
                      className="mt-2 border rounded max-h-24 max-w-full object-contain cursor-zoom-in"
                      onClick={() => setLightboxUrl(r.evidence.photoUrl)}
                    />
                  )}
                </div>
              )}

              {r.tpl.allowScan && (
                <div>
                  <div className="text-sm font-medium">Scan (QR/Barcode/RFID code)</div>
                  <div className="flex gap-2">
                    <input
                      className="input input-bordered input-sm flex-1"
                      placeholder="Enter or scan a code…"
                      value={r.evidence.scanRef}
                      onChange={(e) => setItemEvidence(idx, { scanRef: e.target.value })}
                    />
                    {hasBarcodeDetector() && (
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => setScannerForIdx(idx)}
                        title="Scan using camera"
                      >
                        Scan
                      </button>
                    )}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => handleScanLookup(idx)}>
                      Lookup asset
                    </button>
                    {r.assetMatch ? (
                      <span className="text-xs text-gray-600">
                        {r.assetMatch.name || r.assetMatch.title || "Asset"} —{" "}
                        {r.assetMatch.barcode || r.assetMatch.tag || r.assetMatch._id}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">No asset loaded</span>
                    )}
                  </div>
                </div>
              )}

              {r.tpl.allowNote && (
                <div>
                  <div className="text-sm font-medium">Note</div>
                  <textarea
                    className="textarea textarea-bordered textarea-sm w-full"
                    rows={3}
                    placeholder="Optional note…"
                    value={r.evidence.note}
                    onChange={(e) => setItemEvidence(idx, { note: e.target.value })}
                  />
                </div>
              )}
            </div>

            {r.result === "fail" && (
              <div>
                <div className="text-sm font-medium">Corrective Action</div>
                <textarea
                  className="textarea textarea-bordered textarea-sm w-full"
                  rows={3}
                  placeholder="Describe the corrective action…"
                  value={r.correctiveAction}
                  onChange={(e) => setItem(idx, { correctiveAction: e.target.value })}
                />
              </div>
            )}

            {r.tpl.criticalOnFail && r.result === "fail" && (
              <div className="text-sm text-red-600">
                Critical failure — this will cause the inspection to fail. Please schedule a follow-up date below.
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Follow-up */}
      <div className="rounded-xl border p-4">
        <div className="font-medium mb-1">Follow-up (if any critical failures)</div>
        <input
          type="date"
          className="input input-bordered"
          value={dateValue(followUpDate)}
          onChange={(e) => setFollowUpDate(e.target.value ? new Date(e.target.value) : null)}
        />
      </div>

      {/* Confirmation / Signature */}
      <div className="rounded-xl border p-4 space-y-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={confirmNote} onChange={(e) => setConfirmNote(e.target.checked)} />
          <span>I confirm the above is accurate to the best of my knowledge.</span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <div className="text-sm font-medium">Inspector Name</div>
            <input className="input input-bordered w-full" value={signName} onChange={(e) => setSignName(e.target.value)} />
          </label>
          <label className="block">
            <div className="text-sm font-medium">Signature</div>
            <div className="border rounded overflow-hidden">
              <canvas ref={canvasRef} width={600} height={180} className="w-full h-32" />
            </div>
            <div className="mt-1">
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => {
                  const c = canvasRef.current;
                  if (c) {
                    const ctx = c.getContext("2d");
                    ctx.clearRect(0, 0, c.width, c.height);
                    setSignatureDataUrl("");
                  }
                }}
              >
                Clear
              </button>
            </div>
          </label>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      <div className="flex items-center justify-end gap-2">
        <button className="btn" onClick={() => window.print()}>
          Print / Export PDF
        </button>
        <button className={`btn btn-primary ${saving ? "loading" : ""}`} onClick={handleSave}>
          {saving ? "Saving…" : "Save inspection"}
        </button>
      </div>

      {/* Scanner modal */}
      {scannerForIdx != null && (
        <Scanner
          onClose={() => setScannerForIdx(null)}
          onDetected={(code) => {
            setItemEvidence(scannerForIdx, { scanRef: code || "" });
            setScannerForIdx(null);
          }}
        />
      )}

      {/* Photo lightbox */}
      {lightboxUrl && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center" onClick={() => setLightboxUrl("")}>
          <img src={lightboxUrl} alt="preview" className="max-w-[90vw] max-h-[90vh] object-contain rounded shadow-lg" />
        </div>
      )}
    </div>
  );
}
