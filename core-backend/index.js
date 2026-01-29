// core-backend/index.js
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

// ✅ GridFS support (MongoDB file storage)
const { GridFSBucket } = require("mongodb");

// ------------------ Models (ensure compiled on boot) ------------------
try {
  require("./models/ManagerNote");
} catch {}
try {
  require("./models/TaskCoverage");
} catch {}
try {
  require("./models/InspectionSubmission");
} catch {}
try {
  require("./models/User");
} catch {} // ensure User is compiled for boot

// ✅ IMPORTANT: Inspections compatibility boot
// Your real model file is models/InspectionForm.js, but some routers may expect "Inspection".
// This creates an alias so require("./models/Inspection") or mongoose.model("Inspection") works.
try {
  const InspectionForm = require("./models/InspectionForm");

  // If router expects mongoose.model("Inspection"), ensure it exists.
  if (!mongoose.models.Inspection) {
    try {
      // Best: compile alias using same schema + same collection
      const collectionName =
        InspectionForm?.collection?.name ||
        InspectionForm?.collection?.collectionName ||
        undefined;

      mongoose.model("Inspection", InspectionForm.schema, collectionName);
      console.log("[boot] aliased InspectionForm -> Inspection");
    } catch (e) {
      // Fallback: direct alias reference
      mongoose.models.Inspection = InspectionForm;
      console.log("[boot] aliased mongoose.models.Inspection = InspectionForm");
    }
  }
} catch (e) {
  // Don't crash if inspections are not ready yet
  console.warn("[boot] InspectionForm model not available:", e?.message || e);
}

// --- Optional/Safe require helper (logs failures) ---
function safeRequire(p) {
  try {
    return require(p);
  } catch (e) {
    console.error(`[safeRequire] failed: ${p}`);
    console.error(e);
    return null;
  }
}

const runSuperadminBoot = safeRequire("./boot/superadmin");
const touchOrgActivity =
  safeRequire("./middleware/org-activity") || ((_req, _res, next) => next());
const enforceTrial =
  safeRequire("./middleware/org-trial") || ((_req, _res, next) => next());

// Org model for background trial sweep
const Org = safeRequire("./models/Org");

// --- Core routers that we know exist ---
const orgRouter = require("./routes/org");
const authRouter = require("./routes/auth");
const usersRouter = require("./routes/users");
const clockingsRouter = require("./routes/clockings");
const billingRouter = safeRequire("./routes/billing");

// Geofence routers (mounted early to avoid being shadowed)
const projectsGeofencesRouter = require("./routes/projects-geofences");
const taskFencesRouter = require("./routes/task-fences");

// --- Optional routers (guarded) ---
const projectsRouter = safeRequire("./routes/projects");
const documentsRouter = safeRequire("./routes/documents");

// ✅ Inspections routers (guarded) — define BOTH variants safely
const inspectionModuleRouter = safeRequire("./routes/inspectionModule"); // module variant
const inspectionsRouter = safeRequire("./routes/inspections"); // legacy/simple variant if it exists

const assetsRouter = safeRequire("./routes/assets");
const vehiclesRouter = safeRequire("./routes/vehicles");
const logbookRouter = require("./routes/logbook");
const invoicesRouter = safeRequire("./routes/invoices");
const groupsRouter = safeRequire("./routes/groups");

/**
 * ✅ CRITICAL: tasks router MUST NOT be optional.
 * If it fails to load, we WANT the server to crash so we can see the real error.
 */
const tasksRouter = require("./routes/tasks");

const taskMilestonesRouter = safeRequire("./routes/task-milestones");
const vendorsRouter = safeRequire("./routes/vendors");
const purchasesRouter = safeRequire("./routes/purchases");
const managerNotesRouter = safeRequire("./routes/manager-notes");
const projectsManagerNotesRouter = safeRequire(
  "./routes/projects-manager-notes",
);
const vehicleTripsRouter = safeRequire("./routes/vehicleTrips");
const vehicleTripAliases = safeRequire("./routes/vehicleTripAliases");
const superAdminRouter = safeRequire("./routes/admin.super");

// Auth & visibility middleware
const {
  requireAuth,
  resolveOrgContext,
  requireOrg,
} = require("./middleware/auth");
const { computeAccessibleUserIds } = safeRequire("./middleware/access") || {
  computeAccessibleUserIds: (_req, _res, next) => next(),
};

const app = express();

// ✅ Files (GridFS streaming routes)
const filesRoutes = require("./routes/files");
app.use("/files", filesRoutes);
app.use("/api/files", filesRoutes);

/* ---------------------------- App Middleware --------------------------- */
app.set("trust proxy", 1);
app.disable("x-powered-by");

/**
 * ✅ CORS (stable; no throwing errors)
 */
const allowedOrigins = new Set(
  String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// defaults (safe)
allowedOrigins.add("http://localhost:5173");
allowedOrigins.add("http://localhost:3000");
allowedOrigins.add("https://moat-smartops.vercel.app");

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.has(origin)) return cb(null, true);
    if (/\.vercel\.app$/i.test(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "X-Org-Id",
    "x-org-id",
    "X-Org",
    "x-org",
    "Cache-Control",
    "Pragma",
    "Expires",
    "If-Modified-Since",
    "If-None-Match",
  ],
  exposedHeaders: ["Content-Disposition", "ETag"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

/* ------------------------ Shared helpers ------------------------ */
function toObjectIdOrNull(id) {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
}

/* -------------------------- Superadmin (optional) -------------------------- */
if (superAdminRouter) {
  app.use("/admin/super", superAdminRouter);
  app.use("/api/admin/super", superAdminRouter);
}

// PUBLIC (no auth) — MOUNT AT BOTH /public AND /api/public
const publicAuthRouter = require("./routes/publicAuth");
app.use("/public", publicAuthRouter);
app.use("/api/public", publicAuthRouter);

/* ------------------------------ Auth Routes ---------------------------- */
app.use("/auth", authRouter);
app.use("/api/auth", authRouter);

/* -------------------------------- Health -------------------------------- */
app.get("/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() }),
);
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() }),
);

/* -------------------- GridFS fallback for vehicle trip photos -------------------- */
function getTripsBucket() {
  const db = mongoose.connection?.db;
  if (!db) return null;
  return new GridFSBucket(db, { bucketName: "vehicleTrips" });
}

async function serveVehicleTripFile(req, res, next) {
  try {
    const filename = req.params.filename;
    if (!filename) return res.status(400).json({ error: "Missing filename" });

    const diskPath = path.join(__dirname, "uploads", "vehicle-trips", filename);
    if (fs.existsSync(diskPath)) return res.sendFile(diskPath);

    const bucket = getTripsBucket();
    if (!bucket) return res.status(503).json({ error: "MongoDB not ready" });

    const files = await bucket.find({ filename }).limit(1).toArray();
    if (!files || files.length === 0)
      return res.status(404).json({ error: "File not found" });

    const f = files[0];
    if (f?.contentType) res.setHeader("Content-Type", f.contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    const stream = bucket.openDownloadStreamByName(filename);
    stream.on("error", (err) => next(err));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

app.get("/files/vehicle-trips/:filename", serveVehicleTripFile);
app.get("/api/files/vehicle-trips/:filename", serveVehicleTripFile);

/* -------------------- GridFS serving for Vault/Documents -------------------- */
function getDocumentsBucket() {
  const db = mongoose.connection?.db;
  if (!db) return null;
  return new GridFSBucket(db, { bucketName: "documents" });
}

async function serveDocumentFile(req, res, next) {
  try {
    const fileId = toObjectIdOrNull(req.params.fileId);
    if (!fileId) return res.status(400).json({ error: "Invalid file id" });

    const bucket = getDocumentsBucket();
    if (!bucket) return res.status(503).json({ error: "MongoDB not ready" });

    const files = await bucket.find({ _id: fileId }).limit(1).toArray();
    if (!files || files.length === 0)
      return res.status(404).json({ error: "File not found" });

    const f = files[0];
    if (f?.contentType) res.setHeader("Content-Type", f.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    const stream = bucket.openDownloadStream(fileId);
    stream.on("error", (err) => next(err));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

app.get("/files/documents/:fileId", serveDocumentFile);
app.get("/api/files/documents/:fileId", serveDocumentFile);
app.get("/documents/files/:fileId", serveDocumentFile);
app.get("/api/documents/files/:fileId", serveDocumentFile);

/* -------------------- GridFS for org logos -------------------- */
function getOrgBucket() {
  const db = mongoose.connection?.db;
  if (!db) return null;
  return new GridFSBucket(db, { bucketName: "org" });
}

async function serveOrgLogo(req, res, next) {
  try {
    const org = String(req.params.org || "");
    if (!org) return res.status(400).json({ error: "Missing org" });

    const bucket = getOrgBucket();
    if (!bucket) return res.status(503).json({ error: "MongoDB not ready" });

    const files = await bucket
      .find({ "metadata.orgId": org, "metadata.kind": "logo" })
      .sort({ uploadDate: -1 })
      .limit(1)
      .toArray();

    const f = files?.[0];
    if (!f?._id) return res.status(404).json({ error: "Logo not found" });

    const etag = f.md5 ? `"${f.md5}"` : null;
    if (etag) {
      res.setHeader("ETag", etag);
      const inm = req.headers["if-none-match"];
      if (inm && inm === etag) return res.status(304).end();
    }

    if (f?.contentType) res.setHeader("Content-Type", f.contentType);
    res.setHeader("Cache-Control", "public, max-age=300");

    const stream = bucket.openDownloadStream(f._id);
    stream.on("error", (err) => next(err));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

app.get("/files/org/:org/logo", serveOrgLogo);
app.get("/api/files/org/:org/logo", serveOrgLogo);

/* -------------------- GridFS for asset attachments -------------------- */
function getAssetsBucket() {
  const db = mongoose.connection?.db;
  if (!db) return null;
  return new GridFSBucket(db, { bucketName: "assets" });
}

async function serveAssetFile(req, res, next) {
  try {
    const fileId = toObjectIdOrNull(req.params.fileId);
    if (!fileId) return res.status(400).json({ error: "Invalid file id" });

    const bucket = getAssetsBucket();
    if (!bucket) return res.status(503).json({ error: "MongoDB not ready" });

    const files = await bucket.find({ _id: fileId }).limit(1).toArray();
    if (!files || files.length === 0)
      return res.status(404).json({ error: "File not found" });

    const f = files[0];
    if (f?.contentType) res.setHeader("Content-Type", f.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    const stream = bucket.openDownloadStream(fileId);
    stream.on("error", (err) => next(err));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

app.get("/files/assets/:fileId", serveAssetFile);
app.get("/api/files/assets/:fileId", serveAssetFile);

/* -------------------- GridFS for invoice files -------------------- */
function getInvoicesBucket() {
  const db = mongoose.connection?.db;
  if (!db) return null;
  return new GridFSBucket(db, { bucketName: "invoices" });
}

async function serveInvoiceFile(req, res, next) {
  try {
    const org = String(req.params.org || "");
    const filename = String(req.params.filename || "");
    if (!org || !filename)
      return res.status(400).json({ error: "Missing org or filename" });

    const diskPath = path.join(__dirname, "uploads", "invoices", org, filename);
    if (fs.existsSync(diskPath)) return res.sendFile(diskPath);

    const bucket = getInvoicesBucket();
    if (!bucket) return res.status(503).json({ error: "MongoDB not ready" });

    const files = await bucket
      .find({ filename, "metadata.orgId": org })
      .sort({ uploadDate: -1 })
      .limit(1)
      .toArray();

    const f = files?.[0];
    if (!f?._id) return res.status(404).json({ error: "File not found" });

    if (f?.contentType) res.setHeader("Content-Type", f.contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    const stream = bucket.openDownloadStream(f._id);
    stream.on("error", (err) => next(err));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

app.get("/files/invoices/:org/:filename", serveInvoiceFile);
app.get("/api/files/invoices/:org/:filename", serveInvoiceFile);

/* -------------------- GridFS for task attachments -------------------- */
function getTasksBucket() {
  const db = mongoose.connection?.db;
  if (!db) return null;
  return new GridFSBucket(db, { bucketName: "tasks" });
}

async function serveTaskAttachmentFile(req, res, next) {
  try {
    const fileId = toObjectIdOrNull(req.params.fileId);
    if (!fileId) return res.status(400).json({ error: "Invalid file id" });

    const bucket = getTasksBucket();
    if (!bucket) return res.status(503).json({ error: "MongoDB not ready" });

    const files = await bucket.find({ _id: fileId }).limit(1).toArray();
    if (!files || files.length === 0)
      return res.status(404).json({ error: "File not found" });

    const f = files[0];
    if (f?.contentType) res.setHeader("Content-Type", f.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    const stream = bucket.openDownloadStream(fileId);
    stream.on("error", (err) => next(err));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

app.get("/files/tasks/:fileId", serveTaskAttachmentFile);
app.get("/api/files/tasks/:fileId", serveTaskAttachmentFile);

/* ---------------------------- Static /files ---------------------------- */
const uploadsRoot = path.join(__dirname, "uploads");
[
  "assets",
  "org",
  "docs",
  "vault",
  "tasks",
  "task-fences",
  "fences",
  "fences/tasks",
  "fences/projects",
  "coverage",
  "coverage/tasks",
  "vehicle-trips",
  "invoices",
].forEach((sub) => {
  try {
    fs.mkdirSync(path.join(uploadsRoot, sub), { recursive: true });
  } catch {}
});

const staticOpts = {
  index: false,
  fallthrough: false,
  etag: true,
  maxAge: "1d",
  setHeaders(res, filePath) {
    if (/\.(geo)?json$/i.test(filePath))
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    else if (/\.kml$/i.test(filePath))
      res.setHeader(
        "Content-Type",
        "application/vnd.google-earth.kml+xml; charset=utf-8",
      );
    else if (/\.kmz$/i.test(filePath))
      res.setHeader("Content-Type", "application/vnd.google-earth.kmz");
  },
};

app.use(
  "/files/task-fences",
  express.static(path.join(uploadsRoot, "fences", "tasks"), staticOpts),
);
app.use(
  "/api/files/task-fences",
  express.static(path.join(uploadsRoot, "fences", "tasks"), staticOpts),
);
app.use(
  "/files/project-fences",
  express.static(path.join(uploadsRoot, "fences", "projects"), staticOpts),
);
app.use(
  "/api/files/project-fences",
  express.static(path.join(uploadsRoot, "fences", "projects"), staticOpts),
);
app.use("/files", express.static(uploadsRoot, staticOpts));
app.use("/api/files", express.static(uploadsRoot, staticOpts));
app.use("/uploads", express.static(uploadsRoot, staticOpts));
app.use("/api/uploads", express.static(uploadsRoot, staticOpts));

/* --------------------------- Protected Routers -------------------------- */

// ✅ MOBILE ROUTER: allow bootstrap BEFORE org selection.
// The router itself handles which endpoints need org (your routes/mobile.js already does that).
const mobileRouter = require("./routes/mobile");
app.use(
  "/mobile",
  requireAuth,
  resolveOrgContext,
  enforceTrial,
  touchOrgActivity,
  computeAccessibleUserIds,
  mobileRouter,
);
app.use(
  "/api/mobile",
  requireAuth,
  resolveOrgContext,
  enforceTrial,
  touchOrgActivity,
  computeAccessibleUserIds,
  mobileRouter,
);

// Clockings
app.use(
  "/clockings",
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  computeAccessibleUserIds,
  clockingsRouter,
);
app.use(
  "/api/clockings",
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  computeAccessibleUserIds,
  clockingsRouter,
);

// Users
app.use(
  "/users",
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  computeAccessibleUserIds,
  usersRouter,
);
app.use(
  "/api/users",
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  computeAccessibleUserIds,
  usersRouter,
);

/* --------- Geofence endpoints FIRST to avoid being shadowed --------- */
app.use(
  "/projects",
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  projectsGeofencesRouter,
);
app.use(
  "/api/projects",
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  projectsGeofencesRouter,
);

/**
 * ✅ CRITICAL: mount the BASE tasks router BEFORE any other /tasks routers
 */
app.use(
  "/tasks",
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  computeAccessibleUserIds,
  tasksRouter,
);
app.use(
  "/api/tasks",
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  computeAccessibleUserIds,
  tasksRouter,
);

/* --------- Task-related sub-routers AFTER base tasks router --------- */

// task fences router
app.use(
  "/tasks",
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  taskFencesRouter,
);
app.use(
  "/api/tasks",
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  taskFencesRouter,
);

// Task coverage
app.use(
  "/tasks",
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  require("./routes/task-coverage"),
);
app.use(
  "/api/tasks",
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  require("./routes/task-coverage"),
);

/* -------------------- Manager Notes -------------------- */
if (managerNotesRouter) {
  app.use(
    "/tasks",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    managerNotesRouter,
  );
  app.use(
    "/api/tasks",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    managerNotesRouter,
  );
}

/* -------------------- Project Manager Notes -------------------- */
if (projectsManagerNotesRouter) {
  app.use(
    "/projects",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    projectsManagerNotesRouter,
  );
  app.use(
    "/api/projects",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    projectsManagerNotesRouter,
  );
}

/* -------------------------------- Other Routers -------------------------------- */
if (projectsRouter) {
  app.use(
    "/projects",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    projectsRouter,
  );
  app.use(
    "/api/projects",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    projectsRouter,
  );
}

if (groupsRouter) {
  app.use(
    "/groups",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    groupsRouter,
  );
  app.use(
    "/api/groups",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    groupsRouter,
  );
}

/* -------------------- Task Milestones AFTER base tasks router -------------------- */
if (taskMilestonesRouter) {
  app.use(
    "/tasks",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    taskMilestonesRouter,
  );
  app.use(
    "/api/tasks",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    taskMilestonesRouter,
  );
}

/* ------------------------ Inspections ----------------------- */
if (inspectionModuleRouter) {
  // Keep BOTH spellings so your mobile app can call either:
  // /api/inspection or /api/inspections
  app.use(
    "/inspections",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionModuleRouter,
  );
  app.use(
    "/api/inspections",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionModuleRouter,
  );
  app.use(
    "/inspection",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionModuleRouter,
  );
  app.use(
    "/api/inspection",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionModuleRouter,
  );
} else if (inspectionsRouter) {
  app.use(
    "/inspections",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionsRouter,
  );
  app.use(
    "/api/inspections",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionsRouter,
  );
  app.use(
    "/inspection",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionsRouter,
  );
  app.use(
    "/api/inspection",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionsRouter,
  );
} else {
  console.warn(
    "[routes] inspections not mounted (no inspectionModuleRouter or inspectionsRouter)",
  );
}

/* -------------------------------- Remaining Modules -------------------------------- */
if (assetsRouter) {
  app.use(
    "/assets",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    assetsRouter,
  );
  app.use(
    "/api/assets",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    assetsRouter,
  );
}

if (vehiclesRouter) {
  app.use(
    "/vehicles",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    vehiclesRouter,
  );
  app.use(
    "/api/vehicles",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    vehiclesRouter,
  );
}

if (logbookRouter) {
  app.use(
    "/",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    logbookRouter,
  );
  app.use(
    "/api",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    logbookRouter,
  );
}

if (vendorsRouter) {
  app.use(
    "/vendors",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    vendorsRouter,
  );
  app.use(
    "/api/vendors",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    vendorsRouter,
  );
}

if (purchasesRouter) {
  app.use(
    "/purchases",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    purchasesRouter,
  );
  app.use(
    "/api/purchases",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    purchasesRouter,
  );
}

if (invoicesRouter) {
  app.use(
    "/invoices",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    invoicesRouter,
  );
  app.use(
    "/api/invoices",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    invoicesRouter,
  );
}

if (documentsRouter) {
  app.use(
    "/documents",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    documentsRouter,
  );
  app.use(
    "/api/documents",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    documentsRouter,
  );
}

if (vehicleTripsRouter) {
  app.use(
    "/",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    vehicleTripsRouter,
  );
  app.use(
    "/api",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    vehicleTripsRouter,
  );
}

if (vehicleTripAliases) {
  app.use(
    "/",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    vehicleTripAliases,
  );
  app.use(
    "/api",
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    vehicleTripAliases,
  );
}

if (billingRouter) {
  app.use("/billing", billingRouter);
  app.use("/api/billing", billingRouter);
}

app.use("/api/mobile", require("./routes/mobileDefinitions"));

/* ------------------------------- Org Routes ---------------------------- */
app.use("/org", orgRouter);
app.use("/api/org", orgRouter);

/* ------------------------------ Not Found ------------------------------ */
app.use((req, res) => res.status(404).json({ error: "Not Found" }));

/* --------------------------- Error Handler JSON ------------------------- */
app.use((err, req, res, _next) => {
  console.error("[error]", err);
  if (err.name === "CastError")
    return res.status(400).json({ error: "Invalid ID format" });
  if (err.name === "ValidationError")
    return res.status(400).json({ error: err.message });
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

/* ------------------------------- Database ------------------------------ */
mongoose.set("strictQuery", true);
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/smartops";

/**
 * Background sweep: auto-suspend orgs whose trial has expired.
 */
async function runTrialSweepOnce() {
  if (!Org) {
    console.warn("[trial] Org model not available; skipping trial sweep");
    return;
  }
  try {
    const now = new Date();
    const res = await Org.updateMany(
      { status: "trialing", planCode: "trial", trialEndsAt: { $lt: now } },
      { $set: { status: "suspended" } },
    );
    const modified = res?.modifiedCount ?? res?.nModified ?? 0;
    if (modified > 0)
      console.log(`[trial] Suspended ${modified} org(s) with expired trial`);
  } catch (e) {
    console.error("[trial] sweep error:", e);
  }
}

async function waitForMongo(uri, options = {}, intervalMs = 2000) {
  while (true) {
    try {
      await mongoose.connect(uri, { autoIndex: true, ...options });
      const c = mongoose.connection;
      console.log("[mongo] connected");
      if (c?.host && c?.name)
        console.log(`[mongo] using ${c.host}:${c.port}/${c.name}`);
      return;
    } catch (err) {
      console.error("[mongo] connection error:", err?.message || String(err));
      console.log(`[mongo] retrying in ${intervalMs}ms...`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/* --------------------------------- Start -------------------------------- */
const PORT = process.env.PORT || 5000;
let server;

async function start() {
  console.log(
    `[server] starting in ${process.env.NODE_ENV || "development"} mode`,
  );
  await waitForMongo(MONGO_URI);

  // Boot tasks (optional)
  try {
    if (typeof runSuperadminBoot === "function") {
      await runSuperadminBoot();
    } else if (
      runSuperadminBoot &&
      typeof runSuperadminBoot.run === "function"
    ) {
      await runSuperadminBoot.run();
    } else {
      console.log(
        "[boot] superadmin boot script not found or has no runnable export",
      );
    }
  } catch (e) {
    console.warn("[boot] superadmin error:", e?.message || e);
  }

  server = app.listen(PORT, () => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    console.log(`[server] listening on ${url}`);
  });

  // Schedule trial sweeper
  try {
    await runTrialSweepOnce();
    const interval = Number(
      process.env.TRIAL_SWEEP_INTERVAL_MS || 1000 * 60 * 60,
    );
    setInterval(runTrialSweepOnce, interval);
    console.log(`[trial] sweep scheduled every ${interval}ms`);
  } catch (e) {
    console.error("[trial] failed to schedule sweep:", e);
  }
}

function gracefulShutdown(signal) {
  console.log(`[server] received ${signal}, shutting down...`);
  Promise.resolve()
    .then(() => server && server.close())
    .then(() => mongoose.connection.close(false))
    .then(() => {
      console.log("[server] closed, [mongo] disconnected");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[shutdown] error:", err);
      process.exit(1);
    });
}

if (require.main === module) {
  start();
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

module.exports = app;
