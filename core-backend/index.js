// core-backend/index.js
require('dotenv').config();

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');

// --- Core routers that we know exist ---
const orgRouter         = require('./routes/org');
const authRouter        = require('./routes/auth');
const usersRouter       = require('./routes/users');
const clockingsRouter   = require('./routes/clockings');

// Geofence routers (mounted early to avoid being shadowed)
const projectsGeofencesRouter = require('./routes/projects-geofences');
const taskFencesRouter        = require('./routes/task-fences');

// --- Optional routers (guarded) ---
function safeRequire(p) { try { return require(p); } catch { return null; } }
const projectsRouter       = safeRequire('./routes/projects');
const documentsRouter      = safeRequire('./routes/documents');
const inspectionsRouter    = safeRequire('./routes/inspections');
const assetsRouter         = safeRequire('./routes/assets');
const vehiclesRouter       = safeRequire('./routes/vehicles');
const logbookRouter        = safeRequire('./routes/logbook');
const invoicesRouter       = safeRequire('./routes/invoices');
const groupsRouter         = safeRequire('./routes/groups');
const tasksRouter          = safeRequire('./routes/tasks');
const taskMilestonesRouter = safeRequire('./routes/task-milestones');
const vendorsRouter        = safeRequire('./routes/vendors');
const purchasesRouter      = safeRequire('./routes/purchases');

// Vehicle Trips (optional; define absolute paths inside the router)
const vehicleTripsRouter  = safeRequire('./routes/vehicleTrips');
const vehicleTripAliases  = safeRequire('./routes/vehicleTripAliases');

// Auth & visibility middleware
const { requireAuth } = require('./middleware/auth');
const { computeAccessibleUserIds } = require('./middleware/access');

const app = express();

/* ---------------------------- App Middleware --------------------------- */
app.set('trust proxy', 1); // harmless locally; helpful if ever behind a proxy

// CORS — allow Cache-Control and other commonly sent headers in preflight
const corsOptions = {
  origin: true,                 // allow Vite (http://localhost:5173) and others in dev
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Org-Id',
    'Cache-Control',
    'Pragma',
    'Expires',
    'If-Modified-Since',
    'If-None-Match'
  ],
  exposedHeaders: ['Content-Disposition','ETag'],
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
// Ensure preflight OPTIONS always gets CORS headers
app.options('*', cors(corsOptions));

// Slightly higher limit for fence uploads as JSON
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* ---------------------------- Static /files ---------------------------- */
const uploadsRoot = path.join(__dirname, 'uploads');
[
  'assets',
  'org',
  'docs',
  'vault',
  'tasks',
  'task-fences',      // legacy (kept for compatibility)
  'fences',
  'fences/tasks',     // tidy task fences
  'fences/projects',  // tidy project fences
].forEach((sub) => {
  try { fs.mkdirSync(path.join(uploadsRoot, sub), { recursive: true }); } catch {}
});

const staticOpts = {
  index: false,
  fallthrough: false,
  etag: true,
  maxAge: '1d',
  setHeaders(res, filePath) {
    if (/\.(geo)?json$/i.test(filePath)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    } else if (/\.kml$/i.test(filePath)) {
      res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml; charset=utf-8');
    } else if (/\.kmz$/i.test(filePath)) {
      res.setHeader('Content-Type', 'application/vnd.google-earth.kmz');
    }
  },
};

// Legacy URL aliases → tidy folders
app.use('/files/task-fences',     express.static(path.join(uploadsRoot, 'fences', 'tasks'), staticOpts));
app.use('/api/files/task-fences', express.static(path.join(uploadsRoot, 'fences', 'tasks'), staticOpts));
app.use('/files/project-fences',  express.static(path.join(uploadsRoot, 'fences', 'projects'), staticOpts));
app.use('/api/files/project-fences', express.static(path.join(uploadsRoot, 'fences', 'projects'), staticOpts));

// General files
app.use('/files',     express.static(uploadsRoot, staticOpts));
app.use('/api/files', express.static(uploadsRoot, staticOpts)); // direct calls to :5000/api/files/**

/* ------------------------------ Auth Routes ---------------------------- */
// Support both direct backend calls and Vite-proxied calls
app.use('/auth',     authRouter); // -> /auth/login, /auth/me
app.use('/api/auth', authRouter); // -> /api/auth/login, /api/auth/me

/* -------------------------------- Health -------------------------------- */
app.get('/health',     (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* --------------------------- Protected Routers -------------------------- */
// Clockings
app.use('/clockings',     requireAuth, computeAccessibleUserIds, clockingsRouter);
app.use('/api/clockings', requireAuth, computeAccessibleUserIds, clockingsRouter);

// Users
app.use('/users',     requireAuth, computeAccessibleUserIds, usersRouter);
app.use('/api/users', requireAuth, computeAccessibleUserIds, usersRouter);

/* --------- Geofence endpoints FIRST to avoid being shadowed --------- */
// Projects geofences (share /projects base)
app.use('/projects',     requireAuth, projectsGeofencesRouter);
app.use('/api/projects', requireAuth, projectsGeofencesRouter);

// Task fences (under /tasks/:id/geofences) — mount BEFORE main tasks router
app.use('/tasks',     requireAuth, taskFencesRouter);
app.use('/api/tasks', requireAuth, taskFencesRouter);

/* -------------------------------- Other Routers -------------------------------- */
// Projects (optional)
if (projectsRouter) {
  app.use('/projects',     requireAuth, computeAccessibleUserIds, projectsRouter);
  app.use('/api/projects', requireAuth, computeAccessibleUserIds, projectsRouter);
}

// Groups (optional)
if (groupsRouter) {
  app.use('/groups',     requireAuth, computeAccessibleUserIds, groupsRouter);
  app.use('/api/groups', requireAuth, computeAccessibleUserIds, groupsRouter);
}

// Task Milestones (optional) — keep BEFORE main tasks router
if (taskMilestonesRouter) {
  app.use('/tasks',     requireAuth, taskMilestonesRouter);
  app.use('/api/tasks', requireAuth, taskMilestonesRouter);
}

// Tasks (optional, main tasks CRUD/visibility guards)
if (tasksRouter) {
  app.use('/tasks',     requireAuth, computeAccessibleUserIds, tasksRouter);
  app.use('/api/tasks', requireAuth, computeAccessibleUserIds, tasksRouter);
}

// Inspections (optional)
if (inspectionsRouter) {
  app.use('/inspections',     requireAuth, inspectionsRouter);
  app.use('/api/inspections', requireAuth, inspectionsRouter);
}

// Assets (optional)
if (assetsRouter) {
  app.use('/assets',     requireAuth, assetsRouter);
  app.use('/api/assets', requireAuth, assetsRouter);
}

// Vehicles (optional)
if (vehiclesRouter) {
  app.use('/vehicles',     requireAuth, computeAccessibleUserIds, vehiclesRouter);
  app.use('/api/vehicles', requireAuth, computeAccessibleUserIds, vehiclesRouter);
}

// Logbooks (optional)
if (logbookRouter) {
  app.use('/logbook',     requireAuth, logbookRouter);
  app.use('/api/logbook', requireAuth, logbookRouter);
}

// Vendors & Purchases (optional; now protected)
if (vendorsRouter) {
  app.use('/vendors',     requireAuth, vendorsRouter);
  app.use('/api/vendors', requireAuth, vendorsRouter);
}
if (purchasesRouter) {
  app.use('/purchases',     requireAuth, purchasesRouter);
  app.use('/api/purchases', requireAuth, purchasesRouter);
}

// Invoices (optional)
if (invoicesRouter) {
  app.use('/invoices',     requireAuth, invoicesRouter);
  app.use('/api/invoices', requireAuth, invoicesRouter);
}

// Documents (optional; router should handle doc-level ACL)
if (documentsRouter) {
  app.use('/documents',     requireAuth, documentsRouter);
  app.use('/api/documents', requireAuth, documentsRouter);
}

// Vehicle Trips (optional)
if (vehicleTripsRouter) {
  app.use('/',    requireAuth, computeAccessibleUserIds, vehicleTripsRouter);
  app.use('/api', requireAuth, computeAccessibleUserIds, vehicleTripsRouter);
}
if (vehicleTripAliases) {
  app.use('/',    requireAuth, computeAccessibleUserIds, vehicleTripAliases);
  app.use('/api', requireAuth, computeAccessibleUserIds, vehicleTripAliases);
}

/* ------------------------------- Org Routes ---------------------------- */
// Mount both base and /api for compatibility
app.use(orgRouter);
app.use('/api', orgRouter);

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
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/smartops';

async function waitForMongo(uri, options = {}, intervalMs = 2000) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await mongoose.connect(uri, { autoIndex: true, ...options });
      const c = mongoose.connection;
      console.log('[mongo] connected');
      if (c?.host && c?.name) {
        console.log(`[mongo] using ${c.host}:${c.port}/${c.name}`);
      }
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
  server = app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
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
