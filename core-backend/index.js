// core-backend/index.js
require('dotenv').config();

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');

// ------------------ Models (ensure compiled on boot) ------------------
try { require('./models/ManagerNote'); } catch {}
try { require('./models/TaskCoverage'); } catch {}
try { require('./models/InspectionSubmission'); } catch {}
try { require('./models/User'); } catch {} // ensure User is compiled for boot

// --- Optional/Safe require helper ---
function safeRequire(p) { try { return require(p); } catch { return null; } }
const runSuperadminBoot  = safeRequire('./boot/superadmin');
const touchOrgActivity   = safeRequire('./middleware/org-activity') || ((_req,_res,next)=>next());
const enforceTrial       = safeRequire('./middleware/org-trial')   || ((_req,_res,next)=>next());

// Org model for background trial sweep
const Org = safeRequire('./models/Org');

// --- Core routers that we know exist ---
const orgRouter       = require('./routes/org');
const authRouter      = require('./routes/auth');
const usersRouter     = require('./routes/users');
const clockingsRouter = require('./routes/clockings');
const billingRouter   = safeRequire('./routes/billing');

// Geofence routers (mounted early to avoid being shadowed)
const projectsGeofencesRouter = require('./routes/projects-geofences');
const taskFencesRouter        = require('./routes/task-fences');

// --- Optional routers (guarded) ---
const projectsRouter             = safeRequire('./routes/projects');
const documentsRouter            = safeRequire('./routes/documents');
const inspectionsRouter          = safeRequire('./routes/inspections');        // legacy (fallback)
const inspectionModuleRouter     = safeRequire('./routes/inspectionModule');   // module variant
const assetsRouter               = safeRequire('./routes/assets');
const vehiclesRouter             = safeRequire('./routes/vehicles');
const logbookRouter              = safeRequire('./routes/logbook');
const invoicesRouter             = safeRequire('./routes/invoices');
const groupsRouter               = safeRequire('./routes/groups');
const tasksRouter                = safeRequire('./routes/tasks');
const taskMilestonesRouter       = safeRequire('./routes/task-milestones');
const vendorsRouter              = safeRequire('./routes/vendors');
const purchasesRouter            = safeRequire('./routes/purchases');
const managerNotesRouter         = safeRequire('./routes/manager-notes');
const projectsManagerNotesRouter = safeRequire('./routes/projects-manager-notes');
const vehicleTripsRouter         = safeRequire('./routes/vehicleTrips');
const vehicleTripAliases         = safeRequire('./routes/vehicleTripAliases');
const superAdminRouter           = safeRequire('./routes/admin.super');

// Auth & visibility middleware
const {
  requireAuth,
  resolveOrgContext,
  requireOrg,
} = require('./middleware/auth');
const { computeAccessibleUserIds } = safeRequire('./middleware/access') || { computeAccessibleUserIds: (_req,_res,next)=>next() };

const app = express();

/* ================= HARD CORS + PREFLIGHT FIX ================= */
// This MUST be before cors(), routes, auth, etc.
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,X-Requested-With,X-Org-Id,x-org-id,X-Org,x-org,Cache-Control,Pragma,Expires,If-Modified-Since,If-None-Match"
  );

  // 🔴 CRITICAL: end preflight cleanly
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

/* ---------------------------- App Middleware --------------------------- */
app.set('trust proxy', 1);
app.disable('x-powered-by');

const allowedOrigins = new Set(
  String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

// Allow localhost dev by default if nothing set
if (allowedOrigins.size === 0) {
  allowedOrigins.add("http://localhost:5173");
  allowedOrigins.add("http://localhost:3000");
}

const corsOptions = {
  origin(origin, cb) {
    // non-browser clients (mobile, curl, server-to-server) often send no Origin
    if (!origin) return cb(null, true);

    if (allowedOrigins.has(origin)) return cb(null, true);

    return cb(new Error(`CORS blocked origin: ${origin}`));
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

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Superadmin cockpit (optional, global scope – no org activity touch here)
if (superAdminRouter) {
  app.use('/admin/super', superAdminRouter);
  app.use('/api/admin/super', superAdminRouter);
}

// PUBLIC (no auth) — MOUNT AT BOTH /public AND /api/public
const publicAuthRouter = require('./routes/publicAuth');
app.use('/public', publicAuthRouter);
app.use('/api/public', publicAuthRouter);

/* ---------------------------- Static /files ---------------------------- */
const uploadsRoot = path.join(__dirname, 'uploads');
[
  'assets','org','docs','vault','tasks','task-fences','fences','fences/tasks','fences/projects',
  'coverage','coverage/tasks',
].forEach((sub) => { try { fs.mkdirSync(path.join(uploadsRoot, sub), { recursive: true }); } catch {} });

const staticOpts = {
  index: false, fallthrough: false, etag: true, maxAge: '1d',
  setHeaders(res, filePath) {
    if (/\.(geo)?json$/i.test(filePath)) res.setHeader('Content-Type','application/json; charset=utf-8');
    else if (/\.kml$/i.test(filePath))  res.setHeader('Content-Type','application/vnd.google-earth.kml+xml; charset=utf-8');
    else if (/\.kmz$/i.test(filePath))  res.setHeader('Content-Type','application/vnd.google-earth.kmz');
  },
};
app.use('/files/task-fences',        express.static(path.join(uploadsRoot, 'fences', 'tasks'), staticOpts));
app.use('/api/files/task-fences',    express.static(path.join(uploadsRoot, 'fences', 'tasks'), staticOpts));
app.use('/files/project-fences',     express.static(path.join(uploadsRoot, 'fences', 'projects'), staticOpts));
app.use('/api/files/project-fences', express.static(path.join(uploadsRoot, 'fences', 'projects'), staticOpts));
app.use('/files',     express.static(uploadsRoot, staticOpts));
app.use('/api/files', express.static(uploadsRoot, staticOpts));
app.use('/uploads',     express.static(uploadsRoot, staticOpts));
app.use('/api/uploads', express.static(uploadsRoot, staticOpts));

/* ------------------------------ Auth Routes ---------------------------- */
app.use('/auth',     authRouter);
app.use('/api/auth', authRouter);

/* -------------------------------- Health -------------------------------- */
app.get('/health',     (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* --------------------------- Protected Routers -------------------------- */
/* Pattern: requireAuth → resolveOrgContext → requireOrg → enforceTrial → touchOrgActivity → (computeAccessibleUserIds?) → router
 *
 * IMPORTANT: We DO NOT run enforceTrial on /org and /api/org themselves,
 * so that suspended / expired trial orgs can still view/change billing and settings.
 */

// Clockings
app.use(
  '/clockings',
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  computeAccessibleUserIds,
  clockingsRouter
);
app.use(
  '/api/clockings',
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  computeAccessibleUserIds,
  clockingsRouter
);

// Users
app.use(
  '/users',
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  computeAccessibleUserIds,
  usersRouter
);
app.use(
  '/api/users',
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  computeAccessibleUserIds,
  usersRouter
);

/* --------- Geofence endpoints FIRST to avoid being shadowed --------- */
app.use(
  '/projects',
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  projectsGeofencesRouter
);
app.use(
  '/api/projects',
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  projectsGeofencesRouter
);

app.use(
  '/tasks',
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  taskFencesRouter
);
app.use(
  '/api/tasks',
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  taskFencesRouter
);

// Task coverage
app.use(
  '/tasks',
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  require('./routes/task-coverage')
);
app.use(
  '/api/tasks',
  requireAuth,
  resolveOrgContext,
  requireOrg,
  enforceTrial,
  touchOrgActivity,
  require('./routes/task-coverage')
);

/* -------------------- Manager Notes -------------------- */
if (managerNotesRouter) {
  app.use(
    '/tasks',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    managerNotesRouter
  );
  app.use(
    '/api/tasks',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    managerNotesRouter
  );
}
if (projectsManagerNotesRouter) {
  app.use(
    '/projects',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    projectsManagerNotesRouter
  );
  app.use(
    '/api/projects',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    projectsManagerNotesRouter
  );
}

/* -------------------------------- Other Routers -------------------------------- */
if (projectsRouter) {
  app.use(
    '/projects',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    projectsRouter
  );
  app.use(
    '/api/projects',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    projectsRouter
  );
}

if (groupsRouter) {
  app.use(
    '/groups',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    groupsRouter
  );
  app.use(
    '/api/groups',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    groupsRouter
  );
}

if (taskMilestonesRouter) {
  app.use(
    '/tasks',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    taskMilestonesRouter
  );
  app.use(
    '/api/tasks',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    taskMilestonesRouter
  );
}

if (tasksRouter) {
  app.use(
    '/tasks',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    tasksRouter
  );
  app.use(
    '/api/tasks',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    tasksRouter
  );
}

/* ------------------------ Inspections ----------------------- */
if (inspectionModuleRouter) {
  app.use(
    '/inspections',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionModuleRouter
  );
  app.use(
    '/api/inspections',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionModuleRouter
  );
  app.use(
    '/inspection',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionModuleRouter
  );
  app.use(
    '/api/inspection',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionModuleRouter
  );
} else if (inspectionsRouter) {
  app.use(
    '/inspections',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionsRouter
  );
  app.use(
    '/api/inspections',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionsRouter
  );
  app.use(
    '/inspection',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionsRouter
  );
  app.use(
    '/api/inspection',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    inspectionsRouter
  );
}

/* -------------------------------- Remaining Modules -------------------------------- */
if (assetsRouter) {
  app.use(
    '/assets',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    assetsRouter
  );
  app.use(
    '/api/assets',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    assetsRouter
  );
}
if (vehiclesRouter) {
  app.use(
    '/vehicles',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    vehiclesRouter
  );
  app.use(
    '/api/vehicles',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    vehiclesRouter
  );
}
if (logbookRouter) {
  app.use(
    '/logbook',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    logbookRouter
  );
  app.use(
    '/api/logbook',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    logbookRouter
  );
}
if (vendorsRouter) {
  app.use(
    '/vendors',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    vendorsRouter
  );
  app.use(
    '/api/vendors',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    vendorsRouter
  );
}
if (purchasesRouter) {
  app.use(
    '/purchases',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    purchasesRouter
  );
  app.use(
    '/api/purchases',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    purchasesRouter
  );
}
if (invoicesRouter) {
  app.use(
    '/invoices',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    invoicesRouter
  );
  app.use(
    '/api/invoices',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    invoicesRouter
  );
}
if (documentsRouter) {
  app.use(
    '/documents',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    documentsRouter
  );
  app.use(
    '/api/documents',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    documentsRouter
  );
}

if (vehicleTripsRouter) {
  app.use(
    '/',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    vehicleTripsRouter
  );
  app.use(
    '/api',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    vehicleTripsRouter
  );
}
if (vehicleTripAliases) {
  app.use(
    '/',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    vehicleTripAliases
  );
  app.use(
    '/api',
    requireAuth,
    resolveOrgContext,
    requireOrg,
    enforceTrial,
    touchOrgActivity,
    computeAccessibleUserIds,
    vehicleTripAliases
  );
}

if (billingRouter) {
  // System-level billing (not org-scoped), so no touchOrgActivity here
  app.use('/billing', billingRouter);
  app.use('/api/billing', billingRouter);
}

/* ------------------------------- Org Routes ---------------------------- */
/**
 * orgRouter itself already uses requireAuth → resolveOrgContext → requireOrg inside,
 * so we don't insert enforceTrial or touchOrgActivity here to avoid blocking
 * billing/settings for suspended or expired trial orgs.
 *
 * IMPORTANT: mount at /org and /api/org so that:
 *   - frontend calls like /api/org/billing, /api/org/billing/preview, etc. resolve correctly
 *   - existing /api/org calls (e.g. org settings) continue to work
 */
app.use('/org', orgRouter);
app.use('/api/org', orgRouter);

/* ------------------------------ Not Found ------------------------------ */
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

/* --------------------------- Error Handler JSON ------------------------- */
app.use((err, req, res, _next) => {
  console.error('[error]', err);
  if (err.name === 'CastError')       return res.status(400).json({ error: 'Invalid ID format' });
  if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

/* ------------------------------- Database ------------------------------ */
mongoose.set('strictQuery', true);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/smartops';

/**
 * Background sweep: auto-suspend orgs whose trial has expired.
 *
 * Criteria:
 *   status: "trialing"
 *   planCode: "trial"
 *   trialEndsAt < now
 *
 * It does NOT touch active/paid orgs.
 */
async function runTrialSweepOnce() {
  if (!Org) {
    console.warn('[trial] Org model not available; skipping trial sweep');
    return;
  }
  try {
    const now = new Date();
    const res = await Org.updateMany(
      {
        status: 'trialing',
        planCode: 'trial',
        trialEndsAt: { $lt: now },
      },
      { $set: { status: 'suspended' } }
    );

    const modified = res?.modifiedCount ?? res?.nModified ?? 0;
    if (modified > 0) {
      console.log(`[trial] Suspended ${modified} org(s) with expired trial`);
    }
  } catch (e) {
    console.error('[trial] sweep error:', e);
  }
}

async function waitForMongo(uri, options = {}, intervalMs = 2000) {
  while (true) {
    try {
      await mongoose.connect(uri, { autoIndex: true, ...options });
      const c = mongoose.connection;
      console.log('[mongo] connected');
      if (c?.host && c?.name) console.log(`[mongo] using ${c.host}:${c.port}/${c.name}`);
      return;
    } catch (err) {
      console.error('[mongo] connection error:', err?.message || String(err));
      console.log(`[mongo] retrying in ${intervalMs}ms...`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/* --------------------------------- Start -------------------------------- */
const PORT = process.env.PORT || 5000;
let server;

async function start() {
  console.log(`[server] starting in ${process.env.NODE_ENV || 'development'} mode`);
  await waitForMongo(MONGO_URI);

  // Boot tasks (optional)
  try {
    if (typeof runSuperadminBoot === 'function') {
      await runSuperadminBoot();
    } else if (runSuperadminBoot && typeof runSuperadminBoot.run === 'function') {
      await runSuperadminBoot.run();
    } else {
      console.log('[boot] superadmin boot script not found or has no runnable export');
    }
  } catch (e) {
    console.warn('[boot] superadmin error:', e?.message || e);
  }

  // Start HTTP server
  server = app.listen(PORT, () => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    console.log(`[server] listening on ${url}`);
  });

  // Schedule trial sweeper
  try {
    // Run once on startup
    await runTrialSweepOnce();

    const interval = Number(process.env.TRIAL_SWEEP_INTERVAL_MS || 1000 * 60 * 60); // default: 1h
    setInterval(runTrialSweepOnce, interval);
    console.log(`[trial] sweep scheduled every ${interval}ms`);
  } catch (e) {
    console.error('[trial] failed to schedule sweep:', e);
  }
}

function gracefulShutdown(signal) {
  console.log(`[server] received ${signal}, shutting down...`);
  Promise.resolve()
    .then(() => server && server.close())
    .then(() => mongoose.connection.close(false))
    .then(() => {
      console.log('[server] closed, [mongo] disconnected');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[shutdown] error:', err);
      process.exit(1);
    });
}

if (require.main === module) {
  start();
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

module.exports = app;
