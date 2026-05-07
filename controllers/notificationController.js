// controllers/notificationController.js
const mongoose = require("mongoose");
const Notification = require("../models/notification");

const { AdminModel, ROLES } = require("../models/master");
const BrandAssigned = require("../models/brandAssigned");
const CampaignAssigned = require("../models/CampaignAssigned");

function normalizeId(value = "") {
  return String(value || "").trim();
}

function normalizeRole(value = "") {
  return String(value || "").trim().toLowerCase();
}

function isObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""));
}

function toObjectId(value) {
  return new mongoose.Types.ObjectId(String(value));
}

function parsePageLimit(source = {}) {
  const page = Math.max(1, parseInt(source.page || 1, 10));
  const limit = Math.min(Math.max(1, parseInt(source.limit || 20, 10)), 100);

  return { page, limit };
}

function uniqueStrings(values = []) {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .map((item) => String(item))
        .filter(Boolean)
    ),
  ];
}

function makeStringIdQuery(field, ids = []) {
  const cleanIds = uniqueStrings(ids);
  if (!cleanIds.length) return null;

  return {
    [field]: { $in: cleanIds },
  };
}

function makeObjectIdMatch(value) {
  const id = normalizeId(value);
  if (!id) return [];

  const list = [id];

  if (isObjectId(id)) {
    list.push(toObjectId(id));
  }

  return list;
}

function getActor(req = {}) {
  const admin = req.admin || {};

  return {
    adminId: normalizeId(admin.adminId || admin._id || ""),
    role: normalizeRole(admin.role || ""),
    email: String(admin.email || "").trim().toLowerCase(),
  };
}

async function resolveAdminFromToken(req) {
  const actor = getActor(req);

  if (!actor.adminId && !actor.email) return null;

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

function isFullAdminAccess(role = "") {
  const normalized = normalizeRole(role);

  return (
    normalized === ROLES.SUPER_ADMIN ||
    normalized === "super_admin" ||
    normalized === "admin"
  );
}

async function getRhTeamAdminIds(rhId) {
  const rhObjectIds = makeObjectIdMatch(rhId);

  if (!rhObjectIds.length) return [String(rhId)];

  const team = await AdminModel.find({
    status: "active",
    role: { $in: [ROLES.BME, ROLES.IME, ROLES.SDR] },
    parentAdmin: { $in: rhObjectIds },
  })
    .select("_id")
    .lean();

  return uniqueStrings([
    rhId,
    ...team.map((item) => item._id),
  ]);
}

async function getRhBrandIds({ rhId, teamAdminIds = [] }) {
  const rhObjectIds = makeObjectIdMatch(rhId);

  const teamObjectIds = [];
  teamAdminIds.forEach((id) => {
    teamObjectIds.push(...makeObjectIdMatch(id));
  });

  const or = [];

  if (rhObjectIds.length) {
    or.push({ RHId: { $in: rhObjectIds } });
  }

  if (teamObjectIds.length) {
    or.push({ bdmId: { $in: teamObjectIds } });
  }

  if (!or.length) return [];

  const assignments = await BrandAssigned.find({
    status: "active",
    $or: or,
  })
    .select("brandId")
    .lean();

  return uniqueStrings(assignments.map((item) => item.brandId));
}

async function getRhCampaignIds({ rhId, teamAdminIds = [], brandIds = [] }) {
  const rhObjectIds = makeObjectIdMatch(rhId);

  const teamObjectIds = [];
  teamAdminIds.forEach((id) => {
    teamObjectIds.push(...makeObjectIdMatch(id));
  });

  const brandObjectIds = [];
  brandIds.forEach((id) => {
    brandObjectIds.push(...makeObjectIdMatch(id));
  });

  const or = [];

  if (rhObjectIds.length) {
    or.push({ RHId: { $in: rhObjectIds } });
  }

  if (teamObjectIds.length) {
    or.push({ bdmId: { $in: teamObjectIds } });
    or.push({ idmId: { $in: teamObjectIds } });
  }

  if (brandObjectIds.length) {
    or.push({ brandId: { $in: brandObjectIds } });
  }

  if (!or.length) return [];

  const assignments = await CampaignAssigned.find({
    status: "active",
    $or: or,
  })
    .select("campaignId")
    .lean();

  return uniqueStrings(assignments.map((item) => item.campaignId));
}

async function buildAdminNotificationScope(req) {
  const admin = await resolveAdminFromToken(req);

  if (!admin) {
    return { _id: { $in: [] } };
  }

  const actorId = String(admin._id);
  const actorRole = normalizeRole(admin.role);

  if (isFullAdminAccess(actorRole)) {
    return {};
  }

  if (actorRole === ROLES.REVENUE_HEAD) {
    const teamAdminIds = await getRhTeamAdminIds(actorId);

    const brandIds = await getRhBrandIds({
      rhId: actorId,
      teamAdminIds,
    });

    const campaignIds = await getRhCampaignIds({
      rhId: actorId,
      teamAdminIds,
      brandIds,
    });

    const or = [
      makeStringIdQuery("adminId", teamAdminIds),
      makeStringIdQuery("brandId", brandIds),

      // Campaign notification support:
      // Since your schema has no campaignId field, campaign notifications
      // should use entityType: "campaign" and entityId: String(campaign._id).
      campaignIds.length
        ? {
            entityType: "campaign",
            entityId: { $in: campaignIds },
          }
        : null,

      // Global admin notification, compatible with your XOR schema.
      { adminId: "ALL" },
      { adminId: "all" },
    ].filter(Boolean);

    return or.length ? { $or: or } : { _id: { $in: [] } };
  }

  // BME / IME / SDR see only their direct admin notifications.
  return {
    $or: [
      { adminId: actorId },
      { adminId: "ALL" },
      { adminId: "all" },
    ],
  };
}

/* =========================
   BRAND
========================= */

async function listForBrand(req, res) {
  try {
    const { brandId, page = 1, limit = 20 } = req.query;

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required" });
    }

    const p = Math.max(1, parseInt(page, 10));
    const l = Math.max(1, parseInt(limit, 10));

    const q = {
      brandId: String(brandId),
    };

    const [data, total, unread] = await Promise.all([
      Notification.find(q)
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),

      Notification.countDocuments(q),

      Notification.countDocuments({
        ...q,
        isRead: false,
      }),
    ]);

    return res.json({
      data,
      total,
      unread,
      page: p,
      limit: l,
    });
  } catch (err) {
    console.error("listForBrand error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function markReadForBrand(req, res) {
  try {
    const { id, brandId } = req.body;

    if (!id || !brandId) {
      return res.status(400).json({ message: "id and brandId are required" });
    }

    const doc = await Notification.findOneAndUpdate(
      {
        _id: id,
        brandId: String(brandId),
      },
      {
        $set: {
          isRead: true,
        },
      },
      {
        new: true,
      }
    ).lean();

    if (!doc) {
      return res.status(404).json({ message: "Not found" });
    }

    return res.json({
      ok: true,
      item: doc,
    });
  } catch (err) {
    console.error("markReadForBrand error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function markAllReadForBrand(req, res) {
  try {
    const { brandId } = req.body;

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required" });
    }

    await Notification.updateMany(
      {
        brandId: String(brandId),
        isRead: false,
      },
      {
        $set: {
          isRead: true,
        },
      }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("markAllReadForBrand error:", err);
    return res.status(500).json({ message: "Internal server error" });
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
      ? {
          _id: targetId,
          brandId: String(brandId),
        }
      : {
          notificationId: String(targetId),
        };

    const doc = await Notification.findOneAndDelete(q).lean();

    if (!doc) {
      return res.status(404).json({ message: "Not found" });
    }

    return res.json({
      ok: true,
      deletedId: targetId,
      previous: doc,
    });
  } catch (err) {
    console.error("deleteForBrand error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

/* =========================
   INFLUENCER
========================= */

async function listForInfluencer(req, res) {
  try {
    const { influencerId, page = 1, limit = 20 } = req.query;

    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required" });
    }

    const p = Math.max(1, parseInt(page, 10));
    const l = Math.max(1, parseInt(limit, 10));

    const q = {
      influencerId: String(influencerId),
    };

    const [data, total, unread] = await Promise.all([
      Notification.find(q)
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),

      Notification.countDocuments(q),

      Notification.countDocuments({
        ...q,
        isRead: false,
      }),
    ]);

    return res.json({
      data,
      total,
      unread,
      page: p,
      limit: l,
    });
  } catch (err) {
    console.error("listForInfluencer error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function markReadForInfluencer(req, res) {
  try {
    const { id, influencerId } = req.body;

    if (!id || !influencerId) {
      return res.status(400).json({ message: "id and influencerId are required" });
    }

    const doc = await Notification.findOneAndUpdate(
      {
        _id: id,
        influencerId: String(influencerId),
      },
      {
        $set: {
          isRead: true,
        },
      },
      {
        new: true,
      }
    ).lean();

    if (!doc) {
      return res.status(404).json({ message: "Not found" });
    }

    return res.json({
      ok: true,
      item: doc,
    });
  } catch (err) {
    console.error("markReadForInfluencer error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function markAllReadForInfluencer(req, res) {
  try {
    const { influencerId } = req.body;

    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required" });
    }

    await Notification.updateMany(
      {
        influencerId: String(influencerId),
        isRead: false,
      },
      {
        $set: {
          isRead: true,
        },
      }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("markAllReadForInfluencer error:", err);
    return res.status(500).json({ message: "Internal server error" });
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

    if (!doc) {
      return res.status(404).json({ message: "Not found" });
    }

    return res.json({
      ok: true,
      deletedId: id,
      previous: doc,
    });
  } catch (err) {
    console.error("deleteForInfluencer error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

/* =========================
   ADMIN
========================= */

async function listForAdmin(req, res) {
  try {
    const { page, limit } = parsePageLimit(req.query || {});
    const scope = await buildAdminNotificationScope(req);

    const unreadOnly = String(req.query?.unread || "")
      .trim()
      .toLowerCase();

    const q = {
      ...scope,
    };

    if (unreadOnly === "true" || unreadOnly === "1") {
      q.isRead = false;
    }

    const [data, total, unread] = await Promise.all([
      Notification.find(q)
        .sort({ createdAt: -1, updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      Notification.countDocuments(q),

      Notification.countDocuments({
        ...scope,
        isRead: false,
      }),
    ]);

    return res.json({
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
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function markReadForAdmin(req, res) {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ message: "id is required" });
    }

    const scope = await buildAdminNotificationScope(req);

    const doc = await Notification.findOneAndUpdate(
      {
        _id: id,
        ...scope,
      },
      {
        $set: {
          isRead: true,
        },
      },
      {
        new: true,
      }
    ).lean();

    if (!doc) {
      return res.status(404).json({ message: "Not found" });
    }

    return res.json({
      ok: true,
      item: doc,
    });
  } catch (err) {
    console.error("markReadForAdmin error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function markAllReadForAdmin(req, res) {
  try {
    const scope = await buildAdminNotificationScope(req);

    await Notification.updateMany(
      {
        ...scope,
        isRead: false,
      },
      {
        $set: {
          isRead: true,
        },
      }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("markAllReadForAdmin error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function deleteForAdmin(req, res) {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ message: "id is required" });
    }

    const scope = await buildAdminNotificationScope(req);

    const doc = await Notification.findOneAndDelete({
      _id: id,
      ...scope,
    }).lean();

    if (!doc) {
      return res.status(404).json({ message: "Not found" });
    }

    return res.json({
      ok: true,
      deletedId: id,
      previous: doc,
    });
  } catch (err) {
    console.error("deleteForAdmin error:", err);
    return res.status(500).json({ message: "Internal server error" });
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