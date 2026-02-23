//  routes/project-manager-note.js
const express = require("express");
const mongoose = require("mongoose");
const { requireAuth } = require("../middleware/auth");
const Project = require("../models/Project");
const ProjectManagerNote = require("../models/ProjectManagerNote");

const router = express.Router({ mergeParams: true });

/* ----------------- helpers copied to stay self-contained ----------------- */
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
function allowRoles(...roles) {
  const allow = roles.map((r) => String(r).toLowerCase());
  return (req, res, next) => {
    const user = req.user || {};
    const role = String(user.role || user.claims?.role || "").toLowerCase();
    if (!allow.length) return next();
    if (!role) return res.sendStatus(401);
    if (!allow.includes(role)) return res.sendStatus(403);
    next();
  };
}
// If orgId is a valid ObjectId, scope by it; otherwise (e.g. "root") skip scoping
function orgScope(orgId) {
  if (!orgId) return {};
  const s = String(orgId);
  if (!mongoose.Types.ObjectId.isValid(s)) return {};
  return { orgId: new mongoose.Types.ObjectId(s) };
}

/* ----------------- param validator ----------------- */
router.use(requireAuth);
router.use("/:id*", (req, res, next) => {
  const pid = req.params.id;
  if (!isId(pid)) return res.status(400).json({ error: "bad project id" });
  next();
});

/* ----------------- ensure project belongs to org ----------------- */
async function ensureProject(req, res) {
  const proj = await Project.findOne({
    _id: req.params.id,
    ...orgScope(req.user?.orgId),
  }).lean();
  if (!proj) {
    res.status(404).json({ error: "Project not found" });
    return null;
  }
  return proj;
}

/* ----------------- GET /api/projects/:id/manager-notes ----------------- */
router.get("/:id/manager-notes", async (req, res) => {
  try {
    const proj = await ensureProject(req, res);
    if (!proj) return;

    const limit = Math.min(parseInt(req.query.limit || "200", 10) || 200, 500);
    const rows = await ProjectManagerNote.find({
      projectId: new mongoose.Types.ObjectId(req.params.id),
      ...orgScope(req.user?.orgId),
    })
      .sort({ at: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    res.json(rows);
  } catch (e) {
    console.error("GET /projects/:id/manager-notes error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ----------------- POST /api/projects/:id/manager-notes ----------------- */
/* Body: { status?: string, note: string, at?: ISODate } */
router.post(
  "/:id/manager-notes",
  allowRoles("manager", "admin", "superadmin"),
  async (req, res) => {
    try {
      const proj = await ensureProject(req, res);
      if (!proj) return;

      const b = req.body || {};
      const note = String(b.note || "").trim();
      if (!note) return res.status(400).json({ error: "note required" });

      const status = String(b.status || proj.status || "active");
      const at = b.at ? new Date(b.at) : new Date();

      const orgIdRaw = req.user?.orgId;
      const orgId = mongoose.Types.ObjectId.isValid(String(orgIdRaw))
        ? new mongoose.Types.ObjectId(String(orgIdRaw))
        : orgIdRaw;

      const doc = new ProjectManagerNote({
        orgId,
        projectId: new mongoose.Types.ObjectId(req.params.id),
        status,
        note,
        at,
        author: {
          userId: req.user?._id
            ? new mongoose.Types.ObjectId(String(req.user._id))
            : undefined,
          name: req.user?.name || undefined,
          email: req.user?.email || undefined,
        },
      });

      await doc.save();
      res.status(201).json(doc.toObject());
    } catch (e) {
      console.error("POST /projects/:id/manager-notes error:", e);
      res.status(500).json({ error: "Server error" });
    }
  },
);

/* ----------------- PATCH /api/projects/:id/manager-notes/:noteId ----------------- */
router.patch(
  "/:id/manager-notes/:noteId",
  allowRoles("manager", "admin", "superadmin"),
  async (req, res) => {
    try {
      const proj = await ensureProject(req, res);
      if (!proj) return;

      const { noteId } = req.params;
      if (!isId(noteId)) return res.status(400).json({ error: "bad note id" });

      const update = {};
      if (req.body?.note != null) update.note = String(req.body.note);
      if (req.body?.status != null) update.status = String(req.body.status);
      if (req.body?.at != null) update.at = new Date(req.body.at);

      const doc = await ProjectManagerNote.findOneAndUpdate(
        {
          _id: new mongoose.Types.ObjectId(noteId),
          projectId: new mongoose.Types.ObjectId(req.params.id),
          ...orgScope(req.user?.orgId),
        },
        { $set: update },
        { new: true },
      ).lean();

      if (!doc) return res.status(404).json({ error: "Note not found" });
      res.json(doc);
    } catch (e) {
      console.error("PATCH /projects/:id/manager-notes/:noteId error:", e);
      res.status(500).json({ error: "Server error" });
    }
  },
);

/* ----------------- DELETE /api/projects/:id/manager-notes/:noteId ----------------- */
router.delete(
  "/:id/manager-notes/:noteId",
  allowRoles("manager", "admin", "superadmin"),
  async (req, res) => {
    try {
      const proj = await ensureProject(req, res);
      if (!proj) return;

      const { noteId } = req.params;
      if (!isId(noteId)) return res.status(400).json({ error: "bad note id" });

      const del = await ProjectManagerNote.findOneAndDelete({
        _id: new mongoose.Types.ObjectId(noteId),
        projectId: new mongoose.Types.ObjectId(req.params.id),
        ...orgScope(req.user?.orgId),
      }).lean();

      if (!del) return res.status(404).json({ error: "Note not found" });
      res.sendStatus(204);
    } catch (e) {
      console.error("DELETE /projects/:id/manager-notes/:noteId error:", e);
      res.status(500).json({ error: "Server error" });
    }
  },
);

module.exports = router;
