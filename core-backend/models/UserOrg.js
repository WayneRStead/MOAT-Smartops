const mongoose = require("mongoose");
const UserOrgSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
  roles: { type: [String], default: ["user"] }, // 'owner','admin','user',...
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  invitedAt: Date,
}, { timestamps: true });
UserOrgSchema.index({ userId: 1, orgId: 1 }, { unique: true });
module.exports = mongoose.model("UserOrg", UserOrgSchema);
