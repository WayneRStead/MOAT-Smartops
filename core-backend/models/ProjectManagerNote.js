const mongoose = require("mongoose");

const AuthorSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    name: String,
    email: String,
  },
  { _id: false }
);

const ProjectManagerNoteSchema = new mongoose.Schema(
  {
    orgId:     { type: mongoose.Schema.Types.ObjectId, ref: "Org", index: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true, index: true },

    status:    { type: String, default: "active" }, // free string; UI maps to active/paused/closed
    note:      { type: String, required: true },

    at:        { type: Date, default: Date.now },   // when the note applies (not just createdAt)
    author:    { type: AuthorSchema, default: undefined },
  },
  { timestamps: true }
);

// Helpful compound indexes
ProjectManagerNoteSchema.index({ orgId: 1, projectId: 1, at: -1 });
ProjectManagerNoteSchema.index({ orgId: 1, "author.userId": 1, at: -1 });

module.exports =
  mongoose.models.ProjectManagerNote ||
  mongoose.model("ProjectManagerNote", ProjectManagerNoteSchema);
