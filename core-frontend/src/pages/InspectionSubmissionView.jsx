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
const CANON_ROLES = [
  "user",
  "group-leader",
  "project-manager",
  "manager",
  "admin",
  "superadmin",
];
function normalizeRole(r) {
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
function uniq(arr) {
  return Array.from(new Set(arr));
}
function getCurrentUserSafe() {
  // 1) Window
  let u = window.__CURRENT_USER__ || {};
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
  const roles = uniq(
    rawRoles
      .flatMap((v) => String(v).split(","))
      .map(normalizeRole)
      .filter(Boolean)
  );
  return { ...(u || {}), roles };
}
function isElevated(u) {
  return (u?.roles || []).some((r) =>
    ["project-manager", "manager", "admin", "superadmin"].includes(r)
  );
}

/* ===== Location helpers (robust across shapes) ===== */
function extractLocation(sub) {
  const candidates = [
    sub?.location,
    sub?.locationAtRun,
    sub?.coords,
    sub?.gps,
    sub?.metadata?.location,
    sub?.subjectAtRun?.location,
  ].filter(Boolean);

  for (const loc of candidates) {
    const lat = Number(loc.lat ?? loc.latitude);
    const lng = Number(loc.lng ?? loc.lon ?? loc.longitude);
    const accuracy = Number(loc.accuracy ?? loc.acc);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return {
        lat,
        lng,
        accuracy: Number.isFinite(accuracy) ? accuracy : undefined,
      };
    }
  }
  return null;
}
function formatLocation(loc) {
  if (!loc) return "";
  const acc = Number.isFinite(loc.accuracy) ? ` ±${Math.round(loc.accuracy)}m` : "";
  return `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}${acc}`;
}
function mapsHrefFrom(loc) {
  if (!loc) return "#";
  return `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
}

/* ===== Backend-aware URL normalizer (fixes Vercel vs Render /files/*) ===== */
function backendOrigin() {
  try {
    const b = (import.meta?.env?.VITE_API_BASE || "").trim();
    if (b) return b.replace(/\/$/, "");
  } catch {}
  try {
    const w = typeof window !== "undefined" ? window : {};
    if (w.__API_BASE__) return String(w.__API_BASE__).replace(/\/$/, "");
  } catch {}
  return "";
}
function appendBust(u, bust) {
  const v = String(bust || "").trim();
  if (!v) return u;
  return u.includes("?")
    ? `${u}&v=${encodeURIComponent(v)}`
    : `${u}?v=${encodeURIComponent(v)}`;
}
function toBackendUrl(url, bust) {
  const s = String(url || "").trim();
  if (!s) return "";

  // Absolute already
  if (/^https?:\/\//i.test(s)) return bust ? appendBust(s, bust) : s;

  // Relative: MUST be routed to backend origin, not frontend origin
  const base = backendOrigin();
  if (s.startsWith("/")) {
    const out = base ? `${base}${s}` : s;
    return bust ? appendBust(out, bust) : out;
  }

  // Legacy: treat as file path
  const out = base ? `${base}/files/${s}` : `/files/${s}`;
  return bust ? appendBust(out, bust) : out;
}

/* ===== Legacy logo path helper (turns org/.. into /files/org/..) ===== */
function resolveLogoPath(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return s;
  if (s.startsWith("files/")) return `/${s}`;
  if (s.startsWith("uploads/")) return `/${s}`;
  if (s.startsWith("org/")) return `/files/${s}`; // -> /files/org/<orgId>/logo
  return `/files/${s}`;
}

export default function InspectionSubmissionView() {
  const { subId, id } = useParams();
  const realId = subId || id;
  const TITLE = "Inspection Submission";
  const nav = useNavigate();

  const [sub, setSub] = useState(null);
  const [formMeta, setFormMeta] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  // backfill names (project/task/milestone)
  const [names, setNames] = useState({ project: "", task: "", milestone: "" });

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

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realId]);

  useEffect(() => {
    let cancelled = false;
    resolveOrgBranding().then(({ name, logo, bust }) => {
      if (cancelled) return;
      if (name) setOrgName(name);
      if (logo) {
        // Ensure logo is loaded from backend origin (Render) not frontend (Vercel)
        const normalized = toBackendUrl(resolveLogoPath(logo), bust || Date.now());
        setOrgLogoUrl(normalized);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function load() {
    setLoading(true);
    setErr("");
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
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function backfillNames({ projectId, taskId, milestoneId }) {
    try {
      if (projectId) {
        const { data } = await api.get(`/projects/${projectId}`);
        setNames((n) => ({ ...n, project: labelOf(data) || String(projectId) }));
      }
    } catch {}
    try {
      if (taskId) {
        const { data } = await api.get(`/tasks/${taskId}`);
        setNames((n) => ({ ...n, task: labelOf(data) || String(taskId) }));
      }
    } catch {}
    try {
      if (taskId && milestoneId) {
        const { data } = await api.get(`/tasks/${taskId}/milestones`);
        const m = (Array.isArray(data) ? data : []).find(
          (x) => String(x._id || x.id) === String(milestoneId)
        );
        setNames((n) => ({
          ...n,
          milestone: labelOf(m) || String(milestoneId),
        }));
      }
    } catch {}
  }

  async function saveComment() {
    if (!mgrNote.trim()) return;
    setSavingComment(true);
    setCommentErr("");
    setErr("");
    try {
      await addSubmissionComment(realId, mgrNote.trim());
      setMgrNote("");
      await load();
    } catch (e) {
      const m =
        e?.response?.data?.error ||
        e?.response?.data?.message ||
        e?.message ||
        "Failed to save comment";
      setCommentErr(m);
    } finally {
      setSavingComment(false);
    }
  }

  // delete / restore actions
  async function onSoftDelete() {
    if (!sub?._id) return;
    if (!confirm("Soft delete this submission?")) return;
    try {
      await softDeleteSubmission(sub._id);
      nav("/inspections");
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  }
  async function onHardDelete() {
    if (!sub?._id) return;
    if (!confirm("This will permanently delete the submission. Continue?")) return;
    try {
      await hardDeleteSubmission(sub._id);
      nav("/inspections");
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  }
  async function onRestore() {
    if (!sub?._id) return;
    try {
      await restoreSubmission(sub._id);
      await load();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  }

  const chip = useMemo(() => {
    const r = String(sub?.overallResult || "").toLowerCase();
    return r === "fail"
      ? "chip chip-fail"
      : r === "pass"
      ? "chip chip-pass"
      : "chip chip-na";
  }, [sub]);

  // Unified comments (managerComments preferred; legacy comments fallback)
  const comments = useMemo(() => {
    if (!sub) return [];
    if (Array.isArray(sub.managerComments) && sub.managerComments.length)
      return sub.managerComments;
    if (Array.isArray(sub.comments)) {
      return sub.comments.map((c) => ({
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
      return `Up to ${n} non-critical FAIL${n === 1 ? "" : "s"} allowed (critical auto-fail)`;
    }
    return "Any FAIL ⇒ overall FAIL (critical auto-fail)";
  };

  // Achieved score label
  const achievedLabel = useMemo(() => {
    if (!sub) return "";
    if (sub.scoringSummary?.percentScore != null) {
      const pct = (Math.round(sub.scoringSummary.percentScore * 10) / 10).toFixed(1);
      if (formMeta?.scoring?.mode === "tolerance") {
        const max = Number.isFinite(+formMeta.scoring.maxNonCriticalFails)
          ? +formMeta.scoring.maxNonCriticalFails
          : 0;
        return `${pct}% • Non-critical fails ${sub.scoringSummary.counts?.nonCriticalFails ?? "0"}/${max}`;
      }
      return `${pct}%`;
    }
    // fallback compute
    const items = Array.isArray(sub.items) ? sub.items : [];
    const applicable = items.filter((r) => (r.result || "").toLowerCase() !== "na");
    const totalApplicable = applicable.length;
    const passCount = applicable.filter((r) => r.result === "pass").length;
    const nonCriticalFailCount = applicable.filter(
      (r) => r.result === "fail" && !r.criticalTriggered
    ).length;
    const percent = totalApplicable ? (passCount / totalApplicable) * 100 : 100;
    const pct = (Math.round(percent * 10) / 10).toFixed(1);
    if (formMeta?.scoring?.mode === "tolerance") {
      const max = Number.isFinite(+formMeta.scoring.maxNonCriticalFails)
        ? +formMeta.scoring.maxNonCriticalFails
        : 0;
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
  const formTypeRaw = sub.formType || formMeta?.formType || "standard";
  const formTypeNice = niceCase(formTypeRaw);
  const description = formMeta?.description || "";
  const scoringRule = formMeta?.scoring ? ruleLabel(formMeta.scoring) : "";

  const subjectType = String(sub?.subjectAtRun?.type || "none");
  const subjectNice =
    subjectType === "none"
      ? "General"
      : subjectType === "vehicle"
      ? "Vehicle"
      : subjectType === "asset"
      ? "Asset"
      : "Performance";
  const subjectLabel = sub?.subjectAtRun?.label;

  // Location (if available)
  const loc = extractLocation(sub);
  const locTxt = formatLocation(loc);

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

        /* PRINT-ONLY */
        @media print {
          @page { margin: 10mm; }
          html, body { font-size: 11.5px; }

          /* Hide screen-only bits */
          .no-print{ display: none !important; }

          /* Use full width on paper: override Tailwind layout utilities */
          .max-w-7xl { max-width: none !important; }
          .mx-auto { margin-left: 0 !important; margin-right: 0 !important; }
          .p-4 { padding: 0 !important; }

          /* If the app shell is a 2-col grid, span all columns for print */
          main, .main, .app-content, .content, #root > * {
            grid-column: 1 / -1 !important;
          }

          /* Kill any leftover left offset from the shell */
          html, body, main, .main, .app-content, .content, #root > * {
            margin-left: 0 !important;
            padding-left: 0 !important;
            left: auto !important;
            transform: none !important;
            position: static !important;
            width: 100% !important;
            max-width: none !important;
          }

          /* Keep cards tidy for page breaks */
          .card{ padding: 10px !important; page-break-inside: avoid; break-inside: avoid; }
          .mt-3{ margin-top: 6px !important; }
          h1, h2 { margin: 6px 0 !important; }
          .row { gap: 8px !important; }
          .items-evidence img { max-height: 84px !important; }

          /* Print header on, screen header off (duplicate guard) */
          .print-header{ display: block; margin-bottom: 10px; }
          .hide-outcome-on-print{ display: none !important; }

          /* Ensure the container has no internal padding */
          .print-container{ padding: 0 !important; }
        }
      `}</style>

      {/* Title row (hide whole bar on print to avoid duplicate) */}
      <div className="row no-print">
        <div className="flex items-center gap-3">
          <Link to="/inspections" className="btn" title="Back to list">
            ← Back
          </Link>
          {orgLogoUrl ? (
            <img
              src={orgLogoUrl}
              alt={orgName ? `${orgName} logo` : "Logo"}
              style={{ height: 28, width: "auto" }}
            />
          ) : null}
          <h1 className="text-2xl font-semibold">{TITLE}</h1>
        </div>
        <div className="flex items-center gap-2">
          {loc && (
            <span className="pill" title={locTxt}>
              📍 {locTxt}
            </span>
          )}
          <button className="btn" onClick={() => exportKmz(realId, sub, names)}>
            Export KMZ
          </button>
          <span className="muted text-sm">{formTypeNice}</span>
          <div className={chip} title="Outcome">
            {(sub.overallResult || "—").toUpperCase()}
          </div>
          <button className="btn" onClick={() => window.print()}>
            Print / PDF
          </button>
        </div>
      </div>

      {/* Print header */}
      <div className="print-header">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {orgLogoUrl ? (
              <img
                src={orgLogoUrl}
                alt={orgName ? `${orgName} logo` : "Logo"}
                style={{ height: 24, width: "auto" }}
              />
            ) : null}
            <div style={{ fontSize: 20, fontWeight: 700 }}>{TITLE}</div>
          </div>
          <div className={chip} style={{ fontSize: 12 }}>
            {(sub.overallResult || "—").toUpperCase()}
          </div>
        </div>
      </div>

      {/* Meta card */}
      <div className="card mt-3">
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div>
            <div className="font-medium">
              <b>Form</b>: {sub.formTitle || "Form"}
            </div>
            <div className="muted text-sm meta-type">
              <b>Type</b>: {formTypeNice}
            </div>
          </div>
          <div className="text-right">
            <div>
              <b>Submitted:</b>{" "}
              {sub.createdAt ? new Date(sub.createdAt).toLocaleString() : "—"}
            </div>
          </div>
        </div>

        {/* Scope */}
        <div className="grid-3 mt-3">
          <div>
            <b>Project</b>: {headerProject}
          </div>
          <div>
            <b>Task</b>: {headerTask}
          </div>
          <div>
            <b>Milestone</b>: {headerMilestone}
          </div>
        </div>

        {/* Subject + Label */}
        <div className="mt-3 subject-row">
          <div>
            <b>Subject</b>: {subjectNice}
          </div>
          <div>
            <b>Label</b>: {subjectType !== "none" ? subjectLabel || "—" : "—"}
          </div>
        </div>

        {/* Location block (if available) */}
        {loc && (
          <div className="mt-3">
            <b>Location</b>:{" "}
            <span className="pill" title={locTxt}>
              📍 {locTxt}
            </span>{" "}
            <a className="muted" href={mapsHrefFrom(loc)} target="_blank" rel="noreferrer">
              Open in Maps
            </a>
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
            <div>
              <b>Rule</b>: {scoringRule}
            </div>
            <div className="right">
              <b>Achieved</b>: {achievedLabel}
            </div>
          </div>
        ) : null}

        <div className="mt-3 row">
          <div>
            <b>Inspector</b>: {sub.runBy?.name || "—"}
          </div>
          <div className="right hide-outcome-on-print">
            <b>Outcome</b>:{" "}
            <span className={chip}>{(sub.overallResult || "—").toUpperCase()}</span>
          </div>
        </div>

        {/* Admin actions: delete/restore (screen only) */}
        {canAdminSub && (
          <div className="mt-3 row no-print">
            <div className="muted">Admin</div>
            <div className="right flex gap-2">
              {!sub.isDeleted && (
                <>
                  <button className="btn" onClick={onSoftDelete}>
                    Soft Delete
                  </button>
                  <button className="btn btn-error" onClick={onHardDelete}>
                    Hard Delete
                  </button>
                </>
              )}
              {sub.isDeleted && (
                <button className="btn btn-primary" onClick={onRestore}>
                  Restore
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Items */}
      <div className="card mt-3">
        <h2 className="text-lg font-semibold">Items</h2>
        <div className="mt-2">
          {(sub.items || []).map((it, idx) => (
            <div
              key={it.itemId || idx}
              style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}
            >
              <div className="row">
                <div className="font-medium">
                  {idx + 1}. {it.label}
                </div>
                <div className={badgeFor(it.result)}>{(it.result || "NA").toUpperCase()}</div>
              </div>

              {/* Evidence */}
              <div className="grid-3 items-evidence mt-2">
                <div className="ev-photo">
                  <div className="muted">Photo</div>
                  {it.evidence?.photoUrl ? (
                    <img
                      src={it.evidence.photoUrl}
                      alt="evidence"
                      style={{
                        maxHeight: 96,
                        width: "auto",
                        objectFit: "contain",
                        borderRadius: 8,
                        border: "1px solid var(--border)",
                      }}
                    />
                  ) : (
                    <div>—</div>
                  )}
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
                <div className="mt-2 text-sm" style={{ color: "#991B1B" }}>
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
                style={{
                  maxHeight: 96,
                  width: "auto",
                  objectFit: "contain",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                }}
              />
            ) : (
              <div>—</div>
            )}
          </div>
          <div>
            <div className="muted">Name</div>
            <div>{sub.signoff?.name || sub.runBy?.name || "—"}</div>
          </div>
          <div>
            <div className="muted">Date</div>
            <div>
              {sub.signoff?.date ? new Date(sub.signoff.date).toLocaleDateString() : "—"}
            </div>
          </div>
        </div>
        {String(sub.overallResult || "").toLowerCase() === "fail" && (
          <div className="mt-2">
            <div className="muted">Follow-up inspection date</div>
            <div>
              {sub.followUpDate ? new Date(sub.followUpDate).toLocaleDateString() : "—"}
            </div>
          </div>
        )}
      </div>

      {/* Project Manager Comments */}
      <div className="card mt-3">
        <h2 className="text-lg font-semibold">Project Manager Comments</h2>

        {/* Existing comments */}
        {comments.length ? (
          <div className="mt-2">
            {comments.map((c, i) => (
              <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <div>
                  <b>{c.by?.name || "Manager"}</b>{" "}
                  <small className="muted">
                    ({c.at ? new Date(c.at).toLocaleString() : "—"})
                  </small>
                </div>
                <div className="mt-1">{c.comment}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted mt-1">No comments yet.</div>
        )}

        {/* Add new (screen only) */}
        <div className="mt-3 no-print">
          {commentErr ? <div className="text-red-600 mb-2">{commentErr}</div> : null}
          <textarea
            className="w-full"
            rows={3}
            placeholder={canComment ? "Add a manager note…" : "You don’t have permission to comment"}
            value={mgrNote}
            onChange={(e) => setMgrNote(e.target.value)}
            disabled={!canComment}
            style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}
          />
          <div className="row mt-2">
            <Link to="/inspections" className="muted">
              Back to list
            </Link>
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
        <div>
          © {new Date().getFullYear()} {orgName || ""}
        </div>
        <div className="right">Inspection powered by MOAT SmartOps</div>
      </div>
    </div>
  );
}

/* ===== helpers ===== */
function labelOf(x) {
  return x?.name || x?.title || x?.label || "";
}
function badgeFor(result) {
  const r = String(result || "").toLowerCase();
  return r === "fail" ? "chip chip-fail" : r === "pass" ? "chip chip-pass" : "chip chip-na";
}
function niceCase(s) {
  const t = String(s || "").toLowerCase();
  if (t === "signoff") return "Sign-off";
  if (t === "standard") return "Standard";
  return t.replace(/[-_]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/** Try to resolve org branding from window, token, or API (best-effort, safe failures). */
async function resolveOrgBranding() {
  // ✅ Prefer canonical endpoint first (returns stable logoUrl)
  try {
    const { data } = await api.get("/org", { params: { _ts: Date.now() } });
    const { name, logo } = extractOrgFields(data || {});
    const bust = data?.updatedAt || data?.logoUpdatedAt || "";
    if (name || logo) return { name, logo, bust };
  } catch {}

  const w = typeof window !== "undefined" ? window : {};
  const winCandidates = [
    w.__ORG__,
    w.__CURRENT_ORG__,
    w.__ORG_INFO__,
    (w.__CURRENT_USER__ || {}).org,
    (w.__CURRENT_USER__ || {}).organization,
  ].filter(Boolean);

  for (const c of winCandidates) {
    const { name, logo } = extractOrgFields(c);
    if (name || logo) return { name, logo, bust: "" };
  }

  try {
    const tok = localStorage.getItem("token");
    if (tok && tok.split(".").length === 3) {
      const payload = JSON.parse(atob(tok.split(".")[1] || ""));
      const { name, logo } = extractOrgFields(
        payload?.org || payload?.organization || payload || {}
      );
      if (name || logo) return { name, logo, bust: payload?.updatedAt || "" };
      if (payload?.orgName && typeof payload.orgName === "string") {
        return { name: payload.orgName, logo: "", bust: payload?.updatedAt || "" };
      }
    }
  } catch {}

  const endpoints = ["/admin/org", "/settings/org", "/organization", "/org/current"];
  for (const ep of endpoints) {
    try {
      const { data } = await api.get(ep, { params: { _ts: Date.now() } });
      const { name, logo } = extractOrgFields(data || {});
      const bust = data?.updatedAt || data?.logoUpdatedAt || "";
      if (name || logo) return { name, logo, bust };
    } catch {}
  }

  return { name: "", logo: "", bust: "" };
}

function extractOrgFields(obj) {
  // ✅ handle nested shapes: { org: {...} } or { organization: {...} }
  const o =
    obj && typeof obj === "object" && obj.org && typeof obj.org === "object"
      ? obj.org
      : obj &&
        typeof obj === "object" &&
        obj.organization &&
        typeof obj.organization === "object"
      ? obj.organization
      : obj;

  if (!o || typeof o !== "object") return { name: "", logo: "" };

  const name = pickFirst(
    o.name,
    o.orgName,
    o.company,
    o.displayName,
    o.settings?.name,
    o.profile?.name
  );
  const logo = pickFirst(
    o.logoUrl,
    o.logo,
    o.branding?.logoUrl,
    o.branding?.logo,
    o.assets?.logo,
    o.images?.logo,
    o.settings?.logoUrl
  );
  return { name: stringOrEmpty(name), logo: stringOrEmpty(logo) };
}
function pickFirst(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
function stringOrEmpty(v) {
  return typeof v === "string" && v.trim() ? v : "";
}

/* ---- Minimal KMZ packer (store-only ZIP) ---- */
function crc32(buf) {
  let c = (~0) >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function strToUint8(str) {
  return new TextEncoder().encode(str);
}
function u32(n) {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  b[2] = (n >>> 16) & 0xff;
  b[3] = (n >>> 24) & 0xff;
  return b;
}
function u16(n) {
  const b = new Uint8Array(2);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  return b;
}
function concatU8(arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
function makeKmz(kmlString, innerName = "doc.kml") {
  const fileNameBytes = strToUint8(innerName);
  const data = strToUint8(kmlString);
  const sigLocal = strToUint8("PK\u0003\u0004");
  const sigCD = strToUint8("PK\u0001\u0002");
  const sigEnd = strToUint8("PK\u0005\u0006");
  const version = u16(20);
  const flags = u16(0);
  const methodStore = u16(0); // no compression
  const time = u16(0),
    date = u16(0);
  const crc = u32(crc32(data));
  const size = u32(data.length);
  const nameLen = u16(fileNameBytes.length);
  const extraLen = u16(0);
  const commentLen = u16(0);
  const diskNum = u16(0);
  const intAttr = u16(0);
  const extAttr = u32(0);
  const relOffset = u32(0); // always 0 (single file)

  const localHeader = concatU8([
    sigLocal,
    version,
    flags,
    methodStore,
    time,
    date,
    crc,
    size,
    size,
    nameLen,
    extraLen,
    fileNameBytes,
  ]);
  const localOffset = 0;
  const afterLocalLen = localHeader.length + data.length;

  const cdHeader = concatU8([
    sigCD,
    u16(20),
    version,
    flags,
    methodStore,
    time,
    date,
    crc,
    size,
    size,
    nameLen,
    extraLen,
    commentLen,
    diskNum,
    intAttr,
    extAttr,
    u32(localOffset),
    fileNameBytes,
  ]);

  const cdSize = u32(cdHeader.length);
  const cdOffset = u32(afterLocalLen);
  const total = u16(1);
  const end = concatU8([sigEnd, diskNum, diskNum, total, total, cdSize, cdOffset, commentLen]);

  const zip = concatU8([localHeader, data, cdHeader, end]);
  return new Blob([zip], { type: "application/vnd.google-earth.kmz" });
}

/* ===== Export helpers (KMZ backend, KMZ fallback) ===== */
async function exportKmz(realId, submission, names) {
  // 1) Try backend KMZ first
  try {
    const res = await api.get(`/inspections/${realId}/export.kmz`, { responseType: "blob" });
    const blob =
      res.data instanceof Blob
        ? res.data
        : new Blob([res.data], { type: "application/vnd.google-earth.kmz" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inspection-${realId}.kmz`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return;
  } catch {
    // 2) Fallback to client-built KMZ
  }

  const kml = buildKmlFromSubmission(submission, names || {});
  const blob = makeKmz(kml, "inspection.kml");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inspection-${realId}.kmz`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildKmlFromSubmission(s, names = {}) {
  const loc = extractLocation(s);
  const title = s?.formTitle || s?.title || "Inspection";

  const whenRaw = s?.submittedAt || s?.createdAt || s?.completedAt || s?.finishedAt || s?.updatedAt;
  const whenIso = whenRaw ? new Date(whenRaw).toISOString() : "";
  const whenHuman = whenRaw ? new Date(whenRaw).toLocaleString() : "";

  const links = s?.links || {};
  const proj = names.project || links.projectId || "";
  const task = names.task || links.taskId || "";
  const milestone = names.milestone || links.milestoneId || "";

  const subjectTypeRaw = String(s?.subjectAtRun?.type || "none");
  const subjectNice =
    subjectTypeRaw === "none"
      ? "General"
      : subjectTypeRaw === "vehicle"
      ? "Vehicle"
      : subjectTypeRaw === "asset"
      ? "Asset"
      : "Performance";
  const subjectLabel = s?.subjectAtRun?.label || "";

  const inspector =
    s?.runBy?.name || s?.signoff?.name || s?.runBy?.email || s?.signoff?.email || "";

  const items = Array.isArray(s?.items) ? s.items : [];
  const answers = Array.isArray(s?.answers) ? s.answers : items;
  const anyFail = answers.some(
    (a) => String(a?.result || "").toLowerCase() === "fail" || a?.pass === false
  );

  let status = String(s?.overallResult || "").toLowerCase();
  if (!status || status === "na") status = anyFail ? "fail" : "pass";
  const outcomeUpper = status.toUpperCase();

  const scope = s?.scopeAtRun || s?.scope?.type || "";

  const descriptionText =
    s?.subjectAtRun?.description ||
    s?.description ||
    s?.summary ||
    s?.note ||
    s?.managerNote ||
    "";

  const nameEsc = escapeXml(title);
  const projEsc = escapeXml(String(proj || ""));
  const taskEsc = escapeXml(String(task || ""));
  const mileEsc = escapeXml(String(milestone || ""));
  const subjectTypeEsc = escapeXml(subjectTypeRaw);
  const subjectNiceEsc = escapeXml(subjectNice);
  const subjectLabelEsc = escapeXml(subjectLabel);
  const inspectorEsc = escapeXml(inspector);
  const whenEsc = escapeXml(whenHuman);
  const outcomeEsc = escapeXml(status);
  const scopeEsc = escapeXml(String(scope || ""));
  const descEsc = escapeXml(descriptionText);

  const descHtml = `
    <![CDATA[
      <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;font-size:12px">
        <h3 style="margin:0 0 6px 0">${nameEsc}</h3>
        <table cellpadding="4" cellspacing="0">
          <tr><td><b>Project</b></td><td>${projEsc || "—"}</td></tr>
          <tr><td><b>Task</b></td><td>${taskEsc || "—"}</td></tr>
          <tr><td><b>Milestone</b></td><td>${mileEsc || "—"}</td></tr>
          <tr><td><b>Subject</b></td><td>${subjectNiceEsc} – ${subjectLabelEsc || "—"}</td></tr>
          <tr><td><b>Outcome</b></td><td>${outcomeUpper}</td></tr>
          <tr><td><b>Date run</b></td><td>${whenEsc || "—"}</td></tr>
          <tr><td><b>Inspector</b></td><td>${inspectorEsc || "—"}</td></tr>
          <tr><td><b>Scope</b></td><td>${scopeEsc}</td></tr>
          ${descriptionText ? `<tr><td><b>Description</b></td><td>${descEsc}</td></tr>` : ""}
        </table>
      </div>
    ]]>`;

  const pointPlacemark = loc
    ? `
    <Placemark>
      <name>${nameEsc}</name>
      <description>${descHtml}</description>
      <ExtendedData>
        <Data name="title"><value>${nameEsc}</value></Data>
        <Data name="project"><value>${projEsc}</value></Data>
        <Data name="task"><value>${taskEsc}</value></Data>
        <Data name="milestone"><value>${mileEsc}</value></Data>
        <Data name="subjectType"><value>${subjectTypeEsc}</value></Data>
        <Data name="subjectLabel"><value>${subjectLabelEsc}</value></Data>
        <Data name="description"><value>${descEsc}</value></Data>
        <Data name="inspector"><value>${inspectorEsc}</value></Data>
        <Data name="dateRun"><value>${whenEsc}</value></Data>
        <Data name="outcome"><value>${outcomeEsc}</value></Data>
        <Data name="scope"><value>${scopeEsc}</value></Data>
      </ExtendedData>
      ${whenIso ? `<TimeStamp><when>${whenIso}</when></TimeStamp>` : ""}
      <Point><coordinates>${loc.lng},${loc.lat},0</coordinates></Point>
    </Placemark>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${nameEsc}</name>
    ${pointPlacemark}
  </Document>
</kml>`;
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
