// core-backend/index.js
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

// Auth middleware (must attach req.user = { _id, orgId, role, sub?, email? })
const { requireAuth } = require('./middleware/auth');

// Visibility helper middleware (from our drop-ins)
const { computeAccessibleUserIds } = require('./middleware/access');

// Routers
const clockingsRouter = require('./routes/clockings');
// If you’ve added these from the drop-ins:
let groupsRouter, tasksRouter;
try { groupsRouter = require('./routes/groups'); } catch (_) { /* optional */ }
try { tasksRouter = require('./routes/tasks'); } catch (_) { /* optional */ }

const app = express();

/* ---------------------------- App Middleware --------------------------- */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

/* ------------------------------- Database ------------------------------ */
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/smartops';

mongoose
  .connect(MONGO_URI, {
    // keep defaults simple; tune as needed
    autoIndex: true,
  })
  .then(() => {
    console.log('[mongo] connected');
  })
  .catch((err) => {
    console.error('[mongo] connection error:', err);
    process.exit(1);
  });

/* -------------------------------- Health -------------------------------- */
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* --------------------------- Protected Routers -------------------------- */
/**
 * Important:
 * We layer `requireAuth` BEFORE `computeAccessibleUserIds`.
 * `computeAccessibleUserIds` needs `req.user` (orgId, role, _id).
 *
 * Even if a sub-router also calls `requireAuth` internally
 * (e.g. routes/clockings.js), leaving it here is harmless and ensures
 * visibility state is computed for listing endpoints that rely on it.
 */

// Clockings (uses visibility in your current file)
app.use('/clockings', requireAuth, computeAccessibleUserIds, clockingsRouter);

// Groups (CRUD + membership) — optional if not created yet
if (groupsRouter) {
  app.use('/groups', requireAuth, computeAccessibleUserIds, groupsRouter);
}

// Tasks (visibility guards) — optional if not created yet
if (tasksRouter) {
  app.use('/tasks', requireAuth, computeAccessibleUserIds, tasksRouter);
}

/* ------------------------------ Not Found ------------------------------ */
app.use((req, res, next) => {
  res.status(404).json({ error: 'Not Found' });
});

/* --------------------------- Error Handler JSON ------------------------- */
app.use((err, req, res, _next) => {
  console.error('[error]', err);

  // Common Mongoose errors
  if (err.name === 'CastError') {
    return res.status(400).json({ error: 'Invalid ID format' });
  }
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message });
  }

  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

/* --------------------------------- Start -------------------------------- */
const PORT = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
