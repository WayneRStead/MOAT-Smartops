// core-backend/routes/logbook.js
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");

const router = express.Router();

// Prefer already-compiled model; only require if missing
const VehicleLog = mongoose.models.VehicleLog || require("../models/VehicleLog");

/* ----------------------------- helpers ------------------------------ */
const isValidId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const asObjectId = (v) => (isValidId(v) ? new mongoose.Types.ObjectId(String(v)) : undefined);

function computeDistance(start, end) {
  if (start == null || end == null) return undefined;
  const s = Number(start);
  const e = Number(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return undefined;
  return Math.max(0, e - s);
}

// Prefer org from middleware (req.org), fallback to req.user.orgId
function getOrgId(req) {
  return req.org?._id || req.orgId || req.user?.orgId || undefined;
}

// Build an org filter only if schema supports orgId
function buildOrgFilter(req) {
  const orgId = getOrgId(req);
  const path = VehicleLog.schema.path("orgId");
  if (!path) return {};
  if (!orgId) return {};

  const s = String(orgId);

  if (path.instance === "ObjectID") {
    return isValidId(s) ? { orgId: new mongoose.Types.ObjectId(s) } : {};
  }
  if (path.instance === "String") {
    return s ? { orgId: s } : {};
  }
  return {};
}

function stripUndef(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/* ------------------------------ GridFS ------------------------------ */
/**
 * Bucket name: "logbook"
 * Collections: logbook.files + logbook.chunks
 */
function getBucket() {
  const db = mongoose.connection?.db;
  if (!db) throw new Error("MongoDB connection not ready (mongoose.connection.db missing).");
  return new mongoose.mongo.GridFSBucket(db, { bucketName: "logbook" });
}

function toObjectIdOrNull(id) {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
}

function fileUrl(_req, fileId) {
  // IMPORTANT: keep relative URL
  return `/files/logbook/${fileId}`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /^image\//i.test(file.mimetype) ||
      /^application\/pdf$/i.test(file.mimetype) ||
      /^text\//i.test(file.mimetype) ||
      /^application\/(msword|vnd\.openxmlformats-officedocument\..+)$/i.test(file.mimetype);
    if (!ok) return cb(new Error("Unsupported file type."));
    cb(null, true);
  },
});

async function saveFileToGridFS(req, file) {
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
      orgId: getOrgId(req) ? String(getOrgId(req)) : undefined,
      uploadedBy: req.user?._id ? String(req.user._id) : undefined,
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

/* ------------------------- FILE SERVING (GLOBAL) ------------------------- */
/**
 * GET /files/logbook/:fileId
 * Streams from GridFS.
 *
 * This router is mounted at "/" and "/api" (in index.js),
 * so this works at both:
 * - /files/logbook/:fileId
 * - /api/files/logbook/:fileId
 */
router.get("/files/logbook/:fileId", async (req, res, next) => {
  try {
    const fileId = toObjectIdOrNull(req.params.fileId);
    if (!fileId) return res.status(400).json({ error: "Invalid file id" });

    const bucket = getBucket();
    const files = await bucket.find({ _id: fileId }).limit(1).toArray();
    if (!files || !files.length) return res.status(404).json({ error: "File not found" });

    const f = files[0];
    res.setHeader("Content-Type", f.contentType || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    const dl = bucket.openDownloadStream(fileId);
    dl.on("error", (e) => next(e));
    dl.pipe(res);
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- LIST ------------------------------- */
// GET /logbook?vehicleId=&q=&tag=&from=&to=&minKm=&maxKm=&limit=
router.get("/", async (req, res) => {
  try {
    const { vehicleId, q, tag, from, to, minKm, maxKm, limit } = req.query;

    const find = { ...buildOrgFilter(req) };

    if (vehicleId) {
      const oid = asObjectId(vehicleId);
      if (!oid) return res.status(400).json({ error: "invalid vehicleId" });
      find.vehicleId = oid;
    }

    if (q) {
      const rx = new RegExp(String(q), "i");
      find.$or = [{ title: rx }, { notes: rx }, { tags: q }];
    }

    if (tag) find.tags = tag;

    if (from || to) {
      find.ts = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to ? { $lte: new Date(to) } : {}),
      };
    }

    if (minKm || maxKm) {
      find.distance = {};
      if (minKm != null && minKm !== "") find.distance.$gte = Number(minKm);
      if (maxKm != null && maxKm !== "") find.distance.$lte = Number(maxKm);
    }

    const lim = Math.min(parseInt(limit || "200", 10) || 200, 500);

    const rows = await VehicleLog.find(find).sort({ ts: -1, createdAt: -1 }).limit(lim).lean();
    res.json(rows);
  } catch (e) {
    console.error("GET /logbook error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ------------------------------ CREATE ------------------------------ */
// POST /logbook
router.post("/", async (req, res) => {
  try {
    const { vehicleId, title, notes = "", tags = [], ts, odometerStart, odometerEnd } = req.body || {};

    const vid = asObjectId(vehicleId);
    if (!vid) return res.status(400).json({ error: "vehicleId required/invalid" });
    if (!title) return res.status(400).json({ error: "title required" });

    const distance = computeDistance(odometerStart, odometerEnd);

    const doc = {
      vehicleId: vid,
      title: String(title).trim(),
      notes: String(notes || ""),
      tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
      ts: ts ? new Date(ts) : new Date(),
      odometerStart: odometerStart != null && odometerStart !== "" ? Number(odometerStart) : undefined,
      odometerEnd: odometerEnd != null && odometerEnd !== "" ? Number(odometerEnd) : undefined,
      distance,
      createdBy: req.user?.sub || req.user?._id || "unknown",
    };

    // Apply orgId if schema supports it
    const orgFilter = buildOrgFilter(req);
    if (orgFilter.orgId != null) doc.orgId = orgFilter.orgId;

    const row = await VehicleLog.create(doc);
    res.status(201).json(row);
  } catch (e) {
    console.error("POST /logbook error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ------------------------------- UPDATE ------------------------------ */
// PUT /logbook/:id
router.put("/:id", async (req, res) => {
  try {
    const orgFilter = buildOrgFilter(req);

    const row = await VehicleLog.findOne({ _id: req.params.id, ...orgFilter });
    if (!row) return res.status(404).json({ error: "Not found" });

    const { title, notes, tags, ts, odometerStart, odometerEnd } = req.body || {};

    if (title != null) row.title = String(title).trim();
    if (notes != null) row.notes = String(notes);
    if (Array.isArray(tags)) row.tags = tags.filter(Boolean);
    if (ts != null) row.ts = ts ? new Date(ts) : row.ts;

    if (odometerStart !== undefined) {
      row.odometerStart = odometerStart === "" || odometerStart == null ? undefined : Number(odometerStart);
    }
    if (odometerEnd !== undefined) {
      row.odometerEnd = odometerEnd === "" || odometerEnd == null ? undefined : Number(odometerEnd);
    }
    row.distance = computeDistance(row.odometerStart, row.odometerEnd);

    await row.save();
    res.json(row);
  } catch (e) {
    console.error("PUT /logbook/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ------------------------------- DELETE ------------------------------ */
// DELETE /logbook/:id
router.delete("/:id", async (req, res) => {
  try {
    const orgFilter = buildOrgFilter(req);

    const del = await VehicleLog.findOneAndDelete({ _id: req.params.id, ...orgFilter });
    if (!del) return res.status(404).json({ error: "Not found" });
    res.sendStatus(204);
  } catch (e) {
    console.error("DELETE /logbook/:id error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------- FILE UPLOAD API --------------------------- */
/**
 * POST /logbook/upload
 * Uploads a file to GridFS and returns {fileId, url, ...}
 */
router.post("/upload", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const meta = await saveFileToGridFS(req, req.file);
    res.json(meta);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /logbook/:id/attach
 * Uploads a file AND attaches to the logbook entry if schema supports attachments.
 */
router.post("/:id/attach", upload.single("file"), async (req, res, next) => {
  try {
    const orgFilter = buildOrgFilter(req);
    const row = await VehicleLog.findOne({ _id: req.params.id, ...orgFilter });
    if (!row) return res.status(404).json({ error: "Not found" });

    if (!req.file) return res.status(400).json({ error: "No file" });

    const meta = await saveFileToGridFS(req, req.file);

    const hasAttachments = !!VehicleLog.schema.path("attachments");
    if (!hasAttachments) {
      // Still return uploaded file info even if log schema doesn't support attaching
      return res.json({ ok: true, file: meta, note: "VehicleLog schema has no attachments field; file uploaded only." });
    }

    row.attachments = Array.isArray(row.attachments) ? row.attachments : [];
    row.attachments.push({
      fileId: meta.fileId,
      url: meta.url,
      filename: meta.filename,
      mime: meta.mime,
      size: meta.size,
      uploadedBy: req.user?._id ? String(req.user._id) : undefined,
      uploadedAt: new Date(),
    });

    await row.save();
    res.json(row.toObject());
  } catch (e) {
    next(e);
  }
});

module.exports = router;
