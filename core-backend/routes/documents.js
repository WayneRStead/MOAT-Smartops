// core-backend/routes/documents.js
const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const { requireAuth } = require("../middleware/auth");
const Document = require("../models/Document");

const router = express.Router();

/* ------------------------ Optional ACL import (with fallbacks) ------------------------ */
let canReadDoc, canEditDoc, isAdmin;
try {
  ({ canReadDoc, canEditDoc, isAdmin } = require("../middleware/acl"));
} catch (_) {
  const _isAdmin = (u) => {
    const r = String(u?.role || "").toLowerCase();
    return r === "admin" || r === "superadmin";
  };
  isAdmin = _isAdmin;
  canReadDoc = (user, doc) => {
    if (_isAdmin(user)) return true;
    const owners = doc?.access?.owners || [];
    const vis = doc?.access?.visibility || "org";
    const me = String(user?.sub || user?._id || "");
    if (owners.map(String).includes(me)) return true;
    if (vis === "org" || !doc?.access) return true;
    return false;
  };
  canEditDoc = (user, doc) => {
    if (_isAdmin(user)) return true;
    const owners = doc?.access?.owners || [];
    const me = String(user?.sub || user?._id || "");
    return owners.map(String).includes(me);
  };
}

/* --------------------------------- Helpers ---------------------------------- */
function computeLatest(doc) {
  if (!doc?.versions?.length) return undefined;
  for (let i = doc.versions.length - 1; i >= 0; i--) {
    const v = doc.versions[i];
    if (!v.deletedAt) return v;
  }
  return undefined;
}

function isValidObjectId(id) {
  return typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id);
}

function orgScope(orgId) {
  if (!orgId) return {};
  const s = String(orgId);
  if (!mongoose.Types.ObjectId.isValid(s)) return {}; // tolerate "root" etc.
  return { orgId: new mongoose.Types.ObjectId(s) };
}

function normalizeLinkInput(body = {}) {
  const type = (body.type || body.module || "").trim();
  const ref = String(body.refId || "").trim();
  if (!type || !ref) return { error: "type and refId required" };
  if (!isValidObjectId(ref)) return { error: "refId must be a 24-hex ObjectId" };
  return { type, refId: new mongoose.Types.ObjectId(ref) };
}

function stripUndef(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function toObjectIdOrNull(id) {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
}

/* ------------------------------ GridFS (Vault) ------------------------------ */
/**
 * Bucket name: "documents"
 * Collections: documents.files + documents.chunks
 *
 * NOTE:
 * - Uses mongoose.connection.db (must be connected)
 * - We stream via: GET /documents/files/:fileId
 */
function getBucket() {
  const db = mongoose.connection?.db;
  if (!db) throw new Error("MongoDB connection not ready (mongoose.connection.db missing).");
  return new mongoose.mongo.GridFSBucket(db, { bucketName: "documents" });
}

// We intentionally return a RELATIVE URL
function fileUrl(_req, fileId) {
  return `/documents/files/${fileId}`;
}

async function saveFileToGridFS(req, file, extraMeta = {}) {
  if (!file) throw new Error("No file provided");
  const bucket = getBucket();

  const safeName = String(file.originalname || "file").replace(/[^\w.-]+/g, "_");
  const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;

  const uploadStream = bucket.openUploadStream(filename, {
    contentType: file.mimetype,
    metadata: stripUndef({
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      orgId: req.user?.orgId ? String(req.user.orgId) : undefined,
      uploadedBy: req.user?.sub || req.user?._id ? String(req.user.sub || req.user._id) : undefined,
      ...extraMeta,
    }),
  });

  uploadStream.end(file.buffer);

  const done = await new Promise((resolve, reject) => {
    uploadStream.on("finish", resolve);
    uploadStream.on("error", reject);
  });

  const fileId = String(done?._id || uploadStream.id);

  return {
    fileId,
    filename,
    size: file.size,
    mime: file.mimetype,
    url: fileUrl(req, fileId),
  };
}

/* ------------------------------ Multer (memory) ------------------------------ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

/* ------------------------------ FILE SERVING ------------------------------ */
/**
 * GET /documents/files/:fileId
 * Streams from GridFS (auth required).
 *
 * IMPORTANT:
 * - This is NOT under /files, so it is not shadowed by express.static.
 * - If you open this URL in a browser directly, you will get "Missing token" (expected).
 *   The frontend must fetch it with Authorization header (same pattern as trips/logbook).
 */
router.get("/files/:fileId", requireAuth, async (req, res, next) => {
  try {
    const fileId = toObjectIdOrNull(req.params.fileId);
    if (!fileId) return res.status(400).json({ error: "Invalid file id" });

    const bucket = getBucket();
    const files = await bucket.find({ _id: fileId }).limit(1).toArray();
    if (!files?.length) return res.status(404).json({ error: "File not found" });

    const f = files[0];
    res.setHeader("Content-Type", f.contentType || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");

    // Optional: suggest suggest filename
    if (f.filename) {
      res.setHeader("Content-Disposition", `inline; filename="${String(f.filename).replace(/"/g, "")}"`);
    }

    const dl = bucket.openDownloadStream(fileId);
    dl.on("error", (e) => next(e));
    dl.pipe(res);
  } catch (e) {
    next(e);
  }
});

/* ---------------------------------- LIST ------------------------------------ */
/**
 * GET /documents
 * Filters: q, tag, folder, linkedTo (type:refId), module, uploader, from, to, includeDeleted
 */
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const { q, tag, folder, linkedTo, module, uploader, from, to, includeDeleted } = req.query;

    const find = {
      ...orgScope(req.user?.orgId),
    };
    if (!includeDeleted) find.deletedAt = { $exists: false };

    if (q) {
      const or = [
        { title: new RegExp(q, "i") },
        { "latest.filename": new RegExp(q, "i") },
        { tags: q },
      ];
      if (isValidObjectId(q)) or.push({ _id: new mongoose.Types.ObjectId(q) });
      find.$or = or;
    }

    if (tag) find.tags = tag;
    if (folder) find.folder = folder;
    if (uploader) find["latest.uploadedBy"] = uploader;
    if (from || to) {
      find.createdAt = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to ? { $lte: new Date(to) } : {}),
      };
    }

    // linking filters (supports links.type or links.module)
    if (module) {
      find.$or = (find.$or || []).concat([{ "links.type": module }, { "links.module": module }]);
    }
    if (linkedTo) {
      const [type, rawId] = String(linkedTo).split(":");
      if (type && rawId) {
        const clauses = [];
        if (isValidObjectId(rawId)) {
          const oid = new mongoose.Types.ObjectId(rawId);
          clauses.push(
            { links: { $elemMatch: { type, refId: oid } } },
            { links: { $elemMatch: { module: type, refId: oid } } }
          );
        }
        // legacy string refId support
        clauses.push(
          { links: { $elemMatch: { type, refId: rawId } } },
          { links: { $elemMatch: { module: type, refId: rawId } } }
        );
        (find.$and ||= []).push({ $or: clauses });
      }
    }

    const docs = await Document.find(find).sort({ updatedAt: -1 }).lean();
    res.json(docs.filter((d) => canReadDoc(req.user, d)));
  } catch (e) {
    next(e);
  }
});

/* ---------------------------------- READ ------------------------------------ */
/** GET /documents/:id */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid document id" });

    const doc = await Document.findOne({ _id: id, ...orgScope(req.user?.orgId) }).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (!canReadDoc(req.user, doc)) return res.status(403).json({ error: "Forbidden" });

    res.json(doc);
  } catch (e) {
    console.error("GET /documents/:id failed:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

/* --------------- STREAM/REDIRECT LATEST FILE (preview fallback) -------------- */
/** GET /documents/:id/file -> 302 to doc.latest.url (if readable) */
router.get("/:id/file", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid document id" });

    const doc = await Document.findOne({ _id: id, ...orgScope(req.user?.orgId) }).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (!canReadDoc(req.user, doc)) return res.status(403).json({ error: "Forbidden" });

    const latest = doc.latest || computeLatest(doc);
    if (!latest?.url) return res.status(404).json({ error: "No file for this document" });

    return res.redirect(latest.url);
  } catch (e) {
    console.error("GET /documents/:id/file failed:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

/* --------------------------------- CREATE ---------------------------------- */
/** POST /documents */
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { title, folder = "", tags = [], links = [], access } = req.body || {};
    if (!title) return res.status(400).json({ error: "title required" });

    const normLinks = (Array.isArray(links) ? links : []).map((l) => {
      const type = l.type || l.module;
      return { ...l, type, module: type };
    });

    const now = new Date();
    const body = {
      title,
      folder,
      tags,
      links: normLinks,
      access: access || { visibility: "org", owners: [req.user.sub || req.user._id] },
      createdAt: now,
      updatedAt: now,
      createdBy: req.user.sub || req.user._id,
      updatedBy: req.user.sub || req.user._id,
      versions: [],
      latest: undefined,
    };

    if (mongoose.Types.ObjectId.isValid(String(req.user?.orgId))) {
      body.orgId = new mongoose.Types.ObjectId(String(req.user.orgId));
    } else if (req.user?.orgId) {
      body.orgId = String(req.user.orgId);
    }

    const doc = await Document.create(body);
    res.status(201).json(doc);
  } catch (e) {
    next(e);
  }
});

/* --------------------------------- UPLOAD ---------------------------------- */
/**
 * POST /documents/:id/upload
 * - stores binary in GridFS
 * - appends a version with {fileId, url, ...}
 */
router.post("/:id/upload", requireAuth, upload.single("file"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid document id" });

    const doc = await Document.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (!canEditDoc(req.user, doc)) return res.status(403).json({ error: "Forbidden" });
    if (!req.file) return res.status(400).json({ error: "file required" });

    const meta = await saveFileToGridFS(req, req.file, { documentId: String(id) });

    const version = {
      filename: req.file.originalname,
      url: meta.url,          // /documents/files/:fileId
      fileId: meta.fileId,    // IMPORTANT: keep the id
      mime: req.file.mimetype,
      size: req.file.size,
      uploadedBy: req.user.sub || req.user._id,
      uploadedAt: new Date(),
    };

    doc.versions = doc.versions || [];
    doc.versions.push(version);
    doc.latest = version;
    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub || req.user._id;

    await doc.save();
    res.status(201).json(doc);
  } catch (e) {
    next(e);
  }
});

/* --------------------------------- UPDATE ---------------------------------- */
/** PUT /documents/:id */
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid document id" });

    const doc = await Document.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (!canEditDoc(req.user, doc)) return res.status(403).json({ error: "Forbidden" });

    const { title, folder, tags, links, access } = req.body || {};
    if (title != null) doc.title = title;
    if (folder != null) doc.folder = folder;
    if (tags != null) doc.tags = tags;
    if (links != null) {
      const normLinks = (Array.isArray(links) ? links : []).map((l) => {
        const type = l.type || l.module;
        return { ...l, type, module: type };
      });
      doc.links = normLinks;
    }
    if (access != null) doc.access = access;

    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub || req.user._id;

    await doc.save();
    res.json(doc);
  } catch (e) {
    console.error("PUT /documents/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------------- RESTORE --------------------------------- */
/** PATCH /documents/:id/restore */
router.patch("/:id/restore", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid document id" });

    const doc = await Document.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!doc) return res.status(404).json({ error: "Not found" });

    if (!canEditDoc(req.user, doc) && !isAdmin(req.user)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    doc.deletedAt = undefined;
    doc.deletedBy = undefined;
    if (!doc.latest) doc.latest = computeLatest(doc);

    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub || req.user._id || null;

    await doc.save();
    res.json(doc);
  } catch (e) {
    console.error("PATCH /documents/:id/restore failed:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

/* --------------------------------- DELETE --------------------------------- */
/** DELETE /documents/:id (soft by default; hard with ?hard=1 admin only) */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid document id" });

    const doc = await Document.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!doc) return res.status(404).json({ error: "Not found" });
    const admin = isAdmin(req.user);
    if (!admin && !canEditDoc(req.user, doc)) return res.status(403).json({ error: "Forbidden" });

    const hard = String(req.query.hard) === "1";
    if (hard) {
      if (!admin) return res.status(403).json({ error: "Hard delete requires admin" });
      await Document.deleteOne({ _id: doc._id });
      return res.json({ ok: true, hard: true });
    }

    doc.deletedAt = new Date();
    doc.deletedBy = req.user.sub || req.user._id || null;
    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub || req.user._id || null;

    await doc.save();
    res.json({ ok: true, hard: false });
  } catch (e) {
    console.error("DELETE /documents/:id failed:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

/* ------------------------------ VERSION DELETE ---------------------------- */
/** DELETE /documents/:id/versions/:index */
router.delete("/:id/versions/:index", requireAuth, async (req, res) => {
  try {
    const { id, index } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid document id" });
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) return res.status(400).json({ error: "Bad version index" });

    const doc = await Document.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!doc) return res.sendStatus(404);
    if (!canEditDoc(req.user, doc)) return res.status(403).json({ error: "Forbidden" });

    if (!doc.versions || !doc.versions[i]) {
      return res.status(400).json({ error: "Bad version index" });
    }

    const v = doc.versions[i];
    v.deletedAt = new Date();
    v.deletedBy = req.user.sub || req.user._id || null;

    // If latest matches this version by timestamp, recompute latest
    if (
      doc.latest &&
      v.uploadedAt &&
      doc.latest.uploadedAt &&
      String(new Date(doc.latest.uploadedAt).getTime()) === String(new Date(v.uploadedAt).getTime())
    ) {
      doc.latest = computeLatest(doc);
    }

    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub || req.user._id || null;

    await doc.save();
    res.sendStatus(204);
  } catch (e) {
    console.error("DELETE /documents/:id/versions/:index failed:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

/* ------------------------------ VERSION RESTORE --------------------------- */
/** PATCH /documents/:id/versions/:index/restore */
router.patch("/:id/versions/:index/restore", requireAuth, async (req, res) => {
  try {
    const { id, index } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid document id" });
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) return res.status(400).json({ error: "Bad version index" });

    const doc = await Document.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!doc) return res.sendStatus(404);
    if (!canEditDoc(req.user, doc)) return res.status(403).json({ error: "Forbidden" });

    if (!doc.versions || !doc.versions[i]) {
      return res.status(400).json({ error: "Bad version index" });
    }

    const v = doc.versions[i];
    v.deletedAt = undefined;
    v.deletedBy = undefined;

    if (String(req.query.setLatest) === "1") {
      doc.latest = v;
    } else if (!doc.latest) {
      doc.latest = computeLatest(doc);
    }

    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub || req.user._id || null;

    await doc.save();
    res.json(doc);
  } catch (e) {
    console.error("PATCH /documents/:id/versions/:index/restore failed:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

/* ---------------------------------- LINKS ---------------------------------- */
/** POST /documents/:id/links  -> body { type, refId } ; returns updated links array */
router.post("/:id/links", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid document id" });

    const doc = await Document.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (!canEditDoc(req.user, doc)) return res.status(403).json({ error: "Forbidden" });

    const parsed = normalizeLinkInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { type, refId } = parsed;
    const exists = (doc.links || []).some(
      (l) => (l.type === type || l.module === type) && String(l.refId) === String(refId)
    );
    if (!exists) {
      doc.links = doc.links || [];
      doc.links.push({ type, module: type, refId });
    }

    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub || req.user._id || null;

    await doc.save();
    res.json(doc.links || []);
  } catch (e) {
    console.error("POST /documents/:id/links failed:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

/** DELETE /documents/:id/links -> body { type, refId } ; returns updated links array */
router.delete("/:id/links", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: "Invalid document id" });

    const doc = await Document.findOne({ _id: id, ...orgScope(req.user?.orgId) });
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (!canEditDoc(req.user, doc)) return res.status(403).json({ error: "Forbidden" });

    const parsed = normalizeLinkInput(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { type, refId } = parsed;
    const before = doc.links || [];
    doc.links = before.filter(
      (l) => !((l.type === type || l.module === type) && String(l.refId) === String(refId))
    );

    doc.updatedAt = new Date();
    doc.updatedBy = req.user.sub || req.user._id || null;

    await doc.save();
    res.json(doc.links || []);
  } catch (e) {
    console.error("DELETE /documents/:id/links failed:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

module.exports = router;
