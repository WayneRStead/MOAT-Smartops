// src/components/ProjectOverviewPanel.jsx
import React from "react";
import { api } from "../lib/api";
import { createPortal } from "react-dom";

/* ------------------------------- helpers -------------------------------- */
const idOf = (v) => String(v?._id || v?.id || v || "");
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "-");
const isClosedLike = (s) =>
  ["done", "closed", "complete", "completed", "cancelled", "canceled", "void"].includes(norm(s));
const isPausedLike = (s) =>
  ["paused", "paused-problem", "on-hold", "hold", "pause"].includes(norm(s));

const startOfTask = (t) => t?.startAt || t?.startDate || t?.begin || t?.createdAt || null;
const dueOfTask = (t) =>
  t?.dueAt || t?.dueDate || t?.endAt || t?.endDate || t?.deadlineAt || t?.due || null;
const isOverdueTask = (t, now = new Date()) => {
  const d = dueOfTask(t);
  if (!d) return false;
  const x = new Date(d);
  return !isNaN(+x) && x < now && !isClosedLike(t.status);
};

const clampDay = (d, end = false) => {
  const x = new Date(d);
  if (isNaN(+x)) return null;
  if (end) x.setHours(23, 59, 59, 999);
  else x.setHours(0, 0, 0, 0);
  return x;
};
const within = (raw, fromAt, toAt) => {
  if (!fromAt && !toAt) return true;
  const d = raw ? new Date(raw) : null;
  if (!d || isNaN(+d)) return false;
  const f = fromAt ? clampDay(fromAt, false) : null;
  const t = toAt ? clampDay(toAt, true) : null;
  if (f && d < f) return false;
  if (t && d > t) return false;
  return true;
};
const dOr = (d, fmt = "date") => {
  if (!d) return "—";
  const x = new Date(d);
  if (isNaN(+x)) return "—";
  return fmt === "datetime" ? x.toLocaleString() : x.toLocaleDateString();
};

function safeArr(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function extractCommentsFromObj(obj) {
  const pools = []
    .concat(safeArr(obj?.comments))
    .concat(safeArr(obj?.notes))
    .concat(safeArr(obj?.updates))
    .concat(safeArr(obj?.activity))
    .concat(safeArr(obj?.history))
    .concat(safeArr(obj?.logs))
    .concat(safeArr(obj?.reviews))
    .concat(safeArr(obj?.approvals))
    .concat(safeArr(obj?.approvalHistory))
    .concat(safeArr(obj?.reviewHistory))
    .concat(safeArr(obj?.auditTrail));

  return pools
    .map((c) => ({
      at: c?.at || c?.date || c?.createdAt || c?.timestamp || c?.updatedAt || c?.when,
      text: c?.text || c?.note || c?.comment || c?.message || c?.details || c?.remark || c?.reason || "",
      authorId: idOf(c?.user || c?.userId || c?.authorId || c?.by),
      authorName: c?.userName || c?.authorName || c?.author || c?.byName || "",
      authorRole: c?.userRole || c?.authorRole || c?.role || "",
    }))
    .filter((x) => x.at || x.text);
}

// NEW: get newest *manager* comment for an inspection/submission
function newestManagerCommentForInspection(ins, managerUserId, managerName) {
  const asTime = (v) => {
    const d = v ? new Date(v) : null;
    const t = d && !isNaN(+d) ? +d : 0;
    return t;
  };

  const readText = (c) =>
    String(c?.comment ?? c?.text ?? c?.note ?? c?.message ?? c?.details ?? "").trim();

  const readAt = (c) => c?.at || c?.createdAt || c?.date || c?.timestamp || c?.updatedAt || c?.when || null;

  const readAuthorId = (c) =>
    idOf(c?.by || c?.author || c?.user || c?.userId || c?.authorId || c?.createdBy || c?.createdById);

  const readAuthorName = (c) =>
    String(
      c?.byName ||
        c?.authorName ||
        c?.userName ||
        c?.name ||
        c?.by?.name ||
        c?.author?.name ||
        c?.user?.name ||
        c?.by?.email ||
        c?.author?.email ||
        c?.user?.email ||
        ""
    ).trim();

  const readRole = (c) =>
    String(
      c?.role ||
        c?.authorRole ||
        c?.userRole ||
        c?.byRole ||
        c?.by?.role ||
        c?.author?.role ||
        c?.user?.role ||
        ""
    ).trim();

  const isManagerish = (c) => {
    const role = norm(readRole(c));
    if (role.includes("manager") || role.includes("project-manager") || role.includes("pm")) return true;

    const aid = readAuthorId(c);
    if (managerUserId && aid && String(aid) === String(managerUserId)) return true;

    const an = readAuthorName(c);
    if (managerName && an && an === managerName) return true;

    // sometimes the backend flags it
    if (c?.isManager === true || c?.manager === true) return true;

    return false;
  };

  // 1) Canonical: managerComments array (TaskDetail uses this)
  if (Array.isArray(ins?.managerComments) && ins.managerComments.length) {
    const latest = ins.managerComments
      .map((c) => ({ t: asTime(readAt(c)), text: readText(c), raw: c }))
      .filter((x) => x.t || x.text)
      .sort((a, b) => b.t - a.t)[0];

    if (latest?.text) return latest.text;
  }

  // 2) Direct "last note" fields (list endpoints sometimes flatten these)
  const direct =
    ins?.lastManagerComment ||
    ins?.lastManagerNote ||
    ins?.managerNote ||
    ins?.managerComment ||
    ins?.review?.managerComment ||
    ins?.review?.managerNote ||
    ins?.approval?.managerNote ||
    ins?.approval?.note ||
    "";

  if (String(direct || "").trim()) return String(direct).trim();

  // 3) Legacy mixed comments array: take newest that looks manager-ish
  if (Array.isArray(ins?.comments) && ins.comments.length) {
    const latestMgr = ins.comments
      .map((c) => ({ t: asTime(readAt(c)), text: readText(c), raw: c }))
      .filter((x) => (x.t || x.text) && isManagerish(x.raw))
      .sort((a, b) => b.t - a.t)[0];

    if (latestMgr?.text) return latestMgr.text;
  }

  // 4) Audit/history/logs style: use your extractor and filter manager-ish
  const trail = extractCommentsFromObj(ins || {});
  const latestTrailMgr = trail
    .map((c) => ({
      t: asTime(c?.at),
      text: String(c?.text || "").trim(),
      raw: c,
    }))
    .filter((x) => (x.t || x.text) && isManagerish(x.raw))
    .sort((a, b) => b.t - a.t)[0];

  return latestTrailMgr?.text || "";
}

function groupIdsOfTask(t) {
  const pool = []
    .concat(safeArr(t.groupId))
    .concat(safeArr(t.groups))
    .concat(safeArr(t.group))
    .concat(safeArr(t.assigneeGroupId));
  const out = new Set();
  for (const v of pool.flat()) {
    const s = idOf(v);
    if (s) out.add(s);
  }
  return Array.from(out);
}

function money(n, currency = "ZAR") {
  const v = Number(n || 0);
  try {
    return v.toLocaleString(undefined, { style: "currency", currency });
  } catch {
    return v.toFixed(2);
  }
}

// Used elsewhere; kept as-is
function deriveInspectionStatus(ins) {
  const direct =
    ins.overallStatus ||
    ins.summaryStatus ||
    ins.finalStatus ||
    ins.passFail ||
    ins.result ||
    ins.outcome ||
    ins.status ||
    ins.state;

  if (direct != null && String(direct).trim() !== "") return String(direct);

  if (ins.passed === true) return "Pass";
  if (ins.passed === false) return "Fail";

  const overallPassed = ins.overall?.passed ?? ins.summary?.passed ?? ins.stats?.passed ?? ins.totals?.passed;
  if (overallPassed === true) return "Pass";
  if (overallPassed === false) return "Fail";

  const failCount =
    ins.failedCount ??
    ins.failCount ??
    ins.stats?.failCount ??
    ins.summary?.failCount ??
    ins.totals?.failCount;
  if (Number.isFinite(Number(failCount))) return Number(failCount) > 0 ? "Fail" : "Pass";

  const answers = ins.responses || ins.answers || ins.items || ins.results || [];
  if (Array.isArray(answers) && answers.length) {
    const text = JSON.stringify(answers).toLowerCase();
    if (text.includes("fail")) return "Fail";
    if (text.includes("pass")) return "Pass";
  }

  return "";
}

/* --------------------------- filter bridge ------------------------------- */
function useFiltersBridge() {
  const [rag, setRag] = React.useState("");
  const [dr, setDr] = React.useState({});
  const [context, setContext] = React.useState({});
  const [projectIds, setProjectIds] = React.useState([]);
  React.useEffect(() => {
    const h = (e) => {
      const d = e?.detail || {};
      if ("rag" in d) setRag(String(d.rag || ""));
      if ("dr" in d) setDr(d.dr || {});
      if ("context" in d) setContext(d.context || {});
      if (d.project?.ids) setProjectIds(d.project.ids.map(String));
    };
    window.addEventListener("dashboard:filtersChanged", h);
    return () => window.removeEventListener("dashboard:filtersChanged", h);
  }, []);
  return {
    rag,
    dr,
    focusedProjectId: String(context?.projectId || projectIds[0] || ""),
  };
}

/* -------------------------- Lightweight Lightbox ------------------------- */
/* Uses a portal and injects CSS into the iframe to hide any app chrome (sidebar/header) */
function Lightbox({ open, title, url, html, json, onClose }) {
  const iframeRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return;
    const ifr = iframeRef.current;
    if (!ifr) return;
    const inject = () => {
      try {
        const doc = ifr.contentDocument || ifr.contentWindow?.document;
        if (!doc) return;
        const style = doc.createElement("style");
        style.textContent = `
          header, nav, footer,
          .navbar, .topnav, .app-nav, .site-header, .AppNavbar,
          aside, .sidebar, .sidenav, .AppSidebar, #sidebar, [data-app-sidebar], [role="complementary"],
          .layout-sidebar, .left-rail, .left-rail-container, .shell-sidebar {
            display: none !important;
          }
          .app-shell, .shell, .layout, .layout-grid, .page, .page-content, .content,
          #root, #app, main, body, html {
            margin: 0 !important;
            padding: 0 !important;
            inset: auto !important;
          }
          .has-sidebar, .with-sidebar, [data-has-sidebar], .sidebar-open,
          .content--with-sidebar, .content-shift, .content-wrapper {
            padding-left: 0 !important;
            margin-left: 0 !important;
            grid-template-columns: 1fr !important;
          }
          html, body, #root, #app, main, .page, .content {
            width: 100% !important;
            max-width: 100% !important;
            box-sizing: border-box !important;
            background: #fff !important;
          }
        `;
        doc.head?.appendChild(style);
      } catch {
        /* cross-origin: ignore safely */
      }
    };
    ifr.addEventListener("load", inject);
    return () => ifr.removeEventListener("load", inject);
  }, [open, url]);

  if (!open) return null;

  const content = (
    <div className="lb-wrap" onClick={onClose}>
      <div className="lb" onClick={(e) => e.stopPropagation()}>
        <div className="lb-head">
          <div className="lb-title">{title || "Preview"}</div>
          <button className="lb-x" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="lb-body">
          {url ? (
            <iframe
              ref={iframeRef}
              title="preview"
              src={/\?/.test(url) ? `${url}&embed=1` : `${url}?embed=1`}
              style={{ border: 0, width: "100%", height: "100%" }}
            />
          ) : html ? (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : json ? (
            <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(json, null, 2)}</pre>
          ) : (
            <div className="muted">Nothing to preview.</div>
          )}
        </div>
      </div>
      <style>{`
        .lb-wrap{ position:fixed; inset:0; background:rgba(0,0,0,0.5); display:grid; place-items:center; z-index:9999; }
        .lb{ background:#fff; width:min(1000px, 92vw); height:min(80vh, 92vh); display:grid; grid-template-rows:auto 1fr; border-radius:8px; box-shadow:0 10px 40px rgba(0,0,0,.25); }
        .lb-head{ display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid #e5e7eb; }
        .lb-title{ font-weight:600; }
        .lb-x{ background:none; border:none; font-size:22px; cursor:pointer; line-height:1; }
        .lb-body{ overflow:auto; padding:10px; }
      `}</style>
    </div>
  );

  return createPortal(content, document.body);
}

/* ---------------------------- main component ----------------------------- */
export default function ProjectOverviewPanel() {
  const { rag, dr, focusedProjectId } = useFiltersBridge();
  const hasProject = !!focusedProjectId;

  const fromAt = dr?.fromAt || dr?.from || "";
  const toAt = dr?.toAt || dr?.to || "";

  const ragKey = rag === "green" ? "active" : rag === "amber" ? "paused" : rag === "red" ? "overdue" : "";

  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");

  const [project, setProject] = React.useState(null);
  const [users, setUsers] = React.useState([]);
  const [tasks, setTasks] = React.useState([]);
  const [groups, setGroups] = React.useState([]);
  const [vehicles, setVehicles] = React.useState([]);
  const [assets, setAssets] = React.useState([]);
  const [invoices, setInvoices] = React.useState([]);
  const [inspections, setInspections] = React.useState([]);
  const [submissions, setSubmissions] = React.useState([]);
  const [clockings, setClockings] = React.useState([]);
  const [inspMgrCommentById, setInspMgrCommentById] = React.useState({});

  // lightbox
  const [lb, setLb] = React.useState({ open: false, title: "", url: "", html: "", json: null });
  const openUrl = (title, url) => setLb({ open: true, title, url, html: "", json: null });
  const openJson = (title, json) => setLb({ open: true, title, url: "", html: "", json });

  React.useEffect(() => {
    let alive = true;
    async function load() {
      if (!hasProject) return;
      setLoading(true);
      setErr("");

      const rangeParams = {};
      if (fromAt) rangeParams.start = fromAt;
      if (toAt) rangeParams.end = toAt;

      try {
        const pReq = api
          .get(`/projects/${focusedProjectId}`, { params: { _ts: Date.now() }, timeout: 12000 })
          .catch(() => null);

        const reqs = [
          api.get("/users", { params: { limit: 2000, _ts: Date.now() }, timeout: 12000 }),
          api.get("/tasks", {
            params: { projectId: focusedProjectId, limit: 2000, _ts: Date.now(), ...rangeParams },
            timeout: 12000,
          }),
          api.get("/groups", { params: { limit: 2000, _ts: Date.now() }, timeout: 12000 }),
          api.get("/vehicles", {
            params: { limit: 2000, projectId: focusedProjectId, _ts: Date.now() },
            timeout: 12000,
          }),
          api.get("/assets", {
            params: { limit: 2000, projectId: focusedProjectId, _ts: Date.now() },
            timeout: 12000,
          }),
          api.get("/invoices", {
            params: { projectId: focusedProjectId, limit: 2000, _ts: Date.now(), ...rangeParams },
            timeout: 12000,
          }),
          api.get("/inspections", {
            params: { projectId: focusedProjectId, limit: 2000, _ts: Date.now(), ...rangeParams },
            timeout: 12000,
          }).catch(() => null),
          api.get("/inspection-submissions", {
            params: { projectId: focusedProjectId, limit: 2000, _ts: Date.now(), ...rangeParams },
            timeout: 12000,
          }).catch(() => null),
          api.get("/inspections/submissions", {
            params: { projectId: focusedProjectId, limit: 2000, _ts: Date.now(), ...rangeParams },
            timeout: 12000,
          }).catch(() => null),
          api.get("/clockings", {
            params: { projectId: focusedProjectId, limit: 5000, _ts: Date.now(), ...rangeParams },
            timeout: 12000,
          }).catch(() => null),
        ];

        const [pRes, ...rest] = await Promise.allSettled([pReq, ...reqs]);
        if (!alive) return;

        const list = (r) =>
          Array.isArray(r?.data) ? r.data : Array.isArray(r?.data?.rows) ? r.data.rows : [];

        setProject(pRes.status === "fulfilled" && pRes.value ? pRes.value.data || null : null);
        setUsers(rest[0].status === "fulfilled" ? list(rest[0].value) : []);
        setTasks(rest[1].status === "fulfilled" ? list(rest[1].value) : []);
        setGroups(rest[2].status === "fulfilled" ? list(rest[2].value) : []);
        setVehicles(rest[3].status === "fulfilled" ? list(rest[3].value) : []);
        setAssets(rest[4].status === "fulfilled" ? list(rest[4].value) : []);
        setInvoices(rest[5].status === "fulfilled" ? list(rest[5].value) : []);
        const insBasic = rest[6].status === "fulfilled" ? list(rest[6].value) : [];
        const subA = rest[7].status === "fulfilled" ? list(rest[7].value) : [];
        const subB = rest[8].status === "fulfilled" ? list(rest[8].value) : [];
        setInspections(insBasic);
        setSubmissions(subA.length ? subA : subB);
        setClockings(rest[9].status === "fulfilled" ? list(rest[9].value) : []);

        const fails = [pRes, ...rest].filter((x) => x?.status === "rejected").length;
        if (fails) setErr(`${fails} source${fails > 1 ? "s" : ""} unavailable (partial data).`);
      } catch (e) {
        if (!alive) return;
        setErr(e?.response?.data?.error || String(e));
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [focusedProjectId, fromAt, toAt, hasProject]);

  const userNameById = React.useMemo(() => {
    const m = new Map(
      users.map((u) => [idOf(u), u?.name || u?.displayName || u?.fullName || u?.email || idOf(u)])
    );
    return (id) => m.get(String(id)) || String(id);
  }, [users]);

  /* ------------------------ Manager identity & notes ---------------------- */
  const managerUserId =
    project?.managerUserId ||
    project?.pmUserId ||
    project?.ownerUserId ||
    project?.projectManagerId ||
    project?.projectManagerUserId ||
    project?.assignedProjectManagerId ||
    project?.assignedManagerId ||
    project?.managerId ||
    project?.pmId ||
    project?.ownerId ||
    project?.manager?._id ||
    project?.manager?.id ||
    project?.manager?.userId ||
    project?.pm?._id ||
    project?.pm?.id ||
    project?.pm?.userId ||
    project?.owner?._id ||
    project?.owner?.id ||
    project?.owner?.userId ||
    project?.projectManager?._id ||
    project?.projectManager?.id ||
    project?.projectManager?.userId ||
    project?.assignedProjectManager?._id ||
    project?.assignedProjectManager?.id ||
    project?.assignedProjectManager?.userId ||
    idOf(project?.projectManager) ||
    idOf(project?.managerUser) ||
    idOf(project?.manager) ||
    "";

  const managerObj =
    project?.manager ||
    project?.projectManager ||
    project?.assignedProjectManager ||
    project?.pm ||
    project?.owner ||
    project?.managerUser ||
    null;

  const managerName =
    managerObj?.name ||
    managerObj?.displayName ||
    managerObj?.fullName ||
    managerObj?.email ||
    project?.managerName ||
    project?.pmName ||
    project?.ownerName ||
    project?.projectManagerName ||
    (managerUserId ? userNameById(managerUserId) : "");

  const projectComments = React.useMemo(() => {
    const base = extractCommentsFromObj(project || {});
    const addText = project?.managerNote || project?.pmNote || project?.note || "";
    if (addText) {
      base.push({
        at: project?.updatedAt || project?.modifiedAt || project?.createdAt,
        text: addText,
        authorId: managerUserId,
        authorName: managerName,
        authorRole: "manager",
      });
    }
    return base;
  }, [project, managerUserId, managerName]);

  const lastProjectUpdate = React.useMemo(() => {
    const arr = [...projectComments].filter((x) => x.text);
    arr.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    return arr[0] || null;
  }, [projectComments]);

  /* ------------------------------ Tasks ---------------------------------- */
  const now = new Date();
  const scopedTasks = React.useMemo(() => {
    const base = tasks.filter((t) => {
      const pid = String(t.projectId || t.project?._id || t.project?.id || "");
      if (pid !== focusedProjectId) return false;
      const s = startOfTask(t),
        e = dueOfTask(t);
      if (!within(s || e, fromAt, toAt)) return false;
      return true;
    });
    if (!ragKey) return base;
    return base.filter((t) => {
      const paused = isPausedLike(t.status);
      const overdue = isOverdueTask(t, now);
      const closed = isClosedLike(t.status);
      const active = !paused && !overdue && !closed;
      if (ragKey === "active") return active;
      if (ragKey === "paused") return paused;
      if (ragKey === "overdue") return overdue;
      return true;
    });
  }, [tasks, focusedProjectId, fromAt, toAt, ragKey]);

  // task manager note
  const latestMgrNoteForTask = React.useCallback(
    (t) => {
      const comments = extractCommentsFromObj(t);
      if (t?.managerNote || t?.pmNote || t?.lastManagerNote) {
        comments.push({
          at: t?.managerNoteAt || t?.pmNoteAt || t?.updatedAt || t?.modifiedAt || t?.createdAt,
          text: t?.managerNote || t?.pmNote || t?.lastManagerNote,
          authorId: managerUserId,
          authorName: managerName,
          authorRole: "manager",
        });
      }
      const filtered = comments.filter((c) => {
        if (!c?.text) return false;
        if (managerUserId && String(c.authorId) === String(managerUserId)) return true;
        if (norm(c.authorRole).includes("manager")) return true;
        if (managerName && c.authorName === managerName) return true;
        return false;
      });
      filtered.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
      return filtered[0] || null;
    },
    [managerUserId, managerName]
  );

  /* ----------------- Inspections index (vehicles & assets) ---------------- */
  const inspectionIndex = React.useMemo(() => {
    const src = submissions.length ? submissions : inspections;
    const idx = { byTarget: new Map(), byName: new Map(), byId: new Map() };
    for (const ins of src) {
      const targetId = idOf(ins.targetId || ins.assetId || ins.vehicleId || ins.subjectId || ins.itemId || "");
      const statusRaw = String(
        ins.status ?? ins.result ?? ins.outcome ?? (ins.passed === true ? "Pass" : ins.passed === false ? "Fail" : "")
      ).toLowerCase();
      const passed = statusRaw.includes("pass") && !statusRaw.includes("fail");
      const at = ins.date || ins.inspectedAt || ins.completedAt || ins.createdAt || ins.updatedAt;
      const name = ins.title || ins.type || ins.formName || ins.form?.name || ins.name || "";
      const inspector =
        ins.runBy?.name ||
        ins.signoff?.name ||
        ins.inspectorName ||
        (ins.inspector ? ins.inspector.name || userNameById(idOf(ins.inspector)) : "") ||
        (ins.inspectorId ? userNameById(ins.inspectorId) : "");

      const rec = { id: idOf(ins), at, passed, name, inspector };

      if (targetId) {
        const prev = idx.byTarget.get(targetId);
        if (!prev || new Date(rec.at || 0) > new Date(prev.at || 0)) idx.byTarget.set(targetId, rec);
      }
      const label = (ins.assetName || ins.vehicleReg || ins.vehicleName || ins.name || ins.label || name || "").toString();
      if (label) {
        const prev = idx.byName.get(label);
        if (!prev || new Date(rec.at || 0) > new Date(prev.at || 0)) idx.byName.set(label, rec);
      }
      idx.byId.set(idOf(ins), rec);
    }
    return idx;
  }, [submissions, inspections, users]);

  const vRows = React.useMemo(() => {
    return vehicles
      .filter((v) => String(v.projectId || v.project?._id || v.project?.id || "") === focusedProjectId)
      .map((v) => {
        const id = idOf(v);
        const byId = inspectionIndex.byTarget.get(id);
        const byName = inspectionIndex.byName.get(v.reg || v.registration || v.plate || v.name || "");
        const last = byId || byName || null;
        const statusOnSelf =
          v.lastInspectionResult ||
          v.inspectionStatus ||
          (v.lastInspectionPassed === true ? "Passed" : v.lastInspectionPassed === false ? "Failed" : "");
        return {
          id,
          reg: v.reg || v.registration || v.plate || v.name || "—",
          driver:
            v.driverName ||
            (v.driverId ? userNameById(v.driverId) : v.driver ? userNameById(idOf(v.driver)) : ""),
          status: v.status || "",
          lastInspectionAt: last?.at || v.lastInspectionAt || v.inspectionAt || "",
          lastInspectionResult: last ? (last.passed ? "Passed" : "Failed") : statusOnSelf || "",
          lastInspectionId: last?.id || null,
        };
      });
  }, [vehicles, focusedProjectId, inspectionIndex, users]);

  const aRows = React.useMemo(() => {
    return assets
      .filter((a) => String(a.projectId || a.project?._id || a.project?.id || "") === focusedProjectId)
      .map((a) => {
        const id = idOf(a);
        const byId = inspectionIndex.byTarget.get(id);
        const byName = inspectionIndex.byName.get(a.name || a.title || "");
        const last = byId || byName || null;
        const statusOnSelf =
          a.lastInspectionResult ||
          a.inspectionStatus ||
          (a.lastInspectionPassed === true ? "Passed" : a.lastInspectionPassed === false ? "Failed" : "");
        return {
          id,
          name: a.name || a.title || "—",
          lastInspectionAt: last?.at || a.lastInspectionAt || a.inspectionAt || "",
          lastInspectionResult: last ? (last.passed ? "Passed" : "Failed") : statusOnSelf || "",
          lastInspectionId: last?.id || null,
        };
      });
  }, [assets, focusedProjectId, inspectionIndex]);

  /* ----------------------- Invoices + outstanding ------------------------- */
  const invRows = React.useMemo(() => {
    return invoices
      .filter((inv) => String(inv.projectId || inv.project?._id || inv.project?.id || "") === focusedProjectId)
      .map((inv) => {
        const amount = Number(inv.total ?? inv.amount ?? inv.value ?? 0);
        const paid = Number(inv.paid ?? inv.amountPaid ?? inv.paidAmount ?? 0);

        const statusRaw = inv.paymentStatus || inv.status || inv.state || (inv.paidAt ? "paid" : "unpaid");
        const statusNorm = String(statusRaw || "").toLowerCase();

        const paidLike = !!inv.paidAt || /paid|settled|complete|completed/.test(statusNorm) || (paid > 0 && paid >= amount);

        const balance = Number(inv.balanceDue ?? inv.balance ?? inv.outstanding ?? amount - paid);
        const safeBalance = paidLike ? 0 : isNaN(balance) ? amount - paid : balance;

        return {
          id: idOf(inv),
          number: inv.number || inv.ref || inv.reference || inv.code || idOf(inv),
          submittedAt: inv.submittedAt || inv.issueDate || inv.date || inv.createdAt || "",
          status: statusRaw,
          statusNorm,
          amount,
          paid,
          balance: safeBalance,
          fileUrl: inv.fileUrl || inv.url || inv.documentUrl || inv.attachment?.url || inv.file?.url || "",
        };
      });
  }, [invoices, focusedProjectId]);

  const outstandingTotal = React.useMemo(() => {
    return invRows.reduce((sum, r) => sum + (isNaN(r.balance) ? 0 : r.balance), 0);
  }, [invRows]);

  /* --------------------------- Inspections feed --------------------------- */
  // OPTION A ONLY: Map manager note from whatever list endpoint returns (no extra API calls)
  const inspRows = React.useMemo(() => {
    const src = submissions.length ? submissions : inspections;

    return src
      .map((ins) => {
        // Title
        const name = ins.formTitle || ins.title || ins.formName || ins.form?.name || ins.name || "";

        // Inspector (SubmissionView uses runBy + signoff)
        const inspector =
          ins.runBy?.name ||
          ins.signoff?.name ||
          ins.runBy?.email ||
          ins.signoff?.email ||
          ins.inspectorName ||
          (ins.inspector ? ins.inspector.name || userNameById(idOf(ins.inspector)) : "") ||
          (ins.inspectorId ? userNameById(ins.inspectorId) : "") ||
          "";

        // Status (SubmissionView uses overallResult: pass/fail)
        const raw = String(
          ins.overallResult ??
            ins.overall?.result ??
            ins.summary?.result ??
            ins.status ??
            ins.result ??
            ins.outcome ??
            (ins.passed === true ? "pass" : ins.passed === false ? "fail" : "")
        ).toLowerCase();

        const status = raw === "pass" ? "Passed" : raw === "fail" ? "Failed" : raw ? raw : "";

         // ✅ Newest manager comment ONLY (manager-specific, newest wins)
const managerComment =
  inspMgrCommentById[idOf(ins)] ||
  newestManagerCommentForInspection(ins, managerUserId, managerName);

        const date = ins.completedAt || ins.submittedAt || ins.createdAt || ins.updatedAt || ins.date || "";
        const scope = ins.assetId ? "Asset" : ins.vehicleId ? "Vehicle" : "Project";

        return {
          id: idOf(ins),
          date,
          name,
          scope,
          status,
          inspector,
          managerComment,
          isSubmission: Boolean(ins.items || ins.managerComments || ins.overallResult || ins.runBy),
        };
      })
      .filter((x) => within(x.date, fromAt, toAt))
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  }, [submissions, inspections, fromAt, toAt, users, managerUserId, managerName, inspMgrCommentById]);

  // NEW: lazy-fetch detail objects for top rows to get managerComments (list endpoint may omit them)
React.useEffect(() => {
  let alive = true;

  async function hydrate() {
    // only hydrate what you're actually showing
    const top = inspRows.slice(0, 12);
    const missing = top.filter((r) => !inspMgrCommentById[r.id]);

    if (!missing.length) return;

    const results = await Promise.allSettled(
      missing.map(async (r) => {
        const path = r.isSubmission ? `/inspections/submissions/${r.id}` : `/inspections/${r.id}`;
        const res = await api.get(path, { params: { _ts: Date.now() }, timeout: 12000 });
        const detail = res?.data || {};
        const text = newestManagerCommentForInspection(detail, managerUserId, managerName);
        return { id: r.id, text };
      })
    );

    if (!alive) return;

    const patch = {};
    for (const rr of results) {
      if (rr.status !== "fulfilled") continue;
      const { id, text } = rr.value || {};
      if (id && text) patch[id] = text;
    }

    if (Object.keys(patch).length) {
      setInspMgrCommentById((prev) => ({ ...prev, ...patch }));
    }
  }

  hydrate();

  return () => {
    alive = false;
  };
}, [inspRows, managerUserId, managerName]); // intentionally NOT depending on inspMgrCommentById to avoid loops

  /* ----------------------------- IODs list -------------------------------- */
  function clockingType(r) {
    const text = [r?.type, r?.status, r?.reason, r?.state, r?.category, r?.label, r?.note, r?.comment, r?.details, r?.message]
      .map((s) => String(s || "").toLowerCase())
      .join(" ");
    if (/\biod|injury\s*on\s*duty|injured\b/.test(text)) return "iod";
    if (/\bsick|ill|medical\b/.test(text)) return "sick";
    if (/\b(training|course|induction)\b/.test(text)) return "training";
    if (/\b(present|checked\s*in|clocked\s*in|\bin\b)\b/.test(text)) return "present";
    return "";
  }

  const iodRows = React.useMemo(() => {
    const fset = new Map();
    for (const r of clockings) {
      const pid = String(r.projectId || r.project?._id || r.project?.id || "");
      if (pid && pid !== focusedProjectId) continue;
      const at = r?.date || r?.day || r?.on || r?.createdAt || r?.time || r?.timestamp || r?.updatedAt;
      if (!within(at, fromAt, toAt)) continue;
      if (clockingType(r) !== "iod") continue;
      const uid = idOf(r.user || r.userId || r.uid);
      if (!uid) continue;
      const note = r?.note || r?.comment || r?.reason || r?.details || r?.message || r?.description || "";
      const prev = fset.get(uid);
      if (!prev || new Date(at || 0) < new Date(prev.at || 0)) {
        fset.set(uid, { id: idOf(r), user: userNameById(uid), at, note });
      }
    }
    return Array.from(fset.values()).sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  }, [clockings, focusedProjectId, fromAt, toAt, users]);

  /* ---------------------------- click handlers ---------------------------- */
  const openTask = (t) => openUrl(t.title || t.name || "Task", `/tasks/${idOf(t)}`);
  const openInspection = (row) => {
    const path = row.isSubmission ? `/inspections/submissions/${row.id}` : `/inspections/${row.id}`;
    openUrl(row.name || "Inspection", path);
  };
  const openVehicle = (id) => openUrl("Vehicle", `/vehicles/${id}`);
  const openAsset = (id) => openUrl("Asset", `/assets/${id}`);
  const openInvoice = async (inv) => {
    if (inv.fileUrl) return openUrl(`Invoice ${inv.number}`, inv.fileUrl);
    try {
      const r = await api.get(`/invoices/${inv.id}`, { params: { _ts: Date.now() }, timeout: 10000 });
      const d = r?.data || {};
      const url = d.fileUrl || d.url || d.documentUrl || d.attachment?.url || d.file?.url || "";
      if (url) return openUrl(`Invoice ${inv.number}`, url);
      return openJson(`Invoice ${inv.number}`, d);
    } catch {
      return openJson(`Invoice ${inv.number}`, inv);
    }
  };
  const openClocking = async (row) => {
    try {
      const r = await api.get(`/clockings/${row.id}`, { params: { _ts: Date.now() }, timeout: 10000 });
      return openJson(`Clocking · ${row.user}`, r?.data || {});
    } catch {
      return openJson(`Clocking · ${row.user}`, row);
    }
  };

  /* ------------------------------- pills --------------------------------- */
  const pill = (label, tone = "muted") => <span className={`pill pill--${tone}`}>{label}</span>;
  const toneForStatus = (s = "") => {
    const v = String(s).toLowerCase();
    if (/(pass|paid|complete|completed|done|ok|active)/.test(v)) return "ok";
    if (/(fail|overdue|critical|blocked|void|cancel)/.test(v)) return "bad";
    if (/(pending|submitted|unpaid|waiting|hold|paused)/.test(v)) return "warn";
    return "muted";
  };

  /* -------------------------------- UI ----------------------------------- */
  const start = project?.start || project?.startDate || project?.begin || project?.startAt || "";
  const end = project?.end || project?.endDate || project?.due || project?.deadlineAt || project?.finishAt || "";

  // NOTE: left as your original fallback; if you want PM-note-driven "Last Updated", we can switch this next.
  const updatedAt = project?.updatedAt || project?.modifiedAt || project?.lastUpdatedAt || project?.statusAt || "";

  return (
    <div>
      <style>{`
        .row{ display:grid; gap:10px; }
        .block{ display:grid; gap:6px; }
        .kv{ display:grid; grid-template-columns: 140px 1fr; gap:8px; font-size:12px; }
        .muted{ color:#6b7280; }
        .h{ font-weight:700; margin-top:6px; }
        .table{ width:100%; border-collapse: collapse; font-size:12px; }
        .table th,.table td{ border-top:1px solid #e5e7eb; padding:6px 6px; text-align:left; vertical-align:top; }
        .grid2{ display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
        .linkish{ color:#2563eb; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
        .pill{ display:inline-block; font-size:11px; line-height:1; padding:3px 6px; border-radius:999px; margin-right:4px; vertical-align:middle; }
        .pill--ok{ background:#dcfce7; color:#166534; }
        .pill--warn{ background:#fef9c3; color:#854d0e; }
        .pill--bad{ background:#fee2e2; color:#991b1b; }
        .pill--muted{ background:#e5e7eb; color:#374151; }
        @media (max-width: 760px){ .grid2{ grid-template-columns: 1fr; } .kv{ grid-template-columns: 1fr; } }
      `}</style>

      {!hasProject ? (
        <div className="muted" style={{ fontSize: 13 }}>
          Select a project to see its overview here.
        </div>
      ) : (
        <div className="row">
          <div className="h">Project Overview</div>
          {loading && <div className="muted" style={{ fontSize: 12 }}>Loading…</div>}
          {err && <div style={{ color: "#b91c1c", fontSize: 12 }}>{err}</div>}

          {/* Header facts */}
          <div className="kv">
            <div className="muted">Manager</div>
            <div>{managerName || <span className="muted">—</span>}</div>

            <div className="muted">Start → End</div>
            <div>
              {dOr(start)} → {dOr(end)}
            </div>

            <div className="muted">Last Updated</div>
            <div>
              {dOr(updatedAt, "datetime")}
              {lastProjectUpdate?.text ? (
                <div className="muted" style={{ marginTop: 2 }}>
                  <em>“{lastProjectUpdate.text}”</em>
                  {lastProjectUpdate?.at ? <> — {dOr(lastProjectUpdate.at, "datetime")}</> : null}
                  {lastProjectUpdate?.authorName ? <> · {lastProjectUpdate.authorName}</> : null}
                </div>
              ) : null}
            </div>
          </div>

          {/* Tasks table */}
          <div className="block">
            <div className="h">Tasks</div>
            {!scopedTasks.length ? (
              <div className="muted">No tasks in range.</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Status / Due</th>
                    <th>Groups &amp; Leaders</th>
                    <th>Last Manager Update</th>
                  </tr>
                </thead>
                <tbody>
                  {scopedTasks.slice(0, 12).map((t) => {
                    const gids = groupIdsOfTask(t);
                    const groupBits = gids.map((gid) => {
                      const g = groups.find((x) => idOf(x) === gid);
                      const leaderId =
                        g?.leaderUserId ||
                        g?.leaderId ||
                        g?.groupLeaderUserId ||
                        g?.groupLeaderId ||
                        g?.leader?._id ||
                        g?.leader?.id ||
                        g?.leader ||
                        "";
                      const leaderName = leaderId ? userNameById(leaderId) : "";
                      return `${g?.name || gid}${leaderName ? ` — ${leaderName}` : ""}`;
                    });
                    const latestMgr = latestMgrNoteForTask(t);
                    const status = String(t.status || "").trim() || "—";
                    const due = dueOfTask(t);
                    const overdue = isOverdueTask(t, now);
                    return (
                      <tr key={idOf(t)}>
                        <td>
                          <span className="linkish" onClick={() => openUrl(t.title || t.name || "Task", `/tasks/${idOf(t)}`)}>
                            {t.title || t.name || idOf(t)}
                          </span>
                        </td>
                        <td>
                          {pill(status, toneForStatus(status))}
                          {due ? <span> due {dOr(due)}</span> : null}
                          {overdue ? <> {pill("Overdue", "bad")}</> : null}
                        </td>
                        <td>{groupBits.length ? groupBits.join(", ") : <span className="muted">—</span>}</td>
                        <td>
                          {latestMgr?.at ? <div className="muted">{dOr(latestMgr.at, "datetime")}</div> : <span className="muted">—</span>}
                          {latestMgr?.text ? <div className="muted"><em>“{latestMgr.text}”</em></div> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Vehicles & Assets */}
          <div className="grid2">
            <div className="block">
              <div className="h">Vehicles</div>
              {!vRows.length ? (
                <div className="muted">None in range</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Reg</th>
                      <th>Driver</th>
                      <th>Status</th>
                      <th>Last Inspection</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vRows.slice(0, 12).map((v) => (
                      <tr key={v.id}>
                        <td>
                          <span className="linkish" onClick={() => openVehicle(v.id)}>
                            {v.reg}
                          </span>
                        </td>
                        <td>{v.driver || <span className="muted">—</span>}</td>
                        <td>{v.status ? pill(v.status, toneForStatus(v.status)) : <span className="muted">—</span>}</td>
                        <td>
                          {v.lastInspectionAt ? (
                            <>
                              {dOr(v.lastInspectionAt)} · {pill(v.lastInspectionResult || "—", toneForStatus(v.lastInspectionResult))}
                              {v.lastInspectionId ? (
                                <> · <span className="linkish" onClick={() => openInspection({ id: v.lastInspectionId, isSubmission: true, name: `Inspection ${v.reg}` })}>view</span></>
                              ) : null}
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="block">
              <div className="h">Assets</div>
              {!aRows.length ? (
                <div className="muted">None in range</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Last Inspection</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aRows.slice(0, 12).map((a) => (
                      <tr key={a.id}>
                        <td>
                          <span className="linkish" onClick={() => openAsset(a.id)}>
                            {a.name}
                          </span>
                        </td>
                        <td>
                          {a.lastInspectionAt ? (
                            <>
                              {dOr(a.lastInspectionAt)} · {pill(a.lastInspectionResult || "—", toneForStatus(a.lastInspectionResult))}
                              {a.lastInspectionId ? (
                                <> · <span className="linkish" onClick={() => openInspection({ id: a.lastInspectionId, isSubmission: true, name: `Inspection ${a.name}` })}>view</span></>
                              ) : null}
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Invoices */}
          <div className="block">
            <div className="h">
              Invoices {invRows.length ? <span className="muted">· Outstanding: {money(outstandingTotal)}</span> : null}
            </div>
            {!invRows.length ? (
              <div className="muted">None in range</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Invoice #</th>
                    <th>Submitted</th>
                    <th>Status</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {invRows.slice(0, 12).map((inv) => (
                    <tr key={inv.id}>
                      <td>
                        <span className="linkish" onClick={() => openInvoice(inv)}>
                          {inv.number}
                        </span>
                      </td>
                      <td>{dOr(inv.submittedAt)}</td>
                      <td>{pill(inv.status, toneForStatus(inv.status))}</td>
                      <td>{money(inv.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Inspections feed */}
          <div className="block">
            <div className="h">Inspections</div>
            {!inspRows.length ? (
              <div className="muted">None in range</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Inspection</th>
                    <th>Scope</th>
                    <th>Status</th>
                    <th>Inspector</th>
                    <th>Manager comment</th>
                  </tr>
                </thead>
                <tbody>
                  {inspRows.slice(0, 12).map((x) => (
                    <tr key={x.id}>
                      <td>{dOr(x.date)}</td>
                      <td>
                        <span className="linkish" onClick={() => openInspection(x)}>
                          {x.name || "—"}
                        </span>
                      </td>
                      <td>{x.scope}</td>
                      <td>{x.status ? pill(x.status, toneForStatus(x.status)) : "—"}</td>
                      <td>{x.inspector || <span className="muted">—</span>}</td>
                      <td>{x.managerComment ? <em className="muted">{x.managerComment}</em> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Clocking IODs */}
          <div className="block">
            <div className="h">Clocking IODs</div>
            {!iodRows.length ? (
              <div className="muted">No IOD records in range.</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Date</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {iodRows.slice(0, 12).map((r) => (
                    <tr key={`${r.user}-${r.at}`}>
                      <td>{r.user}</td>
                      <td>{dOr(r.at)}</td>
                      <td>
                        {r.note ? (
                          <>
                            {pill("IOD", "warn")}{" "}
                            <span className="linkish" onClick={() => openClocking(r)}>
                              {r.note}
                            </span>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Lightbox (portal at document.body) */}
      <Lightbox
        open={lb.open}
        title={lb.title}
        url={lb.url}
        json={lb.json}
        onClose={() => setLb({ open: false, title: "", url: "", html: "", json: null })}
      />
    </div>
  );
}
