import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fileUrl } from "../lib/api";

const MOBILE_FOLDER_OPTIONS = ["policies", "safety", "general"];
const DETAIL_CHANNEL_OPTIONS = ["mobile-library", "vault-only"];

function TagEditor({ tags = [], onChange }) {
  const [val, setVal] = useState((tags || []).join(", "));

  useEffect(() => {
    setVal((tags || []).join(", "));
  }, [tags]);

  return (
    <input
      className="border p-2 w-full"
      placeholder="safety, onboarding"
      value={val}
      onChange={(e) => {
        setVal(e.target.value);
        const t = e.target.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        onChange?.(t);
      }}
    />
  );
}

export default function DocumentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState(null);

  const [pendingMeta, setPendingMeta] = useState({
    title: "",
    channel: "vault-only",
    folder: "",
    tags: [],
  });

  const [newLink, setNewLink] = useState({ type: "project", refId: "" });

  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [pickProject, setPickProject] = useState("");
  const [pickUser, setPickUser] = useState("");

  const [projectMap, setProjectMap] = useState(new Map());
  const [userMap, setUserMap] = useState(new Map());

  const [previewUrl, setPreviewUrl] = useState("");
  const [previewMime, setPreviewMime] = useState("");
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewErr, setPreviewErr] = useState("");

  async function resolveLinkedLookups(document) {
    const links = Array.isArray(document?.links) ? document.links : [];

    const projIds = [
      ...new Set(
        links
          .filter((l) => (l.type || l.module) === "project")
          .map((l) => String(l.refId)),
      ),
    ];

    const userIds = [
      ...new Set(
        links
          .filter((l) => (l.type || l.module) === "user")
          .map((l) => String(l.refId)),
      ),
    ];

    try {
      if (projIds.length) {
        const { data } = await api.get("/projects", {
          params: { limit: 500, includeDeleted: 1 },
        });

        const map = new Map(projectMap);
        (Array.isArray(data) ? data : []).forEach((p) => {
          map.set(String(p._id), p);
        });

        setProjectMap(map);
        if (!projects.length) setProjects(Array.isArray(data) ? data : []);
      }
    } catch {
      // ignore
    }

    try {
      if (userIds.length) {
        const { data } = await api.get("/users", {
          params: { limit: 1000 },
        });

        const map = new Map(userMap);
        (Array.isArray(data) ? data : []).forEach((u) => {
          map.set(String(u._id), u);
        });

        setUserMap(map);
        if (!users.length) setUsers(Array.isArray(data) ? data : []);
      }
    } catch {
      // ignore
    }
  }

  async function load() {
    setErr("");
    setInfo("");

    try {
      const { data } = await api.get(`/documents/${id}`);
      setDoc(data);
      setPendingMeta({
        title: data.title || "",
        channel: data.channel || "vault-only",
        folder: data.folder || "",
        tags: data.tags || [],
      });
      resolveLinkedLookups(data);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    let objUrl = "";
    const controller = new AbortController();

    async function getFirstWorkingBlob(urls) {
      for (const u of urls) {
        if (!u) continue;

        try {
          const res = await fetch(u, {
            credentials: "include",
            signal: controller.signal,
          });

          if (!res.ok) continue;

          const mime = String(
            res.headers.get("content-type") || "",
          ).toLowerCase();
          const blob = await res.blob();
          return { blob, mime };
        } catch {
          // try next
        }
      }

      throw new Error("No previewable URL");
    }

    (async () => {
      setPreviewLoading(true);
      setPreviewErr("");
      setPreviewUrl("");
      setPreviewMime("");

      const primary = doc?.latest?.url ? fileUrl(doc.latest.url) : "";
      const fallbacks = [`/api/documents/${id}/file`, `/documents/${id}/file`];

      try {
        const { blob, mime } = await getFirstWorkingBlob([
          primary,
          ...fallbacks,
        ]);

        if (cancelled) return;

        objUrl = URL.createObjectURL(blob);
        setPreviewUrl(objUrl);
        setPreviewMime(
          mime ||
            (doc?.latest?.mime || "application/octet-stream").toLowerCase(),
        );
      } catch (e) {
        if (!cancelled) setPreviewErr(String(e.message || e));
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [id, doc?.latest?.url, doc?.latest?.uploadedAt, doc?.latest?.mime]);

  useEffect(() => {
    (async () => {
      try {
        if (!projects.length) {
          const { data } = await api.get("/projects", {
            params: { limit: 500, includeDeleted: 1 },
          });
          setProjects(Array.isArray(data) ? data : []);
        }
      } catch {}

      try {
        if (!users.length) {
          const { data } = await api.get("/users", {
            params: { limit: 1000 },
          });
          setUsers(Array.isArray(data) ? data : []);
        }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveMeta(patch) {
    try {
      const { data } = await api.put(`/documents/${id}`, patch);
      setDoc(data);
      setPendingMeta({
        title: data.title || "",
        channel: data.channel || "vault-only",
        folder: data.folder || "",
        tags: data.tags || [],
      });
      setInfo("Saved");
      setTimeout(() => setInfo(""), 1200);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function uploadVersion() {
    if (!file) return;

    setUploading(true);
    setErr("");
    setInfo("");

    try {
      const fd = new FormData();
      fd.append("file", file);

      const { data } = await api.post(`/documents/${id}/upload`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      setDoc(data);
      setFile(null);
      setInfo("Version uploaded.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setUploading(false);
    }
  }

  async function deleteDoc() {
    if (!window.confirm("Delete this document?")) return;

    try {
      await api.delete(`/documents/${id}`);
      setInfo("Deleted");
      navigate("/vault");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function restoreDoc() {
    setErr("");
    setInfo("");

    try {
      const { data } = await api.patch(`/documents/${id}/restore`);
      setDoc(data);
      setInfo("Restored");
    } catch (e) {
      const code = e?.response?.status;
      if (code === 404 || code === 405) {
        setErr(
          "Restore is not available on the server yet. Please add PATCH /documents/:id/restore.",
        );
      } else {
        setErr(e?.response?.data?.error || String(e));
      }
    }
  }

  async function deleteVersion(idx) {
    if (!window.confirm("Delete this version?")) return;

    try {
      await api.delete(`/documents/${id}/versions/${idx}`);
      await load();
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function restoreVersion(idx, setLatest = false) {
    try {
      const url = `/documents/${id}/versions/${idx}/restore${
        setLatest ? "?setLatest=1" : ""
      }`;
      const { data } = await api.patch(url);
      setDoc(data);
      setInfo("Version restored");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  function normalizeLink(l) {
    const type = l.type || l.module;
    return { ...l, type, module: type, refId: l.refId };
  }

  async function rewriteLinks(nextLinks) {
    const norm = (nextLinks || []).map(normalizeLink);
    const { data } = await api.put(`/documents/${id}`, { links: norm });
    setDoc((prev) => ({ ...prev, links: data.links || norm }));
    await resolveLinkedLookups({ links: norm });
  }

  async function addLink() {
    if (!newLink.refId) return;

    setErr("");
    setInfo("");

    const body = normalizeLink({ type: newLink.type, refId: newLink.refId });

    try {
      const { data } = await api.post(`/documents/${id}/links`, body);
      setDoc((prev) => ({ ...prev, links: data }));
      setNewLink({ ...newLink, refId: "" });
      await resolveLinkedLookups({ links: data });
    } catch (e) {
      const code = e?.response?.status;

      if (code === 404 || code === 405 || code === 501) {
        const exists = (doc?.links || []).some(
          (l) =>
            (l.type || l.module) === body.type &&
            String(l.refId) === String(body.refId),
        );

        const next = exists ? doc.links : [...(doc?.links || []), body];
        await rewriteLinks(next);
        setNewLink({ ...newLink, refId: "" });
        setInfo("Link added.");
        setTimeout(() => setInfo(""), 1200);
      } else {
        setErr(e?.response?.data?.error || String(e));
      }
    }
  }

  async function removeLink(type, refId) {
    setErr("");
    setInfo("");

    try {
      const { data } = await api.delete(`/documents/${id}/links`, {
        data: { type, refId },
      });
      setDoc((prev) => ({ ...prev, links: data }));
    } catch (e) {
      const code = e?.response?.status;

      if (code === 404 || code === 405 || code === 501) {
        const next = (doc?.links || []).filter(
          (l) =>
            (l.type || l.module) !== type || String(l.refId) !== String(refId),
        );
        await rewriteLinks(next);
        setInfo("Link removed.");
        setTimeout(() => setInfo(""), 1200);
      } else {
        setErr(e?.response?.data?.error || String(e));
      }
    }
  }

  async function linkProject() {
    if (!pickProject) return;
    await addLinkWith({ type: "project", refId: pickProject });
    setPickProject("");
  }

  async function linkUser() {
    if (!pickUser) return;
    await addLinkWith({ type: "user", refId: pickUser });
    setPickUser("");
  }

  async function addLinkWith(l) {
    const prev = { ...newLink };
    setNewLink({ type: l.type, refId: l.refId });
    await addLink();
    setNewLink(prev);
  }

  const projectLinks = useMemo(
    () => (doc?.links || []).filter((l) => (l.type || l.module) === "project"),
    [doc],
  );

  const userLinks = useMemo(
    () => (doc?.links || []).filter((l) => (l.type || l.module) === "user"),
    [doc],
  );

  const forLabel = useMemo(() => {
    if (!userLinks.length) return "—";
    const names = userLinks.map((l) => {
      const u = userMap.get(String(l.refId));
      return u ? u.name || u.email || u.username : String(l.refId);
    });
    return names.join(", ");
  }, [userLinks, userMap]);

  const isImg = previewMime.startsWith("image/");
  const isPdf = previewMime === "application/pdf";
  const isAudio = previewMime.startsWith("audio/");
  const isVideo = previewMime.startsWith("video/");
  const isText =
    previewMime.startsWith("text/") ||
    ["application/json", "application/xml"].includes(previewMime);

  if (!doc) {
    return (
      <div className="p-4">
        Loading… {err && <span style={{ color: "crimson" }}>({err})</span>}
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Document</h1>
        <div className="flex gap-2">
          {!doc.deletedAt ? (
            <button className="px-3 py-2 border rounded" onClick={deleteDoc}>
              Delete
            </button>
          ) : (
            <button className="px-3 py-2 border rounded" onClick={restoreDoc}>
              Restore
            </button>
          )}
          <button
            className="px-3 py-2 border rounded"
            onClick={() => navigate(-1)}
          >
            Back
          </button>
        </div>
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      <div className="grid md:grid-cols-2 gap-4">
        <div className="border rounded p-3 space-y-2">
          <label className="block text-sm">
            Title
            <input
              className="border p-2 w-full"
              value={pendingMeta.title}
              onChange={(e) =>
                setPendingMeta({ ...pendingMeta, title: e.target.value })
              }
              onBlur={() =>
                pendingMeta.title && saveMeta({ title: pendingMeta.title })
              }
            />
          </label>

          <label className="block text-sm">
            Channel
            <select
              className="border p-2 w-full"
              value={pendingMeta.channel}
              onChange={(e) => {
                const nextChannel =
                  e.target.value === "mobile-library"
                    ? "mobile-library"
                    : "vault-only";

                const nextFolder =
                  nextChannel === "mobile-library"
                    ? pendingMeta.folder || "policies"
                    : "";

                setPendingMeta({
                  ...pendingMeta,
                  channel: nextChannel,
                  folder: nextFolder,
                });

                saveMeta({
                  channel: nextChannel,
                  folder: nextFolder,
                });
              }}
            >
              {DETAIL_CHANNEL_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            Folder
            <select
              className="border p-2 w-full"
              value={
                pendingMeta.channel === "mobile-library"
                  ? pendingMeta.folder
                  : ""
              }
              disabled={pendingMeta.channel !== "mobile-library"}
              onChange={(e) => {
                const nextFolder = e.target.value;
                setPendingMeta({ ...pendingMeta, folder: nextFolder });
                saveMeta({ folder: nextFolder });
              }}
            >
              <option value="">— none —</option>
              {MOBILE_FOLDER_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            Tags
            <TagEditor
              tags={pendingMeta.tags}
              onChange={(t) => {
                setPendingMeta({ ...pendingMeta, tags: t });
                saveMeta({ tags: t });
              }}
            />
          </label>

          <div className="text-sm text-gray-600">
            Channel: {doc.channel || "vault-only"}
            <br />
            Folder: {doc.folder || "—"}
            <br />
            Created:{" "}
            {doc.createdAt
              ? new Date(doc.createdAt).toLocaleString()
              : "—"}{" "}
            {doc.createdBy ? `(by ${String(doc.createdBy)})` : ""}
            <br />
            Updated:{" "}
            {doc.updatedAt
              ? new Date(doc.updatedAt).toLocaleString()
              : "—"}{" "}
            {doc.updatedBy ? `(by ${String(doc.updatedBy)})` : ""}
            {doc.deletedAt && (
              <>
                <br />
                <span className="text-red-700">
                  Deleted: {new Date(doc.deletedAt).toLocaleString()}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="border rounded p-3 space-y-2">
          <div className="font-semibold">Latest</div>

          {!doc.latest ? (
            <div className="text-sm text-gray-600">No versions yet.</div>
          ) : (
            <>
              <div className="text-sm">
                <a
                  href={fileUrl(doc.latest.url)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {doc.latest.filename}
                </a>{" "}
                <span className="text-gray-600">
                  ({doc.latest.mime || doc.latest.mimeType || "file"},{" "}
                  {Math.round((doc.latest.size || 0) / 1024)} KB)
                </span>
              </div>

              <div className="text-xs text-gray-600">
                Uploaded {new Date(doc.latest.uploadedAt).toLocaleString()} by{" "}
                {String(doc.latest.uploadedBy || "")}
              </div>

              <div className="text-xs text-gray-600">For: {forLabel}</div>

              <div className="text-xs">
                <a
                  className="underline"
                  href={`/documents/${id}/file`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open latest via server
                </a>
              </div>
            </>
          )}

          {!doc.deletedAt && (
            <div className="flex gap-2 items-center">
              <input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
              <button
                className="px-3 py-2 border rounded"
                onClick={uploadVersion}
                disabled={!file || uploading}
              >
                {uploading ? "Uploading..." : "Upload new version"}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="border rounded p-3 space-y-2">
        <div className="font-semibold">Preview</div>

        {previewLoading && (
          <div className="text-sm text-gray-600">Loading preview…</div>
        )}

        {previewErr && (
          <div className="text-sm text-red-600">
            {previewErr}{" "}
            {doc?.latest?.url && (
              <span className="ml-2">
                <a
                  className="underline"
                  href={fileUrl(doc.latest.url)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open / Download
                </a>
              </span>
            )}
          </div>
        )}

        {!previewLoading && !previewErr && !previewUrl && (
          <div className="text-sm text-gray-600">
            No file uploaded for this document.
          </div>
        )}

        {!previewLoading && !!previewUrl && (
          <>
            {isImg && (
              <img
                src={previewUrl}
                alt={doc?.title || "image"}
                className="max-w-full h-auto rounded"
              />
            )}

            {isPdf && (
              <iframe
                title="pdf"
                src={previewUrl}
                className="w-full bg-white"
                style={{ height: "80vh", border: "none" }}
              />
            )}

            {isAudio && <audio controls src={previewUrl} className="w-full" />}

            {isVideo && (
              <video
                controls
                src={previewUrl}
                className="w-full"
                style={{ maxHeight: "80vh" }}
              />
            )}

            {isText && !isPdf && !isImg && !isAudio && !isVideo && (
              <iframe
                title="text"
                src={previewUrl}
                className="w-full bg-white"
                style={{ height: "70vh", border: "none" }}
              />
            )}

            {!isImg && !isPdf && !isAudio && !isVideo && !isText && (
              <div className="text-sm">
                This file type can’t be previewed inline.&nbsp;
                {doc.latest?.url ? (
                  <a
                    className="underline"
                    href={fileUrl(doc.latest.url)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open / Download
                  </a>
                ) : (
                  <span>Please download from versions above.</span>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="border rounded p-3">
        <div className="font-semibold mb-2">All Versions</div>

        {!Array.isArray(doc.versions) || doc.versions.length === 0 ? (
          <div className="text-sm text-gray-600">No versions.</div>
        ) : (
          <div className="space-y-2">
            {doc.versions.map((v, i) => {
              const isLatest =
                doc.latest &&
                v &&
                doc.latest.filename === v.filename &&
                doc.latest.uploadedAt === v.uploadedAt;

              return (
                <div
                  key={i}
                  className={`flex flex-wrap items-center justify-between border p-2 rounded ${
                    v.deletedAt ? "opacity-60" : ""
                  }`}
                >
                  <div className="space-y-1">
                    <div className="text-sm">
                      {v.url ? (
                        <a
                          href={fileUrl(v.url)}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          {v.filename}
                        </a>
                      ) : (
                        v.filename
                      )}

                      {isLatest && (
                        <span className="ml-2 text-xs bg-gray-200 px-2 py-0.5 rounded">
                          latest
                        </span>
                      )}
                    </div>

                    <div className="text-xs text-gray-600">
                      {v.mime || v.mimeType || "file"} •{" "}
                      {Math.round((v.size || 0) / 1024)} KB •{" "}
                      {new Date(v.uploadedAt).toLocaleString()}
                    </div>
                  </div>

                  <div className="flex gap-2">
                    {!v.deletedAt ? (
                      <>
                        <button
                          className="px-2 py-1 border rounded"
                          onClick={() => deleteVersion(i)}
                        >
                          Delete
                        </button>

                        {!isLatest && (
                          <button
                            className="px-2 py-1 border rounded"
                            onClick={() => restoreVersion(i, true)}
                          >
                            Set as latest
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        className="px-2 py-1 border rounded"
                        onClick={() => restoreVersion(i, false)}
                      >
                        Restore
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border rounded p-3 space-y-3">
        <div className="font-semibold">Links</div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            Link project
            <select
              className="border p-2 block"
              value={pickProject}
              onChange={(e) => setPickProject(e.target.value)}
              style={{ minWidth: 260 }}
            >
              <option value="">— select a project —</option>
              {projects.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <button
            className="px-3 py-2 border rounded"
            onClick={linkProject}
            disabled={!pickProject}
          >
            Add
          </button>

          <label className="text-sm">
            Link user
            <select
              className="border p-2 block"
              value={pickUser}
              onChange={(e) => setPickUser(e.target.value)}
              style={{ minWidth: 260 }}
            >
              <option value="">— select a user —</option>
              {users.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.name || u.email || u.username}
                </option>
              ))}
            </select>
          </label>

          <button
            className="px-3 py-2 border rounded"
            onClick={linkUser}
            disabled={!pickUser}
          >
            Add
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            Type
            <select
              className="border p-2 block"
              value={newLink.type}
              onChange={(e) => setNewLink({ ...newLink, type: e.target.value })}
            >
              <option value="project">project</option>
              <option value="inspection">inspection</option>
              <option value="asset">asset</option>
              <option value="vehicle">vehicle</option>
              <option value="user">user</option>
              <option value="task">task</option>
              <option value="clocking">clocking</option>
            </select>
          </label>

          <label className="text-sm">
            Ref ID
            <input
              className="border p-2 block"
              placeholder="Mongo ObjectId…"
              value={newLink.refId}
              onChange={(e) =>
                setNewLink({ ...newLink, refId: e.target.value })
              }
              style={{ minWidth: 260 }}
            />
          </label>

          <button
            className="px-3 py-2 border rounded"
            onClick={addLink}
            disabled={!newLink.refId}
          >
            Add link
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <div className="text-sm font-medium mb-1">Projects</div>

            {projectLinks.length === 0 ? (
              <div className="text-sm text-gray-600">No project links.</div>
            ) : (
              <div className="grid gap-2">
                {projectLinks.map((l, idx) => {
                  const p = projectMap.get(String(l.refId));

                  return (
                    <div
                      key={idx}
                      className="flex items-center justify-between border p-2 rounded"
                    >
                      <div className="text-sm">
                        {p ? (
                          <Link to={`/projects/${p._id}`} className="underline">
                            {p.name}
                          </Link>
                        ) : (
                          <span className="text-gray-600">
                            {String(l.refId)}
                          </span>
                        )}
                      </div>

                      <button
                        className="px-2 py-1 border rounded"
                        onClick={() => removeLink(l.type || l.module, l.refId)}
                      >
                        Unlink
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div className="text-sm font-medium mb-1">Users</div>

            {userLinks.length === 0 ? (
              <div className="text-sm text-gray-600">No user links.</div>
            ) : (
              <div className="grid gap-2">
                {userLinks.map((l, idx) => {
                  const u = userMap.get(String(l.refId));
                  const label = u
                    ? u.name || u.email || u.username
                    : String(l.refId);

                  return (
                    <div
                      key={idx}
                      className="flex items-center justify-between border p-2 rounded"
                    >
                      <div className="text-sm">{label}</div>

                      <button
                        className="px-2 py-1 border rounded"
                        onClick={() => removeLink(l.type || l.module, l.refId)}
                      >
                        Unlink
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
