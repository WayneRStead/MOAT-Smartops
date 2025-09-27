// core-backend/routes/org.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const Org = require('../models/Org');

const router = express.Router();

/**
 * We support BOTH:
 *  - absolute paths: /org, /organization, /orgs/me (works if you mount with app.use(orgRouter))
 *  - relative root:  /  (works if you mount with app.use('/org', orgRouter))
 * And for logo upload: /logo and /org/logo
 */

// ---------- uploads setup ----------
const uploadsRoot = path.join(__dirname, '..', 'uploads');
const orgDir = path.join(uploadsRoot, 'org');
fs.mkdirSync(orgDir, { recursive: true });

function cleanFilename(name) {
  return String(name || '').replace(/[^\w.\-]+/g, '_').slice(0, 120);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, orgDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}_${cleanFilename(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadEither = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'logo', maxCount: 1 }]);

async function getOrCreateOrg() {
  let org = await Org.findOne();
  if (!org) org = await Org.create({});
  return org;
}

// Helper to send org with sensible defaults (prevents frontend crashes)
function presentOrg(org) {
  // keep raw fields, but ensure theme fallbacks for the UI
  const themeMode = org.themeMode || org?.theme?.mode || 'light';
  const accentColor = org.accentColor || org?.theme?.color || process.env.ORG_THEME_COLOR || '#2E86DE';
  return {
    ...org.toObject?.() ?? org,
    themeMode,
    accentColor,
  };
}

// ---------- GET ----------
const GET_PATHS = ['/', '/org', '/organization', '/orgs/me'];
router.get(GET_PATHS, requireAuth, async (_req, res, next) => {
  try {
    const org = await getOrCreateOrg();
    res.json(presentOrg(org));
  } catch (e) {
    next(e);
  }
});

// ---------- PUT ----------
const PUT_PATHS = ['/', '/org'];
router.put(PUT_PATHS, requireAuth, async (req, res, next) => {
  try {
    const { name, themeMode, accentColor, modules } = req.body || {};
    const org = await getOrCreateOrg();

    if (name != null) org.name = String(name).trim();
    if (themeMode) org.themeMode = themeMode;
    if (accentColor) org.accentColor = accentColor;

    // keep legacy theme in sync
    org.theme = org.theme || {};
    org.theme.mode = org.themeMode;
    org.theme.color = org.accentColor;

    // normalize modules: accept array OR object; produce full object incl. 'tasks'
    if (modules != null) {
      const schema = Org.schema.path('modules');
      if (schema && schema.schema && schema.schema.paths) {
        const schemaKeys = Object.keys(schema.schema.paths); // e.g. ['projects','users',...,'tasks']
        let nextObj = {};

        if (Array.isArray(modules)) {
          const set = new Set(modules.map(String));
          schemaKeys.forEach((k) => { nextObj[k] = set.has(k); });
        } else if (typeof modules === 'object') {
          schemaKeys.forEach((k) => { nextObj[k] = !!modules[k]; });
        }

        if (Object.keys(nextObj).length) {
          org.modules = nextObj;
        }
      }
    }

    await org.save();
    res.json(presentOrg(org));
  } catch (e) {
    next(e);
  }
});

// ---------- POST /logo ----------
const LOGO_PATHS = ['/logo', '/org/logo'];
router.post(LOGO_PATHS, requireAuth, (req, res, next) => {
  uploadEither(req, res, async (err) => {
    if (err) return next(err);
    try {
      const file = (req.files?.file && req.files.file[0]) || (req.files?.logo && req.files.logo[0]);
      if (!file) return res.status(400).json({ error: 'file required' });

      const org = await getOrCreateOrg();
      const relUrl = `/files/org/${path.basename(file.path)}`;
      org.logoUrl = relUrl;
      await org.save();
      res.json(presentOrg(org));
    } catch (e) {
      next(e);
    }
  });
});

module.exports = router;
