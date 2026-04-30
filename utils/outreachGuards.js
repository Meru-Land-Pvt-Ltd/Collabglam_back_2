const mongoose = require("mongoose");
const { AdminModel, ROLES } = require("../models/master");

function normalizeRole(role) {
  const value = String(role || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (value === "rh") return ROLES.REVENUE_HEAD;
  if (value === "revenuehead") return ROLES.REVENUE_HEAD;
  if (value === "revenue_head") return ROLES.REVENUE_HEAD;

  if (value === "superadmin") return ROLES.SUPER_ADMIN;
  if (value === "super_admin") return ROLES.SUPER_ADMIN;

  if (value === "sdr") return ROLES.SDR;
  if (value === "ime") return ROLES.IME;
  if (value === "bme") return ROLES.BME;

  return value;
}

function normalizeAllowedRoles(roles = []) {
  return Array.isArray(roles)
    ? roles.map(normalizeRole).filter(Boolean)
    : [];
}

function getActorId(actor = {}) {
  return String(
    actor?.adminId ||
    actor?._id ||
    actor?.id ||
    actor?.data?.adminId ||
    actor?.data?._id ||
    ""
  ).trim();
}

function createForbiddenError(message = "Forbidden") {
  const err = new Error(message);
  err.statusCode = 403;
  return err;
}

function createBadRequestError(message = "Bad Request") {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function createNotFoundError(message = "Not found") {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function ensureRole(actor, roles = []) {
  const role = normalizeRole(actor?.role);
  const allowedRoles = normalizeAllowedRoles(roles);

  if (!role || !allowedRoles.includes(role)) {
    throw createForbiddenError("Forbidden");
  }

  return true;
}

function ensureActor(actor) {
  const actorId = getActorId(actor);
  const role = normalizeRole(actor?.role);

  if (!actorId || !role) {
    throw createForbiddenError("Forbidden");
  }

  return {
    actorId,
    role,
  };
}

function isSuperAdmin(actor) {
  return normalizeRole(actor?.role) === ROLES.SUPER_ADMIN;
}

function isRevenueHead(actor) {
  return normalizeRole(actor?.role) === ROLES.REVENUE_HEAD;
}

function isSdr(actor) {
  return normalizeRole(actor?.role) === ROLES.SDR;
}

function isIme(actor) {
  return normalizeRole(actor?.role) === ROLES.IME;
}

function isBme(actor) {
  return normalizeRole(actor?.role) === ROLES.BME;
}

function isValidObjectId(value) {
  return mongoose.isValidObjectId(String(value || ""));
}

async function validateOutreachTeam({ sdrId, RHId, bmeId }) {
  if (!isValidObjectId(sdrId)) {
    throw createBadRequestError("Valid sdrId is required");
  }

  if (!isValidObjectId(RHId)) {
    throw createBadRequestError("Valid RHId is required");
  }

  if (!isValidObjectId(bmeId)) {
    throw createBadRequestError("Valid assignedBmeId is required");
  }

  const [rh, sdr, bme] = await Promise.all([
    AdminModel.findOne({
      _id: RHId,
      role: ROLES.REVENUE_HEAD,
      status: "active",
    }).select("_id"),

    AdminModel.findOne({
      _id: sdrId,
      role: ROLES.SDR,
      status: "active",
    }).select("_id parentAdmin rootAdmin"),

    AdminModel.findOne({
      _id: bmeId,
      role: ROLES.BME,
      status: "active",
    }).select("_id parentAdmin rootAdmin"),
  ]);

  if (!rh) {
    throw createNotFoundError("Assigned RH not found or inactive");
  }

  if (!sdr) {
    throw createNotFoundError("Assigned SDR not found or inactive");
  }

  if (!bme) {
    throw createNotFoundError("Assigned BME not found or inactive");
  }

  const rhId = String(RHId);

  const sdrBelongsToRh =
    String(sdr.parentAdmin || "") === rhId ||
    String(sdr.rootAdmin || "") === rhId;

  const bmeBelongsToRh =
    String(bme.parentAdmin || "") === rhId ||
    String(bme.rootAdmin || "") === rhId;

  if (!sdrBelongsToRh) {
    throw createBadRequestError("Selected SDR does not belong to the assigned RH");
  }

  if (!bmeBelongsToRh) {
    throw createBadRequestError("Selected BME does not belong to the assigned RH");
  }

  return true;
}

module.exports = {
  validateOutreachTeam,
  ensureRole,
  ensureActor,
  normalizeRole,
  getActorId,
  isSuperAdmin,
  isRevenueHead,
  isSdr,
  isIme,
  isBme,
};