// core-backend/routes/invoices.js
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const multer = require("multer");
const { Readable } = require("stream");
const { requireAuth, resolveOrgContext, requireOrg } = require("../middleware/auth");

// Prefer already-compiled models to avoid OverwriteModelError
const Invoice = mongoose.models.Invoice || require("../models/Invoice");

// Optional Vendor model
let Vendor = null;
try {
  Vendor = mongoose.models.Vendor || require("../models/Vendor");
} catch {
  Vendor = null;
}

const router = express.Router();

// Keep router safe even if mounted without these upstream (index.js already does this)
router.use(requireAuth, resolveOrgContext, requireOrg);

/* ------------------------------ helpers ------------------------------ */

// Use request org context (header) first; token fallback last.
function getOrgFromReq(req) {
  return req.orgObjectId || req.orgId || req.user?.orgId || null;
}

// Since Invoice.orgId is Mixed, query should match either string or ObjectId forms.
function orgScopeFromReq(req) {
  const src = getOrgFromReq(req);
  if (!src) return {};
  const s = String(src);

  const clauses = [];
  if (mongoose.Types.ObjectId.isValid(s)) clauses.push({ orgId: new mongoose.Types.ObjectId(s) });
  clauses.push({ orgId: s });

  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

// Set orgId on create using request org context, storing ObjectId if valid else string.
function setOrgOnCreate(docData, req) {
  const src = getOrgFromReq(req);
  if (!src) return docData;
  const s = String(src);
  docData.orgId = mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : s;
  return docData;
}

function safeOrgIdForFolder(req) {
  const src = getOrgFromReq(req);
  return src ? String(src) : "global";
}

function addDays(dateLike, days) {
  if (!dateLike) return null;
  const d = new Date(dateLike);
  if (isNaN(+d)) return null;
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

function normalizeDueAt(body) {
  const dueExplicit = body.dueAt ? new Date(body.dueAt) : null;
  if (dueExplicit && !isNaN(+dueExplicit)) return dueExplicit;

  const submitted = body.submittedAt || body.issuedAt;
  const terms = Number(body.termsDays ?? body.terms ?? body.netDays ?? 0);
  const d = addDays(submitted, terms);
  return d || null;
}

function computeStatusLikeFrontend({ paidAt, dueAt }) {
  if (paidAt) return "paid";
  if (dueAt && new Date(dueAt).getTime() < Date.now()) return "outstanding";
  return "submitted";
}

// upsert vendor by name if requested and model exists
async function maybeUpsertVendor({ req, name, email, phone, upsertFlag }) {
  if (!Vendor || !upsertFlag || !name) return null;

  const scope = orgScopeFromReq(req);
  let v = await Vendor.findOne({ name, ...scope }).lean();
  if (v) return v._id;

  v = await Vendor.create({
    name,
    email,
    phone,
    ...(function () {
      const src = getOrgFromReq(req);
      if (!src) return {};
      const s = String(src);
      return { orgId: mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : s };
    })(),
  });

  return v._id;
}

/* --------------------------- role guarding --------------------------- */
function userHasAnyRole(user, allowed = []) {
  const want = new Set((allowed || []).map((r) => String(r).toLowerCase()));
  const r1 = String(user?.role || "").toLowerCase();
  if (r1 && want.has(r1)) return true;

  const rs = Array.isArray(user?.roles) ? user.roles : [];
  for (const r of rs) {
    const rr = String(r || "").toLowerCase();
    if (rr && want.has(rr)) return true;
  }
  return false;
}

function requireAnyRole(...allowed) {
  return function (req, res, next) {
    if (userHasAnyRole(req.user, allowed)) return next();
    return res.status(403).json({ error: "Forbidden" });
  };
}

/* ----------------------------- GridFS ----------------------------- */
function getInvoicesBucket() {
  const db = mongoose.connection?.db;
  if (!db) throw new Error("MongoDB not connected yet");
  return new mongoose.mongo.GridFSBucket(db, { bucketName: "invoices" });
}

function sanitizeBaseName(original = "upload") {
  const ext = path.extname(original || "").toLowerCase();
  const base = path
    .basename(original || "upload", ext)
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 120);
  return { base: base || "upload", ext };
}

function makeStoredFilename(invoiceId, originalName) {
  const { base, ext } = sanitizeBaseName(originalName);
  const ts = Date.now();
  return `${invoiceId}-${ts}-${base}${ext}`;
}

/* ----------------------------- file upload ---------------------------- */
// Multer MEMORY storage (because we stream into GridFS)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB (adjust if needed)
  },
});

/* -------------------------------- LIST ------------------------------- */
router.get("/", async (req, res, next) => {
  try {
    const { q, status, from, to, limit } = req.query;
    const includeDeleted = String(req.query.includeDeleted || "") === "1";

    const filter = { ...orgScopeFromReq(req) };
    if (!includeDeleted) filter.deleted = { $ne: true };

    if (status) filter.status = status;

    if (q) {
      const rx = new RegExp(String(q), "i");
      filter.$or = [{ number: rx }, { vendorName: rx }, { notes: rx }];
    }

    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lte = new Date(to);
    if (Object.keys(range).length) {
      filter.$or = (filter.$or || []).concat([
        { submittedAt: range },
        { issuedAt: range },
        { createdAt: range },
      ]);
    }

    const lim = Math.min(parseInt(limit || "200", 10) || 200, 1000);

    const rows = await Invoice.find(filter)
      .sort({ submittedAt: -1, issuedAt: -1, createdAt: -1 })
      .limit(lim)
      .lean();

    res.json(rows);
  } catch (e) {
    next(e);
  }
});

/* -------------------------------- READ ------------------------------- */
router.get("/:id", async (req, res, next) => {
  try {
    const includeDeleted = String(req.query.includeDeleted || "") === "1";
    const filter = { _id: req.params.id, ...orgScopeFromReq(req) };
    if (!includeDeleted) filter.deleted = { $ne: true };

    const doc = await Invoice.findOne(filter).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- CREATE ------------------------------ */
router.post("/", requireAnyRole("manager", "admin", "superadmin"), async (req, res, next) => {
  try {
    const upsertVendor = String(req.query.upsertVendor || "") === "1";

    let vendorId = req.body.vendorId || null;
    if (!vendorId && (req.body.vendorName || req.body.vendor)) {
      vendorId = await maybeUpsertVendor({
        req,
        name: req.body.vendorName || req.body.vendor,
        email: req.body.vendorEmail,
        phone: req.body.vendorPhone,
        upsertFlag: upsertVendor,
      });
    }

    const dueAt = normalizeDueAt(req.body);
    const paidAt = req.body.paidAt || req.body.paymentDate || null;

    const docData = {
      ...req.body,
      deleted: false,
      deletedAt: null,
      deletedBy: null,
      vendorId: vendorId || req.body.vendorId || null,
      vendorName: req.body.vendorName || req.body.vendor || null,
      dueAt,
      paidAt,
      status: req.body.status || computeStatusLikeFrontend({ paidAt, dueAt }),
    };

    // Force orgId from request context (header), not from req.body
    setOrgOnCreate(docData, req);

    ["amount", "subtotal", "tax", "total", "termsDays", "terms", "netDays"].forEach((k) => {
      if (docData[k] != null) docData[k] = Number(docData[k]);
    });

    const doc = await Invoice.create(docData);
    res.status(201).json(doc);
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- UPDATE ------------------------------ */
router.put("/:id", requireAnyRole("manager", "admin", "superadmin"), async (req, res, next) => {
  try {
    const upsertVendor = String(req.query.upsertVendor || "") === "1";

    const set = { ...req.body };

    delete set.orgId;
    delete set.org;
    delete set.orgObjectId;

    delete set.deleted;
    delete set.deletedAt;
    delete set.deletedBy;

    if (!set.vendorId && (set.vendorName || set.vendor)) {
      const vid = await maybeUpsertVendor({
        req,
        name: set.vendorName || set.vendor,
        email: set.vendorEmail,
        phone: set.vendorPhone,
        upsertFlag: upsertVendor,
      });
      if (vid) set.vendorId = vid;
    }

    const maybeDue = normalizeDueAt(set);
    if (maybeDue) set.dueAt = maybeDue;

    if (set.paymentDate && !set.paidAt) set.paidAt = set.paymentDate;

    if (set.status == null) {
      set.status = computeStatusLikeFrontend({ paidAt: set.paidAt, dueAt: set.dueAt });
    }

    ["amount", "subtotal", "tax", "total", "termsDays", "terms", "netDays"].forEach((k) => {
      if (set[k] != null) set[k] = Number(set[k]);
    });

    const doc = await Invoice.findOneAndUpdate(
      { _id: req.params.id, ...orgScopeFromReq(req), deleted: { $ne: true } },
      { $set: set },
      { new: true, runValidators: true }
    ).lean();

    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- DELETE ------------------------------ */
router.delete("/:id", requireAnyRole("admin", "superadmin"), async (req, res, next) => {
  try {
    const scope = { _id: req.params.id, ...orgScopeFromReq(req) };

    const existing = await Invoice.findOne(scope);
    if (!existing) return res.status(404).json({ error: "Not found" });

    // If already soft-deleted -> hard delete (and delete GridFS file if present)
    if (existing.deleted === true) {
      // delete gridfs file if we know it
      try {
        const bucket = getInvoicesBucket();
        const fid = existing.fileId || existing.fileGridFsId; // allow either name
        if (fid && mongoose.Types.ObjectId.isValid(String(fid))) {
          await bucket.delete(new mongoose.Types.ObjectId(String(fid)));
        } else if (existing.fileName) {
          // fallback: delete latest by filename+org metadata (best effort)
          const org = safeOrgIdForFolder(req);
          const cursor = bucket.find({ filename: existing._gridfsFilename || undefined, "metadata.orgId": org }).sort({ uploadDate: -1 }).limit(1);
          const files = await cursor.toArray();
          if (files[0]?._id) await bucket.delete(files[0]._id);
        }
      } catch {}

      await Invoice.deleteOne(scope);
      return res.json({ ok: true, hardDeleted: true });
    }

    // otherwise soft delete
    existing.deleted = true;
    existing.deletedAt = new Date();
    existing.deletedBy = req.user?.sub || req.user?._id || req.user?.email || null;
    await existing.save();

    return res.json({ ok: true, deleted: true });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------ UPLOAD FILE --------------------------- */
/**
 * POST /invoices/:id/file
 * form-data: file=<binary>
 * Stores in GridFS bucket "invoices"
 * Returns { ok, url, filename, invoice }
 */
router.post(
  "/:id/file",
  requireAnyRole("manager", "admin", "superadmin"),
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file" });

      // confirm invoice exists and is in org + not deleted
      const inv = await Invoice.findOne({
        _id: req.params.id,
        ...orgScopeFromReq(req),
        deleted: { $ne: true },
      });
      if (!inv) return res.status(404).json({ error: "Not found" });

      const org = safeOrgIdForFolder(req);
      const bucket = getInvoicesBucket();

      // If invoice already has a fileId, delete old GridFS file (prevents bloat)
      try {
        const oldId = inv.fileId || inv.fileGridFsId;
        if (oldId && mongoose.Types.ObjectId.isValid(String(oldId))) {
          await bucket.delete(new mongoose.Types.ObjectId(String(oldId)));
        }
      } catch {}

      const storedFilename = makeStoredFilename(req.params.id, req.file.originalname);
      const publicUrl = `/files/invoices/${org}/${storedFilename}`;

      const metadata = {
        orgId: org,
        invoiceId: String(req.params.id),
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
      };

      const uploadStream = bucket.openUploadStream(storedFilename, {
        contentType: req.file.mimetype,
        metadata,
      });

      // Stream buffer into GridFS
      await new Promise((resolve, reject) => {
        Readable.from(req.file.buffer)
          .pipe(uploadStream)
          .on("error", reject)
          .on("finish", resolve);
      });

      const fileId = uploadStream.id;

      const set = {
        fileUrl: publicUrl,
        fileName: req.file.originalname || storedFilename,
        fileSize: req.file.size,
        fileType: req.file.mimetype,
        fileId: fileId,              // <- recommend adding to Invoice schema
        _gridfsFilename: storedFilename, // internal convenience; optional
        updatedBy: req.user?.sub || req.user?._id || req.user?.email || null,
      };

      const doc = await Invoice.findOneAndUpdate(
        { _id: req.params.id, ...orgScopeFromReq(req), deleted: { $ne: true } },
        { $set: set },
        { new: true }
      ).lean();

      if (!doc) return res.status(404).json({ error: "Not found" });

      res.json({ ok: true, url: publicUrl, filename: storedFilename, fileId: String(fileId), invoice: doc });
    } catch (e) {
      next(e);
    }
  }
);

/* ---------------------------- FILE SERVE ---------------------------- */
/**
 * GET /invoices/files/invoices/:org/:filename
 *
 * NOTE: This route exists ONLY to keep the backend self-contained if you mount it that way.
 * If your server already has a global /files router, move this handler there instead.
 *
 * Recommended mounting:
 *   app.get("/files/invoices/:org/:filename", ...)
 *
 * If you can't change index.js quickly, you can temporarily mount:
 *   app.use("/invoices", invoicesRouter)
 * and let frontend use /invoices/files/invoices/... (but your UI currently uses /files/...).
 */
router.get("/__gridfs__/invoices/:org/:filename", async (req, res, next) => {
  try {
    const org = String(req.params.org || "");
    const filename = String(req.params.filename || "");

    if (!org || !filename) return res.status(400).send("Bad request");

    const bucket = getInvoicesBucket();

    // Find the file by filename + org metadata
    const files = await bucket
      .find({ filename, "metadata.orgId": org })
      .sort({ uploadDate: -1 })
      .limit(1)
      .toArray();

    const f = files[0];
    if (!f?._id) return res.sendStatus(404);

    res.set("Cache-Control", "public, max-age=3600"); // adjust
    if (f.contentType) res.set("Content-Type", f.contentType);

    bucket.openDownloadStream(f._id).on("error", () => res.sendStatus(404)).pipe(res);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
