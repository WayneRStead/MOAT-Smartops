// core-backend/middleware/features.js
module.exports.requireFeature = (key) => (req, res, next) => {
  try {
    // If you attach org to req earlier, prefer that:
    const org = req.org || req.user?.org || req.orgFromDb;

    // Default behavior: if no org or no features map, allow (don’t break existing setups)
    const enabled = !org?.features || org.features[key] !== false;
    if (!enabled) return res.status(403).json({ error: 'Feature disabled' });

    next();
  } catch (e) {
    console.error('requireFeature error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
