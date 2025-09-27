// src/pages/InspectionRun.jsx
import React, { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import InspectionRunner from "../components/InspectionRunner.jsx";

/* ---------- Normalizer (title + id) ---------- */
function normalizeTemplate(t) {
  if (!t) return t;
  const id = String(t._id || t.id || "");
  const title = t.title ?? t.name ?? "Untitled form";
  return { ...t, _id: id, id, title };
}

/* ---------- Load from multiple possible endpoints ---------- */
async function loadTemplateAny(id) {
  const idStr = String(id);
  const attempts = [
    () => api.get(`/inspection-forms/${idStr}`),
    () => api.get(`/inspection-templates/${idStr}`),
    () => api.get(`/inspections/forms/${idStr}`),
    () => api.get(`/inspections/templates/${idStr}`),
  ];
  let lastErr = null;
  for (const fn of attempts) {
    try {
      const r = await fn();
      return normalizeTemplate(r.data);
    } catch (e) {
      const st = e?.response?.status;
      if (st === 404) { lastErr = e; continue; }
      throw e;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error("Form not found");
}

export default function InspectionRun() {
  const { formId } = useParams();
  const [search] = useSearchParams();
  const projectId = search.get("projectId") || null;
  const taskId = search.get("taskId") || null;
  const navigate = useNavigate();

  const [tpl, setTpl] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let mounted = true;
    (async () => {
      setErr("");
      try {
        const data = await loadTemplateAny(formId);
        if (mounted) setTpl(data);
      } catch (e) {
        if (!mounted) return;
        const msg =
          e?.response?.data?.error ||
          e?.response?.data?.message ||
          e?.message ||
          "Failed to load form";
        setErr(msg);
      }
    })();
    return () => { mounted = false; };
  }, [formId]);

  const heading = tpl?.title ? `Run Inspection — ${tpl.title}` : "Run Inspection";

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{heading}</h1>
        <button className="px-3 py-2 border rounded" onClick={() => navigate(-1)}>Back</button>
      </div>

      {err && <div className="text-red-600">{err}</div>}

      {tpl ? (
        <InspectionRunner
          template={tpl}
          projectId={projectId}
          taskId={taskId}
          onSaved={() => navigate("/inspections")}
        />
      ) : !err ? (
        <div className="text-gray-600">Loading…</div>
      ) : null}
    </div>
  );
}
