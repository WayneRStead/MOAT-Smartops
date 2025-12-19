// src/widgets/widgets/RiskSummaryWidget.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";

/** Registry identity */
export const id = "risk.summary";
export const title = "Risks";

/* ---------- optional FilterContext (falls back to window bus) ----------- */
function useOptionalFilters() {
  let ctx = null;
  try { ctx = require("../FilterContext"); } catch {}
  if (ctx?.useFilters) return ctx.useFilters();
  return {
    filters: {},
    setFilters: () => {},
    emit: (delta) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: delta })),
  };
}

/* ----------------------------- helpers ---------------------------------- */
const size = { h: 58, pad: "10px 12px", font: 11 }; // consistent tile sizing

function haloStyle(color, active, alwaysHalo) {
  // show a soft halo if selected OR if count > 0 (alwaysHalo)
  const glow = (active || alwaysHalo) ? `0 0 0 3px ${color}` : "0 0 0 0 rgba(0,0,0,0)";
  return { boxShadow: glow };
}
const tones = {
  green: "rgba(16,185,129,.25)",   // emerald-ish halo
  amber: "rgba(245,158,11,.25)",
  red:   "rgba(239,68,68,.25)",
  gray:  "rgba(107,114,128,.18)",
};

/* Loose-normalizers used across modules */
const norm = (v) => String(v || "").toLowerCase();
const isClosedLike = (s) => ["done","closed","complete","completed","cancelled","void"].includes(norm(s));
const isPausedLike = (s) => /\bpaused|on\s*hold|hold|waiting|blocked\b/.test(norm(s));
const isStartedLike = (s) => /\bstart|started|in-?progress|open\b/.test(norm(s));

function dateOrNull(d){ if(!d) return null; const x = new Date(d); return isNaN(+x)?null:x; }

/* ----------------------------- widget ----------------------------------- */
export default function RiskSummaryWidget({ bare, compact }) {
  const { filters, setFilters, emit } = useOptionalFilters();

  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [insps, setInsps] = useState([]);
  const [assets, setAssets] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [users, setUsers] = useState([]);

  const [err, setErr] = useState("");

  // RAG master comes from filters.rag = 'green' | 'amber' | 'red' | ''
  const rag = (filters?.rag || "").toLowerCase();

  /* --------- load small batches; prefer globals if already present ------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const win = typeof window !== "undefined" ? window : {};

        // projects
        if (Array.isArray(win.__PROJECTS__)) setProjects(win.__PROJECTS__);
        else {
          const pr = await api.get("/projects", { params: { limit: 1000, _ts: Date.now() }, timeout: 10000 });
          if (alive) setProjects(Array.isArray(pr.data) ? pr.data : pr.data?.rows || []);
        }

        // tasks
        if (Array.isArray(win.__TASKS__)) setTasks(win.__TASKS__);
        else {
          const tr = await api.get("/tasks", { params: { limit: 1500, _ts: Date.now() }, timeout: 10000 });
          if (alive) setTasks(Array.isArray(tr.data) ? tr.data : tr.data?.rows || []);
        }

        // inspections (submissions)
        if (Array.isArray(win.__INSPECTIONS__)) setInsps(win.__INSPECTIONS__);
        else {
          const ir = await api.get("/inspections/submissions", { params: { limit: 800, _ts: Date.now() }, timeout: 10000 });
          if (alive) setInsps(Array.isArray(ir.data) ? ir.data : ir.data?.rows || []);
        }

        // assets
        if (Array.isArray(win.__ASSETS__)) setAssets(win.__ASSETS__);
        else {
          const ar = await api.get("/assets", { params: { limit: 800, _ts: Date.now() }, timeout: 10000 });
          if (alive) setAssets(Array.isArray(ar.data) ? ar.data : ar.data?.rows || []);
        }

        // vehicles
        if (Array.isArray(win.__VEHICLES__)) setVehicles(win.__VEHICLES__);
        else {
          const vr = await api.get("/vehicles", { params: { limit: 800, _ts: Date.now() }, timeout: 10000 });
          if (alive) setVehicles(Array.isArray(vr.data) ? vr.data : vr.data?.rows || []);
        }

        // users (for IOD/sick signals later if we want)
        if (Array.isArray(win.__USERS__)) setUsers(win.__USERS__);
        else {
          const ur = await api.get("/users", { params: { limit: 2000, _ts: Date.now() }, timeout: 10000 });
          if (alive) setUsers(Array.isArray(ur.data) ? ur.data : ur.data?.rows || []);
        }

        if (alive) setErr("");
      } catch (e) {
        if (!alive) return;
        setErr(e?.response?.data?.error || String(e));
      }
    })();
    return () => { alive = false; };
  }, []);

  /* ------------------------ derive portfolio counts ---------------------- */
  const now = useMemo(() => new Date(), []);
  const counts = useMemo(() => {
    const c = {
      proj_overdue: 0,
      proj_paused: 0,
      tasks_overdue: 0,
      tasks_paused: 0,
      ins_failed: 0,
      assets_maint: 0,
      vehicles_stolen: 0,
    };

    // projects
    for (const p of projects) {
      const end = p.end || p.endDate || p.due || p.end_at;
      const overdue = end && dateOrNull(end) && dateOrNull(end) < now && !isClosedLike(p.status);
      if (overdue) c.proj_overdue += 1;
      else if (isPausedLike(p.status)) c.proj_paused += 1;
    }

    // tasks
    const dueOf = (t) => t.dueAt || t.dueDate || t.endAt || t.endDate || t.deadlineAt || t.due;
    for (const t of tasks) {
      const overdue = (() => {
        const d = dueOf(t);
        const x = dateOrNull(d);
        return x && x < now && !isClosedLike(t.status);
      })();
      if (overdue) c.tasks_overdue += 1;
      else if (isPausedLike(t.status) || norm(t.status) === "paused-problem") c.tasks_paused += 1;
    }

    // inspections
    for (const r of insps) {
      const s = norm(r.status || r.result || r.outcome);
      const passedFlag =
        s.includes("pass") || r.passed === true ||
        (typeof r.score === "number" && typeof r.maxScore === "number" && r.score >= r.maxScore);
      if (!passedFlag) c.ins_failed += 1;
    }

    // assets
    for (const a of assets) {
      const s = norm(a.status || a.state || a.lifecycle);
      const tags = JSON.stringify(a.tags || a.labels || a.flags || "").toLowerCase();
      const isMaint = ["maintenance","maint","repair","service","workshop"].some(x => s.includes(x)) ||
                      /\bmaint|repair|service|workshop\b/.test(tags);
      if (isMaint) c.assets_maint += 1;
    }

    // vehicles
    for (const v of vehicles) {
      const s = norm(v.status || v.state || v.condition);
      const tags = JSON.stringify(v.tags || v.labels || v.flags || "").toLowerCase();
      const stolen = s.includes("stolen") || /\bstolen|hijack(ed)?\b/.test(tags);
      if (stolen) c.vehicles_stolen += 1;
    }

    return c;
  }, [projects, tasks, insps, assets, vehicles, now]);

  /* --------------------- tiles (2 rows x 4 cols) ------------------------- */
  const tiles = [
    {
      key: "proj_overdue",
      label: "Projects Overdue",
      value: counts.proj_overdue,
      tone: "red",
      click: () => emit({ project: { status: ["overdue"], ids: [] } }),
    },
    {
      key: "proj_paused",
      label: "Projects Paused",
      value: counts.proj_paused,
      tone: "amber",
      click: () => emit({ project: { status: ["paused"], ids: [] } }),
    },
    {
      key: "tasks_overdue",
      label: "Tasks Overdue",
      value: counts.tasks_overdue,
      tone: "red",
      click: () => emit({ task: { status: ["overdue"], ids: [] } }),
    },
    {
      key: "tasks_paused",
      label: "Tasks Paused",
      value: counts.tasks_paused,
      tone: "amber",
      click: () => emit({ task: { status: ["paused","paused-problem"], ids: [] } }),
    },
    {
      key: "ins_failed",
      label: "Inspections Failed",
      value: counts.ins_failed,
      tone: "red",
      click: () => emit({ inspections: { status: ["failed"] } }),
    },
    {
      key: "assets_maint",
      label: "Assets in Maintenance",
      value: counts.assets_maint,
      tone: "amber",
      click: () => emit({ assets: { status: ["maintenance"] } }),
    },
    {
      key: "vehicles_stolen",
      label: "Vehicles Stolen",
      value: counts.vehicles_stolen,
      tone: "red",
      click: () => emit({ vehicles: { status: ["stolen"] } }),
    },
  ];

  // RAG master narrows which tiles are visually emphasized (but we still show all)
  const ragToneMap = { green: "green", amber: "amber", red: "red" };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2">
      {!bare && <div className="font-semibold">Risks</div>}

      {err && <div className="mt-1 text-sm text-red-600">{err}</div>}

      <div className="mt-2 grid grid-cols-4 gap-2">
        {tiles.map((t) => {
          const on = false; // this widget doesn’t persist a selection; tiles act as quick-filters
          const toneHalo =
            t.tone === "green" ? tones.green :
            t.tone === "amber" ? tones.amber :
            t.tone === "red"   ? tones.red   : tones.gray;

          // if RAG set, de-emphasize tiles that don't match the tone
          const dim = rag && ragToneMap[rag] !== t.tone;

          return (
            <button
              key={t.key}
              type="button"
              onClick={t.click}
              className="rounded border flex flex-col items-center justify-center"
              style={{
                height: size.h,
                padding: size.pad,
                borderColor: "#e5e7eb",
                background: on ? "#f8fafc" : "#fff",
                ...(haloStyle(toneHalo, on, t.value > 0)),
                opacity: dim ? 0.55 : 1,
              }}
              title={`${t.label} • ${t.value}`}
              onMouseEnter={(e) => e.currentTarget.style.boxShadow = `0 0 0 3px ${toneHalo}`}
              onMouseLeave={(e) => e.currentTarget.style.boxShadow = haloStyle(toneHalo, on, t.value > 0).boxShadow}
            >
              <div className="text-[11px] leading-[1.1] text-gray-600 text-center">{t.label}</div>
              <div className="font-semibold" style={{ fontSize: size.font }}>{t.value}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
