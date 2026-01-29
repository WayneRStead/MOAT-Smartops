// core-backend/routes/mobileDefinitions.js
const express = require("express");
const router = express.Router();

// Import model-exported constants where available
// (Task/Project enums are inside schema; we hardcode from your pasted schemas)
let CLOCK_TYPES = null;
try {
  // Clocking.js exports CLOCK_TYPES as module.exports.CLOCK_TYPES
  // eslint-disable-next-line global-require
  CLOCK_TYPES = require("../models/Clocking").CLOCK_TYPES;
} catch {
  CLOCK_TYPES = null;
}

router.get("/definitions", async (_req, res) => {
  // Everything below is based directly on the schemas you pasted
  // We keep it explicit and stable so mobile can cache it offline.

  const definitions = {
    version: 1,
    updatedAt: new Date().toISOString(),

    project: {
      status: ["active", "paused", "closed"],
      geoMode: ["off", "circle", "polygon", "kml"],
      planning: {
        itemStatus: ["planned", "active", "done"],
        priority: ["low", "medium", "high", "urgent"],
      },
    },

    task: {
      status: [
        "pending",
        "in-progress",
        "paused",
        "paused-problem",
        "completed",
      ],
      priority: ["low", "medium", "high", "urgent"],
      visibilityMode: [
        "org",
        "assignees",
        "groups",
        "assignees+groups",
        "restricted",
        "admins",
      ],
      geoMode: ["off", "circle", "polygon", "kml"],
      // legacy embedded milestone enum inside Task.milestones (NOT TaskMilestone docs)
      embeddedMilestoneStatus: ["open", "done"],
    },

    taskMilestone: {
      status: ["pending", "started", "paused", "paused - problem", "finished"],
      kind: ["milestone", "deliverable", "reporting"],
    },

    clocking: {
      // Clocking schema does NOT enforce enum, but UI should
      types: CLOCK_TYPES || [
        "present",
        "in",
        "out",
        "training",
        "sick",
        "leave",
        "iod",
        "overtime",
      ],
    },

    inspectionSubmission: {
      formType: ["standard", "signoff"],
      scopeAtRun: ["global", "scoped"],
      subjectType: ["none", "vehicle", "asset", "performance"],
      itemResult: ["pass", "na", "fail"],
      overallResult: ["pass", "fail"],
      scoringMode: ["any-fail", "tolerance", "percent"],
    },

    vehicle: {
      status: ["active", "workshop", "retired", "stolen"],
      reminderKind: ["date", "odometer"],
    },

    vehicleTrip: {
      status: ["open", "closed", "cancelled"],
      purpose: ["Business", "Private"],
    },

    purchase: {
      // Purchase.type is free text, so provide a UI list
      types: [
        "service",
        "repair",
        "tyres",
        "parts",
        "fuel",
        "toll",
        "registration",
        "other",
      ],
    },

    asset: {
      status: ["active", "maintenance", "retired", "lost", "stolen"],
    },

    document: {
      // schema is flexible; we provide a UI dropdown list
      linkModules: [
        "project",
        "inspection",
        "asset",
        "vehicle",
        "user",
        "task",
        "clocking",
      ],
    },
  };

  res.json({ ok: true, definitions });
});

module.exports = router;
