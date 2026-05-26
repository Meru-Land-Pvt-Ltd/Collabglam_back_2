// controllers/notificationController.js
const mongoose = require("mongoose");
const Notification = require("../models/notification");
const { AdminModel, ROLES } = require("../models/master");
const BrandAssigned = require("../models/brandAssigned");
const CampaignAssigned = require("../models/CampaignAssigned");
const saveErrorLog = require("../services/errorLog.service");

function normalizeRole(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizeId(value = "") {
  return String(value || "").trim();
}

function isObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""));
}

function toObjectId(value) {
  return new mongoose.Types.ObjectId(String(value));
}

function idVariants(value) {
  const id = normalizeId(value);
  if (!id) return [];

  const values = [id];
  if (isObjectId(id)) values.push(toObjectId(id));
  return values;
}

function uniqueStringIds(values = []) {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .map((item) => String(item))
        .filter(Boolean)
    ),
  ];
}

function parsePageLimit(source = {}) {
  const page = Math.max(1, parseInt(source.page || 1, 10));
  const limit = Math.min(Math.max(1, parseInt(source.limit || 20, 10)), 100);
  return { page, limit };
}

function getActor(req = {}) {
  const admin = req.admin || req.user || {};

  return {
    adminId: normalizeId(admin.adminId || admin._id || ""),
    role: normalizeRole(admin.role || ""),
    email: String(admin.email || "").trim().toLowerCase(),
  };
}

function isFullNotificationAccess(role = "") {
  const value = normalizeRole(role);
  return value === ROLES.SUPER_ADMIN || value === "super_admin" || value === "admin" || value === "master_admin";
}

function makeStringInQuery(field, values = []) {
  const ids = uniqueStringIds(values);
  if (!ids.length) return null;
  return { [field]: { $in: ids } };
}

function compact(values = []) {
  return values.filter(Boolean);
}

async function resolveAdminFromToken(req) {
  const actor = getActor(req);
  const or = [];

  if (isObjectId(actor.adminId)) {
    or.push({ _id: toObjectId(actor.adminId) });
  }

  if (actor.email) {
    or.push({ email: actor.email });
  }

  if (!or.length) return null;

  return AdminModel.findOne({ $or: or })
    .select("_id name email role parentAdmin rootAdmin status")
    .lean();
}

async function getRhTeamIds(rhId) {
  const parentVariants = idVariants(rhId);
  if (!parentVariants.length) return [];

  const team = await AdminModel.find({
    status: "active",
    role: { $in: [ROLES.BME, ROLES.IME, ROLES.SDR] },
    parentAdmin: { $in: parentVariants },
  })
    .select("_id")
    .lean();

  return uniqueStringIds([rhId, ...team.map((item) => item._id)]);
}

async function getRhBrandIds({ rhId, teamIds = [] }) {
  const rhVariants = idVariants(rhId);
  const teamVariants = [];

  teamIds.forEach((id) => {
    teamVariants.push(...idVariants(id));
  });

  const or = compact([
    rhVariants.length ? { RHId: { $in: rhVariants } } : null,
    teamVariants.length ? { bdmId: { $in: teamVariants } } : null,
  ]);

  if (!or.length) return [];

  const assignments = await BrandAssigned.find({
    status: "active",
    $or: or,
  })
    .select("brandId")
    .lean();

  return uniqueStringIds(assignments.map((item) => item.brandId));
}

async function getRhCampaignIds({ rhId, teamIds = [], brandIds = [] }) {
  const rhVariants = idVariants(rhId);

  const teamVariants = [];
  teamIds.forEach((id) => {
    teamVariants.push(...idVariants(id));
  });

  const brandVariants = [];
  brandIds.forEach((id) => {
    brandVariants.push(...idVariants(id));
  });

  const or = compact([
    rhVariants.length ? { RHId: { $in: rhVariants } } : null,
    teamVariants.length ? { bdmId: { $in: teamVariants } } : null,
    teamVariants.length ? { idmId: { $in: teamVariants } } : null,
    brandVariants.length ? { brandId: { $in: brandVariants } } : null,
  ]);

  if (!or.length) return [];

  const assignments = await CampaignAssigned.find({
    status: "active",
    $or: or,
  })
    .select("campaignId")
    .lean();

  return uniqueStringIds(assignments.map((item) => item.campaignId));
}

async function buildAdminNotificationScope(req) {
  const admin = await resolveAdminFromToken(req);

  if (!admin) {
    return { _id: { $in: [] } };
  }

  const actorId = String(admin._id);
  const actorRole = normalizeRole(admin.role);

  if (isFullNotificationAccess(actorRole)) {
    return {};
  }

  if (actorRole === ROLES.REVENUE_HEAD || actorRole === "rh") {
    const teamIds = await getRhTeamIds(actorId);
    const brandIds = await getRhBrandIds({ rhId: actorId, teamIds });
    const campaignIds = await getRhCampaignIds({ rhId: actorId, teamIds, brandIds });

    const or = compact([
      makeStringInQuery("adminId", teamIds),
      makeStringInQuery("brandId", brandIds),
      campaignIds.length
        ? {
            entityType: "campaign",
            entityId: { $in: campaignIds },
          }
        : null,
      { adminId: "ALL" },
      { adminId: "all" },
    ]);

    return or.length ? { $or: or } : { _id: { $in: [] } };
  }

  return {
    $or: [
      { adminId: actorId },
      { adminId: "ALL" },
      { adminId: "all" },
    ],
  };
}

function buildActivityGroupKey(row) {
  const notificationId = String(row.notificationId || "").trim();

  // New rows created by utils/notifier.js share notificationId across all recipients.
  if (notificationId) {
    return `notification:${notificationId}`;
  }

  // Legacy fallback for old rows where every recipient had a unique notificationId.
  const createdAt = row.createdAt ? new Date(row.createdAt).getTime() : 0;
  const bucket = Number.isFinite(createdAt) ? Math.floor(createdAt / 1000) : 0;

  return [
    "legacy",
    row.type || "",
    row.entityType || "",
    row.entityId || "",
    row.title || "",
    row.message || "",
    bucket,
  ].join("|");
}

function buildActivityMatchQuery(row) {
  if (row.notificationId) {
    return { notificationId: row.notificationId };
  }

  return {
    type: row.type,
    entityType: row.entityType || null,
    entityId: row.entityId || null,
    title: row.title,
    message: row.message || "",
  };
}

function preferAdminRow(existing, row) {
  if (!existing) return row;

  const existingIsAdmin = Boolean(existing.adminId);
  const rowIsAdmin = Boolean(row.adminId);

  if (!existingIsAdmin && rowIsAdmin) {
    return {
      ...row,
      isRead: existing.isRead && row.isRead,
      createdAt: existing.createdAt || row.createdAt,
      updatedAt: existing.updatedAt || row.updatedAt,
    };
  }

  return existing;
}

function groupAdminNotifications(rows = []) {
  const grouped = new Map();

  for (const row of rows) {
    const key = buildActivityGroupKey(row);
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        ...row,
        isRead: Boolean(row.isRead),
      });
      continue;
    }

    const preferred = preferAdminRow(existing, row);
    preferred.isRead = Boolean(existing.isRead && row.isRead);

    if (!preferred.actorName && row.actorName) preferred.actorName = row.actorName;
    if (!preferred.actorEmail && row.actorEmail) preferred.actorEmail = row.actorEmail;
    if (!preferred.actorRole && row.actorRole) preferred.actorRole = row.actorRole;
    if (!preferred.actorAdminId && row.actorAdminId) preferred.actorAdminId = row.actorAdminId;

    const existingTime = new Date(preferred.createdAt || 0).getTime();
    const rowTime = new Date(row.createdAt || 0).getTime();

    if (rowTime > existingTime) {
      preferred.createdAt = row.createdAt;
      preferred.updatedAt = row.updatedAt;
    }

    grouped.set(key, preferred);
  }

  return Array.from(grouped.values()).sort((a, b) => {
    const unreadDiff = Number(!b.isRead) - Number(!a.isRead);
    if (unreadDiff) return unreadDiff;

    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });
}

// -------------------------
// BRAND
// -------------------------
async function listForBrand(req, res) {
  try {
    const { brandId, page = 1, limit = 20 } = req.query;
    if (!brandId) return res.status(400).json({ message: "brandId is required" });

    const p = Math.max(1, parseInt(page, 10));
    const l = Math.max(1, parseInt(limit, 10));
    const q = { brandId: String(brandId) };

    const [data, total, unread] = await Promise.all([
      Notification.find(q).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      Notification.countDocuments(q),
      Notification.countDocuments({ ...q, isRead: false }),
    ]);

    res.json({ data, total, unread, page: p, limit: l });
  } catch (err) {
    console.error("listForBrand error:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "LIST_FOR_BRAND_ERROR");res.status(500).json({ message: "Internal server error" });
  }
}

async function markReadForBrand(req, res) {
  try {
    const { id, brandId } = req.body;
    if (!id || !brandId) {
      return res.status(400).json({ message: "id and brandId are required" });
    }

    const doc = await Notification.findOneAndUpdate(
      { _id: id, brandId: String(brandId) },
      { $set: { isRead: true } },
      { new: true }
    ).lean();

    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json({ ok: true, item: doc });
  } catch (err) {
    console.error("markReadForBrand error:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "MARK_READ_FOR_BRAND_ERROR");res.status(500).json({ message: "Internal server error" });
  }
}

async function markAllReadForBrand(req, res) {
  try {
    const { brandId } = req.body;
    if (!brandId) return res.status(400).json({ message: "brandId is required" });

    await Notification.updateMany(
      { brandId: String(brandId), isRead: false },
      { $set: { isRead: true } }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("markAllReadForBrand error:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "MARK_ALL_READ_FOR_BRAND_ERROR");res.status(500).json({ message: "Internal server error" });
  }
}

async function deleteForBrand(req, res) {
  try {
    const { notificationId, id, brandId } = req.body;
    const targetId = notificationId || id;

    if (!targetId) {
      return res.status(400).json({ message: "notificationId or id is required" });
    }

    const q = brandId
      ? { _id: targetId, brandId: String(brandId) }
      : { notificationId: String(targetId) };

    const doc = await Notification.findOneAndDelete(q).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });

    return res.json({ ok: true, deletedId: targetId, previous: doc });
  } catch (err) {
    console.error("deleteForBrand error:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "DELETE_FOR_BRAND_ERROR");return res.status(500).json({ message: "Internal server error" });
  }
}

// -------------------------
// INFLUENCER
// -------------------------
async function listForInfluencer(req, res) {
  try {
    const { influencerId, page = 1, limit = 20 } = req.query;
    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required" });
    }

    const p = Math.max(1, parseInt(page, 10));
    const l = Math.max(1, parseInt(limit, 10));
    const q = { influencerId: String(influencerId) };

    const [data, total, unread] = await Promise.all([
      Notification.find(q).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      Notification.countDocuments(q),
      Notification.countDocuments({ ...q, isRead: false }),
    ]);

    res.json({ data, total, unread, page: p, limit: l });
  } catch (err) {
    console.error("listForInfluencer error:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "LIST_FOR_INFLUENCER_ERROR");res.status(500).json({ message: "Internal server error" });
  }
}

async function markReadForInfluencer(req, res) {
  try {
    const { id, influencerId } = req.body;
    if (!id || !influencerId) {
      return res.status(400).json({ message: "id and influencerId are required" });
    }

    const doc = await Notification.findOneAndUpdate(
      { _id: id, influencerId: String(influencerId) },
      { $set: { isRead: true } },
      { new: true }
    ).lean();

    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json({ ok: true, item: doc });
  } catch (err) {
    console.error("markReadForInfluencer error:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "MARK_READ_FOR_INFLUENCER_ERROR");res.status(500).json({ message: "Internal server error" });
  }
}

async function markAllReadForInfluencer(req, res) {
  try {
    const { influencerId } = req.body;
    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required" });
    }

    await Notification.updateMany(
      { influencerId: String(influencerId), isRead: false },
      { $set: { isRead: true } }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("markAllReadForInfluencer error:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "MARK_ALL_READ_FOR_INFLUENCER_ERROR");res.status(500).json({ message: "Internal server error" });
  }
}

async function deleteForInfluencer(req, res) {
  try {
    const { id, influencerId } = req.body;
    if (!id || !influencerId) {
      return res.status(400).json({ message: "id and influencerId are required" });
    }

    const doc = await Notification.findOneAndDelete({
      _id: id,
      influencerId: String(influencerId),
    }).lean();

    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json({ ok: true, deletedId: id, previous: doc });
  } catch (err) {
    console.error("deleteForInfluencer error:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "DELETE_FOR_INFLUENCER_ERROR");res.status(500).json({ message: "Internal server error" });
  }
}

// -------------------------
// ADMIN
// -------------------------
async function listForAdmin(req, res) {
  try {
    const { page, limit } = parsePageLimit({ ...req.query, ...req.body });
    const scope = await buildAdminNotificationScope(req);

    const unreadOnly = String(req.query?.unread || req.body?.unread || "")
      .trim()
      .toLowerCase();

    const rawRows = await Notification.find(scope)
      .sort({ createdAt: -1, updatedAt: -1 })
      .lean();

    const groupedRows = groupAdminNotifications(rawRows);
    const filteredRows =
      unreadOnly === "true" || unreadOnly === "1"
        ? groupedRows.filter((item) => !item.isRead)
        : groupedRows;

    const total = filteredRows.length;
    const unread = groupedRows.filter((item) => !item.isRead).length;
    const data = filteredRows.slice((page - 1) * limit, page * limit);

    res.json({
      success: true,
      data,
      total,
      unread,
      unreadCount: unread,
      page,
      limit,
    });
  } catch (err) {
    console.error("listForAdmin error:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "LIST_FOR_ADMIN_ERROR");res.status(500).json({ message: "Internal server error" });
  }
}

async function markReadForAdmin(req, res) {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ message: "id is required" });

    const scope = await buildAdminNotificationScope(req);
    const notification = await Notification.findOne({ _id: id, ...scope }).lean();

    if (!notification) return res.status(404).json({ message: "Not found" });

    await Notification.updateMany(
      {
        ...scope,
        ...buildActivityMatchQuery(notification),
      },
      { $set: { isRead: true } }
    );

    res.json({ ok: true, item: { ...notification, isRead: true } });
  } catch (err) {
    console.error("markReadForAdmin error:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "MARK_READ_FOR_ADMIN_ERROR");res.status(500).json({ message: "Internal server error" });
  }
}

async function markAllReadForAdmin(req, res) {
  try {
    const scope = await buildAdminNotificationScope(req);

    await Notification.updateMany(
      { ...scope, isRead: false },
      { $set: { isRead: true } }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("markAllReadForAdmin error:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "MARK_ALL_READ_FOR_ADMIN_ERROR");res.status(500).json({ message: "Internal server error" });
  }
}

async function deleteForAdmin(req, res) {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ message: "id is required" });

    const scope = await buildAdminNotificationScope(req);
    const notification = await Notification.findOne({ _id: id, ...scope }).lean();

    if (!notification) return res.status(404).json({ message: "Not found" });

    const result = await Notification.deleteMany({
      ...scope,
      ...buildActivityMatchQuery(notification),
    });

    res.json({
      ok: true,
      deletedId: id,
      deletedCount: result.deletedCount || 0,
      previous: notification,
    });
  } catch (err) {
    console.error("deleteForAdmin error:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "DELETE_FOR_ADMIN_ERROR");res.status(500).json({ message: "Internal server error" });
  }
}

module.exports = {
  listForBrand,
  markReadForBrand,
  markAllReadForBrand,
  deleteForBrand,

  listForInfluencer,
  markReadForInfluencer,
  markAllReadForInfluencer,
  deleteForInfluencer,

  listForAdmin,
  markReadForAdmin,
  markAllReadForAdmin,
  deleteForAdmin,

  buildAdminNotificationScope,
};