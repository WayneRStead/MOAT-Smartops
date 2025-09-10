// src/components/DocPreviewModal.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

/**
 * Props:
 * - doc: object that may look like:
 *    { _id, name?, title?, filename?, mime?, sizeBytes?, url?, latest?: { url, filename, mime, sizeBytes } }
 *   (Minimally needs either _id or a usable url via doc.url / doc.latest.url)
 * - onClose: () => void
 * - buildPreviewUrl?: (doc) => string   // optional override
 * - buildDownloadUrl?: (doc) => string  // optional override
 */
export default function DocPreviewModal({
  doc,
  onClose,
  buildPreviewUrl,
  buildDownloadUrl,
}) {
  const [meta, setMeta] = useState(doc || null);
  const [textSample, setTextSample] = useState("");
  const [objUrl, setObjUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // ---- Helpers ----
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
  function addQuery(u, key, val) {
    try {
      const url = new URL(u, window.location.origin);
      url.searchParams.set(key, val);
      return url.pathname + url.search + url.hash;
    } catch {
      // relative or odd URLs – fallback to a simple appender
      return u + (u.includes("?") ? "&" : "?") + `${encodeURIComponent(key)}=${encodeURIComponent(val)}`;
    }
  }
  const preferredName =
    meta?.title || meta?.name || meta?.filename || meta?.latest?.filename || "document";

  // Resolve preview & download URLs from multiple shapes
  const resolvedPreviewUrl = useMemo(() => {
    if (!meta) return "";
    if (typeof buildPreviewUrl === "function") return buildPreviewUrl(meta);
    if (meta.previewUrl) return meta.previewUrl;
    if (meta.latest?.url) return meta.latest.url;
    if (meta.url) return meta.url;
    if (meta._id) return `/api/vault/${meta._id}/file`; // legacy default
    return "";
  }, [meta, buildPreviewUrl]);

  const resolvedDownloadUrl = useMemo(() => {
    if (!meta) return "";
    if (typeof buildDownloadUrl === "function") return buildDownloadUrl(meta);
    if (meta.downloadUrl) return meta.downloadUrl;
    if (meta.latest?.url) return addQuery(meta.latest.url, "download", "1");
    if (meta.url) return addQuery(meta.url, "download", "1");
    if (meta._id) return `/api/vault/${meta._id}/file?download=1`; // legacy default
    return "";
  }, [meta, buildDownloadUrl]);

  // Prefer an explicit mime, else guess from filename
  const mime = useMemo(() => {
    return (meta?.mime || meta?.latest?.mime || guessMimeFromName(preferredName)).toLowerCase();
  }, [meta, preferredName]);

  // Capabilities
  const isImage = /^image\//.test(mime);
  const isVideo = /^video\//.test(mime);
  const isAudio = /^audio\//.test(mime);
  const isPdf   = mime === "application/pdf";
  const isTextLike = /^text\//.test(mime) || /\/(json|csv)$/.test(mime);

  const sizeLabel =
    meta?.sizeBytes != null
      ? `${(Number(meta.sizeBytes) / 1024).toFixed(1)} KB`
      : meta?.latest?.sizeBytes != null
      ? `${(Number(meta.latest.sizeBytes) / 1024).toFixed(1)} KB`
      : "—";

  // Try to enrich meta for legacy vault docs (optional). If the endpoint doesn’t exist, we ignore it.
  useEffect(() => {
    let alive = true;
    setErr("");
    setMeta(doc || null);
    // Only fetch if we have an id but missing sensible info
    (async () => {
      if (!doc?._id) return;
      const needs =
        !doc?.mime && !doc?.latest?.mime && !doc?.sizeBytes && !doc?.latest?.sizeBytes && !doc?.name && !doc?.title;
      if (!needs) return;
      try {
        const { data } = await api.get(`/vault/${doc._id}`);
        if (alive && data) setMeta((m) => ({ ...m, ...data }));
      } catch (e) {
        // Don’t surface 404/etc as UI error; we can still preview via URLs we already have.
        // If you do want to show, uncomment:
        // if (alive) setErr(e?.response?.data?.error || String(e));
      }
    })();
    return () => { alive = false; };
  }, [doc]);

  // Fetch content for preview:
  // - Text-like: fetch text
  // - Others: fetch blob and render via object URL (helps when server sets Content-Disposition: attachment)
  useEffect(() => {
    let alive = true;
    let revokeUrl = "";
    setLoading(false);
    setErr("");
    setTextSample("");
    if (objUrl) {
      try { URL.revokeObjectURL(objUrl); } catch {}
      setObjUrl("");
    }
    if (!resolvedPreviewUrl) return;

    (async () => {
      try {
        setLoading(true);
        // Try a HEAD-like sniff by just requesting; we already know desired behavior from mime,
        // but server mime may differ — it’s fine, user asked to preview anyway.
        if (isTextLike) {
          const res = await fetch(resolvedPreviewUrl, { credentials: "include" });
          if (!res.ok) throw new Error(`Failed to load (status ${res.status})`);
          const txt = await res.text();
          if (alive) setTextSample(txt);
        } else {
          const res = await fetch(resolvedPreviewUrl, { credentials: "include" });
          if (!res.ok) throw new Error(`Failed to load (status ${res.status})`);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          revokeUrl = url;
          if (alive) setObjUrl(url);
        }
      } catch (e) {
        if (alive) setErr(e?.message || "Failed to preview file.");
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
      if (revokeUrl) {
        try { URL.revokeObjectURL(revokeUrl); } catch {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedPreviewUrl, mime]);

  // Close on Escape
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!doc) return null;

  return (
    <div className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center p-3">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b">
          <div className="min-w-0">
            <div className="font-medium truncate" title={preferredName}>{preferredName}</div>
            <div className="text-xs text-gray-600">
              Type: {mime || "unknown"} • Size: {sizeLabel}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {resolvedDownloadUrl ? (
              <a
                href={resolvedDownloadUrl}
                className="px-3 py-1.5 border rounded"
                target="_blank"
                rel="noreferrer"
              >
                Download
              </a>
            ) : null}
            <button className="px-3 py-1.5 border rounded" onClick={onClose}>Close</button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto bg-gray-50">
          {loading && !err && (
            <div className="p-4 text-sm text-gray-700">Loading preview…</div>
          )}
          {err && (
            <div className="p-4 text-red-600 text-sm">{err}</div>
          )}

          {!loading && !err && (
            <>
              {/* Text-like */}
              {isTextLike && (
                <div className="p-4">
                  <pre className="text-xs whitespace-pre-wrap bg-white rounded border p-3 overflow-auto max-h-[75vh]">
                    {textSample || "(empty file)"}
                  </pre>
                </div>
              )}

              {/* Image */}
              {isImage && objUrl && (
                <div className="p-4 flex items-center justify-center">
                  <img
                    src={objUrl}
                    alt={preferredName}
                    className="max-h-[75vh] max-w-full object-contain rounded bg-white"
                  />
                </div>
              )}

              {/* Video */}
              {isVideo && objUrl && (
                <div className="p-4">
                  <video src={objUrl} controls className="w-full max-h-[75vh] bg-black" />
                </div>
              )}

              {/* Audio */}
              {isAudio && objUrl && (
                <div className="p-4">
                  <audio src={objUrl} controls className="w-full" />
                </div>
              )}

              {/* PDF */}
              {isPdf && objUrl && (
                <div className="h-[75vh]">
                  <iframe title="PDF preview" src={objUrl} className="w-full h-full" />
                </div>
              )}

              {/* Unsupported */}
              {!isTextLike && !isImage && !isVideo && !isAudio && !isPdf && (
                <div className="p-4 text-sm text-gray-700">
                  <p>Preview for this file type isn’t supported yet.</p>
                  {resolvedDownloadUrl && (
                    <p className="mt-2">
                      Click <b>Download</b> above to open it with your default app.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
