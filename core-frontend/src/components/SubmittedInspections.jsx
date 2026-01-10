import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

/* --- simple modal --- */
function Modal({ open, title, onClose, children, footer, size = "xl" }) {
  if (!open) return null;
  const maxW =
    size === "sm" ? "max-w-md" :
    size === "lg" ? "max-w-3xl" :
    size === "xl" ? "max-w-5xl" : "max-w-5xl";

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`relative z-10 w-full ${maxW} rounded-2xl border bg-white shadow-xl`}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="text-lg font-semibold">{title}</div>
          <button className="text-sm underline" onClick={onClose}>Close</button>
        </div>
        <div className="p-4 space-y-3 max-h-[78vh] overflow-auto">{children}</div>
        {footer && <div className="px-4 py-3 border-t flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/* --- outcome badge --- */
function OutcomeBadge({ value }) {
  const v = String(value || "").toUpperCase();
  const cls =
    v === "PASS" ? "bg-green-50 text-green-700 border-green-200" :
    v === "FAIL" ? "bg-red-50 text-red-700 border-red-200" :
    v.includes("FOLLOW") ? "bg-amber-50 text-amber-800 border-amber-200" :
    "bg-gray-50 text-gray-700 border-gray-200";

  return (
    <span className={`px-2 py-0.5 rounded-full text-xs border ${cls}`}>
      {value || "—"}
    </span>
  );
}

/* --- safe helpers --- */
function safeDate(d) {
  const x = d ? new Date(d) : null;
  return x && !isNaN(+x) ? x : null;
}

function readStr(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return String(v).trim(); } catch { return ""; }
}

function normalizeOverallResult(v) {
  const raw = readStr(v);
  if (!raw) return "";
  const up = raw.toUpperCase().trim();

  if (["PASS", "PASSED", "OK", "SUCCESS", "COMPLIANT"].includes(up)) return "PASS";
  if (["FAIL", "FAILED", "NOK", "NONCOMPLIANT", "NON-COMPLIANT"].includes(up)) return "FAIL";
  if (["NEEDS FOLLOW-UP", "NEEDS_FOLLOW_UP", "NEEDS-FOLLOW-UP", "FOLLOW-UP", "FOLLOW UP", "REQUIRES ACTION"].includes(up))
    return "NEEDS FOLLOW-UP";

  return raw; // last resort (don’t crash / don’t lie)
}

function resolveSubmissionFields(s) {
  const submittedRaw = s?.submittedAt || s?.createdAt || s?.completedAt || s?.finishedAt || s?.updatedAt || null;
  const submitted = safeDate(submittedRaw);

  const runBy = s?.runBy && typeof s.runBy === "object" ? s.runBy : null;
  const actorObj =
    runBy ||
    (s?.actor && typeof s.actor === "object" ? s.actor : null) ||
    (s?.user && typeof s.user === "object" ? s.user : null) ||
    null;

  const inspector =
    actorObj?.name ||
    actorObj?.email ||
    runBy?.name ||
    runBy?.email ||
    s?.userName ||
    s?.createdByName ||
    s?.actorName ||
    s?.actorEmail ||
    "—";

  const formTitle =
    s?.form?.title ||
    s?.formTitle ||
    s?.templateTitle ||
    s?.templateName ||
    s?.form?.name ||
    "Form";

  // ✅ overallResult first (do NOT compute PASS/FAIL by answers here)
  const overallResultRaw =
    s?.overallResult ??
    s?.overall?.overallResult ??
    s?.summary?.overallResult ??
    s?.meta?.overallResult ??
    s?.review?.overallResult ??
    s?.results?.overallResult ??
    "";

  const outcome = normalizeOverallResult(overallResultRaw) || "—";

  return { submitted, inspector, formTitle, outcome };
}

/* --- fetch submissions with fallbacks (asset/vehicle may differ by backend) --- */
async function fetchSubmissionsFor(entityType, entityId) {
  const limit = 300;

  // Try the most likely param first: assetId / vehicleId
  const tryParams = [
    { limit, [`${entityType}Id`]: entityId },
    { limit, entityType, entityId },                  // sometimes backend uses these
    { limit, targetType: entityType, targetId: entityId },
  ];

  for (const params of tryParams) {
    try {
      const { data } = await api.get("/inspections/submissions", { params });
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.items)) return data.items;
      if (Array.isArray(data?.rows)) return data.rows;
    } catch {
      // keep trying
    }
  }

  // Last resort: load a batch and filter client-side
  // (prevents “empty list” when filter param name doesn’t match backend)
  try {
    const { data } = await api.get("/inspections/submissions", { params: { limit } });
    const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.rows) ? data.rows : [];

    const idStr = String(entityId);
    return list.filter((s) => {
      const a =
        s?.assetId || s?.asset || s?.meta?.assetId || s?.target?.assetId || null;
      const v =
        s?.vehicleId || s?.vehicle || s?.meta?.vehicleId || s?.target?.vehicleId || null;

      if (entityType === "asset") return String(a?._id || a?.id || a || "") === idStr;
      if (entityType === "vehicle") return String(v?._id || v?.id || v || "") === idStr;
      return false;
    });
  } catch {
    return [];
  }
}

export default function SubmittedInspections({ entityType, entityId }) {
  const [subs, setSubs] = useState([]);
  const [err, setErr] = useState("");

  // viewer modal
  const [open, setOpen] = useState(false);
  const [subView, setSubView] = useState(null);
  const [subViewErr, setSubViewErr] = useState("");
  const [iframeUrl, setIframeUrl] = useState("");

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!entityId) return;
      setErr("");
      try {
        const list = await fetchSubmissionsFor(entityType, entityId);
        if (mounted) setSubs(Array.isArray(list) ? list : []);
      } catch (e) {
        if (mounted) setErr(e?.response?.data?.error || e?.message || String(e));
      }
    })();
    return () => { mounted = false; };
  }, [entityType, entityId]);

  const rows = useMemo(() => {
    const copy = (subs || []).slice();
    copy.sort((a, b) => +new Date(b?.submittedAt || b?.createdAt || 0) - +new Date(a?.submittedAt || a?.createdAt || 0));
    return copy;
  }, [subs]);

  return (
    <div className="border rounded-2xl p-4 bg-white space-y-2">
      <div className="font-semibold">Submitted Inspections</div>
      {err && <div className="text-sm text-red-600">{err}</div>}

      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="p-2 text-left">Date</th>
                <th className="p-2 text-left">Form</th>
                <th className="p-2 text-left">Inspector</th>
                <th className="p-2 text-left">Overall result</th>
                <th className="p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const { submitted, formTitle, inspector, outcome } = resolveSubmissionFields(s);
                const when = submitted ? submitted.toLocaleString() : "—";
                const sid = s?._id || s?.id;

                return (
                  <tr key={String(sid || Math.random())}>
                    <td className="border-t p-2">{when}</td>
                    <td className="border-t p-2">{formTitle}</td>
                    <td className="border-t p-2">{inspector}</td>
                    <td className="border-t p-2"><OutcomeBadge value={outcome} /></td>
                    <td className="border-t p-2 text-right">
                      <button
                        type="button"
                        className="px-2 py-1 border rounded"
                        onClick={async () => {
                          setSubViewErr("");
                          setSubView(s);      // placeholder (fast)
                          setIframeUrl("");
                          setOpen(true);

                          try {
                            const { data } = await api.get(`/inspections/submissions/${sid}`, {
                              headers: { Accept: "application/json" },
                              params: { _ts: Date.now() },
                            });

                            if (
                              data && typeof data === "object" &&
                              (Array.isArray(data.answers) || data.submittedAt || data.form || data.actor || data.overallResult != null)
                            ) {
                              setSubView(data);
                              return;
                            }

                            setSubView(null);
                            setIframeUrl(`/inspections/submissions/${sid}?embed=1`);
                          } catch (e) {
                            setSubViewErr(e?.response?.data?.error || e?.message || "Failed to load submission.");
                            setSubView(null);
                            setIframeUrl(`/inspections/submissions/${sid}?embed=1`);
                          }
                        }}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-sm text-gray-600">No submissions yet.</div>
      )}

      <Modal
        open={open}
        title={subView?.form?.title || subView?.formTitle || subView?.templateTitle || "Submission"}
        onClose={() => { setOpen(false); setIframeUrl(""); setSubView(null); setSubViewErr(""); }}
        size="xl"
        footer={<button className="px-3 py-2 border rounded" onClick={() => setOpen(false)}>Close</button>}
      >
        {subViewErr && <div className="text-sm text-red-600">{subViewErr}</div>}

        {iframeUrl ? (
          <iframe
            title="Inspection Submission"
            src={iframeUrl}
            className="w-full border rounded"
            style={{ height: "70vh" }}
          />
        ) : subView ? (
          <div className="space-y-2 text-sm">
            {(() => {
              const { submitted, inspector, outcome, formTitle } = resolveSubmissionFields(subView);
              return (
                <div className="text-gray-600">
                  Form: <b>{formTitle}</b>
                  {" • "}Submitted: {submitted ? submitted.toLocaleString() : "—"}
                  {" • "}Inspector: {inspector}
                  {" • "}Overall: <b>{outcome}</b>
                </div>
              );
            })()}

            {Array.isArray(subView.answers) && subView.answers.length ? (
              <div className="space-y-1">
                {subView.answers.map((a, i) => (
                  <div key={i} className="border rounded p-2">
                    <div className="font-medium">{a?.label || a?.question || `Q${i + 1}`}</div>
                    <div className="text-gray-700 whitespace-pre-wrap">
                      {typeof a?.value === "string"
                        ? a.value
                        : JSON.stringify(a?.value ?? "", null, 2)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-gray-600">No answers on this submission.</div>
            )}
          </div>
        ) : (
          <div className="text-sm text-gray-600">Loading…</div>
        )}
      </Modal>
    </div>
  );
}
