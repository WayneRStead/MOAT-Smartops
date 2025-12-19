// core-backend/models/InspectionSubmission.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

// Treat "", null, undefined as "not set" so Mongoose won't try to cast to ObjectId.
function emptyToUndefined(v) {
  if (v === '' || v === null || v === undefined) return undefined;
  return v;
}

/* ----------------------------- Evidence ----------------------------- */
const EvidenceSchema = new Schema(
  {
    photoUrl: String, // optional upload pipeline
    scanRef: String,  // asset id / QR / NFC
    note: String,
  },
  { _id: false }
);

/* ----------------------------- Item Result ----------------------------- */
const ItemResultSchema = new Schema(
  {
    itemId: { type: Schema.Types.ObjectId, required: true },
    label: String, // denormalized for easy reading
    result: { type: String, enum: ['pass', 'na', 'fail'], required: true },
    evidence: { type: EvidenceSchema, default: undefined },
    correctiveAction: String,
    criticalTriggered: { type: Boolean, default: false },
  },
  { _id: false }
);

/* ----------------------------- Links (project/task/milestone) ----------------------------- */
const LinkSchema = new Schema(
  {
    // IMPORTANT: setters prevent "" from casting to ObjectId
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', set: emptyToUndefined, default: undefined },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', set: emptyToUndefined, default: undefined },
    milestoneId: { type: Schema.Types.ObjectId, ref: 'TaskMilestone', set: emptyToUndefined, default: undefined }, // consistent with forms
  },
  { _id: false }
);

/* ----------------------------- Subject at run ----------------------------- */
const SubjectAtRunSchema = new Schema(
  {
    // none | vehicle | asset | performance
    type: { type: String, enum: ['none', 'vehicle', 'asset', 'performance'], default: 'none' },
    // chosen subject id (ObjectId or string), left generic on purpose
    id: { type: Schema.Types.Mixed, set: emptyToUndefined, default: undefined },
    // denormalized friendly label for the chosen subject
    label: { type: String, default: '' },
  },
  { _id: false }
);

/* ----------------------------- Signoff ----------------------------- */
const SignoffSchema = new Schema(
  {
    confirmed: { type: Boolean, required: true },
    name: { type: String, required: true }, // captured from user details
    date: { type: Date, required: true },
    signatureDataUrl: { type: String }, // canvas data URL
  },
  { _id: false }
);

/* ----------------------------- Comments (legacy) ----------------------------- */
const LegacyCommentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    name: String,
    comment: String,
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/* ----------------------------- Manager Comments (new) ----------------------------- */
const ManagerCommentSchema = new Schema(
  {
    comment: { type: String, required: true },
    at: { type: Date, default: Date.now },
    by: {
      _id: { type: Schema.Types.ObjectId, ref: 'User' },
      name: String,
      role: String,
      email: String,
    },
  },
  { _id: false }
);

/* ----------------------------- Scoring summary (optional) ----------------------------- */
const ScoringSummarySchema = new Schema(
  {
    mode: { type: String, enum: ['any-fail', 'tolerance', 'percent'], default: 'any-fail' },
    percentScore: { type: Number, min: 0, max: 100 }, // when mode='percent'
    counts: {
      total: { type: Number, default: 0 },
      considered: { type: Number, default: 0 }, // non-NA
      pass: { type: Number, default: 0 },
      fail: { type: Number, default: 0 },
      na: { type: Number, default: 0 },
      criticalFails: { type: Number, default: 0 },
      nonCriticalFails: { type: Number, default: 0 },
    },
  },
  { _id: false }
);

/* ----------------------------- Geo (for KMZ/exports) ----------------------------- */
// Store as GeoJSON Point [lng, lat]; 2dsphere index below.
const GeoPointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: {
      type: [Number], // [lng, lat]
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length === 2 && arr.every((n) => Number.isFinite(n)),
        message: 'coordinates must be [lng, lat]',
      },
      default: undefined,
    },
  },
  { _id: false }
);

const LocationMetaSchema = new Schema(
  {
    capturedAt: { type: Date },
    source: { type: String }, // 'body' | 'header' | 'server'
    accuracy: { type: Number }, // meters, if supplied
    altitude: { type: Number }, // if supplied
  },
  { _id: false }
);

/* ----------------------------- Submission ----------------------------- */
const InspectionSubmissionSchema = new Schema(
  {
    // multi-tenant guard (routes apply org filter)
    orgId: { type: Schema.Types.ObjectId, index: true },

    formId: { type: Schema.Types.ObjectId, ref: 'InspectionForm', required: true },
    formTitle: String, // denormalized
    formType: { type: String, enum: ['standard', 'signoff'], default: 'standard' },

    // what the form's scope was at run time
    scopeAtRun: { type: String, enum: ['global', 'scoped'], default: 'global' },

    // links chosen at run (if global) or inherited (if scoped)
    links: { type: LinkSchema, default: () => ({}) },

    // optional subject selection at run (vehicle/asset/performance)
    subjectAtRun: { type: SubjectAtRunSchema, default: () => ({ type: 'none' }) },

    // If performance subject: who is being assessed (indexed for KPI)
    assessedUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },

    // Geo capture
    location: { type: GeoPointSchema, index: '2dsphere', default: undefined },
    locationMeta: { type: LocationMetaSchema, default: undefined },

    // results
    items: { type: [ItemResultSchema], default: [] },
    overallResult: { type: String, enum: ['pass', 'fail'], required: true },

    // optional scoring summary (filled when tolerance/percent modes used)
    scoringSummary: { type: ScoringSummarySchema, default: undefined },

    followUpDate: Date, // optional planned follow-up (often on fail)

    // Router currently sets runBy._id; keep userId for backward compatibility.
    runBy: {
      _id: { type: Schema.Types.ObjectId, ref: 'User' },
      userId: { type: Schema.Types.ObjectId, ref: 'User' }, // legacy
      name: String,
      email: String,
    },

    signoff: { type: SignoffSchema, required: true },

    // NEW preferred field for manager notes
    managerComments: { type: [ManagerCommentSchema], default: undefined },

    // Legacy field (kept for backward compatibility / previously saved data)
    comments: { type: [LegacyCommentSchema], default: undefined },

    // Soft delete support for submissions
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Helpful indexes
InspectionSubmissionSchema.index({ formTitle: 1, createdAt: -1 });
InspectionSubmissionSchema.index({ 'links.projectId': 1, createdAt: -1 });
InspectionSubmissionSchema.index({ 'links.taskId': 1, createdAt: -1 });
InspectionSubmissionSchema.index({ 'links.milestoneId': 1, createdAt: -1 });
InspectionSubmissionSchema.index({ 'subjectAtRun.type': 1, 'subjectAtRun.id': 1, createdAt: -1 });
InspectionSubmissionSchema.index({ assessedUserId: 1, createdAt: -1 });
InspectionSubmissionSchema.index({ isDeleted: 1, createdAt: -1 });

/* ----------------------------- Pre-validate cleanup ----------------------------- */
InspectionSubmissionSchema.pre('validate', function (next) {
  try {
    // Normalize link ids (prevent casting "" to ObjectId)
    if (this.links) {
      this.links.projectId = emptyToUndefined(this.links.projectId);
      this.links.taskId = emptyToUndefined(this.links.taskId);
      this.links.milestoneId = emptyToUndefined(this.links.milestoneId);
    }

    // Subject defaults
    if (!this.subjectAtRun) this.subjectAtRun = { type: 'none' };
    const validSubject = ['none', 'vehicle', 'asset', 'performance'];
    if (!validSubject.includes(this.subjectAtRun.type)) this.subjectAtRun.type = 'none';
    if (this.subjectAtRun.type === 'none') {
      this.subjectAtRun.id = undefined;
      this.subjectAtRun.label = '';
      this.assessedUserId = undefined;
    } else {
      this.subjectAtRun.id = emptyToUndefined(this.subjectAtRun.id);
      if (typeof this.subjectAtRun.label !== 'string') this.subjectAtRun.label = '';
      // If performance, mirror to assessedUserId when possible
      if (this.subjectAtRun.type === 'performance' && !this.assessedUserId && this.subjectAtRun.id) {
        // attempt cast to ObjectId; if invalid, it will be validated in route
        if (mongoose.Types.ObjectId.isValid(String(this.subjectAtRun.id))) {
          this.assessedUserId = new mongoose.Types.ObjectId(String(this.subjectAtRun.id));
        }
      }
    }

    // Ensure items array
    if (!Array.isArray(this.items)) this.items = [];

    // runBy compatibility: prefer _id, fall back to userId if present
    if (!this.runBy) this.runBy = {};
    if (!this.runBy._id && this.runBy.userId) this.runBy._id = this.runBy.userId;

    // location sanity: coordinates must be [lng, lat] finite numbers or undefined
    if (this.location && Array.isArray(this.location.coordinates)) {
      const [lng, lat] = this.location.coordinates;
      const ok = Number.isFinite(lng) && Number.isFinite(lat);
      if (!ok) {
        this.location = undefined;
      }
    }

    next();
  } catch (e) {
    next(e);
  }
});

module.exports =
  mongoose.models.InspectionSubmission ||
  mongoose.model('InspectionSubmission', InspectionSubmissionSchema);
