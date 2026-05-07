// utils/notifier.js
const Notification = require("../models/notification");

let sockets = {};

try {
  sockets = require("../sockets"); // { emitToBrand, emitToInfluencer, emitToAdmin, emitToAllAdmins? }
} catch (error) {
  sockets = {};
}

function toCleanString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeIdList(singleId, manyIds) {
  const ids = [
    ...(singleId ? [singleId] : []),
    ...(Array.isArray(manyIds) ? manyIds : []),
  ]
    .map(toCleanString)
    .filter(Boolean);

  return Array.from(new Set(ids));
}

function normalizeNullableString(value) {
  const cleaned = toCleanString(value);
  return cleaned || null;
}

function resolveActionPath(actionPath, kind) {
  if (!actionPath) return null;

  if (typeof actionPath === "string") {
    return normalizeNullableString(actionPath);
  }

  if (typeof actionPath === "object") {
    if (kind === "brand") return normalizeNullableString(actionPath.brand);
    if (kind === "influencer") return normalizeNullableString(actionPath.influencer);
    if (kind === "admin") return normalizeNullableString(actionPath.admin);
  }

  return null;
}

function buildBaseNotificationPayload({
  type,
  title,
  message = "",
  entityType = null,
  entityId = null,
}) {
  return {
    type: toCleanString(type),
    title: toCleanString(title),
    message: String(message || ""),
    entityType: normalizeNullableString(entityType),
    entityId: normalizeNullableString(entityId),
    isRead: false,
  };
}

function buildNotificationDocs({
  brandIds = [],
  influencerIds = [],
  adminIds = [],

  type,
  title,
  message = "",
  entityType = null,
  entityId = null,
  actionPath = null,
}) {
  const basePayload = buildBaseNotificationPayload({
    type,
    title,
    message,
    entityType,
    entityId,
  });

  const docs = [];

  for (const id of brandIds) {
    docs.push({
      ...basePayload,
      brandId: String(id),
      influencerId: null,
      adminId: null,
      actionPath: resolveActionPath(actionPath, "brand"),
    });
  }

  for (const id of influencerIds) {
    docs.push({
      ...basePayload,
      brandId: null,
      influencerId: String(id),
      adminId: null,
      actionPath: resolveActionPath(actionPath, "influencer"),
    });
  }

  for (const id of adminIds) {
    docs.push({
      ...basePayload,
      brandId: null,
      influencerId: null,
      adminId: String(id),
      actionPath: resolveActionPath(actionPath, "admin"),
    });
  }

  return docs;
}

function emitNotification(doc) {
  const payload = doc?.toObject ? doc.toObject() : doc;
  if (!payload) return;

  try {
    if (payload.brandId && typeof sockets.emitToBrand === "function") {
      sockets.emitToBrand(String(payload.brandId), "notification.new", payload);
    }

    if (payload.influencerId && typeof sockets.emitToInfluencer === "function") {
      sockets.emitToInfluencer(
        String(payload.influencerId),
        "notification.new",
        payload
      );
    }

    if (payload.adminId) {
      const adminId = String(payload.adminId);

      if (
        (adminId === "ALL" || adminId.toLowerCase() === "all") &&
        typeof sockets.emitToAllAdmins === "function"
      ) {
        sockets.emitToAllAdmins("notification.new", payload);
      } else if (typeof sockets.emitToAdmin === "function") {
        sockets.emitToAdmin(adminId, "notification.new", payload);
      }
    }
  } catch (error) {
    console.warn("Notification socket emit failed:", error?.message || error);
  }
}

async function createAndEmit({
  brandId = null,
  influencerId = null,
  adminId = null,

  brandIds = null,
  influencerIds = null,
  adminIds = null,

  type,
  title,
  message = "",
  entityType = null,
  entityId = null,
  actionPath = null,
}) {
  const cleanType = toCleanString(type);
  const cleanTitle = toCleanString(title);

  if (!cleanType || !cleanTitle) {
    throw new Error("createAndEmit: type and title are required");
  }

  const uniqueBrandIds = normalizeIdList(brandId, brandIds);
  const uniqueInfluencerIds = normalizeIdList(influencerId, influencerIds);
  const uniqueAdminIds = normalizeIdList(adminId, adminIds);

  if (
    !uniqueBrandIds.length &&
    !uniqueInfluencerIds.length &&
    !uniqueAdminIds.length
  ) {
    throw new Error(
      "createAndEmit: provide at least one recipient: brandId, influencerId, or adminId"
    );
  }

  const docsToInsert = buildNotificationDocs({
    brandIds: uniqueBrandIds,
    influencerIds: uniqueInfluencerIds,
    adminIds: uniqueAdminIds,

    type: cleanType,
    title: cleanTitle,
    message,
    entityType,
    entityId,
    actionPath,
  });

  if (!docsToInsert.length) {
    throw new Error("createAndEmit: no notification documents created");
  }

  const created = await Notification.insertMany(docsToInsert, {
    ordered: true,
  });

  for (const doc of created) {
    emitNotification(doc);
  }

  return created.length === 1 ? created[0] : created;
}

module.exports = {
  createAndEmit,
};