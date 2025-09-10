const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const Org = require('../models/Org');

const router = express.Router();

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

// ---------- GET ----------
router.get('/', requireAuth, async (_req, res) => {
  const org = await getOrCreateOrg();
  res.json(org);
});

// ---------- PUT ----------
router.put('/', requireAuth, async (req, res) => {
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
    // Build from the model’s schema keys to ensure new keys like 'tasks' are present
    const schemaKeys = Object.keys(Org.schema.path('modules').schema.paths); // ['projects','users',...,'tasks']
    let nextObj = {};

    if (Array.isArray(modules)) {
      const set = new Set(modules.map(String));
      schemaKeys.forEach(k => { nextObj[k] = set.has(k); });
    } else if (typeof modules === 'object') {
      schemaKeys.forEach(k => { nextObj[k] = !!modules[k]; });
    }

    // Only assign if we built something
    if (Object.keys(nextObj).length) {
      org.modules = nextObj;
    }
  }

  await org.save();
  res.json(org);
});

// ---------- POST /logo ----------
router.post('/logo', requireAuth, (req, res, next) => {
  uploadEither(req, res, async (err) => {
    if (err) return next(err);
    try {
      const file = (req.files?.file && req.files.file[0]) || (req.files?.logo && req.files.logo[0]);
      if (!file) return res.status(400).json({ error: 'file required' });

      const org = await getOrCreateOrg();
      const relUrl = `/files/org/${path.basename(file.path)}`;
      org.logoUrl = relUrl;
      await org.save();
      res.json(org);
    } catch (e) {
      next(e);
    }
  });
});

module.exports = router;
