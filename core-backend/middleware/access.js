// core-backend/middleware/access.js
const mongoose = require("mongoose");

let _Group, _User;
try { _Group = mongoose.models.Group || require("../models/Group"); } catch {}
try { _User  = mongoose.models.User  || require("../models/User"); }  catch {}

function asOid(x) {
  const s = String(x || "");
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * Build an org read-scope that:
 *  - returns {} (no filter) for "root" (cross-org read)
 *  - matches the model's orgId type (ObjectId vs String)
 */
function orgScope(model, orgId, { allowRootCrossOrg = true } = {}) {
  if (!model?.schema?.path("orgId")) return {};
  const p = model.schema.path("orgId");
  const wantsObjectId = p.instance === "ObjectId";

  const s = String(orgId || "");
  if (!s) return {};
  if (allowRootCrossOrg && s.toLowerCase() === "root") return {};

  if (wantsObjectId) {
    return mongoose.Types.ObjectId.isValid(s) ? { orgId: new mongoose.Types.ObjectId(s) } : {};
  }
  return { orgId: s };
}

/**
 * Populates:
 *  - req.accessibleUserIds: set of user ids the requester can "see"
 *  - req.myGroupIds: groups where requester is a member or leader
 *  - req.myLeaderGroupIds: groups where requester is the leader
 *
 * Behavior:
 *  - Admin/superadmin: sees all users in (scoped) org
 *  - Non-admin: sees themself + members of groups they belong to or lead
 *    (If you want "members see only themselves", see the commented block)
 */
async function computeAccessibleUserIds(req, res, next) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const role = String(user.role || "").toLowerCase();
    const isAdmin = role === "admin" || role === "superadmin";

    // Admins: all users in org (or cross-org for root) if Users model is present
    if (isAdmin && _User) {
      const scope = orgScope(_User, user.orgId);
      const users = await _User.find({ ...scope, isDeleted: { $ne: true } })
        .select("_id")
        .lean();
      req.accessibleUserIds = users.map((u) => u._id);
      req.myGroupIds = [];
      req.myLeaderGroupIds = [];
      return next();
    }

    // Non-admin path
    const myOid = asOid(user._id) || asOid(user.id) || asOid(user.sub) || asOid(user.userId);
    const selfOnlySet = new Set([String(myOid || user._id || user.id || user.sub || user.userId || "")]);

    if (!_Group) {
      // Fallback if Group model isn't loaded
      req.accessibleUserIds = Array.from(selfOnlySet);
      req.myGroupIds = [];
      req.myLeaderGroupIds = [];
      return next();
    }

    const scope = orgScope(_Group, user.orgId); // "root" => {}

    // Groups where requester is a MEMBER
    const memberGroups = await _Group.find({
      ...scope,
      active: { $ne: false },
      memberIds: myOid, // array contains me
    })
      .select("_id memberIds leaderId")
      .lean();

    // Groups where requester is the LEADER
    const leaderGroups = await _Group.find({
      ...scope,
      active: { $ne: false },
      leaderId: myOid,
    })
      .select("_id memberIds leaderId")
      .lean();

    const visibleUserIdSet = new Set(selfOnlySet);
    const myGroupIds = [];
    const myLeaderGroupIds = [];

    // From groups I belong to as member
    for (const g of memberGroups) {
      myGroupIds.push(g._id);
      // Usually you may want members to at least see their leader too:
      if (g.leaderId) visibleUserIdSet.add(String(g.leaderId));
      for (const uid of g.memberIds || []) visibleUserIdSet.add(String(uid));
    }

    // From groups I lead
    for (const g of leaderGroups) {
      myLeaderGroupIds.push(g._id);
      myGroupIds.push(g._id); // leaders also count as "in" the group
      if (g.leaderId) visibleUserIdSet.add(String(g.leaderId));
      for (const uid of g.memberIds || []) visibleUserIdSet.add(String(uid));
    }

    // If you want “members only see themselves” (leaders still see members),
    // uncomment this block:
    
    if (myGroupIds.length && !myLeaderGroupIds.length) {
      for (const k of Array.from(visibleUserIdSet)) {
        if (k !== String(myOid || "")) visibleUserIdSet.delete(k);
      }
    }

    // Normalize id types to ObjectIds when possible
    req.accessibleUserIds = Array.from(visibleUserIdSet).map((s) => asOid(s) || s);
    req.myGroupIds = myGroupIds; // ObjectIds from DB
    req.myLeaderGroupIds = myLeaderGroupIds;

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { computeAccessibleUserIds };
