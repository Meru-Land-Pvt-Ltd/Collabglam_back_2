const mongoose = require("mongoose");
const { AdminModel, ROLES } = require("../models/master");
const BrandAssigned = require("../models/brandAssigned");
const CampaignAssigned = require("../models/CampaignAssigned");

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

  const variants = [id];

  if (isObjectId(id)) {
    variants.push(toObjectId(id));
  }

  return variants;
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

function buildInQuery(field, values = []) {
  const ids = [];

  values.forEach((value) => {
    ids.push(...idVariants(value));
  });

  if (!ids.length) return null;

  return {
    [field]: { $in: ids },
  };
}

function compactOr(conditions = []) {
  return conditions.filter(Boolean);
}

function isGlobalNotificationQuery() {
  return {
    $or: [
      { isGlobal: true },
      { audience: "all" },
      { audienceRoles: { $in: ["all"] } },
      { targetRoles: { $in: ["all"] } },
      { recipientRoles: { $in: ["all"] } },
    ],
  };
}

function isAdminFullAccessRole(role) {
  const value = normalizeRole(role);

  return (
    value === ROLES.SUPER_ADMIN ||
    value === "super_admin" ||
    value === "admin"
  );
}

async function getRhTeamIds(rhId) {
  const rhIdText = normalizeId(rhId);
  const parentVariants = idVariants(rhIdText);

  if (!parentVariants.length) return [];

  const team = await AdminModel.find({
    status: "active",
    role: { $in: [ROLES.BME, ROLES.IME, ROLES.SDR, "bme", "ime", "sdr"] },
    parentAdmin: { $in: parentVariants },
  })
    .select("_id role")
    .lean();

  return uniqueStringIds([rhIdText, ...team.map((item) => item._id)]);
}

async function getRhBrandIds({ rhId, teamIds = [] }) {
  const rhVariants = idVariants(rhId);

  const teamVariants = [];
  teamIds.forEach((id) => {
    teamVariants.push(...idVariants(id));
  });

  const or = compactOr([
    rhVariants.length ? { RHId: { $in: rhVariants } } : null,
    teamVariants.length ? { bdmId: { $in: teamVariants } } : null,
    teamVariants.length ? { idmId: { $in: teamVariants } } : null,
    teamVariants.length ? { sdrId: { $in: teamVariants } } : null,
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

  const or = compactOr([
    rhVariants.length ? { RHId: { $in: rhVariants } } : null,
    teamVariants.length ? { bdmId: { $in: teamVariants } } : null,
    teamVariants.length ? { idmId: { $in: teamVariants } } : null,
    teamVariants.length ? { sdrId: { $in: teamVariants } } : null,
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

function buildNotificationFieldScope({
  actorId,
  actorRole,
  teamIds = [],
  brandIds = [],
  campaignIds = [],
}) {
  const actorAndTeamIds = uniqueStringIds([actorId, ...teamIds]);

  const directUserConditions = [
    buildInQuery("adminId", actorAndTeamIds),
    buildInQuery("recipientAdminId", actorAndTeamIds),
    buildInQuery("recipientId", actorAndTeamIds),
    buildInQuery("createdByAdminId", actorAndTeamIds),
    buildInQuery("actorAdminId", actorAndTeamIds),

    buildInQuery("recipientAdminIds", actorAndTeamIds),
    buildInQuery("recipientIds", actorAndTeamIds),
    buildInQuery("targetAdminIds", actorAndTeamIds),

    buildInQuery("metadata.adminId", actorAndTeamIds),
    buildInQuery("metadata.recipientAdminId", actorAndTeamIds),
    buildInQuery("metadata.createdByAdminId", actorAndTeamIds),
    buildInQuery("metadata.actorAdminId", actorAndTeamIds),
  ];

  const roleConditions = [
    { audienceRoles: { $in: [actorRole] } },
    { targetRoles: { $in: [actorRole] } },
    { recipientRoles: { $in: [actorRole] } },
  ];

  const brandConditions = [
    buildInQuery("brandId", brandIds),
    buildInQuery("brandIds", brandIds),
    buildInQuery("metadata.brandId", brandIds),
  ];

  const campaignConditions = [
    buildInQuery("campaignId", campaignIds),
    buildInQuery("campaignIds", campaignIds),
    buildInQuery("metadata.campaignId", campaignIds),
  ];

  const assignmentConditions = [
    buildInQuery("RHId", [actorId]),
    buildInQuery("rmId", [actorId]),
    buildInQuery("bdmId", actorAndTeamIds),
    buildInQuery("idmId", actorAndTeamIds),
    buildInQuery("sdrId", actorAndTeamIds),

    buildInQuery("metadata.RHId", [actorId]),
    buildInQuery("metadata.rmId", [actorId]),
    buildInQuery("metadata.bdmId", actorAndTeamIds),
    buildInQuery("metadata.idmId", actorAndTeamIds),
    buildInQuery("metadata.sdrId", actorAndTeamIds),
  ];

  return {
    $or: compactOr([
      isGlobalNotificationQuery(),
      ...directUserConditions,
      ...roleConditions,
      ...brandConditions,
      ...campaignConditions,
      ...assignmentConditions,
    ]),
  };
}

async function buildNotificationScopeQuery(actor = {}) {
  const actorId = normalizeId(actor?.adminId || actor?._id);
  const actorRole = normalizeRole(actor?.role);

  if (!actorId) {
    return {
      _id: { $in: [] },
    };
  }

  if (isAdminFullAccessRole(actorRole)) {
    return {};
  }

  if (actorRole === ROLES.REVENUE_HEAD || actorRole === "revenue_head" || actorRole === "rh") {
    const teamIds = await getRhTeamIds(actorId);
    const brandIds = await getRhBrandIds({
      rhId: actorId,
      teamIds,
    });

    const campaignIds = await getRhCampaignIds({
      rhId: actorId,
      teamIds,
      brandIds,
    });

    return buildNotificationFieldScope({
      actorId,
      actorRole: ROLES.REVENUE_HEAD,
      teamIds,
      brandIds,
      campaignIds,
    });
  }

  return buildNotificationFieldScope({
    actorId,
    actorRole,
    teamIds: [],
    brandIds: [],
    campaignIds: [],
  });
}

module.exports = {
  buildNotificationScopeQuery,
  isAdminFullAccessRole,
};