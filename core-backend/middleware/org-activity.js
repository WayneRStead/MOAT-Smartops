// core-backend/middleware/org-activity.js
const Org = require('../models/Org');

/**
 * Lightweight middleware to "touch" an org's lastActiveAt timestamp
 * whenever an org-scoped authed route is hit.
 *
 * - Uses in-memory throttling so we don't spam Mongo on every request.
 * - Safe to include in the chain after resolveOrgContext + requireOrg.
 */

const lastTouchByOrg = new Map();
// minimum interval between writes per org (ms)
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

module.exports = function touchOrgActivity(req, _res, next) {
  try {
    const orgId = req.orgId || req.org?._id;
    if (!orgId) return next(); // no org in context, nothing to do

    const key = String(orgId);
    const now = Date.now();
    const last = lastTouchByOrg.get(key) || 0;

    // Throttle writes per org
    if (now - last < MIN_INTERVAL_MS) {
      return next();
    }

    lastTouchByOrg.set(key, now);

    // Fire-and-forget: don't block the request
    Org.updateOne(
      { _id: orgId },
      { $set: { lastActiveAt: new Date(now) } }
    ).catch((err) => {
      console.warn('[org-activity] failed to update lastActiveAt for org', key, err?.message || err);
    });

    return next();
  } catch (err) {
    console.warn('[org-activity] unexpected error:', err?.message || err);
    return next();
  }
};
