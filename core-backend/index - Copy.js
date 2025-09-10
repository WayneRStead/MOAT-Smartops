// core-backend/index.js
require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');

const app = express();

/* ------------------------------------------------------------------ */
/*               Storage roots (new) + legacy fallbacks                */
/* ------------------------------------------------------------------ */
const DATA_DIR       = process.env.DATA_DIR
  || path.resolve(__dirname, '..', 'data');                 // e.g. C:\MOAT-Smartops\data
const UPLOADS_DIR    = process.env.UPLOADS_DIR
  || path.join(DATA_DIR, 'uploads');                        // e.g. ...\data\uploads
const DOCUMENTS_DIR  = process.env.DOCUMENTS_DIR
  || path.join(DATA_DIR, 'documents');                      // e.g. ...\data\documents

// Legacy, in-repo locations (files may still be here)
const LEGACY_UPLOADS_DIR   = path.resolve(__dirname, 'uploads');           // core-backend/uploads
const LEGACY_DOCUMENTS_DIR = path.resolve(__dirname, 'documents');         // core-backend/documents
const LEGACY_UPLOADS_DOCS  = path.join(LEGACY_UPLOADS_DIR, 'docs');        // core-backend/uploads/docs

;[DATA_DIR, UPLOADS_DIR, DOCUMENTS_DIR].forEach((d) => {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
});

// Expose for routes that read from env
process.env.DATA_DIR      = DATA_DIR;
process.env.UPLOADS_DIR   = UPLOADS_DIR;
process.env.DOCUMENTS_DIR = DOCUMENTS_DIR;

/* ------------------------- Basics & Middleware ------------------------- */

if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

// CORS: allow dev frontends + credentials
const ORIGINS = (process.env.ORIGIN || process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin || ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Accept',
    'Origin',
    'X-Requested-With',
    'Cache-Control',
    'Pragma'
  ],
  exposedHeaders: ['Content-Disposition'],
  maxAge: 86400,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* ------------------------------ Health ------------------------------- */

app.get('/', (_req, res) => res.send('MOAT-SmartOps backend is running 🚀'));
app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    time: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    version: process.env.GIT_SHA || undefined,
    dataDirs: {
      data: DATA_DIR,
      uploads: UPLOADS_DIR,
      documents: DOCUMENTS_DIR,
      legacyUploads: LEGACY_UPLOADS_DIR,
      legacyDocuments: LEGACY_DOCUMENTS_DIR,
    },
  })
);

/* ---------------------- Static serving (layered) --------------------- */
/**
 * We layer static mounts so:
 *  - new paths resolve first (…/data/*),
 *  - then legacy in-repo folders act as a fallback.
 * Express will fall through to the next static() when a file isn’t found.
 *
 * Key mappings we must support (old UIs still generate them):
 *   /files/tasks/<name>                       (task attachments)
 *   /files/<anything-else>                    (generic uploads)
 *   /files/docs/<docId>/<ts>/<filename>       (legacy Vault preview)
 *   /documents/<docId>/...   OR /documents/docs/<docId>/...  (new/old)
 *   /vault/...                                 (alias to documents)
 */

// /files -> uploads (new first, then legacy)
app.use('/files', express.static(UPLOADS_DIR, { fallthrough: true }));
app.use('/files', express.static(LEGACY_UPLOADS_DIR, { fallthrough: true }));

// Make sure /files/tasks works even if some files are under legacy structures
app.use('/files/tasks', express.static(path.join(UPLOADS_DIR, 'tasks'), { fallthrough: true }));
app.use('/files/tasks', express.static(path.join(LEGACY_UPLOADS_DIR, 'tasks'), { fallthrough: true }));

// Legacy Vault path: /files/docs/... actually lives under a "docs" subfolder
app.use('/files/docs', express.static(path.join(DOCUMENTS_DIR, 'docs'), { fallthrough: true }));
app.use('/files/docs', express.static(LEGACY_UPLOADS_DOCS, { fallthrough: true })); // some older builds saved here
app.use('/files/docs', express.static(path.join(LEGACY_DOCUMENTS_DIR, 'docs'), { fallthrough: true }));

// New Vault mounts: try DOCUMENTS_DIR/docs first (common), then DOCUMENTS_DIR root, then legacy
app.use('/documents', express.static(path.join(DOCUMENTS_DIR, 'docs'), { fallthrough: true }));
app.use('/documents', express.static(DOCUMENTS_DIR, { fallthrough: true }));
app.use('/documents', express.static(path.join(LEGACY_DOCUMENTS_DIR, 'docs'), { fallthrough: true }));
app.use('/documents', express.static(LEGACY_DOCUMENTS_DIR, { fallthrough: true }));

// Alias /vault to the same layered document mounts
app.use('/vault', express.static(path.join(DOCUMENTS_DIR, 'docs'), { fallthrough: true }));
app.use('/vault', express.static(DOCUMENTS_DIR, { fallthrough: true }));
app.use('/vault', express.static(path.join(LEGACY_DOCUMENTS_DIR, 'docs'), { fallthrough: true }));
app.use('/vault', express.static(LEGACY_DOCUMENTS_DIR, { fallthrough: true }));

/* ------------------------------- Routes ------------------------------ */
function safeRequire(p) {
  try { return require(p); }
  catch (e) { console.warn(`⚠️  Optional route "${p}" not loaded: ${e?.message || e}`); return null; }
}

const authRoute              = require('./routes/auth');
const authUserRoute          = require('./routes/auth-user');
const accountRoute           = require('./routes/account');
const orgRoute               = require('./routes/org');
const usersRoute             = require('./routes/users');
const usersBulkRoute         = require('./routes/users-bulk');
const projectsRoute          = require('./routes/projects');
const clockingsRoute         = require('./routes/clockings');
const inspectionsRoute       = require('./routes/inspections');
const assetsRoute            = require('./routes/assets');
const vehiclesRoute          = require('./routes/vehicles');
const vehicleRemindersRoute  = require('./routes/vehicle-reminders');
const logbookRoute           = require('./routes/logbook');
const invoicesRoute          = require('./routes/invoices');
const uploadsRoute           = require('./routes/uploads');
const billingRoute           = require('./routes/billing');
const billingConfigRoute     = require('./routes/billing-config');
const documentsRoute         = require('./routes/documents');
const debugRoute             = require('./routes/debug');
const tasksRoute             = require('./routes/tasks');
const taskFencesRoute        = require('./routes/task-fences'); // mount before tasks
const timeRoute              = safeRequire('./routes/time');

// Auth first
app.use('/api', authRoute);
app.use('/api', authUserRoute);

// Account & org
app.use('/api/account', accountRoute);
app.use('/api/org',     orgRoute);

// Users (+bulk)
app.use('/api/users', usersRoute);
app.use('/api/users', usersBulkRoute);

// Time (optional)
if (timeRoute) app.use('/api/time', timeRoute);

// Core modules
app.use('/api/projects',    projectsRoute);
app.use('/api/clockings',   clockingsRoute);
app.use('/api/inspections', inspectionsRoute);
app.use('/api/assets',      assetsRoute);
app.use('/api/vehicles',    vehiclesRoute);
app.use('/api/vehicles',    vehicleRemindersRoute);
app.use('/api/logbook',     logbookRoute);
app.use('/api/invoices',    invoicesRoute);
app.use('/api/uploads',     uploadsRoute);
app.use('/api/billing',     billingRoute);
app.use('/api/system/billing-config', billingConfigRoute);
app.use('/api/documents',   documentsRoute);

// Geofences first, then general tasks
app.use('/api/tasks', taskFencesRoute);
app.use('/api/tasks', tasksRoute);

// Debug last
app.use('/api/debug', debugRoute);

/* ---------------------------- MongoDB ------------------------------- */

const enc = encodeURIComponent;
const MONGO_USER = process.env.MONGO_USER ? enc(process.env.MONGO_USER) : '';
const MONGO_PASS = process.env.MONGO_PASS ? enc(process.env.MONGO_PASS) : '';
const MONGO_HOST = process.env.MONGO_HOST;
const MONGO_DB   = process.env.MONGO_DB;

const MONGO_URI =
  process.env.MONGO_URI ||
  (MONGO_HOST && MONGO_DB
    ? `mongodb+srv://${MONGO_USER}:${MONGO_PASS}@${MONGO_HOST}/${MONGO_DB}?retryWrites=true&w=majority`
    : 'mongodb://127.0.0.1:27017/moat');

if (!process.env.MONGO_URI && (!MONGO_HOST || !MONGO_DB)) {
  console.warn('⚠️  MONGO_HOST or MONGO_DB not set; using local fallback:', MONGO_URI);
}

mongoose.set('strictQuery', false);

mongoose
  .connect(MONGO_URI, { autoIndex: true })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err?.message || err);
    process.exitCode = 1;
  });

/* --------------------- 404 & Error Handlers ------------------------- */

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Server error' });
});

/* --------------------------- Start Server --------------------------- */

const PORT = Number(process.env.PORT) || 5000;
const server = app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log('📁 Data dir:        ', DATA_DIR);
  console.log('📁 Uploads dir:     ', UPLOADS_DIR);
  console.log('📁 Documents dir:   ', DOCUMENTS_DIR);
  console.log('📁 Legacy uploads:  ', LEGACY_UPLOADS_DIR);
  console.log('📁 Legacy documents:', LEGACY_DOCUMENTS_DIR);
  console.log(`🌐 /files  -> ${UPLOADS_DIR} (then ${LEGACY_UPLOADS_DIR})`);
  console.log(`🌐 /files/tasks -> ${path.join(UPLOADS_DIR,'tasks')} (then ${path.join(LEGACY_UPLOADS_DIR,'tasks')})`);
  console.log(`🌐 /files/docs -> ${path.join(DOCUMENTS_DIR,'docs')} (then ${LEGACY_UPLOADS_DOCS})`);
  console.log(`🌐 /documents -> ${path.join(DOCUMENTS_DIR,'docs')} (fallback ${DOCUMENTS_DIR} & legacy)`);
  console.log(`🌐 /vault -> same as /documents (layered)`);
});

// Graceful shutdown
function shutdown(sig) {
  console.log(`\n${sig} received. Shutting down...`);
  server.close(() => {
    mongoose.connection.close(false, () => {
      console.log('🧹 Closed out remaining connections. Bye!');
      process.exit(0);
    });
  });
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED REJECTION:', e);
});
