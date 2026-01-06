// core-backend/routes/invoices.js
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
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
// This prevents “disappearing” due to type mismatches.
function orgScopeFromReq(req) {
  const src = getOrgFromReq(req);
  if (!src) return {};
  const s = String(src);

  const clauses = [];
  if (mongoose.Types.ObjectId.isValid(s)) {
    clauses.push({ orgId: new mongoose.Types.ObjectId(s) });
  }
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
  // Prefer explicit dueAt; otherwise compute from submittedAt/issuedAt + termsDays/terms/netDays
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
async function maybeUpsertVendor({ reqUser, req, name, email, phone, upsertFlag }) {
  if (!Vendor || !upsertFlag || !name) return null;

  // vendor should be org-scoped the same way invoices are
  const scope = orgScopeFromReq(req);
  let v = await Vendor.findOne({ name, ...scope }).lean();
  if (v) return v._id;

  v = await Vendor.create({
    name,
    email,
    phone,
    // store orgId if Vendor schema supports it; harmless otherwise (strict will drop)
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
/**
 * Invoice rule:
 * - create/edit/upload: manager, admin, superadmin
 * - delete: admin, superadmin (soft delete)
 * - hard delete: admin, superadmin (only if already deleted)
 *
 * Supports:
 * - req.user.role as string
 * - req.user.roles as array
 */
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

/* ----------------------------- file upload ---------------------------- */
// Multer storage with per-org subfolder and deterministic filename
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const org = safeOrgIdForFolder(req);
    const dir = path.join(__dirname, "..", "uploads", "invoices", org);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const id = req.params.id || "unknown";
    const ts = Date.now();
    const ext = path.extname(file.originalname || "").toLowerCase();
    const base = path
      .basename(file.originalname || "upload", ext)
      .replace(/[^\w.\-]+/g, "_");
    cb(null, `${id}-${ts}-${base}${ext}`);
  },
});
const upload = multer({ storage });

/* -------------------------------- LIST ------------------------------- */
/**
 * GET /invoices
 * Query:
 *   - q: text search (number, vendorName, notes)
 *   - status: submitted|outstanding|paid|void
 *   - from, to: date range (issuedAt/submittedAt/createdAt)
 *   - limit: default 200 (max 1000)
 *   - includeDeleted=1 to include soft-deleted invoices
 */
router.get("/", async (req, res, next) => {
  try {
    const { q, status, from, to, limit } = req.query;

    const includeDeleted = String(req.query.includeDeleted || "") === "1";

    const filter = { ...orgScopeFromReq(req) };

    // Soft delete filter (works even if field absent in schema; if schema later adds it, this will work)
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
      filter.$or = (filter.$or || []).concat([{ submittedAt: range }, { issuedAt: range }, { createdAt: range }]);
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
        reqUser: req.user,
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

      // Prevent a client from trying to inject deleted/orgId
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

    // normalize numerics (safe even if schema ignores some fields)
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

    // ✅ CRITICAL: never allow orgId mutation via update payload
    delete set.orgId;
    delete set.org;
    delete set.orgObjectId;

    // never let client “delete by update”
    delete set.deleted;
    delete set.deletedAt;
    delete set.deletedBy;

    // optionally upsert vendor
    if (!set.vendorId && (set.vendorName || set.vendor)) {
      const vid = await maybeUpsertVendor({
        reqUser: req.user,
        req,
        name: set.vendorName || set.vendor,
        email: set.vendorEmail,
        phone: set.vendorPhone,
        upsertFlag: upsertVendor,
      });
      if (vid) set.vendorId = vid;
    }

    // recompute dueAt if inputs provided
    const maybeDue = normalizeDueAt(set);
    if (maybeDue) set.dueAt = maybeDue;

    // standardize paidAt/paymentDate
    if (set.paymentDate && !set.paidAt) set.paidAt = set.paymentDate;

    // status (only recompute if not explicitly supplied)
    if (set.status == null) {
      set.status = computeStatusLikeFrontend({ paidAt: set.paidAt, dueAt: set.dueAt });
    }

    // numerics
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
/**
 * Soft delete by default:
 * - If invoice is not deleted: mark deleted=true
 * - If invoice is already deleted: hard delete (and remove file if present)
 *
 * This matches your UI:
 * - showDeleted toggle expects soft deleted items exist
 * - hard delete button can call the same endpoint again
 */
router.delete("/:id", requireAnyRole("admin", "superadmin"), async (req, res, next) => {
  try {
    const scope = { _id: req.params.id, ...orgScopeFromReq(req) };

    const existing = await Invoice.findOne(scope);
    if (!existing) return res.status(404).json({ error: "Not found" });

    // If already soft-deleted -> hard delete
    if (existing.deleted === true) {
      // attempt to remove file on disk if it exists and lives under uploads/invoices/<org>/
      try {
        const fileUrl = existing.fileUrl || "";
        const m = String(fileUrl).match(/\/files\/invoices\/([^/]+)\/([^/]+)$/i);
        if (m) {
          const orgFolder = m[1];
          const filename = m[2];
          const p = path.join(__dirname, "..", "uploads", "invoices", orgFolder, filename);
          try { fs.unlinkSync(p); } catch {}
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
 * Stores under /uploads/invoices/<orgId>/...
 * Returns { ok, url, filename, invoice }
 */
router.post(
  "/:id/file",
  requireAnyRole("manager", "admin", "superadmin"),
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file" });

      const org = safeOrgIdForFolder(req);
      const filename = req.file.filename;
      const publicUrl = `/files/invoices/${org}/${filename}`;

      const set = {
        fileUrl: publicUrl,
        fileName: req.file.originalname || filename,
        fileSize: req.file.size,
        fileType: req.file.mimetype,
        updatedBy: req.user?.sub || req.user?._id || req.user?.email || null,
      };

      const doc = await Invoice.findOneAndUpdate(
        { _id: req.params.id, ...orgScopeFromReq(req), deleted: { $ne: true } },
        { $set: set },
        { new: true }
      ).lean();

      if (!doc) return res.status(404).json({ error: "Not found" });

      res.json({ ok: true, url: publicUrl, filename, invoice: doc });
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
