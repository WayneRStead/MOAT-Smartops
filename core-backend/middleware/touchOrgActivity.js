// core-backend/middleware/touchOrgActivity.js
const Org = require('../models/Org');

module.exports = async function touchOrgActivity(req, _res, next) {
  try {
    if (req.orgId) {
      await Org.findByIdAndUpdate(
        req.orgId,
        { $set: { lastActiveAt: new Date() } },
        { lean: true }
      );
    }
  } catch (e) {
    console.error('[touchOrgActivity] failed:', e);
  }
  next();
};
