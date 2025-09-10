// src/components/ClockingsExportButton.jsx
import React, { useState } from "react";
import { api } from "../lib/api";

// Tiny CSV helper that handles quotes, commas, newlines safely
function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.map(c => esc(c.header || c.key)).join(",");
  const body = rows.map(r =>
    columns.map(c => {
      const raw = typeof c.get === "function" ? c.get(r) : r[c.key];
      return esc(raw);
    }).join(",")
  ).join("\n");
  return `${header}\n${body}`;
}

export default function ClockingsExportButton({
  // required: a function that returns the exact params you use for your table fetch
  getCurrentQueryParams, 
  // optional: let us know how to paginate
  pageSizeParam = "limit",
  cursorParam = "cursor",
  pageSize = 500,
  // optional: filename
  filename = "clockings.csv",
  // optional: transform api response to { rows, nextCursor }
  normalizeListResponse = (data) => ({
    rows: Array.isArray(data?.rows) ? data.rows : (Array.isArray(data) ? data : []),
    nextCursor: data?.nextCursor || data?.next || data?.cursor || null
  }),
  // columns to export (change to match your schema)
  columns = [
    { key: "_id", header: "id" },
    { key: "userName", header: "user", get: r => r.user?.name || r.userName || r.userEmail || r.userId || "" },
    { key: "projectName", header: "project", get: r => r.project?.name || r.projectName || r.projectId || "" },
    { key: "taskTitle", header: "task", get: r => r.task?.title || r.taskTitle || r.taskId || "" },
    { key: "action", header: "action" },
    { key: "at", header: "at", get: r => r.at ? new Date(r.at).toISOString() : "" },
    { key: "durationMinutes", header: "durationMinutes" },
    { key: "lat", header: "lat", get: r => r.location?.lat ?? r.lat ?? "" },
    { key: "lng", header: "lng", get: r => r.location?.lng ?? r.lng ?? "" },
    { key: "note", header: "note" },
    { key: "source", header: "source" },
    { key: "device", header: "device" },
  ],
  className = "px-3 py-2 border rounded",
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function tryServerCsv(params) {
    // If you implement a backend CSV export, it might live here:
    // GET /clockings/export.csv?...
    try {
      const { data, headers } = await api.get("/clockings/export.csv", {
        params,
        responseType: "blob",
        // disable caches to avoid stale CSV
        headers: { "cache-control": "no-cache" },
      });
      const contentType = (headers["content-type"] || "").toLowerCase();
      if (!contentType.includes("text/csv")) return null;
      return data; // Blob
    } catch (e) {
      // 404 => no server endpoint: fall back to client export
      if (e?.response?.status === 404) return null;
      // Other errors should surface
      throw e;
    }
  }

  async function fetchAllPages(params) {
    const all = [];
    let cursor = null;
    let guard = 0;
    do {
      guard += 1;
      const pageParams = {
        ...params,
        [pageSizeParam]: pageSize,
      };
      if (cursor) pageParams[cursorParam] = cursor;

      const { data } = await api.get("/clockings", {
        params: pageParams,
        headers: { "cache-control": "no-cache" },
      });
      const { rows, nextCursor } = normalizeListResponse(data);
      if (Array.isArray(rows) && rows.length) all.push(...rows);
      cursor = nextCursor || null;
    } while (cursor && guard < 100); // hard stop just in case

    return all;
  }

  async function exportCsv() {
    setErr("");
    setBusy(true);
    try {
      const baseParams = getCurrentQueryParams?.() || {};
      // 1) Try server CSV if available
      const serverCsvBlob = await tryServerCsv(baseParams);
      if (serverCsvBlob) {
        const url = URL.createObjectURL(serverCsvBlob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
        setBusy(false);
        return;
      }

      // 2) Client-side export: fetch all rows for current search
      const rows = await fetchAllPages(baseParams);
      const csv = toCsv(rows, columns);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Failed to export CSV.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button onClick={exportCsv} disabled={busy} className={className} title="Export search results as CSV">
        {busy ? "Exporting…" : "Export CSV"}
      </button>
      {err && <span className="text-sm text-red-600">{err}</span>}
    </div>
  );
}
