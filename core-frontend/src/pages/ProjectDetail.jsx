// src/pages/ProjectDetail.jsx — Print-as-seen, manager notes-only,
// Tasks open TaskDetail in lightbox,
// ✅ Project inspections now show a proper table (like Tasks) and open View in a lightbox (embed=1)

import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { api, fileUrl } from "../lib/api";
import { listProjectTasks } from "../lib/api";
// import ProjectTasksTimeline from "../components/ProjectTasksTimeline";
import GanttPane from "../components/GanttPane";
import { listForms } from "../lib/inspectionApi.js";
import TaskDetail from "./TaskDetail.jsx";

/* ---------------- small UI bits ---------------- */
function Card({ title, children, right, className = "" }) {
  return (
    <div className={`rounded-xl border bg-white shadow-sm ${className}`}>
      {(title || right) && (
        <div className="px-3 py-2 border-b flex items-center justify-between">
          {title ? <div className="font-semibold">{title}</div> : <div />}
          {right || null}
        </div>
      )}
      <div className="p-3">{children}</div>
    </div>
  );
}
function Modal({ open, onClose, title, children, width = 860, footer }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center"
      style={{ background: "rgba(17,24,39,0.55)" }}
      onMouseDown={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full"
        style={{ maxWidth: width, maxHeight: "90vh", overflow: "auto" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="text-lg font-semibold m-0">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none">
            ✕
          </button>
        </div>
        <div className="p-4">{children}</div>
        {footer && <div className="px-4 py-3 border-t flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------------- helpers ---------------- */
const TASK_PALETTE = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#7f7f7f",
  "#bcbd22",
  "#17becf",
  "#ef4444",
  "#10b981",
];
const normalizeHex = (c) => {
  if (!c) return "";
  const m = String(c).trim();
  return /^#?[0-9a-f]{6}$/i.test(m) ? (m.startsWith("#") ? m : `#${m}`) : "";
};
const hexToRgba = (hex, a = 0.2) => {
  const h = normalizeHex(hex).slice(1);
  if (h.length !== 6) return `rgba(0,0,0,${a})`;
  const r = parseInt(h.slice(0, 2), 16),
    g = parseInt(h.slice(2, 4), 16),
    b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
};
const asId = (maybe) =>
  typeof maybe === "string" || typeof maybe === "number"
    ? String(maybe)
    : maybe && (maybe._id || maybe.id || maybe.userId || maybe.value)
    ? String(maybe._id || maybe.id || maybe.userId || maybe.value)
    : "";

// Normalize manager id from various backend shapes
const getManagerIdFromProject = (proj) =>
  asId(
    proj?.manager ??
      proj?.managerId ??
      proj?.managerUserId ??
      proj?.owner ??
      proj?.ownerId ??
      proj?.projectManager ??
      proj?.projectManagerId ??
      (proj?.team && proj.team.manager) ??
      null
  );

function SafeGeoFencePreview(props) {
  const [Loaded, setLoaded] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let mnt = true;
    import("../components/GeoFencePreview")
      .then((m) => mnt && setLoaded(() => m.default))
      .catch(() => mnt && setErr("Map preview unavailable (Leaflet not installed)."));
    return () => {
      mnt = false;
    };
  }, []);
  if (err)
    return (
      <div className="flex items-center justify-center rounded text-sm text-gray-600" style={{ height: props.height || 360 }}>
        {err}
      </div>
    );
  if (!Loaded)
    return (
      <div className="flex items-center justify-center bg-gray-100 rounded text-sm text-gray-600" style={{ height: props.height || 360 }}>
        Loading map…
      </div>
    );
  const C = Loaded;
  return <C {...props} />;
}

function TagEditor({ value = [], onChange }) {
  const [text, setText] = useState((value || []).join(", "));
  useEffect(() => setText((value || []).join(", ")), [value]);
  return (
    <input
      className="mt-1 border p-2 w-full rounded"
      placeholder="site-a, osha"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange?.(
          e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        );
      }}
    />
  );
}

/* -------- File helpers (Vault parity) -------- */
const docIdOf = (d) => (d && (d._id || d.id) ? String(d._id || d.id) : "");
function guessMimeFromName(name = "") {
  const ext = String(name).toLowerCase().split(".").pop();
  const map = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    ogg: "video/ogg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    md: "text/markdown",
    html: "text/html",
  };
  return map[ext] || "";
}
function isTextLike(mime = "") {
  const m = (mime || "").toLowerCase();
  return m.startsWith("text/") || /\/(json|csv)$/.test(m);
}

/* ---------------- Inspection helpers ---------------- */
const pickFirst = (...vals) => {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    return v;
  }
  return "";
};

const normalizeOutcome = (sub) => {
  // ✅ current schema: overallResult = "pass" | "fail" (sometimes other)
  const raw = pickFirst(
    sub?.overallResult,
    sub?.outcome,
    sub?.result,
    sub?.status,
    sub?.finalOutcome,
    sub?.summary?.outcome,
    sub?.meta?.outcome
  );

  if (!raw) return "—";

  const s = String(raw).toLowerCase();
  if (["pass", "passed", "ok", "success", "completed"].includes(s)) return "Pass";
  if (["fail", "failed", "ng", "noncompliant", "non-compliant"].includes(s)) return "Fail";
  if (["pending", "inprogress", "in-progress"].includes(s)) return "Pending";

  return String(raw);
};

const inspectorNameFromSub = (sub) => {
  // ✅ current schema: runBy is the person who performed it
  // fallback: signoff, then older shapes
  const who = pickFirst(
    sub?.runBy,
    sub?.signoff,
    sub?.inspector,
    sub?.inspectorUser,
    sub?.user,
    sub?.createdBy,
    sub?.submittedBy,
    sub?.author
  );

  if (!who) return "—";
  if (typeof who === "string") return who;

  if (typeof who === "object") {
    return (
      pickFirst(
        who.name,
        who.fullName,
        who.email,
        who.username,
        who._id,
        who.id
      ) || "—"
    );
  }

  return "—";
};

const submittedAtFromSub = (sub) =>
  pickFirst(sub?.submittedAt, sub?.completedAt, sub?.createdAt, sub?.updatedAt, sub?.at) || "";

const subIdFrom = (sub) => String(pickFirst(sub?._id, sub?.id, sub?.submissionId, sub?.subId) || "");

const formTitleFromSub = (sub) =>
  pickFirst(
    sub?.formTitle,
    sub?.formName,
    sub?.form?.title,
    sub?.form?.name,
    sub?.templateTitle,
    sub?.template?.title
  ) || "Form";

/* ---------------- Page ---------------- */
export default function ProjectDetail({ id: propId, onClose }) {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const id = propId ?? routeId;

  const [p, setP] = useState(null);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const [users, setUsers] = useState([]);
  const [projectTasks, setProjectTasks] = useState([]);

  // === DOCS AREA ===
  const [docs, setDocs] = useState([]);
  const [docQuery, setDocQuery] = useState("");
  const [docPick, setDocPick] = useState("");

  // Forms
  const [forms, setForms] = useState([]);
  const [formsErr, setFormsErr] = useState("");

  // Proof (Vault) — lightbox
  const [proofOpen, setProofOpen] = useState(false);
  const [proofUser, setProofUser] = useState("");
  const [proofTitle, setProofTitle] = useState("");
  const [proofTags, setProofTags] = useState("");
  const [proofFile, setProofFile] = useState(null);
  const [proofErr, setProofErr] = useState("");
  const [proofInfo, setProofInfo] = useState("");

  // Document lightbox
  const [viewDoc, setViewDoc] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewErr, setViewErr] = useState("");
  const [viewUrl, setViewUrl] = useState("");
  const [viewText, setViewText] = useState("");
  const [viewMime, setViewMime] = useState("");

  // Location helpers
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [radius, setRadius] = useState("");

  // Geofences summary
  const [gfFile, setGfFile] = useState(null);
  const [gfBuffer, setGfBuffer] = useState(50);
  const [gfCount, setGfCount] = useState(0);
  const [gfSource, setGfSource] = useState("none");
  const [replaceFences, setReplaceFences] = useState(true);

  // Overlays
  const [showTaskPins, setShowTaskPins] = useState(true);
  const [showTaskAreas, setShowTaskAreas] = useState(true);
  const [taskGfByTask, setTaskGfByTask] = useState({});
  const [taskGfLoading, setTaskGfLoading] = useState(false);

  // Manager controls (Details)
  const managerId = useMemo(() => getManagerIdFromProject(p) || "", [p]);
  const [managerDraft, setManagerDraft] = useState(managerId);
  useEffect(() => setManagerDraft(managerId), [managerId]);
  const managerDirty = String(managerDraft || "") !== String(managerId || "");

  // Manager notes (status input removed; notes only)
  const [mgrNote, setMgrNote] = useState("");
  const [managerNotes, setManagerNotes] = useState([]);

  // Task/Milestone name maps (for inspections)
  const taskNameById = useMemo(() => {
    const m = new Map();
    (projectTasks || []).forEach((t) => m.set(String(t._id), t.title || "Task"));
    return m;
  }, [projectTasks]);
  const [milestoneNameById, setMilestoneNameById] = useState(new Map());

  // 🔧 Task detail lightbox
  const [taskModalId, setTaskModalId] = useState(null);

  // ✅ Inspection submissions table + lightbox
  const [projSubs, setProjSubs] = useState([]);
  const [subsLoading, setSubsLoading] = useState(false);
  const [subsErr, setSubsErr] = useState("");
  const [subModal, setSubModal] = useState({ open: false, subId: "", url: "", title: "" });

  /* ------------ data loads ------------ */
useEffect(() => {
  loadProject();
  loadUsers();
  loadDocs();
  loadForms();
  loadProjectTasks();
  loadProjectSubmissions();

  // ✅ Force embedded Gantt to filter to this project
  try {
    window.dispatchEvent(
      new CustomEvent("dashboard:filtersChanged", {
        detail: { project: { ids: [String(id)] } },
      })
    );
  } catch {}

  // eslint-disable-next-line
}, [id]);

  async function loadProject() {
    setErr("");
    setInfo("");
    try {
      const { data } = await api.get(`/projects/${id}`, { params: { _ts: Date.now() } });
      setP(data);
      try {
        const { data: notes } = await api.get(`/projects/${id}/manager-notes`, { params: { _ts: Date.now() } });
        setManagerNotes(Array.isArray(notes) ? notes : []);
      } catch {
        setManagerNotes(Array.isArray(data?.managerNotes) ? data.managerNotes : []);
      }
      await refreshFenceSummary(true);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function loadUsers() {
    try {
      const { data } = await api.get("/users", { params: { limit: 500 } });
      setUsers(Array.isArray(data) ? data : []);
    } catch {
      setUsers([]);
    }
  }
  async function loadDocs(q = "") {
    try {
      const params = { limit: 100 };
      if (q) params.q = q;
      const { data } = await api.get("/documents", { params });
      setDocs(Array.isArray(data) ? data : []);
    } catch {
      setDocs([]);
    }
  }

  async function loadForms() {
    try {
      const data = await listForms({ includeDeleted: false });
      const filtered = (Array.isArray(data) ? data : []).filter((f) => {
        if (!f || f.isDeleted) return false;
        const sc = f.scope || {};
        const t = (sc.type || "global").toLowerCase();
        if (t === "global") return true;
        return String(sc.projectId || "") === String(id);
      });
      setForms(filtered);
      setFormsErr("");
    } catch (e) {
      setForms([]);
      setFormsErr(e?.response?.data?.error || e?.message || "Failed to load forms");
    }
  }

  async function loadProjectTasks() {
    try {
      const rows = await listProjectTasks(id, { limit: 1000 });
      const arr = Array.isArray(rows) ? rows : [];
      setProjectTasks(arr);

      // Preload milestone names for the project (best-effort)
      const mMap = new Map();
      const chunk = 6;
      for (let i = 0; i < arr.length; i += chunk) {
        const slice = arr.slice(i, i + chunk);
        await Promise.all(
          slice.map(async (t) => {
            try {
              const { data } = await api.get(`/tasks/${t._id}/milestones`, { params: { _ts: Date.now() } });
              const list = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
              list.forEach((m) => mMap.set(String(m._id || m.id), m.title || m.name || "Milestone"));
            } catch {}
          })
        );
      }
      setMilestoneNameById(mMap);
    } catch {
      setProjectTasks([]);
      setMilestoneNameById(new Map());
    }
  }

  // ✅ Load submissions for this project (robust endpoint attempts)
  async function loadProjectSubmissions() {
    setSubsLoading(true);
    setSubsErr("");
    try {
      const candidates = [
        { url: "/inspections/submissions", params: { projectId: id, limit: 200, _ts: Date.now() } },
        { url: "/inspection-submissions", params: { projectId: id, limit: 200, _ts: Date.now() } },
        { url: "/inspections", params: { projectId: id, limit: 200, _ts: Date.now() } },
        { url: `/projects/${id}/inspections/submissions`, params: { limit: 200, _ts: Date.now() } },
        { url: `/projects/${id}/inspection-submissions`, params: { limit: 200, _ts: Date.now() } },
      ];

      let data = null;
      let lastErr = null;

      for (const c of candidates) {
        try {
          const res = await api.get(c.url, { params: c.params });
          data = res?.data;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        }
      }

      if (lastErr && data === null) throw lastErr;

      const rows = Array.isArray(data)
        ? data
        : Array.isArray(data?.rows)
        ? data.rows
        : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.submissions)
        ? data.submissions
        : [];

      // filter hard by projectId if present (sometimes server ignores param)
      const filtered = rows.filter((r) => {
        const pid = pickFirst(r?.projectId, r?.scope?.projectId, r?.meta?.projectId, r?.project?._id, r?.project?.id);
        if (!pid) return true; // keep if unknown
        return String(pid) === String(id);
      });

      filtered.sort((a, b) => +new Date(submittedAtFromSub(b) || 0) - +new Date(submittedAtFromSub(a) || 0));
      setProjSubs(filtered);
    } catch (e) {
      setProjSubs([]);
      setSubsErr(e?.response?.data?.error || e?.message || "Failed to load project inspections.");
    } finally {
      setSubsLoading(false);
    }
  }

  function openSubmissionLightbox(sub) {
    const subId = subIdFrom(sub);
    if (!subId) return;

    // Primary route we know exists in your app
    const primary = `/inspections/submissions/${encodeURIComponent(subId)}?embed=1`;
    const title = `${formTitleFromSub(sub) || "Inspection"} • ${subId}`;

    setSubModal({
      open: true,
      subId,
      url: primary,
      title,
    });
  }

  /* ---------- robust manager save ---------- */
  async function robustSaveManager() {
    setErr("");
    setInfo("");
    const m = String(managerDraft || "");

    const shapes = [
      { manager: m || null },
      { managerId: m || null },
      { managerUserId: m || null },
      { owner: m || null },
      { ownerId: m || null },
      { projectManager: m || null },
      { projectManagerId: m || null },
      { team: { manager: m || null } },
      { manager: m ? { _id: m } : null },
    ];

    let lastErr;
    for (const patch of shapes) {
      try {
        try {
          await api.put(`/projects/${id}`, patch);
        } catch {
          await api.patch(`/projects/${id}`, patch);
        }
        const { data } = await api.get(`/projects/${id}`, { params: { _ts: Date.now() } });
        const got = getManagerIdFromProject(data);
        if (String(got || "") === String(m || "")) {
          setP(data);
          setInfo("Manager saved.");
          setTimeout(() => setInfo(""), 1200);
          return true;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    for (const a of [
      { m: "patch", u: `/projects/${id}/manager` },
      { m: "put", u: `/projects/${id}/manager` },
      { m: "post", u: `/projects/${id}/manager` },
    ]) {
      try {
        await api[a.m](a.u, { manager: m || null });
      } catch {}
    }
    try {
      const { data } = await api.get(`/projects/${id}`, { params: { _ts: Date.now() } });
      const got = getManagerIdFromProject(data);
      if (String(got || "") === String(m || "")) {
        setP(data);
        setInfo("Manager saved.");
        setTimeout(() => setInfo(""), 1200);
        return true;
      }
    } catch (e) {
      lastErr = e;
    }

    setErr(lastErr?.response?.data?.error || "Could not persist manager on the server.");
    return false;
  }

  /* ---------- generic project save ---------- */
  async function save(patch) {
    try {
      const { data } = await api.put(`/projects/${id}`, patch);
      setP((prev) => ({ ...(prev || {}), ...(data || {}), ...patch }));
      setInfo("Saved");
      setTimeout(() => setInfo(""), 1200);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function setStatus(newStatus) {
    await save({ status: newStatus });
  }

  async function softDelete() {
    if (!confirm("Delete this project?")) return;
    try {
      await api.delete(`/projects/${id}`);
      await loadProject();
      setInfo("Project deleted.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function restore() {
    try {
      const { data } = await api.patch(`/projects/${id}/restore`);
      setP((prev) => ({ ...prev, ...data, deletedAt: null }));
      setInfo("Project restored.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  /* ---------- Vault linking helpers ---------- */
  async function linkDoc() {
    if (!docPick) return;
    try {
      await api.post(`/documents/${docPick}/links`, { type: "project", refId: id });
      setInfo("Linked document.");
      loadDocs();
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function unlinkDoc(docId) {
    try {
      await api.delete(`/documents/${docId}/links`, { data: { type: "project", refId: id } });
      setInfo("Unlinked document.");
      loadDocs();
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  // Filter to docs linked to this project
  const linkedDocs = useMemo(() => {
    const ref = String(id);
    return (docs || []).filter((d) => (d.links || []).some((l) => (l.type || l.module) === "project" && String(l.refId) === ref));
  }, [docs, id]);

  // Extract associated user (first user link) for a doc
  const docUserId = (d) => {
    const ulink = (d.links || []).find((l) => (l.type || l.module) === "user" && l.refId);
    return ulink ? String(ulink.refId) : "";
  };
  const userById = (uid) => users.find((u) => String(u._id) === String(uid));
  const userName = (uid) => {
    const u = userById(uid);
    return u ? u.name || u.email || u.username || uid : uid || "—";
  };

  /* ---------- Proof upload ---------- */
  const getDocId = (doc) => {
    if (!doc || typeof doc !== "object") return "";
    return doc._id || doc.id || doc.documentId || doc.docId || (doc.data && (doc.data._id || doc.data.id)) || (Array.isArray(doc) && doc[0] && (doc[0]._id || doc[0].id)) || "";
  };

  async function attachProofSubmit(e) {
    e.preventDefault();
    setProofErr("");
    setProofInfo("");
    if (!proofUser) return setProofErr("Pick a user.");
    if (!proofFile) return setProofErr("Choose a file.");

    try {
      const title = (proofTitle || proofFile.name || "Proof").trim();
      const tags = (proofTags || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const { data: created } = await api.post("/documents", {
        title,
        folder: `projects/${id}/proof`,
        tags,
        links: [
          { type: "project", refId: id },
          { type: "user", refId: proofUser },
        ],
        access: { visibility: "org" },
      });

      const newId = String(getDocId(created) || "");
      if (!newId) throw new Error("Upload target id missing from /documents response.");

      const fd = new FormData();
      fd.append("file", proofFile);
      await api.post(`/documents/${newId}/upload`, fd, { headers: { "Content-Type": "multipart/form-data" } });

      setProofInfo("Proof attached.");
      setProofFile(null);
      setProofTitle("");
      setProofTags("");
      setProofUser("");
      setProofOpen(false);
      loadDocs();
    } catch (e2) {
      setProofErr(e2?.response?.data?.error || e2?.message || "Upload failed");
    }
  }

  /* ---------- Geofence helpers ---------- */
  function makeCirclePolygon(lat, lng, radiusMeters, steps = 64) {
    const R = 6371000,
      lat1 = (lat * Math.PI) / 180,
      lon1 = (lng * Math.PI) / 180,
      d = radiusMeters / R;
    const ring = [];
    for (let i = 0; i <= steps; i++) {
      const brng = (2 * Math.PI * i) / steps;
      const sinLat1 = Math.sin(lat1),
        cosLat1 = Math.cos(lat1),
        sinD = Math.sin(d),
        cosD = Math.cos(d);
      const sinLat2 = sinLat1 * cosD + cosLat1 * sinD * Math.cos(brng);
      const lat2 = Math.asin(sinLat2);
      const y = Math.sin(brng) * sinD * cosLat1;
      const x = cosD - sinLat1 * sinLat2;
      const lon2 = lon1 + Math.atan2(y, x);
      ring.push([((lon2 * 180) / Math.PI + 540) % 360 - 180, (lat2 * 180) / Math.PI]);
    }
    return ring;
  }
  async function refreshFenceSummary(prefill = false) {
    try {
      const { data } = await api.get(`/projects/${id}/geofences`, { params: { _ts: Date.now() } });
      const fences = Array.isArray(data?.geoFences)
        ? data.geoFences
        : Array.isArray(data?.fences)
        ? data.fences
        : Array.isArray(data)
        ? data
        : [];
      setGfCount(fences.length);
      setGfSource(fences.length ? "project" : "none");
      if (prefill) {
        const circle = fences.find((f) => String(f?.type).toLowerCase() === "circle");
        if (circle) {
          let L2, G2, R2;
          if (circle.center) {
            if (Array.isArray(circle.center)) {
              G2 = Number(circle.center[0]);
              L2 = Number(circle.center[1]);
            } else {
              L2 = Number(circle.center.lat);
              G2 = Number(circle.center.lng);
            }
          }
          if ((L2 === undefined || G2 === undefined) && circle.point) {
            G2 = Number(circle.point.lng);
            L2 = Number(circle.point.lat);
          }
          R2 = Number(circle.radius ?? circle.radiusMeters);
          if (Number.isFinite(L2)) setLat(String(L2));
          if (Number.isFinite(G2)) setLng(String(G2));
          if (Number.isFinite(R2)) setRadius(String(R2));
        }
      }
    } catch {
      setGfCount(0);
      setGfSource("none");
    }
  }
  function circleFromInputs() {
    if (lat === "" || lng === "") return null;
    const L2 = Number(lat),
      G2 = Number(lng),
      R2 = radius === "" ? 50 : Number(radius);
    if (!Number.isFinite(L2) || !Number.isFinite(G2) || !Number.isFinite(R2)) return null;
    return { lat: L2, lng: G2, radius: R2 };
  }
  async function persistCircleAsPolygon(projectId, { lat, lng, radius }) {
    const polygon = makeCirclePolygon(lat, lng, radius, 64);
    const body = { geoFences: [{ type: "polygon", polygon }] };
    try {
      if (replaceFences) await api.delete(`/projects/${projectId}/geofences`);
    } catch {}
    const attempts = [
      { m: "patch", u: `/projects/${projectId}/geofences`, b: body },
      { m: "post", u: `/projects/${projectId}/geofences`, b: body },
      { m: "put", u: `/projects/${projectId}/geofences`, b: body },
    ];
    let lastErr;
    for (const a of attempts) {
      try {
        await api[a.m](a.u, a.b, { headers: { "Content-Type": "application/json" } });
        return { ok: true };
      } catch (e) {
        lastErr = e;
      }
    }
    try {
      await api.delete(`/projects/${projectId}/geofences`);
    } catch {}
    try {
      await api.post(`/projects/${projectId}/geofences`, body, { headers: { "Content-Type": "application/json" } });
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: lastErr || e2 };
    }
  }
  async function handleSaveLocation(e) {
    e?.preventDefault?.();
    setErr("");
    setInfo("");
    const c = circleFromInputs();
    if (!c) {
      setErr("Please enter valid Lat, Lng and Radius.");
      return;
    }
    const { ok, error } = await persistCircleAsPolygon(id, c);
    if (!ok) {
      setErr(error?.response?.data?.error || String(error) || "Failed to save location.");
      return;
    }
    await refreshFenceSummary(true);
    setInfo("Location saved.");
    setTimeout(() => setInfo(""), 1200);
  }
  async function uploadGeofenceFile(e) {
    e?.preventDefault?.();
    setErr("");
    setInfo("");
    if (!gfFile) return setErr("Choose a .geojson, .kml or .kmz file first.");
    try {
      if (replaceFences) {
        try {
          await api.delete(`/projects/${id}/geofences`);
        } catch {}
      }
      const fd = new FormData();
      fd.append("file", gfFile);
      const qs = [
        `radius=${encodeURIComponent(Number(gfBuffer) || 50)}`,
        `buffer=${encodeURIComponent(Number(gfBuffer) || 50)}`,
        `radiusMeters=${encodeURIComponent(Number(gfBuffer) || 50)}`,
      ];
      let lastErr;
      for (const q of qs) {
        try {
          await api.post(`/projects/${id}/geofences/upload?${q}`, fd);
          setGfFile(null);
          await refreshFenceSummary(true);
          setInfo(replaceFences ? "Fences replaced with uploaded file." : "Fences uploaded (appended).");
          setTimeout(() => setInfo(""), 1200);
          return;
        } catch (eTry) {
          lastErr = eTry;
        }
      }
      throw lastErr || new Error("Upload failed");
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }
  async function clearAllFences() {
    if (!window.confirm("Remove ALL geofences from this project?")) return;
    setErr("");
    setInfo("");
    try {
      await api.delete(`/projects/${id}/geofences`);
      await refreshFenceSummary(true);
      setInfo("Project geofences cleared.");
      setTimeout(() => setInfo(""), 1200);
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }
  function useMyLocation() {
    if (!navigator.geolocation) {
      setErr("Geolocation not supported by this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(6));
        setLng(pos.coords.longitude.toFixed(6));
        if (!radius) setRadius("50");
      },
      (ge) => setErr(ge?.message || "Failed to get current position"),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
    );
  }

  // Normalizers for overlays
  function normPolygon(raw) {
    if (!Array.isArray(raw)) return null;
    const out = raw.map((p) => (Array.isArray(p) ? p : [Number(p.lng), Number(p.lat)]));
    return out.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite)) ? out : null;
  }
  function normLine(raw) {
    if (!Array.isArray(raw)) return null;
    const out = raw.map((p) => (Array.isArray(p) ? p : [Number(p.lng), Number(p.lat)]));
    return out.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite)) ? out : null;
  }
  function normCircle(raw) {
    const c = raw.center || raw.point || {};
    const lat = Number(c.lat ?? c[1]),
      lng = Number(c.lng ?? c[0]),
      r = Number(raw.radius ?? raw.radiusMeters ?? raw.r);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(r)) return null;
    return { center: { lat, lng }, radius: r };
  }

  const userLabel = (maybe) => {
    const idStr = asId(maybe);
    const u = users.find((x) => String(x._id) === idStr);
    return u ? u.name || u.email || u.username || idStr : idStr || "—";
  };

  // Per-task colours
  const taskColourMap = useMemo(() => {
    const byId = new Map();
    (projectTasks || []).forEach((t, i) => {
      const explicit = normalizeHex(t.color || t.colour || t.hex);
      byId.set(String(t._id), explicit || TASK_PALETTE[i % TASK_PALETTE.length]);
    });
    return byId;
  }, [projectTasks]);

  // Legend items
  const legendItems = useMemo(() => {
    const used = new Set();
    if (showTaskPins) {
      for (const t of projectTasks || []) {
        const gf = t.locationGeoFence;
        if (gf && gf.lat != null && gf.lng != null) used.add(String(t._id));
      }
    }
    if (showTaskAreas) {
      for (const t of projectTasks || []) {
        const arr = taskGfByTask[String(t._id)] || [];
        if (arr.length) used.add(String(t._id));
      }
    }
    return (projectTasks || [])
      .filter((t) => used.has(String(t._id)))
      .map((t) => ({ id: String(t._id), title: t.title || "Task", color: taskColourMap.get(String(t._id)) }));
  }, [projectTasks, taskGfByTask, showTaskPins, showTaskAreas, taskColourMap]);

  // Build overlays
  const taskOverlays = useMemo(() => {
    const out = [];
    if (showTaskPins) {
      for (const t of projectTasks || []) {
        const gf = t.locationGeoFence;
        if (gf && gf.lat != null && gf.lng != null) {
          const lat = Number(gf.lat),
            lng = Number(gf.lng);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            const color = taskColourMap.get(String(t._id));
            out.push({
            id: `${t._id}-pin`,
            type: "point",                    // ✅ normalize (lowercase)
            lat,                              // ✅ explicit for Leaflet helpers
            lng,                              // ✅ explicit for Leaflet helpers
            point: { lat, lng },              // ✅ common GeoFencePreview convention
            coordinates: [lng, lat],          // ✅ keep GeoJSON-style coords too
            title: t.title || "Task",
            meta: { label: t.title || "Task", taskId: String(t._id || ""), color },
            style: { stroke: color, fill: color, strokeWidth: 2 },
          });
          }
        }
      }
    }
    if (showTaskAreas) {
      for (const t of projectTasks || []) {
        const color = taskColourMap.get(String(t._id));
        const fences = taskGfByTask[String(t._id)] || [];
        for (const raw of fences) {
          const type = String(raw?.type || raw?.kind || raw?.geometry?.type || "").toLowerCase();
          if (type === "polygon" || raw?.polygon || raw?.geometry?.type === "Polygon") {
            const poly =
              normPolygon(raw?.polygon) ||
              (Array.isArray(raw?.geometry?.coordinates) && Array.isArray(raw.geometry.coordinates[0]) && normPolygon(raw.geometry.coordinates[0])) ||
              null;
            if (poly) {
              out.push({
                id: `${t._id}-poly-${out.length}`,
                type: "polygon",
                polygon: poly,
                meta: { label: t.title || "Task", taskId: String(t._id || ""), color },
                style: { stroke: color, strokeWidth: 2, fill: hexToRgba(color, 0.2) },
              });
              continue;
            }
          }
          if (type === "polyline" || type === "line" || Array.isArray(raw?.line) || Array.isArray(raw?.path)) {
            const line = normLine(raw.line || raw.path);
            if (line) {
              out.push({
                id: `${t._id}-line-${out.length}`,
                type: "polyline",
                line,
                meta: { label: t.title || "Task", taskId: String(t._id || ""), color },
                style: { stroke: color, strokeWidth: 3 },
              });
              continue;
            }
          }
          if (type === "circle" || raw?.radius || raw?.radiusMeters) {
            const c = normCircle(raw);
            if (c) {
              out.push({
                id: `${t._id}-circle-${out.length}`,
                type: "circle",
                center: c.center,
                radius: c.radius,
                meta: { label: t.title || "Task", taskId: String(t._id || ""), color },
                style: { stroke: color, strokeWidth: 2, fill: hexToRgba(color, 0.2) },
              });
              continue;
            }
          }
          if (type === "point" || raw?.geometry?.type === "Point") {
            const coords = Array.isArray(raw?.coordinates) ? raw.coordinates : Array.isArray(raw?.geometry?.coordinates) ? raw.geometry.coordinates : null;
            if (Array.isArray(coords) && coords.length >= 2 && coords.every(Number.isFinite)) {
              const lng = Number(coords[0]);
              const lat = Number(coords[1]);

              out.push({
                id: `${t._id}-pt-${out.length}`,
                type: "point",
                lat,
                lng,
                point: { lat, lng },
                coordinates: [lng, lat],
                meta: { label: t.title || "Task", taskId: String(t._id || ""), color },
                style: { stroke: color, fill: color, strokeWidth: 2 },
              });
            }
          }
        }
      }
    }
    return out;
  }, [projectTasks, taskGfByTask, showTaskPins, showTaskAreas, taskColourMap]);

  function hoverMetaResolver(overlay) {
    const tid = String(overlay?.meta?.taskId || "");
    const t = (projectTasks || []).find((x) => String(x._id) === tid);
    if (!t) return null;
    return {
      taskName: t.title || "Task",
      assigneeName: t.assignee ? userLabel(t.assignee) : "",
      status: t.status || "",
      due: t.dueAt ? new Date(t.dueAt).toLocaleDateString() : "",
      color: taskColourMap.get(tid),
    };
  }
  const overlayStyleResolver = (o) => o?.style || { color: o?.meta?.color, fillColor: o?.meta?.color };

  // Task geofences (for overlays)
  useEffect(() => {
    if (!showTaskAreas || !(projectTasks && projectTasks.length)) {
      setTaskGfByTask({});
      return;
    }
    let cancelled = false;
    (async () => {
      setTaskGfLoading(true);
      try {
        const ids = projectTasks.map((t) => String(t._id)).filter(Boolean);
        const next = {};
        const chunk = 5;
        for (let i = 0; i < ids.length; i += chunk) {
          const slice = ids.slice(i, i + chunk);
          const res = await Promise.all(
            slice.map(async (tid) => {
              try {
                const { data } = await api.get(`/tasks/${tid}/geofences`, { params: { _ts: Date.now() } });
                const list =
                  (Array.isArray(data?.geoFences) && data.geoFences) ||
                  (Array.isArray(data?.fences) && data.fences) ||
                  (Array.isArray(data) && data) ||
                  [];
                return { taskId: tid, fences: list };
              } catch {
                return { taskId: tid, fences: [] };
              }
            })
          );
          res.forEach((r) => {
            next[r.taskId] = r.fences;
          });
          if (cancelled) return;
        }
        if (!cancelled) setTaskGfByTask(next);
      } finally {
        if (!cancelled) setTaskGfLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectTasks, showTaskAreas]);

  if (!p) {
    return (
      <div className="max-w-7xl mx-auto p-4">
        Loading… {err && <span className="text-red-600">({err})</span>}
      </div>
    );
  }

  /* ---------- Manager note save (status update removed) ---------- */
  async function saveManagerNote() {
    setErr("");
    setInfo("");
    const note = (mgrNote || "").trim();
    if (!note) {
      setErr("Please enter a note.");
      return;
    }

    try {
      const entry = { at: new Date().toISOString(), note };
      try {
        await api.post(`/projects/${id}/manager-notes`, entry);
        const { data: fresh } = await api.get(`/projects/${id}/manager-notes`, { params: { _ts: Date.now() } });
        setManagerNotes(Array.isArray(fresh) ? fresh : []);
      } catch (e) {
        const st = e?.response?.status;
        if (st === 404 || st === 405) {
          const existing = Array.isArray(p?.managerNotes) ? p.managerNotes : [];
          try {
            await api.put(`/projects/${id}`, { managerNotes: [...existing, entry] });
          } catch {
            await api.patch(`/projects/${id}`, { managerNotes: [...existing, entry] });
          }
          setManagerNotes((prev) => [...prev, entry]);
        } else {
          throw e;
        }
      }
      setMgrNote("");
      setInfo("Manager note saved.");
      setTimeout(() => setInfo(""), 1200);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  /* ---------- Document preview / download ---------- */
  function closeDocLightbox() {
    if (viewUrl) {
      try {
        URL.revokeObjectURL(viewUrl);
      } catch {}
    }
    setViewDoc(null);
    setViewUrl("");
    setViewText("");
    setViewErr("");
    setViewMime("");
  }

  async function openDocInLightbox(doc) {
    setViewDoc(doc);
    setViewErr("");
    setViewText("");
    setViewUrl("");
    setViewMime("");
    setViewLoading(true);

    try {
      const url = doc?.latest?.url;
      const filename = doc?.latest?.filename || doc?.title || "document";
      const declaredMime = doc?.latest?.mime || guessMimeFromName(filename) || "application/octet-stream";

      if (!url) {
        const safeId = docIdOf(doc);
        if (!safeId) throw new Error("No file URL available.");
        const res = await api.get(`/documents/${encodeURIComponent(safeId)}/download`, { responseType: "blob" });
        const mime = res?.data?.type || declaredMime;
        if (isTextLike(mime)) {
          const text = await res.data.text();
          setViewText(text);
          setViewMime(mime);
        } else {
          const objUrl = URL.createObjectURL(res.data);
          setViewUrl(objUrl);
          setViewMime(mime);
        }
        return;
      }

      const res = await fetch(fileUrl(url), { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load file (${res.status})`);
      const contentType = res.headers.get("content-type") || declaredMime;

      if (isTextLike(contentType)) {
        const text = await res.text();
        setViewText(text);
      } else {
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        setViewUrl(objUrl);
      }
      setViewMime(contentType);
    } catch (e) {
      setViewErr(e?.message || "Failed to preview file.");
    } finally {
      setViewLoading(false);
    }
  }

  async function downloadDoc(doc) {
    try {
      if (doc?.latest?.url) {
        window.open(fileUrl(doc.latest.url), "_blank", "noopener,noreferrer");
        return;
      }
      const safeId = docIdOf(doc);
      const res = await api.get(`/documents/${encodeURIComponent(safeId)}/download`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc?.latest?.filename || doc?.title || `${safeId}.bin`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Download failed");
    }
  }

  /* ---------- Print current page (as seen) ---------- */
  const printCss = `
    @media print {
      nav, header, .navbar, .app-navbar, [data-navbar], [role="navigation"] { display:none !important; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  `;
  function printPdf() {
    const id = "__pd_print_css__";
    if (!document.getElementById(id)) {
      const s = document.createElement("style");
      s.id = id;
      s.type = "text/css";
      s.appendChild(document.createTextNode(printCss));
      document.head.appendChild(s);
    }
    window.print();
  }

  /* ------------------- UI ------------------- */
  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Project</h1>
        <div className="flex gap-2">
          <button className="px-3 py-2 border rounded" onClick={() => (onClose ? onClose() : navigate(-1))}>
            Back
          </button>
          <button className="px-3 py-2 border rounded" onClick={printPdf}>
            Print PDF
          </button>
          {!p.deletedAt ? (
            <button className="px-3 py-2 border rounded" onClick={softDelete}>
              Delete
            </button>
          ) : (
            <button className="px-3 py-2 border rounded" onClick={restore}>
              Restore
            </button>
          )}
        </div>
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      {/* Top grid */}
      <div className="grid md:grid-cols-2 gap-4">
        {/* DETAILS */}
        <Card title="Details" className="space-y-3">
          <label className="block text-sm">
            Name
            <input
              className="mt-1 border p-2 w-full rounded"
              value={p.name || ""}
              onChange={(e) => setP({ ...p, name: e.target.value })}
              onBlur={() => p.name && save({ name: p.name })}
            />
          </label>

          <div className="grid md:grid-cols-2 gap-3">
            <label className="block text-sm">
              Manager
              <select className="mt-1 border p-2 w-full rounded" value={managerDraft} onChange={(e) => setManagerDraft(String(e.target.value || ""))}>
                <option value="">— none —</option>
                {users.map((u) => (
                  <option key={u._id} value={String(u._id)}>
                    {u.name || u.email || u.username}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Status
              <select className="mt-1 border p-2 w-full rounded" value={p.status || "active"} onChange={(e) => setStatus(e.target.value)}>
                <option value="active">active</option>
                <option value="paused">paused</option>
                <option value="closed">closed</option>
              </select>
            </label>
          </div>

          <div className="flex gap-2">
            <button className="px-3 py-2 border rounded" onClick={robustSaveManager} disabled={!managerDirty}>
              Save Manager
            </button>
            <button className="px-3 py-2 border rounded" onClick={() => setManagerDraft(managerId)} disabled={!managerDirty}>
              Revert
            </button>
            {!managerDirty && <span className="self-center text-xs text-gray-500">Manager up to date</span>}
          </div>

          <label className="block text-sm">
            Description
            <textarea
              className="mt-1 border p-2 w-full rounded"
              rows={3}
              value={p.description || ""}
              onChange={(e) => setP({ ...p, description: e.target.value })}
              onBlur={() => save({ description: p.description || "" })}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              Start
              <input
                className="mt-1 border p-2 w-full rounded"
                type="date"
                value={p.startDate ? p.startDate.slice(0, 10) : ""}
                onChange={(e) => setP({ ...p, startDate: e.target.value ? new Date(e.target.value).toISOString() : "" })}
                onBlur={() => save({ startDate: p.startDate || undefined })}
              />
            </label>
            <label className="block text-sm">
              End
              <input
                className="mt-1 border p-2 w-full rounded"
                type="date"
                value={p.endDate ? p.endDate.slice(0, 10) : ""}
                onChange={(e) => setP({ ...p, endDate: e.target.value ? new Date(e.target.value).toISOString() : "" })}
                onBlur={() => save({ endDate: p.endDate || undefined })}
              />
            </label>
          </div>

          <label className="block text-sm">
            Tags
            <TagEditor
              value={p.tags || []}
              onChange={(t) => {
                setP({ ...p, tags: t });
                save({ tags: t });
              }}
            />
          </label>

          <div className="text-sm text-gray-600">
            Created: {p.createdAt ? new Date(p.createdAt).toLocaleString() : "—"}
            <br />
            Updated: {p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "—"}
            {p.deletedAt && (
              <>
                <br />
                <span className="text-red-700">Deleted: {new Date(p.deletedAt).toLocaleString()}</span>
              </>
            )}
          </div>
        </Card>

        {/* PROJECT MANAGER — notes only */}
        <Card title="Project Manager">
          <div className="space-y-3">
            <div className="font-medium text-sm">Manager note</div>
            <label className="text-sm block">
              Note
              <textarea
                className="mt-1 border p-2 w-full rounded"
                rows={3}
                value={mgrNote}
                onChange={(e) => setMgrNote(e.target.value)}
                placeholder="Context for this update, blockers, decisions…"
              />
            </label>
            <div className="text-right">
              <button className="px-3 py-2 border rounded" onClick={saveManagerNote}>
                Save
              </button>
            </div>

            {Array.isArray(managerNotes) && managerNotes.length > 0 && (
              <div className="pt-2">
                <div className="text-sm font-medium mb-1">Recent manager notes</div>
                <div className="space-y-2">
                  {managerNotes
                    .slice()
                    .sort((a, b) => +new Date(b.at || b.createdAt || 0) - +new Date(a.at || a.createdAt || 0))
                    .map((n, idx) => (
                      <div key={(n._id || n.id || idx) + ":" + (n.at || n.createdAt || "")} className="text-sm border rounded p-2 bg-gray-50">
                        <div className="text-xs text-gray-600 mb-1">
                          {(n.at || n.createdAt) ? new Date(n.at || n.createdAt).toLocaleString() : "—"}
                          {n.author?.name ? ` • ${n.author.name}` : n.author?.email ? ` • ${n.author.email}` : ""}
                        </div>
                        <div style={{ whiteSpace: "pre-wrap" }}>{n.note}</div>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Print helper CSS */}
      <style dangerouslySetInnerHTML={{ __html: printCss }} />

      {/* === Project Documents (Table only) === */}
      <Card
        title="Project Documents"
        right={
          <div className="flex items-center gap-2 whitespace-nowrap overflow-x-auto">
            <input
              className="border p-1 rounded text-sm"
              placeholder="Search vault…"
              value={docQuery}
              onChange={(e) => setDocQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadDocs(docQuery)}
              style={{ width: 220 }}
            />
            <button className="px-2 py-1 border rounded text-sm" onClick={() => loadDocs(docQuery)}>
              Search
            </button>
            <select className="border p-1 rounded text-sm" value={docPick} onChange={(e) => setDocPick(e.target.value)}>
              <option value="">Pick a doc…</option>
              {(docs || []).map((d) => (
                <option key={d._id || d.id} value={String(d._id || d.id)}>
                  {d.title || d.filename || d.name || (d._id || d.id)}
                </option>
              ))}
            </select>
            <button className="px-2 py-1 border rounded text-sm" onClick={linkDoc} disabled={!docPick}>
              Link
            </button>
            <button className="px-2 py-1 border rounded text-sm" onClick={() => {
              setProofOpen(true);
              setProofErr("");
              setProofInfo("");
            }}>
              Attach Proof
            </button>
          </div>
        }
      >
        {linkedDocs.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="p-2 text-left">Title</th>
                  <th className="p-2 text-left">Tags</th>
                  <th className="p-2 text-left">Uploaded</th>
                  <th className="p-2 text-left">User</th>
                  <th className="p-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {linkedDocs.map((att) => {
                  const when = att.uploadedAt || att.createdAt || att.updatedAt;
                  const uid = docUserId(att);
                  return (
                    <tr key={att._id || att.id}>
                      <td className="border-t p-2">
                        <span
                          className="underline cursor-pointer"
                          title="Open preview"
                          onClick={() => openDocInLightbox(att)}
                          style={{ display: "inline-block", maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {att.title || att.filename || "Document"}
                        </span>
                      </td>
                      <td className="border-t p-2 text-gray-700">
                        {Array.isArray(att.tags) && att.tags.length ? att.tags.join(", ") : <span className="text-gray-500">—</span>}
                      </td>
                      <td className="border-t p-2">{when ? new Date(when).toLocaleString() : "—"}</td>
                      <td className="border-t p-2">{uid ? userName(uid) : "—"}</td>
                      <td className="border-t p-2 text-right">
                        <button className="px-2 py-1 border rounded text-xs mr-1" onClick={() => downloadDoc(att)}>
                          Download
                        </button>
                        <button className="px-2 py-1 border rounded text-xs" onClick={() => unlinkDoc(att._id || att.id)}>
                          Unlink
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-sm text-gray-600">No documents linked to this project yet.</div>
        )}
      </Card>

      {/* Location & Geofencing */}
      <Card
        title="Project Location"
        right={
          <div className="text-sm text-gray-600">
            Fences: <b>{gfCount}</b> <span className="ml-2">source: <i>{gfSource}</i></span>
          </div>
        }
      >
        {legendItems.length > 0 && (
          <div className="mt-2 max-h-28 overflow-auto rounded bg-white px-3 py-2 text-xs shadow-sm">
            <div className="font-medium mb-1">Task Legend</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1">
              {legendItems.map((it) => (
                <div key={it.id} className="inline-flex items-center gap-2">
                  <svg width="14" height="14" aria-hidden focusable="false">
                    <rect width="14" height="14" rx="2" ry="2" fill={it.color || "#999"} />
                  </svg>
                  <span className="truncate" title={it.title}>{it.title}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-2">
          <SafeGeoFencePreview
            projectId={id}
            height={360}
            className="rounded"
            reloadKey={`${gfCount}:${showTaskPins}:${showTaskAreas}:${projectTasks.length}:${Object.keys(taskGfByTask).length}:${p?.updatedAt || ""}`}
            fallbackCircle={gfCount === 0 && lat !== "" && lng !== "" ? { lat: Number(lat), lng: Number(lng), radius: Number(radius || 50) } : null}
            allowPicking={replaceFences || gfCount === 0}
            onPickLocation={({ lat: la, lng: lo }) => {
              setLat(la.toFixed(6));
              setLng(lo.toFixed(6));
              if (!radius) setRadius("50");
              setInfo(`Pin set at ${la.toFixed(6)}, ${lo.toFixed(6)} — click “Save location” to persist.`);
              setTimeout(() => setInfo(""), 2000);
            }}
            extraFences={taskOverlays}
            overlayStyleResolver={overlayStyleResolver}
            hoverMetaResolver={hoverMetaResolver}
          />
        </div>

        <div className="mt-2 flex items-center gap-3 text-sm flex-wrap">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={replaceFences} onChange={(e) => setReplaceFences(e.target.checked)} />
            Replace existing fences (recommended)
          </label>
          <span className="text-gray-500">{replaceFences ? "We'll clear existing fences before saving/uploading." : "We'll add to existing fences."}</span>
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={showTaskPins} onChange={(e) => setShowTaskPins(e.target.checked)} />
            Show task pins
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={showTaskAreas} onChange={(e) => setShowTaskAreas(e.target.checked)} />
            Show task geofences
          </label>
          {taskGfLoading && <span className="text-xs text-gray-700">Loading task areas…</span>}
        </div>

        <form onSubmit={handleSaveLocation} className="grid md:grid-cols-5 gap-2 mt-2">
          <label className="text-sm">
            Lat
            <input className="mt-1 border p-2 w-full rounded" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="-33.123456" />
          </label>
          <label className="text-sm">
            Lng
            <input className="mt-1 border p-2 w-full rounded" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="18.654321" />
          </label>
          <label className="text-sm">
            Radius (m)
            <input className="mt-1 border p-2 w-full rounded" type="number" min="5" value={radius} onChange={(e) => setRadius(e.target.value)} placeholder="50" />
          </label>
          <div className="flex items-end gap-2 md:col-span-2">
            <button type="button" className="px-3 py-2 border rounded" onClick={useMyLocation}>
              Use my location
            </button>
            <button className="px-3 py-2 bg-black text-white rounded ml-auto" type="submit">
              Save location
            </button>
          </div>
        </form>

        <form onSubmit={uploadGeofenceFile} className="mt-2 flex flex-wrap items-end gap-3">
          <label className="text-sm" style={{ minWidth: 220 }}>
            Upload .geojson / .kml / .kmz
            <input
              className="mt-1 border p-2 w-full rounded"
              type="file"
              accept=".geojson,.json,.kml,.kmz,application/json,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/zip"
              onChange={(e) => setGfFile(e.target.files?.[0] || null)}
            />
          </label>
          <label className="text-sm">
            Geofence buffer size (m)
            <input
              className="mt-1 border p-2 ml-2 w-28 rounded"
              type="number"
              min="1"
              step="1"
              value={gfBuffer}
              onChange={(e) => setGfBuffer(e.target.value)}
              title="Used to buffer Point features into circles"
            />
          </label>
          <button className="px-3 py-2 border rounded" type="submit">
            Upload Fences
          </button>
          <button className="px-3 py-2 border rounded" type="button" onClick={clearAllFences}>
            Clear Project Fences
          </button>
          <button className="px-3 py-2 border rounded" type="button" onClick={() => refreshFenceSummary(true)}>
            Refresh
          </button>
        </form>

        <div className="text-xs text-gray-600 mt-2">
          Saving a pin or uploading a file will <b>{replaceFences ? "replace" : "append to"}</b> the current fences.
        </div>
      </Card>

      {/* ✅ Project Plan (Gantt) */}
      <Card title="Project Plan (Gantt)">
        <GanttPane />
      </Card>
    
      {/* Tasks list — titles open TaskDetail in lightbox */}
      <Card
        title="Tasks for this Project"
        right={
          <div className="flex gap-2">
            <button className="px-3 py-2 border rounded" onClick={loadProjectTasks}>
              Refresh
            </button>
            <Link to="/tasks" className="px-3 py-2 border rounded">
              Open Tasks
            </Link>
          </div>
        }
      >
        {projectTasks.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="p-2 text-left">Title</th>
                <th className="p-2 text-left">Status</th>
                <th className="p-2 text-left">Assignee</th>
                <th className="p-2 text-left">Due</th>
              </tr>
            </thead>
            <tbody>
              {projectTasks.map((t, i) => {
                const color = taskColourMap.get(String(t._id)) || TASK_PALETTE[i % TASK_PALETTE.length];
                return (
                  <tr key={t._id}>
                    <td className="border-t p-2">
                      <span className="inline-flex items-center gap-2">
                        <svg width="12" height="12" aria-hidden focusable="false">
                          <rect width="12" height="12" rx="2" ry="2" fill={color} />
                        </svg>
                        <span className="underline cursor-pointer" title="Open task" onClick={() => setTaskModalId(String(t._id))}>
                          {t.title}
                        </span>
                      </span>
                    </td>
                    <td className="border-t p-2">{t.status}</td>
                    <td className="border-t p-2">{t.assignee ? userLabel(t.assignee) : "—"}</td>
                    <td className="border-t p-2">{t.dueAt ? new Date(t.dueAt).toLocaleDateString() : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="text-sm text-gray-600">No tasks for this project.</div>
        )}
      </Card>

      {/* Inspections */}
      <Card
        title="Inspections for this Project"
        right={
          <div className="flex items-center gap-2">
            <button className="px-3 py-2 border rounded" onClick={loadProjectSubmissions}>
              Refresh
            </button>
            <Link to="/inspections" className="underline">
              Inspections hub
            </Link>
          </div>
        }
      >
        <div className="space-y-2">
          <div className="font-medium text-sm">Available forms</div>
          {formsErr && <div className="text-red-600 text-sm">{formsErr}</div>}
          {forms.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="p-2 text-left">Form</th>
                  <th className="p-2 text-left">Scope</th>
                  <th className="p-2 text-left">Task</th>
                  <th className="p-2 text-right">Run</th>
                </tr>
              </thead>
              <tbody>
                {forms.map((f) => {
                  const sc = f.scope || {};
                  const scopeText = (sc.type || "global").toLowerCase() === "global" ? "Global" : "Project";
                  const tname = sc.taskId ? projectTasks.find((t) => String(t._id) === String(sc.taskId))?.title || sc.taskId : "—";
                  return (
                    <tr key={f._id || f.id}>
                      <td className="border-t p-2">{f.title || f.name || "Form"}</td>
                      <td className="border-t p-2">{scopeText}</td>
                      <td className="border-t p-2">{tname}</td>
                      <td className="border-t p-2 text-right">
                        <Link className="px-2 py-1 border rounded" to={`/inspections/forms/${f._id || f.id}/run`}>
                          Run
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="text-sm text-gray-600">No forms available for this project yet.</div>
          )}
        </div>

        {/* ✅ Submitted inspections table (like Tasks) */}
        <div className="mt-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="font-medium text-sm">Submitted inspections</div>
            {subsLoading && <div className="text-xs text-gray-600">Loading…</div>}
          </div>

          {subsErr && <div className="text-sm text-red-600 mt-2">{subsErr}</div>}

          {!subsLoading && !subsErr && (!projSubs || projSubs.length === 0) && (
            <div className="text-sm text-gray-600 mt-2">No inspection submissions for this project yet.</div>
          )}

          {!!projSubs?.length && (
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="p-2 text-left">Submitted</th>
                    <th className="p-2 text-left">Form name</th>
                    <th className="p-2 text-left">Outcome</th>
                    <th className="p-2 text-left">Inspector</th>
                    <th className="p-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {projSubs.map((sub) => {
                    const sid = subIdFrom(sub);
                    const when = submittedAtFromSub(sub);
                    const formTitle = formTitleFromSub(sub);

                    return (
                      <tr key={sid || JSON.stringify(sub).slice(0, 32)}>
                        <td className="border-t p-2">{when ? new Date(when).toLocaleString() : "—"}</td>
                        <td className="border-t p-2">{formTitle}</td>
                        <td className="border-t p-2">{normalizeOutcome(sub)}</td>
                        <td className="border-t p-2">{inspectorNameFromSub(sub)}</td>
                        <td className="border-t p-2 text-right">
                          <button className="px-2 py-1 border rounded text-xs" onClick={() => openSubmissionLightbox(sub)} disabled={!sid}>
                            View
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div className="text-xs text-gray-500 mt-2">
                Tip: “View” opens in a lightbox using <code>?embed=1</code> so the sidebar won’t show.
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Lightbox: Attach Proof */}
      <Modal open={proofOpen} onClose={() => setProofOpen(false)} title="Attach Proof" width={720} footer={null}>
        {proofErr && <div className="text-red-600 text-sm mb-2">{proofErr}</div>}
        {proofInfo && <div className="text-green-700 text-sm mb-2">{proofInfo}</div>}
        <form onSubmit={attachProofSubmit} className="grid md:grid-cols-2 gap-3">
          <label className="text-sm">
            User
            <select className="mt-1 border p-2 w-full rounded" value={proofUser} onChange={(e) => setProofUser(e.target.value)} required>
              <option value="">— select a user —</option>
              {users.map((u) => (
                <option key={u._id} value={String(u._id)}>
                  {u.name || u.email || u.username}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Title
            <input className="mt-1 border p-2 w-full rounded" placeholder="e.g. Permit 2025-08-26" value={proofTitle} onChange={(e) => setProofTitle(e.target.value)} />
          </label>
          <label className="text-sm md:col-span-2">
            Tags (comma)
            <input className="mt-1 border p-2 w-full rounded" placeholder="permit, proof" value={proofTags} onChange={(e) => setProofTags(e.target.value)} />
          </label>
          <label className="text-sm md:col-span-2">
            File
            <input type="file" className="mt-1 border p-2 w-full rounded" onChange={(e) => setProofFile(e.target.files?.[0] || null)} required />
          </label>
          <div className="md:col-span-2 flex justify-end gap-2">
            <button type="button" className="px-3 py-2 border rounded" onClick={() => setProofOpen(false)}>
              Cancel
            </button>
            <button className="px-3 py-2 bg-black text-white rounded" type="submit">
              Attach
            </button>
          </div>
          <div className="md:col-span-2 text-xs text-gray-600">Files are stored in the Vault and auto-linked to this project and the selected user.</div>
        </form>
      </Modal>

      {/* Lightbox: Document preview */}
      <Modal
        open={!!viewDoc}
        onClose={closeDocLightbox}
        title={viewDoc ? viewDoc.title || viewDoc.filename || viewDoc?.latest?.filename || "Document" : "Document"}
        width={960}
        footer={
          viewDoc ? (
            <>
              <button className="px-3 py-2 border rounded" onClick={() => downloadDoc(viewDoc)}>
                Download
              </button>
              <button className="px-3 py-2 border rounded" onClick={closeDocLightbox}>
                Close
              </button>
            </>
          ) : null
        }
      >
        {viewDoc && (
          <>
            {viewLoading && <div className="text-sm text-gray-700">Loading preview…</div>}
            {viewErr && <div className="text-sm text-red-600">{viewErr}</div>}

            {!viewLoading && !viewErr && (
              <>
                {isTextLike(viewMime) && (
                  <div className="p-3">
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        background: "white",
                        border: "1px solid #eee",
                        borderRadius: 8,
                        padding: 12,
                        maxHeight: "70vh",
                        overflow: "auto",
                        fontSize: 12,
                      }}
                    >
                      {viewText || "(empty file)"}
                    </pre>
                  </div>
                )}

                {viewMime.startsWith("image/") && viewUrl && (
                  <img
                    src={viewUrl}
                    alt={viewDoc?.latest?.filename || viewDoc?.title || "document"}
                    style={{ maxWidth: "100%", height: "auto", maxHeight: "70vh" }}
                  />
                )}

                {viewMime.startsWith("video/") && viewUrl && (
                  <video src={viewUrl} controls style={{ width: "100%", maxHeight: "70vh", background: "black", borderRadius: 8 }} />
                )}

                {viewMime.startsWith("audio/") && viewUrl && <audio src={viewUrl} controls style={{ width: "100%" }} />}

                {viewMime === "application/pdf" && viewUrl && <iframe title="PDF preview" src={viewUrl} style={{ width: "100%", height: "70vh", border: 0 }} />}

                {!isTextLike(viewMime) && !viewMime.startsWith("image/") && !viewMime.startsWith("video/") && !viewMime.startsWith("audio/") && viewMime !== "application/pdf" && (
                  <div className="text-sm text-gray-700">
                    Preview not available. Use the <b>Download</b> button below.
                  </div>
                )}

                <div className="mt-3 text-xs text-gray-600">
                  Uploaded:{" "}
                  {viewDoc?.uploadedAt ? new Date(viewDoc.uploadedAt).toLocaleString() : viewDoc?.createdAt ? new Date(viewDoc.createdAt).toLocaleString() : "—"}
                  {(() => {
                    const uid = docUserId(viewDoc);
                    return <> • User: {uid ? userName(uid) : "—"}</>;
                  })()}
                </div>
              </>
            )}
          </>
        )}
      </Modal>

      {/* ✅ Lightbox: Inspection submission view */}
      <Modal
        open={subModal.open}
        onClose={() => setSubModal({ open: false, subId: "", url: "", title: "" })}
        title={subModal.title || "Inspection"}
        width={1100}
        footer={
          <button className="px-3 py-2 border rounded" onClick={() => setSubModal({ open: false, subId: "", url: "", title: "" })}>
            Close
          </button>
        }
      >
        {subModal.url ? (
          <div style={{ height: "70vh" }}>
            <iframe title="Inspection submission" src={subModal.url} style={{ width: "100%", height: "100%", border: 0 }} />
            <div className="text-xs text-gray-600 mt-2">
              If the preview is blank,{" "}
              <a className="underline" href={subModal.url.replace("?embed=1", "")} target="_blank" rel="noreferrer">
                open in a new tab
              </a>
              .
            </div>
          </div>
        ) : (
          <div className="text-sm text-gray-600">No submission URL.</div>
        )}
      </Modal>

      {/* Lightbox: TaskDetail */}
      <Modal
        open={!!taskModalId}
        onClose={() => setTaskModalId(null)}
        title="Task"
        width={960}
        footer={
          <button className="px-3 py-2 border rounded" onClick={() => setTaskModalId(null)}>
            Close
          </button>
        }
      >
        {taskModalId && <TaskDetail id={taskModalId} onClose={() => setTaskModalId(null)} />}
      </Modal>
    </div>
  );
}
