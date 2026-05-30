const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const saveErrorLog = require("../services/errorLog.service");

const { AdminModel, ROLES } = require("../models/master");
const Brand = require("../models/brand");
const { InfluencerModel: Influencer } = require("../models/influencer");
const { AgeRangeModel: AgeRange } = require("../models/ageRange");
const ContentLanguage = require("../models/language");
const { InfluencerTierModel: InfluencerTier } = require("../models/influencerTier");
const { ProductServiceGoalModel } = require("../models/productServiceGoal");
const { ContentFormatModel: ContentFormat } = require("../models/contentFormat");
const { PreferredHashtagModel: PreferredHashtag } = require("../models/preferredHashtag");
const Country = require("../models/country");
const { Category } = require("../models/categories");
const subscriptionHelper = require("../utils/subscriptionHelper");
const { sendSubscriptionLifecycleEmail } = require("../utils/subscriptionEmailHelper");
const crypto = require("crypto");
const BrandCoupon = require("../models/brandCoupon")

const Campaign = require("../models/campaign");
const Milestone = require("../models/milestone");
const Modash = require("../models/modash");
const Payment = require("../models/payment");
const MissingEmail = require("../models/MissingEmail");
const Invitation = require("../models/NewInvitations");
const SubscriptionPlan = require("../models/subscription");
const PortalSettings = require("../models/portalSettings");
const BrandAssigned = require("../models/brandAssigned");
const ApplyCampaign = require("../models/applyCampaign");
const CampaignAssigned = require("../models/CampaignAssigned");

const { createAndEmit } = require("../utils/notifier");

function getActorPayloadFromReq(req = {}) {
  const admin = req?.admin || req?.user || {};
  const actorAdminId = String(admin.adminId || admin._id || "").trim();

  return {
    actorAdminId: actorAdminId || null,
    actorName: String(admin.name || "").trim(),
    actorEmail: String(admin.email || "").trim().toLowerCase(),
    actorRole: String(admin.role || "").trim().toLowerCase(),
  };
}

async function notifySafely(context, reqOrPayload, maybePayload) {
  const hasReq = maybePayload !== undefined;
  const req = hasReq ? reqOrPayload : null;
  const payload = hasReq ? maybePayload : reqOrPayload;

  try {
    return await createAndEmit({
      ...getActorPayloadFromReq(req),
      ...(payload || {}),
    });
  } catch (error) {
    console.warn(`${context} notification failed:`, error?.message || error);
    return null;
  }
}

function toStringId(value) {
  return String(value || "").trim();
}

function uniqueCleanIds(values = []) {
  return [
    ...new Set(
      values
        .map((value) => toStringId(value))
        .filter(Boolean)
    ),
  ];
}

function objectIdVariants(value) {
  const id = toStringId(value);
  if (!id) return [];

  const variants = [id];

  if (mongoose.Types.ObjectId.isValid(id)) {
    variants.push(new mongoose.Types.ObjectId(id));
  }

  return variants;
}

async function getTeamUnderRevenueHeads(revenueHeadIds = []) {
  const rhIds = uniqueCleanIds(revenueHeadIds);
  const parentVariants = [];

  rhIds.forEach((id) => {
    parentVariants.push(...objectIdVariants(id));
  });

  if (!parentVariants.length) return [];

  const team = await AdminModel.find({
    status: "active",
    parentAdmin: { $in: parentVariants },
    role: { $in: [ROLES.BME, ROLES.IME, ROLES.SDR] },
  })
    .select("_id")
    .lean();

  return team.map((item) => String(item._id));
}

async function getBrandAdminNotificationRecipients(brandId) {
  const variants = objectIdVariants(brandId);
  if (!variants.length) return [];

  const assignments = await BrandAssigned.find({
    brandId: { $in: variants },
    status: "active",
  })
    .select("RHId bdmId idmId sdrId")
    .lean();

  const directIds = assignments.flatMap((assignment) => [
    assignment?.RHId,
    assignment?.bdmId,
    assignment?.idmId,
    assignment?.sdrId,
  ]);

  const rhIds = assignments.map((assignment) => assignment?.RHId).filter(Boolean);
  const teamIds = await getTeamUnderRevenueHeads(rhIds);

  return uniqueCleanIds([...directIds, ...teamIds]);
}

async function getCampaignAdminNotificationRecipients({ campaignId, brandId }) {
  const campaignVariants = objectIdVariants(campaignId);
  const brandRecipients = await getBrandAdminNotificationRecipients(brandId);

  if (!campaignVariants.length) return brandRecipients;

  const assignments = await CampaignAssigned.find({
    campaignId: { $in: campaignVariants },
    status: "active",
  })
    .select("RHId bdmId idmId")
    .lean();

  const directIds = assignments.flatMap((assignment) => [
    assignment?.RHId,
    assignment?.bdmId,
    assignment?.idmId,
  ]);

  const rhIds = assignments.map((assignment) => assignment?.RHId).filter(Boolean);
  const teamIds = await getTeamUnderRevenueHeads(rhIds);

  return uniqueCleanIds([...brandRecipients, ...directIds, ...teamIds]);
}

const BrandAssignedPlanHistory = require("../models/assignedPlanHistory");

const { BrandWalletModel } = require("../models/brandWallet");
const {
  syncCampaignFreeze,
  syncUsableBalance,
  ensureCampaignFreeze,
  getOrCreateWallet,
} = require("../controllers/brandWalletController");

const { _sendCampaignInvitationInternal } = require("../controllers/emailController");

const ASSIGNEE_MODEL = AdminModel;
const FULLY_MANAGED_PLAN_ID = "e5cb75da-6d0d-481b-b202-69b9cf864940";
const EMAIL_RX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;

void PortalSettings;
void BrandWalletModel;

const escapeRegex = (s = "") => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const toObjectId = (v) => new mongoose.Types.ObjectId(String(v));

function parsePositiveInt(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeSortOrder(value, fallback = "desc") {
  return String(value || fallback).toLowerCase() === "asc" ? "asc" : "desc";
}

function safeRegex(value = "") {
  const q = String(value || "").trim();
  if (!q) return null;
  return new RegExp(escapeRegex(q), "i");
}

function normalizeHandle(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  const withAt = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  return withAt.toLowerCase();
}

function featureValueToLimit(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && value.unlimited === true) return -1;
  return 0;
}

function buildAdminDisplay(admin = {}) {
  const name = String(admin?.name || "").trim();
  const email = String(admin?.email || "").trim();
  const adminRole = String(admin?.adminRole || "").trim();

  return {
    userId: admin?.userId ? String(admin.userId) : "",
    name,
    email,
    adminRole,
    label: name || email || "Admin",
  };
}

function formatAdminRoleLabel(role = "") {
  const normalized = String(role || "").trim().toLowerCase();

  if (normalized === ROLES.SUPER_ADMIN) return "Super Admin";
  if (normalized === ROLES.REVENUE_HEAD) return "RH";
  if (normalized === ROLES.BME) return "BME";
  if (normalized === ROLES.IME) return "IME";
  if (normalized === ROLES.SDR) return "SDR";

  return normalized ? normalized.replace(/_/g, " ").toUpperCase() : "Admin";
}

function buildCreatorPayload(doc = {}, adminMap = new Map(), selfLabel = "User") {
  const isAdminCreated = doc?.isAdminCreated === true;

  if (isAdminCreated) {
    const adminId = doc?.createdByAdmin ? String(doc.createdByAdmin) : "";
    const admin = adminId ? adminMap.get(adminId) : null;
    const adminRole = String(doc?.adminCreatedRole || admin?.role || "").trim();
    const adminName = String(admin?.name || "").trim();
    const adminEmail = String(admin?.email || "").trim();

    return {
      createdBySource: "admin",
      createdByLabel: adminName || adminEmail || "Admin",
      createdByAdminName: adminName,
      createdByAdminEmail: adminEmail,
      createdByAdminRole: adminRole,
      createdByRoleLabel: formatAdminRoleLabel(adminRole),
    };
  }

  return {
    createdBySource: selfLabel.toLowerCase(),
    createdByLabel: selfLabel,
    createdByAdminName: "",
    createdByAdminEmail: "",
    createdByAdminRole: "",
    createdByRoleLabel: "Self signup",
  };
}

function buildSignupCurrentStatus(doc = {}) {
  if (doc?.isAdminCreated === true && doc?.signupCompleted === false) {
    return {
      currentStatus: "pending_signup",
      currentStatusLabel: "Pending Signup",
      currentStatusSubLabel: "Admin-created placeholder",
    };
  }

  return {
    currentStatus: "active",
    currentStatusLabel: "Active",
    currentStatusSubLabel: "Signup completed",
  };
}

async function getAdminMapByIds(ids = []) {
  const objectIds = [...new Set(ids.map((id) => String(id || "")).filter(isObjectId))].map(toObjectId);

  if (!objectIds.length) return new Map();

  const admins = await AdminModel.find({ _id: { $in: objectIds } })
    .select("_id name email role")
    .lean();

  return new Map(admins.map((admin) => [String(admin._id), admin]));
}

async function enrichLiteCampaignCreatedBy(rows = []) {
  const adminIds = [
    ...new Set(
      rows
        .filter(
          (row) =>
            String(row?.createdBy?.role || "").toLowerCase() === "admin" &&
            isObjectId(row?.createdBy?.userId)
        )
        .map((row) => String(row.createdBy.userId))
    ),
  ];

  const adminDocs = adminIds.length
    ? await ASSIGNEE_MODEL.find({ _id: { $in: adminIds.map(toObjectId) } })
      .select("_id name email role")
      .lean()
    : [];

  const adminMap = new Map(
    adminDocs.map((admin) => [
      String(admin._id),
      {
        userId: String(admin._id),
        name: admin.name || "",
        email: admin.email || "",
        adminRole: admin.role || "",
        label: admin.name || admin.email || "Admin",
      },
    ])
  );

  return rows.map((row) => {
    const embeddedRole = String(row?.createdBy?.role || "").toLowerCase();

    if (embeddedRole !== "admin") {
      return {
        ...row,
        createdByAdmin: null,
      };
    }

    const embedded = buildAdminDisplay(row.createdBy);

    const resolved =
      embedded.name || embedded.email
        ? embedded
        : adminMap.get(String(row.createdBy.userId)) || embedded;

    return {
      ...row,
      createdByAdmin: resolved,
    };
  });
}

function buildSubscriptionFromPlan(plan, options = {}) {
  const now = new Date();

  const expiresAt = subscriptionHelper.computeExpiry(plan, {
    billingCycle: options.billingCycle || "monthly",
    durationDays: options.durationDays,
    durationMinutes: options.durationMinutes,
    durationMins: options.durationMins,
    expiresAt: options.expiresAt,
  });

  const featureSnapshot = (plan.features || []).map((feature) => ({
    key: feature.key,
    value: feature.value ?? null,
    limit: featureValueToLimit(feature.value),
    used: 0,
    note: feature.note ?? null,
    resetsEvery: null,
    resetsAt: null,
  }));

  return {
    planId: plan.planId,
    planName: plan.name,
    role: plan.role,
    planRef: plan._id,
    monthlyCost: plan.monthlyCost ?? 0,
    annualCost: plan.annualCost ?? 0,
    billingCycle: options.billingCycle || "monthly",
    autoRenew: plan.autoRenew ?? false,
    status: plan.status || "active",
    durationMins: plan.durationMins ?? 43200,
    startedAt: now,
    expiresAt,
    features: featureSnapshot,
    internalCredits: {
      used: 0,
      resetsAt: null,
    },
  };
}

function isExpiredDate(value) {
  if (!value) return false;
  const dt = new Date(value);
  return !Number.isNaN(dt.getTime()) && dt < new Date();
}

function isFullyManagedBrandDoc(doc = {}) {
  const subscription = doc.subscription || {};
  const planId = String(subscription.planId || "").trim();
  const planName = String(subscription.planName || "").toLowerCase().trim();
  const features = Array.isArray(subscription.features) ? subscription.features : [];

  if (planId === FULLY_MANAGED_PLAN_ID) return true;
  if (planName.includes("fully managed") || planName.includes("full managed")) return true;

  return features.some((feature) =>
    [
      "creator_sourcing_and_outreach",
      "shortlist_delivered",
      "negotiation_and_followups",
    ].includes(String(feature?.key || ""))
  );
}

function getStatusFromSubscription(doc = {}) {
  const subscription = doc.subscription || {};
  if (subscription.status) return subscription.status;
  return doc.subscriptionExpired || isExpiredDate(subscription.expiresAt) ? "expired" : "active";
}

async function getCampaignScopedBrandIdsForAdmin(actor = {}) {
  const role = String(actor?.role || "").trim().toLowerCase();
  const adminId = String(actor?.adminId || actor?._id || "").trim();

  if (!adminId) return [];

  // Super Admin can see all campaigns
  if (role === ROLES.SUPER_ADMIN) {
    return null;
  }

  let assignmentField = null;

  if (role === ROLES.REVENUE_HEAD) {
    assignmentField = "RHId";
  }

  if (role === ROLES.BME) {
    assignmentField = "bdmId";
  }

  if (!assignmentField) {
    return [];
  }

  const orConditions = [{ [assignmentField]: adminId }];

  if (mongoose.Types.ObjectId.isValid(adminId)) {
    orConditions.push({
      [assignmentField]: new mongoose.Types.ObjectId(adminId),
    });
  }

  const assignments = await BrandAssigned.find({
    status: "active",
    $or: orConditions,
  })
    .select("brandId")
    .lean();

  return assignments
    .map((item) => item.brandId)
    .filter(Boolean);
}

function getBrandFieldValue(brand, field) {
  switch (field) {
    case "name":
      return brand.name || brand.brandName || "";
    case "email":
      return brand.email || "";
    case "phone":
      return `${brand.callingcode || ""} ${brand.phone || ""}`.trim();
    case "planName":
      return brand.planName || brand.subscription?.planName || "";
    case "createdAt":
      return brand.createdAt || "";
    case "expiresAt":
      return brand.expiresAt || brand.subscription?.expiresAt || "";
    case "status":
      return brand.status || getStatusFromSubscription(brand) || "";
    case "createdBy":
      return brand.createdByLabel || brand.createdByAdminName || brand.createdByAdminEmail || "";
    case "currentStatus":
      return brand.currentStatusLabel || brand.currentStatus || "";
    case "assignedRh":
    case "assignedRm":
      return brand.assignedRh || brand.assignedRm || "";
    case "assignedBme":
    case "assignedBm":
      return brand.assignedBme || brand.assignedBm || "";
    case "assignedIme":
    case "assignedIm":
      return brand.assignedIme || brand.assignedIm || "";
    default:
      return brand?.[field] || "";
  }
}

function compareBrandRows(a, b, field, dir) {
  const dateFields = new Set(["createdAt", "expiresAt"]);
  const av = getBrandFieldValue(a, field);
  const bv = getBrandFieldValue(b, field);

  if (dateFields.has(field)) {
    const at = av ? new Date(av).getTime() : 0;
    const bt = bv ? new Date(bv).getTime() : 0;
    return (at - bt) * dir;
  }

  return String(av).localeCompare(String(bv), undefined, {
    numeric: true,
    sensitivity: "base",
  }) * dir;
}

async function findCampaignByAnyId(campaignId) {
  const id = String(campaignId || "").trim();
  if (!id) return null;

  if (isObjectId(id)) {
    const byMongoId = await Campaign.findById(id).lean();
    if (byMongoId) return byMongoId;
  }

  return Campaign.findOne({ campaignsId: id }).lean();
}

async function findModashByUserId(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;

  if (isObjectId(id)) {
    const byId = await Modash.findById(id).lean();
    if (byId) return byId;
  }

  return Modash.findOne({
    $or: [
      { userId: id },
      { modashUserId: id },
      { profileId: id },
      { providerUserId: id },
      { platformUserId: id },
      { "user.userId": id },
      { "profile.userId": id },
    ],
  }).lean();
}

function extractHandleFromModash(modashDoc) {
  const candidates = [
    modashDoc?.handle,
    modashDoc?.username,
    modashDoc?.userName,
    modashDoc?.providerUsername,
    modashDoc?.user?.username,
    modashDoc?.profile?.username,
    modashDoc?.profile?.handle,
  ].filter(Boolean);

  if (!candidates.length) return null;
  return normalizeHandle(candidates[0]);
}

async function enrichLiteCampaignBrandMeta(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const rowBrandKeys = [
    ...new Set(
      rows
        .map((row) => String(row?.brandId || "").trim())
        .filter(Boolean)
    ),
  ];

  const rowBrandObjectIds = rowBrandKeys
    .filter((id) => isObjectId(id))
    .map((id) => toObjectId(id));

  const brandLookupOr = [];

  if (rowBrandObjectIds.length) {
    brandLookupOr.push({ _id: { $in: rowBrandObjectIds } });
  }

  if (rowBrandKeys.length) {
    brandLookupOr.push({ brandId: { $in: rowBrandKeys } });
  }

  const brands = brandLookupOr.length
    ? await Brand.find({ $or: brandLookupOr })
      .select("_id brandId name brandName subscription.planName subscription.planId")
      .lean()
    : [];

  const brandMap = new Map();

  brands.forEach((brand) => {
    const meta = {
      brandMongoId: String(brand._id),
      brandName: brand.brandName || brand.name || "—",
      brandPlanName: brand?.subscription?.planName || "free",
      brandPlanId: brand?.subscription?.planId || "",
    };

    brandMap.set(String(brand._id), meta);

    if (brand.brandId) {
      brandMap.set(String(brand.brandId), meta);
    }
  });

  return rows.map((row) => {
    const meta = brandMap.get(String(row.brandId));

    return {
      ...row,
      brandMongoId: meta?.brandMongoId || String(row.brandId || ""),
      brandName: row.brandName || meta?.brandName || "—",
      brandPlanName: meta?.brandPlanName || row.brandPlanName || "free",
      brandPlanId: meta?.brandPlanId || row.brandPlanId || "",
    };
  });
}

async function enrichLiteCampaignAssignments(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const brandObjectIds = [
    ...new Set(
      rows
        .map((row) => String(row?.brandId || ""))
        .filter((id) => isObjectId(id))
    ),
  ].map((id) => toObjectId(id));

  const campaignObjectIds = [
    ...new Set(
      rows
        .map((row) => String(row?._id || ""))
        .filter((id) => isObjectId(id))
    ),
  ].map((id) => toObjectId(id));

  const brandAssignments = brandObjectIds.length
    ? await BrandAssigned.find({
      brandId: { $in: brandObjectIds },
      status: "active",
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
    : [];

  const campaignAssignments = campaignObjectIds.length
    ? await CampaignAssigned.find({
      campaignId: { $in: campaignObjectIds },
      status: "active",
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
    : [];

  const brandAssignmentMap = new Map();

  for (const assignment of brandAssignments) {
    const key = String(assignment.brandId);
    if (!brandAssignmentMap.has(key)) {
      brandAssignmentMap.set(key, assignment);
    }
  }

  const campaignAssignmentMap = new Map();

  for (const assignment of campaignAssignments) {
    const key = String(assignment.campaignId);
    if (!campaignAssignmentMap.has(key)) {
      campaignAssignmentMap.set(key, assignment);
    }
  }

  const assigneeIds = [
    ...new Set(
      [
        ...brandAssignments.flatMap((assignment) => [
          assignment?.RHId,
          assignment?.bdmId,
          assignment?.idmId,
          assignment?.sdrId,
        ]),
        ...campaignAssignments.flatMap((assignment) => [
          assignment?.RHId,
          assignment?.bdmId,
          assignment?.idmId,
        ]),
      ]
        .filter(Boolean)
        .map((id) => String(id))
        .filter((id) => isObjectId(id))
    ),
  ].map((id) => toObjectId(id));

  const assignees = assigneeIds.length
    ? await ASSIGNEE_MODEL.find({ _id: { $in: assigneeIds } })
      .select("_id name email role")
      .lean()
    : [];

  const assigneeMap = new Map();

  assignees.forEach((admin) => {
    assigneeMap.set(String(admin._id), admin.name || admin.email || "");
  });

  return rows.map((row) => {
    const brandAssignment =
      brandAssignmentMap.get(String(row.brandMongoId || row.brandId));
    const campaignAssignment = campaignAssignmentMap.get(String(row._id));

    const RHId = campaignAssignment?.RHId || brandAssignment?.RHId || null;
    const bdmId = campaignAssignment?.bdmId || brandAssignment?.bdmId || null;
    const idmId = campaignAssignment?.idmId || brandAssignment?.idmId || null;

    return {
      ...row,

      RHId,
      bdmId,
      idmId,

      assignedRh: RHId ? assigneeMap.get(String(RHId)) || "" : "",
      assignedBme: bdmId ? assigneeMap.get(String(bdmId)) || "" : "",
      assignedIme: idmId ? assigneeMap.get(String(idmId)) || "" : "",

      assignmentId: campaignAssignment?._id || brandAssignment?._id || null,
      assignmentStatus:
        campaignAssignment?.status || brandAssignment?.status || null,
    };
  });
}

async function getScopedCampaignAccessForAdmin(actor = {}) {
  const role = String(actor?.role || "").trim().toLowerCase();
  const adminId = String(actor?.adminId || actor?._id || "").trim();

  if (!adminId) {
    return {
      brandKeys: [],
      campaignIds: [],
    };
  }

  if (role === ROLES.SUPER_ADMIN) {
    return {
      brandKeys: null,
      campaignIds: null,
    };
  }

  // IME visibility is campaign-based, not brand-based.
  if (role === ROLES.IME) {
    const imeFilters = [{ idmId: adminId }];

    if (isObjectId(adminId)) {
      imeFilters.push({ idmId: toObjectId(adminId) });
    }

    const assignedCampaigns = await CampaignAssigned.find({
      status: "active",
      $or: imeFilters,
    })
      .select("campaignId")
      .lean();

    const campaignIds = [
      ...new Set(
        assignedCampaigns
          .map((item) => String(item?.campaignId || ""))
          .filter((id) => isObjectId(id))
      ),
    ].map((id) => toObjectId(id));

    return {
      brandKeys: null,
      campaignIds,
    };
  }

  // RH/BME visibility remains brand-based.
  const brandKeys = await getScopedCampaignBrandKeysForAdmin(actor);

  return {
    brandKeys,
    campaignIds: null,
  };
}

async function enrichBrandsWithAssignments(brandDocs = [], logId = "getAllBrands") {
  const enrichStart = Date.now();

  if (!Array.isArray(brandDocs) || brandDocs.length === 0) {
    console.log(`[${logId}] 5 enrichBrandsWithAssignments: 0ms | no brands`);
    return [];
  }

  const brandIds = brandDocs
    .map((brand) => brand?._id)
    .filter((id) => isObjectId(id))
    .map((id) => toObjectId(id));

  if (!brandIds.length) {
    console.log(
      `[${logId}] 5 enrichBrandsWithAssignments: ${Date.now() - enrichStart}ms | no valid brandIds`
    );
    return brandDocs;
  }

  const assignmentStart = Date.now();

  const assigneeCollectionName = ASSIGNEE_MODEL.collection.name;

  const assignments = await BrandAssigned.aggregate([
    {
      $match: {
        brandId: { $in: brandIds },
      },
    },
    {
      $addFields: {
        __isActive: {
          $eq: [
            {
              $toLower: {
                $ifNull: ["$status", ""],
              },
            },
            "active",
          ],
        },
      },
    },
    {
      $sort: {
        brandId: 1,
        __isActive: -1,
        updatedAt: -1,
        createdAt: -1,
      },
    },
    {
      $group: {
        _id: "$brandId",
        assignment: {
          $first: "$$ROOT",
        },
      },
    },
    {
      $replaceRoot: {
        newRoot: "$assignment",
      },
    },
    {
      $addFields: {
        assigneeIds: {
          $filter: {
            input: [
              {
                $convert: {
                  input: "$RHId",
                  to: "objectId",
                  onError: null,
                  onNull: null,
                },
              },
              {
                $convert: {
                  input: "$bdmId",
                  to: "objectId",
                  onError: null,
                  onNull: null,
                },
              },
              {
                $convert: {
                  input: "$idmId",
                  to: "objectId",
                  onError: null,
                  onNull: null,
                },
              },
              {
                $convert: {
                  input: "$sdrId",
                  to: "objectId",
                  onError: null,
                  onNull: null,
                },
              },
            ],
            as: "id",
            cond: {
              $ne: ["$$id", null],
            },
          },
        },
      },
    },
    {
      $lookup: {
        from: assigneeCollectionName,
        localField: "assigneeIds",
        foreignField: "_id",
        as: "assignees",
      },
    },
    {
      $project: {
        __isActive: 0,
        assigneeIds: 0,
        password: 0,
        __v: 0,
      },
    },
  ]);

  console.log(
    `[${logId}] 5.1 BrandAssigned + ASSIGNEE lookup: ${Date.now() - assignmentStart
    }ms | assignments=${assignments.length}`
  );

  const assignmentMap = new Map();

  for (const assignment of assignments) {
    assignmentMap.set(String(assignment.brandId), assignment);
  }

  const result = brandDocs.map((brand) => {
    const assignment = assignmentMap.get(String(brand._id));
    const subscription = brand.subscription || {};

    const expiresAt = subscription.expiresAt || null;
    const subscriptionExpired =
      Boolean(brand.subscriptionExpired) || isExpiredDate(expiresAt);

    const status =
      subscription.status || (subscriptionExpired ? "expired" : "active");

    const assigneeMap = {};

    if (Array.isArray(assignment?.assignees)) {
      assignment.assignees.forEach((assignee) => {
        assigneeMap[String(assignee._id)] =
          assignee.name || assignee.email || "";
      });
    }

    const assignedRh = assignment?.RHId
      ? assigneeMap[String(assignment.RHId)] || ""
      : "";

    const assignedBme = assignment?.bdmId
      ? assigneeMap[String(assignment.bdmId)] || ""
      : "";

    const assignedIme = assignment?.idmId
      ? assigneeMap[String(assignment.idmId)] || ""
      : "";

    const assignedSdr = assignment?.sdrId
      ? assigneeMap[String(assignment.sdrId)] || ""
      : "";

    return {
      ...brand,
      planName: subscription.planName || "free",
      expiresAt,
      status,
      subscriptionExpired,

      assignedRh,
      assignedBme,
      assignedIme,
      assignedSdr,

      assignedRm: assignedRh,
      assignedBm: assignedBme,
      assignedIm: assignedIme,

      fullyManagedSubscription: isFullyManagedBrandDoc(brand),

      assignmentId: assignment?._id || null,
      assignmentStatus: assignment?.status || null,

      RHId: assignment?.RHId || null,
      bdmId: assignment?.bdmId || null,
      idmId: assignment?.idmId || null,
      sdrId: assignment?.sdrId || null,
    };
  });

  console.log(
    `[${logId}] 5 enrichBrandsWithAssignments total: ${Date.now() - enrichStart
    }ms | brands=${brandDocs.length}`
  );

  return result;
}

async function getScopedCampaignBrandKeysForAdmin(actor = {}) {
  const scopedBrandObjectIds = await getCampaignScopedBrandIdsForAdmin(actor);

  if (scopedBrandObjectIds === null) return null;

  if (!Array.isArray(scopedBrandObjectIds) || !scopedBrandObjectIds.length) {
    return [];
  }

  const brands = await Brand.find({
    _id: { $in: scopedBrandObjectIds },
  })
    .select("_id brandId")
    .lean();

  const keys = new Set();

  for (const brand of brands) {
    if (brand?._id) keys.add(String(brand._id));
    if (brand?.brandId) keys.add(String(brand.brandId));
  }

  return [...keys];
}

function getCampaignSortField(sortBy) {
  const map = {
    campaignTitle: "campaignTitle",
    name: "campaignTitle",
    goal: "goal",
    startDate: "timeline.startDate",
    endDate: "timeline.endDate",
    budget: "budget",
    applicantCount: "applicantCount",
    isActive: "isActive",
    createdAt: "createdAt",
  };

  return map[sortBy] || "createdAt";
}

function buildCampaignBaseFilter({ search, statusFlag, brandKeys, requestedBrandId }) {
  const filter = {};

  if (Array.isArray(brandKeys)) {
    if (!brandKeys.length) {
      filter.brandId = { $in: [] };
      return filter;
    }

    filter.brandId = { $in: brandKeys };
  }

  if (requestedBrandId) {
    const requested = String(requestedBrandId).trim();

    if (filter.brandId?.$in) {
      if (!filter.brandId.$in.includes(requested)) {
        filter.brandId = { $in: [] };
        return filter;
      }
      filter.brandId = requested;
    } else {
      filter.brandId = requested;
    }
  }

  if (statusFlag === 1) filter.isActive = 1;
  if (statusFlag === 2) filter.isActive = 0;

  const re = safeRegex(search);
  if (re) {
    filter.$or = [
      { campaignTitle: re },
      { productOrServiceName: re },
      { brandName: re },
      { description: re },
      { goal: re },
    ];
  }

  return filter;
}

async function buildFullyManagedCampaignOrFilter() {
  const histories = await BrandAssignedPlanHistory.find({
    $or: [
      { planId: FULLY_MANAGED_PLAN_ID },
      { newPlanName: /fully managed/i },
      { newPlanName: /full managed/i },
    ],
    status: { $ne: "cancelled" },
  })
    .select("brandId planId newPlanName startedAt expiresAt createdAt")
    .lean();

  const historyCampaignFilters = histories
    .map((history) => {
      if (!history?.brandId) return null;

      const startedAt = history.startedAt || history.createdAt;
      if (!startedAt) return null;

      const createdAt = {
        $gte: new Date(startedAt),
      };

      if (history.expiresAt) {
        createdAt.$lte = new Date(history.expiresAt);
      }

      const brandIds = [String(history.brandId)];

      if (mongoose.Types.ObjectId.isValid(String(history.brandId))) {
        brandIds.push(new mongoose.Types.ObjectId(String(history.brandId)));
      }

      return {
        brandId: { $in: brandIds },
        createdAt,
      };
    })
    .filter(Boolean);

  return [
    // Admin-created campaign = fully managed
    { "createdBy.role": "admin" },
    { "createdBy.userModel": "Master" },
    { approvalMode: "admin_review" },

    // New snapshot fields for future/current campaigns
    { brandWasFullyManagedAtCreation: true },
    { "brandSubscriptionSnapshot.wasFullyManaged": true },
    { isFullyManaged: true },
    { managementType: "fully_managed" },

    // Old campaigns fallback using Fully Managed assigned-plan history window
    ...historyCampaignFilters,
  ];
}

async function applyFullyManagedCampaignFilter(filter) {
  const fullyManagedOrFilter = await buildFullyManagedCampaignOrFilter();

  if (!fullyManagedOrFilter.length) {
    filter._id = { $in: [] };
    return filter;
  }

  filter.$and = Array.isArray(filter.$and) ? filter.$and : [];
  filter.$and.push({ $or: fullyManagedOrFilter });

  return filter;
}

function toCampaignSummary(doc = {}) {
  const fullyManaged =
    String(doc.createdBy?.role || "").toLowerCase() === "admin" ||
    String(doc.createdBy?.userModel || "").toLowerCase() === "master" ||
    String(doc.approvalMode || "").toLowerCase() === "admin_review" ||
    Boolean(doc.isFullyManaged) ||
    Boolean(doc.brandWasFullyManagedAtCreation) ||
    Boolean(doc.brandSubscriptionSnapshot?.wasFullyManaged) ||
    String(doc.managementType || "").toLowerCase() === "fully_managed";

  return {
    _id: doc._id,
    brandId: doc.brandId || "",
    brandName: doc.brandName || "—",
    brandPlanName: doc.brandPlanName || "free",
    campaignId: doc.campaignsId || String(doc._id || ""),
    name: doc.campaignTitle || doc.productOrServiceName || "—",
    startDate: doc.timeline?.startDate || null,
    endDate: doc.timeline?.endDate || null,
    budget: Number(doc.budget || 0),
    goal: doc.goal || "",
    applicantCount: Number(doc.applicantCount || 0),
    isActive: Number(doc.isActive || 0),
    isDraft: Number(doc.isDraft || 0),
    campaignStatus: doc.campaignStatus || "",
    byAi: Number(doc.byAi || 0),
    createdByAdmin: doc.createdByAdmin || null,

    brandPlanId: doc.brandPlanId || "",
    fullyManaged,
    isFullyManaged: fullyManaged,
    managementType: fullyManaged ? "fully_managed" : "self_serve",
    brandWasFullyManagedAtCreation: Boolean(doc.brandWasFullyManagedAtCreation),
    brandSubscriptionSnapshot: doc.brandSubscriptionSnapshot || null,

    assignedRh: doc.assignedRh || "",
    assignedBme: doc.assignedBme || "",
    assignedIme: doc.assignedIme || "",

    RHId: doc.RHId || null,
    bdmId: doc.bdmId || null,
    idmId: doc.idmId || null,

    assignmentId: doc.assignmentId || null,
    assignmentStatus: doc.assignmentStatus || null,
  };
}

exports.adminAssignBrandPlan = async (req, res) => {
  try {
    const brandId = String(req.body?.brandId || req.body?._id || "").trim();
    const planId = String(req.body?.planId || "").trim();
    const billingCycle = String(req.body?.billingCycle || "monthly").trim();

    const durationDays = req.body?.durationDays;
    const durationMinutes = req.body?.durationMinutes;
    const durationMins = req.body?.durationMins;
    const expiresAt = req.body?.expiresAt;

    if (!brandId || !planId) {
      return res.status(400).json({
        message: "brandId and planId required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(brandId)) {
      return res.status(400).json({
        message: "Valid brand _id required",
      });
    }

    const existingBrand = await Brand.findById(brandId)
      .select("_id brandName name email proxyEmail subscription subscriptionExpired")
      .lean();

    if (!existingBrand) {
      return res.status(404).json({
        message: "Brand not found",
      });
    }

    const plan = await SubscriptionPlan.findOne({
      planId,
      role: "Brand",
      status: "active",
    }).lean();

    if (!plan) {
      return res.status(404).json({
        message: "Brand plan not found/archived",
      });
    }

    const oldPlanName =
      existingBrand?.subscription?.planName ||
      (existingBrand?.subscriptionExpired ? "expired" : "free");

    const subscription = buildSubscriptionFromPlan(plan, {
      billingCycle,
      durationDays,
      durationMinutes,
      durationMins,
      expiresAt,
    });

    subscription.lastExpiringSoonEmailSentAt = null;
    subscription.lastExpiredEmailSentAt = null;

    const updated = await Brand.findByIdAndUpdate(
      brandId,
      {
        $set: {
          subscription,
          subscriptionExpired: false,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    )
      .select("_id brandName name email proxyEmail subscription subscriptionExpired")
      .lean();

    if (!updated) {
      return res.status(404).json({
        message: "Brand not found",
      });
    }

    const rawAdminId = String(req.admin?.adminId || req.admin?._id || "").trim();

    const assignedByAdminId = mongoose.Types.ObjectId.isValid(rawAdminId)
      ? new mongoose.Types.ObjectId(rawAdminId)
      : null;

    const assignedPlanHistory = await BrandAssignedPlanHistory.create({
      brandId: updated._id,

      planId: plan.planId,

      oldPlanName,
      newPlanName: subscription.planName,

      billingCycle: subscription.billingCycle || billingCycle,

      startedAt: subscription.startedAt || new Date(),
      expiresAt: subscription.expiresAt || null,

      durationDays: durationDays || null,

      assignedByAdminId,
      assignedByAdminEmail: req.admin?.email || "",

      source: "admin_manual",
      status: "assigned",
    });

    await sendSubscriptionLifecycleEmail({
      userType: "Brand",
      user: updated,
      plan,
      oldPlanName,
      eventType: "upgraded",
    });

    await notifySafely("adminAssignBrandPlan", req, {
      brandId: String(updated._id),
      adminIds: await getBrandAdminNotificationRecipients(updated._id),
      type: "brand.plan_assigned",
      title: "Brand plan assigned",
      message: `${updated.brandName || updated.name || "Brand"} was assigned ${subscription.planName}.`,
      entityType: "brand",
      entityId: String(updated._id),
      actionPath: {
        brand: "/brand/subscription",
        admin: `/admin/brands/view?brandId=${updated._id}`,
      },
    });

    return res.json({
      status: "success",
      message: `Brand plan assigned successfully. Email notification sent to ${updated.email || updated.proxyEmail || "brand user"
        }.`,
      brand: {
        ...updated,
        brandId: String(updated._id),
      },
      assignedPlanHistory,
    });
  } catch (error) {
    console.error("adminAssignBrandPlan error:", error);
    await saveErrorLog(req, error, 500, "ADMIN_ASSIGN_BRAND_PLAN_ERROR");
    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.adminAssignInfluencerPlan = async (req, res) => {
  try {
    const influencerMongoId = String(
      req.body?._id || req.body?.id || req.body?.influencerId || ""
    ).trim();
    const planId = String(req.body?.planId || "").trim();

    const durationDays = req.body?.durationDays;
    const durationMinutes = req.body?.durationMinutes;
    const durationMins = req.body?.durationMins;
    const expiresAt = req.body?.expiresAt;

    if (!influencerMongoId || !planId) {
      return res.status(400).json({ message: "influencer _id and planId required" });
    }

    if (!isObjectId(influencerMongoId)) {
      return res.status(400).json({ message: "Valid influencer _id required" });
    }

    const existingInfluencer = await Influencer.findById(influencerMongoId)
      .select("_id name email proxyEmail subscription subscriptionExpired")
      .lean();

    if (!existingInfluencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const plan = await SubscriptionPlan.findOne({
      planId,
      role: "Influencer",
      status: "active",
    }).lean();

    if (!plan) {
      return res.status(404).json({ message: "Influencer plan not found/archived" });
    }

    const oldPlanName =
      existingInfluencer?.subscription?.planName ||
      (existingInfluencer?.subscriptionExpired ? "expired" : "free");

    const subscription = buildSubscriptionFromPlan(plan, {
      billingCycle: "monthly",
      durationDays,
      durationMinutes,
      durationMins,
      expiresAt,
    });

    subscription.lastExpiringSoonEmailSentAt = null;
    subscription.lastExpiredEmailSentAt = null;

    const updated = await Influencer.findByIdAndUpdate(
      influencerMongoId,
      {
        $set: {
          subscription,
          subscriptionExpired: false,
        },
      },
      { new: true, runValidators: true }
    )
      .select("_id name email proxyEmail subscription subscriptionExpired")
      .lean();

    if (!updated) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    await sendSubscriptionLifecycleEmail({
      userType: "Influencer",
      user: updated,
      plan,
      oldPlanName,
      eventType: "upgraded",
    });

    await notifySafely("adminAssignInfluencerPlan", req, {
      influencerId: String(updated._id),
      type: "influencer.plan_assigned",
      title: "Influencer plan assigned",
      message: `${updated.name || "Influencer"} was assigned ${subscription.planName}.`,
      entityType: "influencer",
      entityId: String(updated._id),
      actionPath: {
        influencer: "/influencer/subscription",
        admin: `/admin/influencers/view?influencerId=${updated._id}`,
      },
    });

    return res.json({
      status: "success",
      message: `Influencer plan assigned successfully. Email notification sent to ${updated.email || updated.proxyEmail || "influencer"}.`,
      influencer: updated,
    });
  } catch (error) {
    console.error("adminAssignInfluencerPlan error:", error);
    await saveErrorLog(req, error, 500, "ADMIN_ASSIGN_INFLUENCER_PLAN_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.login = async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({
        message: "email and password are required",
      });
    }

    const admin = await AdminModel.findOne({ email }).select(
      "+passwordHash email name role status access parentAdmin rootAdmin proxyEmail"
    );

    if (!admin) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (admin.status !== "active") {
      return res.status(403).json({
        message: `Admin is ${admin.status}`,
      });
    }

    if (!admin.passwordHash) {
      return res.status(403).json({
        message: "Password not set. Please use invite link.",
      });
    }

    const isMatch = await bcrypt.compare(password, admin.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        adminId: String(admin._id),
        email: admin.email,
        role: admin.role,
        parentAdmin: admin.parentAdmin ? String(admin.parentAdmin) : null,
        rootAdmin: admin.rootAdmin ? String(admin.rootAdmin) : null,
      },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    return res.json({
      message: "Login successful",
      token,
      admin: {
        _id: admin._id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        status: admin.status,
        access: admin.access || [],
        parentAdmin: admin.parentAdmin,
        rootAdmin: admin.rootAdmin,
        proxyEmail: admin.proxyEmail || null,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    await saveErrorLog(req, error, 500, "LOGIN_ERROR");
    return res.status(500).json({ message: "Server error" });
  }
};

exports.verifyAdminToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(403).json({ message: "Token required" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(403).json({ message: "Token required" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: "Invalid or expired token" });
    }

    req.admin = decoded;
    return next();
  });
};

async function resolveActorFromMaster(actor = {}) {
  let adminId = String(actor?.adminId || actor?._id || "").trim();
  let email = String(actor?.email || "").trim().toLowerCase();
  let role = String(actor?.role || "").trim().toLowerCase();

  const validRoles = new Set(Object.values(ROLES));

  const mustResolve =
    !adminId ||
    !isObjectId(adminId) ||
    !role ||
    !validRoles.has(role);

  if (!mustResolve) {
    return { adminId, email, role };
  }

  const or = [];
  if (isObjectId(adminId)) or.push({ _id: toObjectId(adminId) });
  if (email) or.push({ email });

  if (!or.length) {
    return { adminId: "", email, role: "" };
  }

  const masterAdmin = await AdminModel.findOne({ $or: or })
    .select("_id email role parentAdmin rootAdmin")
    .lean();

  if (!masterAdmin) {
    return { adminId: "", email, role: "" };
  }

  return {
    adminId: String(masterAdmin._id),
    email: String(masterAdmin.email || "").toLowerCase(),
    role: String(masterAdmin.role || "").trim().toLowerCase(),
  };
}

async function getScopedBrandIdsForAdmin(actor = {}) {
  const role = String(actor?.role || "").trim().toLowerCase();
  const adminId = String(actor?.adminId || actor?._id || "").trim();

  if (!adminId) return [];

  if (role === ROLES.SUPER_ADMIN) {
    return null;
  }

  const roleToField = {
    [ROLES.REVENUE_HEAD]: "RHId",
    [ROLES.BME]: "bdmId",
  };

  const assignmentField = roleToField[role];

  if (!assignmentField) {
    return [];
  }

  const assigneeFilters = [{ [assignmentField]: adminId }];

  if (isObjectId(adminId)) {
    assigneeFilters.push({ [assignmentField]: toObjectId(adminId) });
  }

  const assignments = await BrandAssigned.find({
    status: "active",
    $or: assigneeFilters,
  })
    .select("brandId")
    .lean();

  return assignments
    .map((item) => String(item.brandId || ""))
    .filter((id) => isObjectId(id))
    .map((id) => toObjectId(id));
}

exports.getAllBrands = async (req, res) => {
  const logId = `getAllBrands-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;

  const totalStart = Date.now();

  try {
    console.log(`[${logId}] START`);

    const parseStart = Date.now();

    const page = parsePositiveInt(req.body?.page, 1);
    const limit = Math.min(parsePositiveInt(req.body?.limit, 10), 100);
    const skip = (page - 1) * limit;

    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "desc");
    const dir = sortOrder === "asc" ? 1 : -1;

    console.log(`[${logId}] 1 parse: ${Date.now() - parseStart}ms`);

    const actor = req.admin || {};
    const actorRole = String(actor?.role || "").trim().toLowerCase();
    const actorId = String(actor?.adminId || actor?._id || "").trim();

    const brandQuery = {};

    const bmeStart = Date.now();

    if (actorRole === ROLES.BME) {
      if (!actorId) {
        console.log(
          `[${logId}] 2 BME assignment filter: ${Date.now() - bmeStart}ms | no actorId`
        );
        console.log(
          `[${logId}] TOTAL getAllBrands: ${Date.now() - totalStart}ms`
        );

        return res.status(200).json({
          page,
          limit,
          total: 0,
          totalPages: 1,
          sortBy,
          sortOrder,
          brands: [],
        });
      }

      const bmeFilters = [{ bdmId: actorId }];

      if (isObjectId(actorId)) {
        bmeFilters.push({ bdmId: toObjectId(actorId) });
      }

      const bmeQueryStart = Date.now();

      const assignments = await BrandAssigned.find({
        status: "active",
        $or: bmeFilters,
      })
        .select("brandId")
        .lean();

      console.log(
        `[${logId}] 2.1 BME BrandAssigned query: ${Date.now() - bmeQueryStart
        }ms | assignments=${assignments.length}`
      );

      const assignedBrandIds = assignments
        .map((item) => String(item.brandId || ""))
        .filter((id) => isObjectId(id))
        .map((id) => toObjectId(id));

      if (!assignedBrandIds.length) {
        console.log(
          `[${logId}] 2 BME assignment filter: ${Date.now() - bmeStart}ms | no assigned brands`
        );
        console.log(
          `[${logId}] TOTAL getAllBrands: ${Date.now() - totalStart}ms`
        );

        return res.status(200).json({
          page,
          limit,
          total: 0,
          totalPages: 1,
          sortBy,
          sortOrder,
          brands: [],
        });
      }

      brandQuery._id = { $in: assignedBrandIds };
    }

    console.log(
      `[${logId}] 2 BME assignment filter: ${Date.now() - bmeStart}ms`
    );

    const searchStart = Date.now();

    if (search) {
      const re = safeRegex(search);

      if (re) {
        brandQuery.$or = [
          { name: re },
          { brandName: re },
          { email: re },
          { phone: re },
          { callingcode: re },
          { companySize: re },
          { industry: re },
          { planName: re },
          { status: re },
          { region: re },
          { preferredLanguage: re },
          { currencyFormat: re },
        ];
      }
    }

    console.log(
      `[${logId}] 3 search build: ${Date.now() - searchStart}ms | search="${search}"`
    );

    const allowedDbSortFields = new Set([
      "name",
      "brandName",
      "email",
      "phone",
      "planName",
      "createdAt",
      "expiresAt",
      "status",
      "companySize",
      "industry",
    ]);

    const field = allowedDbSortFields.has(sortBy) ? sortBy : "createdAt";

    const sortQuery =
      field === "createdAt"
        ? { createdAt: dir, _id: -1 }
        : { [field]: dir, createdAt: -1, _id: -1 };

    const brandStart = Date.now();

    const canUseFastTotal =
      !search && actorRole !== ROLES.BME && Object.keys(brandQuery).length === 0;

    const brandFindPromise = Brand.find(brandQuery)
      .select("-password -__v -profilePic")
      .sort(sortQuery)
      .skip(skip)
      .limit(limit)
      .lean();

    const totalPromise = canUseFastTotal
      ? Brand.estimatedDocumentCount()
      : Brand.countDocuments(brandQuery);

    const [rawBrands, total] = await Promise.all([
      brandFindPromise,
      totalPromise,
    ]);

    console.log(
      `[${logId}] 4 Brand find + total: ${Date.now() - brandStart
      }ms | rawBrands=${rawBrands.length} | total=${total} | fastTotal=${canUseFastTotal}`
    );

    const creatorAdminIds = rawBrands
      .filter((brand) => brand?.isAdminCreated === true)
      .map((brand) => brand?.createdByAdmin)
      .filter(Boolean);

    const enrichAdminStart = Date.now();

    const enrichedBrandsPromise = enrichBrandsWithAssignments(rawBrands, logId);

    const adminStart = Date.now();

    const adminMapPromise = creatorAdminIds.length
      ? getAdminMapByIds(creatorAdminIds)
      : Promise.resolve(new Map());

    const [enrichedBrands, adminMap] = await Promise.all([
      enrichedBrandsPromise,
      adminMapPromise,
    ]);

    console.log(
      `[${logId}] 5 + 6 enrich/admin parallel wait: ${Date.now() - enrichAdminStart
      }ms`
    );

    console.log(
      `[${logId}] 6 getAdminMapByIds approx: ${Date.now() - adminStart
      }ms | ids=${creatorAdminIds.length}`
    );

    const mapStart = Date.now();

    const brands = enrichedBrands.map((brand) => ({
      ...brand,
      ...buildCreatorPayload(brand, adminMap, "Brand"),
      ...buildSignupCurrentStatus(brand),
    }));

    console.log(`[${logId}] 7 final map: ${Date.now() - mapStart}ms`);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    console.log(
      `[${logId}] TOTAL getAllBrands: ${Date.now() - totalStart}ms`
    );

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages,
      sortBy: field,
      sortOrder,
      brands,
    });
  } catch (error) {
    console.error(`[${logId}] Error in getAllBrands:`, error);
    await saveErrorLog(req, error, 500, "GET_ALL_BRANDS_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getList = async (req, res) => {
  try {
    const page = parsePositiveInt(req.body?.page, 1);
    const limit = parsePositiveInt(req.body?.limit, 10);
    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "name").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "asc");

    const filter = {};
    const re = safeRegex(search);

    if (re) {
      filter.$or = [
        { name: re },
        { email: re },
        { countryName: re },
        { proxyEmail: re },
      ];
    }

    const total = await Influencer.countDocuments(filter);
    const allowedSortFields = new Set(["name", "email", "countryName", "createdAt"]);
    const field = allowedSortFields.has(sortBy) ? sortBy : "name";
    const dir = sortOrder === "desc" ? -1 : 1;

    const influencers = await Influencer.find(filter)
      .select("-password -__v")
      .sort({ [field]: dir })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      influencers,
    });
  } catch (error) {
    console.error("Error fetching influencers:", error);
    await saveErrorLog(req, error, 500, "GET_LIST_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getAllCampaigns = async (req, res) => {
  try {
    const page = parsePositiveInt(req.body?.page, 1);
    const limit = parsePositiveInt(req.body?.limit, 10);
    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "desc");
    const statusFlag = Number.parseInt(req.body?.type, 10) || 0;
    const brandId = String(req.body?.brandId || "").trim();
    const actor = req.admin || {};
    const scopedAccess = await getScopedCampaignAccessForAdmin(actor);

    const filter = buildCampaignBaseFilter({
      search,
      statusFlag,
      brandKeys: scopedAccess.brandKeys,
      requestedBrandId: brandId,
    });

    if (Array.isArray(scopedAccess.campaignIds)) {
      filter._id = { $in: scopedAccess.campaignIds };
    }

    const field = getCampaignSortField(sortBy);
    const dir = sortOrder === "asc" ? 1 : -1;

    const total = await Campaign.countDocuments(filter);

    const campaigns = await Campaign.find(filter)
      .select("-__v")
      .sort({ [field]: dir, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      status: statusFlag,
      sortBy,
      sortOrder,
      campaigns,
    });
  } catch (error) {
    console.error("Error in getAllCampaigns:", error);
    await saveErrorLog(req, error, 500, "GET_ALL_CAMPAIGNS_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getBrandById = async (req, res) => {
  try {
    const id = String(req.query?.id || "").trim();

    if (!id) {
      return res.status(400).json({
        message: "Query parameter id is required.",
      });
    }

    if (!isObjectId(id)) {
      return res.status(400).json({
        message: "Invalid brand _id.",
      });
    }

    const brandDoc = await Brand.findById(id)
      .select("-password -__v")
      .lean();

    if (!brandDoc) {
      return res.status(404).json({
        message: "Brand not found.",
      });
    }

    const [enrichedBrand] = await enrichBrandsWithAssignments([brandDoc]);

    const milestoneDoc = await Milestone.findOne({
      brandId: brandDoc.brandId,
    }).lean();

    const walletBalance = milestoneDoc ? milestoneDoc.walletBalance : 0;

    const brandCouponHistory = await BrandCoupon.find({
      brandId: brandDoc._id,
    })
      .populate({
        path: "subscriptionId",
        select: "name title price duration description",
      })
      .select("-__v")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      ...enrichedBrand,
      walletBalance,
      brandCouponHistory,
    });
  } catch (error) {
    console.error("Error in getBrandById:", error);
    await saveErrorLog(req, error, 500, "GET_BRAND_BY_ID_ERROR");

    return res.status(500).json({
      message: "Internal server error while fetching brand.",
    });
  }
};

exports.getByInfluencerId = async (req, res) => {
  try {
    const id = String(req.query?.id || "").trim();

    if (!id) {
      return res.status(400).json({ message: "Query parameter id is required." });
    }

    if (!isObjectId(id)) {
      return res.status(400).json({ message: "Invalid influencer _id." });
    }

    const influencer = await Influencer.findById(id)
      .select("-password -__v")
      .lean();

    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const modashProfiles = await Modash.find(
      {
        $or: [
          { influencer: influencer._id },
          { influencerId: String(influencer._id) },
        ],
      },
      "-__v -providerRaw"
    ).lean();

    return res.status(200).json({
      influencer,
      modash: modashProfiles,
    });
  } catch (error) {
    console.error("Error fetching influencer & Modash by ID:", error);
    await saveErrorLog(req, error, 500, "GET_BY_INFLUENCER_ID_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id));

const toObjectIds = (ids = []) => {
  return [...new Set(ids.map((id) => String(id)).filter(isValidObjectId))].map(
    (id) => new mongoose.Types.ObjectId(id)
  );
};

const getDocById = async (Model, id) => {
  if (!Model || !id || !isValidObjectId(id)) return null;
  return await Model.findById(id).lean();
};

const getDocsByIds = async (Model, ids = []) => {
  if (!Model || !Array.isArray(ids) || !ids.length) return [];

  const objectIds = toObjectIds(ids);
  if (!objectIds.length) return [];

  const docs = await Model.find({ _id: { $in: objectIds } }).lean();
  const docsMap = new Map(docs.map((doc) => [String(doc._id), doc]));

  return ids.map((id) => docsMap.get(String(id))).filter(Boolean);
};

const buildSubcategoryDetails = (categoryDoc, subcategoryIds = []) => {
  if (!categoryDoc || !Array.isArray(subcategoryIds)) return [];

  const nestedSubcategories =
    categoryDoc.subcategories ||
    categoryDoc.subcategory ||
    categoryDoc.children ||
    [];

  if (Array.isArray(nestedSubcategories) && nestedSubcategories.length) {
    const subMap = new Map(
      nestedSubcategories.map((sub) => [String(sub._id), sub])
    );

    return subcategoryIds
      .map((id) => {
        const sub = subMap.get(String(id));
        if (!sub) return null;

        return {
          _id: sub._id,
          name: sub.name || sub.subcategoryName || "",
          categoryId: categoryDoc._id,
          categoryName: categoryDoc.name || categoryDoc.categoryName || "",
          ...sub,
        };
      })
      .filter(Boolean);
  }

  return [];
};

exports.getCampaignById = async (req, res) => {
  try {
    const id = String(
      req.query?.id || req.body?.campaignId || req.body?._id || ""
    ).trim();

    if (!id) {
      return res.status(400).json({
        message: "Query parameter id or body campaignId is required.",
      });
    }

    const actor = req.admin || {};
    const scopedAccess = await getScopedCampaignAccessForAdmin(actor);

    const filter = {
      $or: [{ campaignsId: id }],
    };

    if (mongoose.Types.ObjectId.isValid(id)) {
      filter.$or.push({ _id: new mongoose.Types.ObjectId(id) });
    }

    // RH / BME brand-based visibility
    if (Array.isArray(scopedAccess.brandKeys)) {
      if (!scopedAccess.brandKeys.length) {
        return res.status(404).json({ message: "Campaign not found." });
      }

      filter.brandId = { $in: scopedAccess.brandKeys };
    }

    // IME campaign-based visibility
    if (Array.isArray(scopedAccess.campaignIds)) {
      if (!scopedAccess.campaignIds.length) {
        return res.status(404).json({ message: "Campaign not found." });
      }

      filter._id = { $in: scopedAccess.campaignIds };
    }

    const campaign = await Campaign.findOne(filter).lean();

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found." });
    }

    const categoryDetails = await getDocById(Category, campaign.categoryId);

    const [
      campaignGoalDetails,
      influencerTierDetails,
      contentFormatDetails,
      contentLanguageDetails,
      preferredHashtagDetails,
      targetCountryDetails,
      targetAgeRangeDetails,
    ] = await Promise.all([
      getDocsByIds(ProductServiceGoalModel, campaign.campaignGoals),
      getDocsByIds(InfluencerTier, campaign.influencerTierIds),
      getDocsByIds(ContentFormat, campaign.contentFormats),
      getDocsByIds(ContentLanguage, campaign.contentLanguageIds),
      getDocsByIds(PreferredHashtag, campaign.preferredHashtags),
      getDocsByIds(Country, campaign.targetCountryIds),
      getDocsByIds(AgeRange, campaign.targetAgeRanges),
    ]);

    let subcategoryDetails = buildSubcategoryDetails(
      categoryDetails,
      campaign.subcategoryIds || []
    );

    if (!subcategoryDetails.length && Array.isArray(campaign.categories)) {
      subcategoryDetails = campaign.categories.map((item) => ({
        _id: item.subcategoryId,
        name: item.subcategoryName,
        categoryId: item.categoryId,
        categoryName: item.categoryName,
      }));
    }

    const fullCampaign = {
      ...campaign,
      brandDetails: null,
      categoryDetails: categoryDetails || null,
      subcategoryDetails: subcategoryDetails || [],
      campaignGoalDetails: campaignGoalDetails || [],
      influencerTierDetails: influencerTierDetails || [],
      contentFormatDetails: contentFormatDetails || [],
      contentLanguageDetails: contentLanguageDetails || [],
      preferredHashtagDetails: preferredHashtagDetails || [],
      targetCountryDetails: targetCountryDetails || [],
      targetAgeRangeDetails: targetAgeRangeDetails || [],
    };

    return res.status(200).json({
      message: "Campaign fetched successfully.",
      data: fullCampaign,
    });
  } catch (error) {
    console.error("Error in getCampaignById:", error);
    await saveErrorLog(req, error, 500, "GET_CAMPAIGN_BY_ID_ERROR");
    return res.status(500).json({
      message: "Internal server error while fetching campaign.",
      error: error.message,
    });
  }
};

exports.getCampaignsByBrandId = async (req, res) => {
  try {
    const brandId = String(req.body?.brandId || "").trim();
    const page = parsePositiveInt(req.body?.page, 1);
    const limit = parsePositiveInt(req.body?.limit, 10);
    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "desc");
    const statusFlag = Number.parseInt(req.body?.status, 10) || 0;

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required in the request body" });
    }

    const filter = { brandId };

    if (statusFlag === 1) filter.isActive = 1;
    if (statusFlag === 2) filter.isActive = 0;

    if (search) {
      const re = safeRegex(search);
      const numericSearch = Number(search);

      const orClauses = [
        { brandName: re },
        { productOrServiceName: re },
        { description: re },
        { "targetAudience.location": re },
        { interestName: re },
        { goal: re },
        { creativeBriefText: re },
        { additionalNotes: re },
        { images: re },
        { creativeBrief: re },
      ];

      if (!Number.isNaN(numericSearch)) {
        orClauses.push(
          { "targetAudience.age.MinAge": numericSearch },
          { "targetAudience.age.MaxAge": numericSearch },
          { budget: numericSearch },
          { applicantCount: numericSearch }
        );
      }

      filter.$or = orClauses;
    }

    const total = await Campaign.countDocuments(filter);
    const allowedSortFields = new Set([
      "brandName",
      "productOrServiceName",
      "createdAt",
      "timeline.startDate",
      "timeline.endDate",
      "budget",
    ]);
    const field = allowedSortFields.has(sortBy) ? sortBy : "createdAt";
    const dir = sortOrder === "asc" ? 1 : -1;

    const campaigns = await Campaign.find(filter)
      .select("-__v")
      .sort({ [field]: dir })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      status: statusFlag,
      campaigns,
    });
  } catch (error) {
    console.error("Error in getCampaignsByBrandId:", error);
    await saveErrorLog(req, error, 500, "GET_CAMPAIGNS_BY_BRAND_ID_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.adminGetInfluencerById = async (req, res) => {
  try {
    const id = String(req.body?._id || req.body?.id || req.body?.influencerId || "").trim();

    if (!id) {
      return res.status(400).json({ message: 'Body parameter "_id" or "id" is required.' });
    }

    if (!isObjectId(id)) {
      return res.status(400).json({ message: "Invalid influencer _id." });
    }

    const influencer = await Influencer.findById(id)
      .select("-password -__v")
      .lean();

    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    return res.status(200).json({ influencer });
  } catch (error) {
    console.error("Error in adminGetInfluencerById:", error);
    await saveErrorLog(req, error, 500, "ADMIN_GET_INFLUENCER_BY_ID_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

function computeInfluencerNextRoute(influencer) {
  const page1Done = Array.isArray(influencer?.page1) && influencer.page1.length > 0;

  const page2Done =
    (Array.isArray(influencer?.page2) && influencer.page2.length > 0) ||
    influencer?.ispage2Skip === true;

  const page3Done =
    (Array.isArray(influencer?.page3) && influencer.page3.length > 0) ||
    influencer?.ispage3Skip === true;

  let route = "campaign";
  if (!page1Done) route = "page1";
  else if (!page2Done) route = "page2";
  else if (!page3Done) route = "page3";

  return { route, page1Done, page2Done, page3Done };
}

async function loadSocialProfilesFromModashBulk(influencerIds = []) {
  const docs = await Modash.find(
    { influencerId: { $in: influencerIds.map((id) => String(id)) } },
    "influencerId provider handle username followers url picture"
  ).lean();

  const grouped = {};

  for (const d of docs) {
    const key = String(d.influencerId);
    if (!grouped[key]) grouped[key] = [];

    grouped[key].push({
      provider: d.provider,
      handle: normalizeHandle(d.handle, d.username),
      username: d.username || null,
      followers: Number(d.followers) || 0,
      url: d.url || null,
      picture: d.picture || null,
    });
  }

  return grouped;
}

exports.adminGetInfluencerList = async (req, res) => {
  try {
    const params = {
      ...(req.query || {}),
      ...(req.body || {}),
    };

    const {
      page = 1,
      limit = 20,
      search = "",
      countryId = "",
      languageId = "",
      categoryId = "",
      hasProxyEmail,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = params;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(Math.min(parseInt(limit, 10) || 20, 100), 1);
    const skip = (pageNum - 1) * limitNum;
    const order = String(sortOrder).toLowerCase() === "asc" ? 1 : -1;

    const allowedSortFields = new Set([
      "createdAt",
      "updatedAt",
      "name",
      "email",
      "countryName",
      "proxyEmail",
    ]);

    const finalSortBy = allowedSortFields.has(String(sortBy))
      ? String(sortBy)
      : "createdAt";

    const filter = {};

    if (search && String(search).trim()) {
      const q = String(search).trim();
      const rx = new RegExp(escapeRegex(q), "i");

      filter.$or = [
        { name: rx },
        { email: rx },
        { proxyEmail: rx },
        { countryName: rx },
        { "languages.name": rx },
        { "categories.name": rx },
      ];
    }

    if (countryId && mongoose.Types.ObjectId.isValid(String(countryId))) {
      filter.countryId = new mongoose.Types.ObjectId(String(countryId));
    }

    if (languageId && mongoose.Types.ObjectId.isValid(String(languageId))) {
      filter["languages._id"] = new mongoose.Types.ObjectId(String(languageId));
    }

    if (categoryId && mongoose.Types.ObjectId.isValid(String(categoryId))) {
      filter["categories._id"] = new mongoose.Types.ObjectId(String(categoryId));
    }

    if (String(hasProxyEmail).toLowerCase() === "true") {
      filter.proxyEmail = { $exists: true, $nin: ["", null] };
    } else if (String(hasProxyEmail).toLowerCase() === "false") {
      filter.$or = [...(filter.$or || []), { proxyEmail: { $exists: false } }, { proxyEmail: "" }, { proxyEmail: null }];
    }

    const [total, docs] = await Promise.all([
      Influencer.countDocuments(filter),
      Influencer.find(filter)
        .select(
          [
            "email",
            "name",
            "countryId",
            "countryName",
            "languages",
            "categories",
            "page1",
            "page2",
            "page3",
            "ispage2Skip",
            "ispage3Skip",
            "proxyEmail",
            "primaryPlatform",
            "isAdminCreated",
            "signupCompleted",
            "createdByAdmin",
            "adminCreatedRole",
            "adminCreatedAt",
            "signupCompletedAt",
            "createdAt",
            "updatedAt",
          ].join(" ")
        )
        .sort({ [finalSortBy]: order, _id: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
    ]);

    const socialProfilesMap = await loadSocialProfilesFromModashBulk(
      docs.map((doc) => doc._id)
    );

    const adminMap = await getAdminMapByIds(
      docs
        .filter((doc) => doc?.isAdminCreated === true)
        .map((doc) => doc?.createdByAdmin)
    );

    const influencers = docs.map((doc) => {
      const routeInfo = computeInfluencerNextRoute(doc);

      const page1Profiles = Array.isArray(doc.page1) ? doc.page1 : [];
      const primaryPage1Profile =
        page1Profiles.find((item) => item?.isPrimary) || page1Profiles[0] || null;

      const primaryPlatform = primaryPage1Profile
        ? String(
          primaryPage1Profile.platform ||
          primaryPage1Profile.provider ||
          ""
        ).toLowerCase() || null
        : null;

      const socialProfiles =
        socialProfilesMap[String(doc._id)] || [];

      const createdByPayload = buildCreatorPayload(doc, adminMap, "Influencer");
      const currentStatusPayload = buildSignupCurrentStatus(doc);

      return {
        _id: doc._id,
        email: doc.email || "",
        name: doc.name || "",
        country: {
          _id: doc.countryId || null,
          name: doc.countryName || "",
        },
        languages: Array.isArray(doc.languages)
          ? doc.languages.map((item) => ({
            _id: item?._id || null,
            name: item?.name || "",
          }))
          : [],
        categories: Array.isArray(doc.categories)
          ? doc.categories.map((item) => ({
            _id: item?._id || null,
            name: item?.name || "",
          }))
          : [],
        proxyEmail: doc.proxyEmail || null,
        primaryPlatform: primaryPlatform || doc.primaryPlatform || null,
        socialProfiles,
        isAdminCreated: doc.isAdminCreated === true,
        signupCompleted: doc.signupCompleted !== false,
        createdByAdmin: doc.createdByAdmin || null,
        adminCreatedRole: doc.adminCreatedRole || createdByPayload.createdByAdminRole || "",
        adminCreatedAt: doc.adminCreatedAt || null,
        signupCompletedAt: doc.signupCompletedAt || null,
        ...createdByPayload,
        ...currentStatusPayload,
        pageCounts: {
          page1: Array.isArray(doc.page1) ? doc.page1.length : 0,
          page2: Array.isArray(doc.page2) ? doc.page2.length : 0,
          page3: Array.isArray(doc.page3) ? doc.page3.length : 0,
        },
        onboarding: {
          route: routeInfo.route,
          page1Done: routeInfo.page1Done,
          page2Done: routeInfo.page2Done,
          page3Done: routeInfo.page3Done,
          ispage2Skip: Boolean(doc.ispage2Skip),
          ispage3Skip: Boolean(doc.ispage3Skip),
        },
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      };
    });

    return res.status(200).json({
      success: true,
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum),
      count: influencers.length,
      influencers,
    });
  } catch (error) {
    console.error("Error in adminGetInfluencerList:", error);
    await saveErrorLog(req, error, 500, "ADMIN_GET_INFLUENCER_LIST_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.adminAddYouTubeEmail = async (req, res) => {
  try {
    const rawHandle = String(req.body?.handle || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const platform = "youtube";

    if (!rawHandle || !email) {
      return res.status(400).json({
        status: "error",
        message: "handle and email are required",
      });
    }

    if (!EMAIL_RX.test(email)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid email address",
      });
    }

    const handle = normalizeHandle(rawHandle);
    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid handle format",
      });
    }

    let missingEmailDoc = await MissingEmail.findOne({ handle, platform });
    const isExisting = Boolean(missingEmailDoc);

    if (!missingEmailDoc) {
      missingEmailDoc = await MissingEmail.create({
        handle,
        platform,
        email,
        createdByAdminId: req.admin?.adminId || req.user?.adminId || null,
      });
    } else {
      missingEmailDoc.email = email;
      await missingEmailDoc.save();
    }

    try {
      await Invitation.updateMany(
        {
          handle,
          platform,
          $or: [
            { missingEmailId: { $exists: false } },
            { missingEmailId: null },
            { missingEmailId: "" },
          ],
        },
        { $set: { missingEmailId: missingEmailDoc.missingEmailId } }
      );
    } catch (attachError) {
      console.error("adminAddYouTubeEmail attach failed:", attachError);
    }

    let autoInvitesSent = 0;

    if (!isExisting) {
      try {
        const invitations = await Invitation.find({ handle, platform }).lean();

        for (const invitation of invitations) {
          if (!invitation.brandId) continue;

          try {
            await _sendCampaignInvitationInternal({
              brandId: invitation.brandId,
              campaignId: invitation.campaignId || null,
              invitationId: invitation.invitationId,
              influencerId: null,
              campaignLink: null,
              compensation: null,
              deliverables: null,
              additionalNotes: null,
              subject: null,
              body: null,
            });
            autoInvitesSent += 1;
          } catch (sendError) {
            console.error("adminAddYouTubeEmail invitation send failed:", sendError);
          }
        }
      } catch (listError) {
        console.error("adminAddYouTubeEmail invitation list failed:", listError);
      }
    }

    return res.json({
      status: isExisting ? "exists" : "saved",
      message: isExisting ? "Email updated for existing handle." : "Email saved successfully.",
      data: {
        missingEmailId: missingEmailDoc.missingEmailId,
        email: missingEmailDoc.email,
        handle: missingEmailDoc.handle,
        platform: missingEmailDoc.platform,
        createdAt: missingEmailDoc.createdAt,
        updatedAt: missingEmailDoc.updatedAt,
        autoInvitesSent,
      },
    });
  } catch (error) {
    console.error("Error in adminAddYouTubeEmail:", error);
    await saveErrorLog(req, error, 500, "ADMIN_ADD_YOU_TUBE_EMAIL_ERROR");
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};

exports.listMissingEmail = async (req, res) => {
  try {
    const body = req.body || {};
    const page = parsePositiveInt(body.page, 1, { min: 1, max: 100000 });
    const limit = parsePositiveInt(body.limit, 50, { min: 1, max: 200 });

    const rawSearch = typeof body.search === "string" ? body.search.trim() : "";
    const rawEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const rawHandle = typeof body.handle === "string" ? body.handle.trim() : "";
    const rawCreatedByAdminId = typeof body.createdByAdminId === "string" ? body.createdByAdminId.trim() : "";

    const query = {};

    if (rawEmail) query.email = rawEmail;

    if (rawHandle) {
      const handle = normalizeHandle(rawHandle);
      if (!HANDLE_RX.test(handle)) {
        return res.status(400).json({ status: "error", message: "Invalid handle format in filter" });
      }
      query.handle = handle;
    }

    if (rawCreatedByAdminId) {
      query.createdByAdminId = rawCreatedByAdminId;
    }

    const [total, docs] = await Promise.all([
      MissingEmail.countDocuments(query),
      MissingEmail.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select({
          _id: 0,
          missingEmailId: 1,
          email: 1,
          handle: 1,
          platform: 1,
          youtube: 1,
          createdByAdminId: 1,
          createdAt: 1,
          updatedAt: 1,
        })
        .lean(),
    ]);

    let data = docs;
    if (rawSearch) {
      const re = safeRegex(rawSearch);
      data = docs.filter((row) =>
        re.test(row.email || "") ||
        re.test(row.handle || "") ||
        re.test(row.missingEmailId || "") ||
        re.test(row.createdByAdminId || "")
      );
    }

    return res.json({
      page,
      limit,
      total,
      hasNext: page * limit < total,
      data,
    });
  } catch (error) {
    console.error("Error in listMissingEmail:", error);
    await saveErrorLog(req, error, 500, "LIST_MISSING_EMAIL_ERROR");
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};

exports.updateMissingEmail = async (req, res) => {
  try {
    const missingEmailId = String(req.body?.missingEmailId || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();

    if (!missingEmailId) {
      return res.status(400).json({ status: "error", message: "missingEmailId is required" });
    }

    if (!email) {
      return res.status(400).json({ status: "error", message: "email is required" });
    }

    if (!EMAIL_RX.test(email)) {
      return res.status(400).json({ status: "error", message: "Invalid email address" });
    }

    const doc = await MissingEmail.findOne({ missingEmailId });
    if (!doc) {
      return res.status(404).json({ status: "error", message: "MissingEmail record not found" });
    }

    doc.email = email;
    await doc.save();

    let autoInvitesSent = 0;

    try {
      await Invitation.updateMany(
        {
          handle: doc.handle,
          platform: doc.platform,
          $or: [
            { missingEmailId: { $exists: false } },
            { missingEmailId: null },
            { missingEmailId: "" },
          ],
        },
        { $set: { missingEmailId: doc.missingEmailId } }
      );
    } catch (attachError) {
      console.error("updateMissingEmail attach failed:", attachError);
    }

    try {
      const invitations = await Invitation.find({
        handle: doc.handle,
        platform: doc.platform,
      }).lean();

      for (const invitation of invitations) {
        if (!invitation.brandId) continue;

        try {
          await _sendCampaignInvitationInternal({
            brandId: invitation.brandId,
            campaignId: invitation.campaignId || null,
            invitationId: invitation.invitationId,
            influencerId: null,
            campaignLink: null,
            compensation: null,
            deliverables: null,
            additionalNotes: null,
            subject: null,
            body: null,
          });
          autoInvitesSent += 1;
        } catch (sendError) {
          console.error("updateMissingEmail invitation send failed:", sendError);
        }
      }
    } catch (listError) {
      console.error("updateMissingEmail invitation list failed:", listError);
    }

    return res.json({
      status: "success",
      message: "Email updated successfully.",
      data: {
        missingEmailId: doc.missingEmailId,
        email: doc.email,
        handle: doc.handle,
        platform: doc.platform,
        youtube: doc.youtube || null,
        createdByAdminId: doc.createdByAdminId || null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        autoInvitesSent,
      },
    });
  } catch (error) {
    console.error("Error in updateMissingEmail:", error);
    await saveErrorLog(req, error, 500, "UPDATE_MISSING_EMAIL_ERROR");
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};

exports.checkMissingEmailByHandle = async (req, res) => {
  try {
    const rawHandle = String(req.body?.handle || "").trim();
    const rawPlatform = String(req.body?.platform || "youtube").trim().toLowerCase();

    if (!rawHandle) {
      return res.status(400).json({ status: 0, message: "handle is required" });
    }

    const handle = normalizeHandle(rawHandle);
    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: 0,
        message: 'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-".',
      });
    }

    if (rawPlatform !== "youtube") {
      return res.status(400).json({
        status: 0,
        message: 'Invalid platform. MissingEmail only supports "youtube".',
      });
    }

    const doc = await MissingEmail.findOne({ handle, platform: rawPlatform }).lean();
    if (!doc) {
      return res.json({ status: 0, handle, email: null, platform: rawPlatform });
    }

    return res.json({
      status: 1,
      handle: doc.handle,
      email: doc.email,
      platform: doc.platform,
    });
  } catch (error) {
    console.error("Error in checkMissingEmailByHandle:", error);
    await saveErrorLog(req, error, 500, "CHECK_MISSING_EMAIL_BY_HANDLE_ERROR");
    return res.status(500).json({
      status: 0,
      message: "Internal server error while checking missing email.",
    });
  }
};

exports.getAllPayments = async (req, res) => {
  try {
    const page = parsePositiveInt(req.body?.page, 1);
    const limit = parsePositiveInt(req.body?.limit, 10);
    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "desc");
    const statusFilter = String(req.body?.status || "").trim();
    const roleFilter = String(req.body?.role || "").trim();

    const filter = {};

    if (statusFilter && statusFilter !== "all") {
      filter.status = statusFilter;
    }

    if (roleFilter && roleFilter !== "all") {
      filter.role = roleFilter;
    }

    if (search) {
      const re = safeRegex(search);
      filter.$or = [
        { orderId: re },
        { paymentId: re },
        { invoiceNumber: re },
        { invoiceEmailTo: re },
        { planName: re },
        { userId: re },
      ];
    }

    const total = await Payment.countDocuments(filter);
    const allowedSortFields = new Set(["amount", "createdAt", "paidAt", "status", "planName"]);
    const field = allowedSortFields.has(sortBy) ? sortBy : "createdAt";
    const dir = sortOrder === "asc" ? 1 : -1;

    const payments = await Payment.find(filter)
      .sort({ [field]: dir })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const brandIds = [];
    const influencerIds = [];

    payments.forEach((payment) => {
      if (payment.role === "Brand" && payment.userId) brandIds.push(payment.userId);
      if (payment.role === "Influencer" && payment.userId) influencerIds.push(payment.userId);
    });

    const [brands, influencers] = await Promise.all([
      Brand.find({ brandId: { $in: brandIds } })
        .select("brandId name brandName email")
        .lean(),
      Influencer.find({
        _id: {
          $in: influencerIds.filter((id) => isObjectId(id)).map((id) => toObjectId(id)),
        },
      })
        .select("_id name email")
        .lean(),
    ]);

    const brandMap = {};
    brands.forEach((brand) => {
      brandMap[brand.brandId] = brand.name || brand.brandName || brand.email || "Unknown Brand";
    });

    const influencerMap = {};
    influencers.forEach((influencer) => {
      influencerMap[String(influencer._id)] = influencer.name || influencer.email || "Unknown Influencer";
    });

    const data = payments.map((payment) => {
      let userName = "Unknown";

      if (payment.role === "Brand") {
        userName = brandMap[payment.userId] || `Brand (${payment.userId})`;
      } else if (payment.role === "Influencer") {
        userName = influencerMap[payment.userId] || `Influencer (${payment.userId})`;
      }

      return {
        _id: payment._id,
        orderId: payment.orderId,
        paymentId: payment.paymentId || "N/A",
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        planName: payment.planName,
        role: payment.role,
        userId: payment.userId,
        userName,
        invoiceNumber: payment.invoiceNumber || "-",
        invoiceEmailTo: payment.invoiceEmailTo || "-",
        createdAt: payment.createdAt,
        paidAt: payment.paidAt,
      };
    });

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      sortBy: field,
      sortOrder,
      payments: data,
    });
  } catch (error) {
    console.error("Error in getAllPayments:", error);
    await saveErrorLog(req, error, 500, "GET_ALL_PAYMENTS_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getAllCampaignsLite = async (req, res) => {
  try {
    const page = parsePositiveInt(req.body?.page, 1);
    const limit = parsePositiveInt(req.body?.limit, 10);
    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "desc");
    const statusFlag = Number.parseInt(req.body?.type, 10) || 0;
    const brandId = String(req.body?.brandId || "").trim();

    const actor = req.admin || {};
    const scopedAccess = await getScopedCampaignAccessForAdmin(actor);

    const filter = buildCampaignBaseFilter({
      search,
      statusFlag,
      brandKeys: scopedAccess.brandKeys,
      requestedBrandId: brandId,
    });

    if (Array.isArray(scopedAccess.campaignIds)) {
      filter._id = { $in: scopedAccess.campaignIds };
    }

    const field = getCampaignSortField(sortBy);
    const dir = sortOrder === "asc" ? 1 : -1;

    const total = await Campaign.countDocuments(filter);

    const rows = await Campaign.find(filter)
      .select(
        "_id brandId brandName campaignsId campaignTitle productOrServiceName goal budget applicantCount isActive isDraft byAi createdBy campaignStatus timeline.startDate timeline.endDate createdAt"
      )
      .sort({ [field]: dir, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const rowsWithCreators = await enrichLiteCampaignCreatedBy(rows);
    const rowsWithBrandMeta = await enrichLiteCampaignBrandMeta(rowsWithCreators);
    const rowsWithAssignments = await enrichLiteCampaignAssignments(rowsWithBrandMeta);
    const campaigns = rowsWithAssignments.map(toCampaignSummary);

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      status: statusFlag,
      sortBy,
      sortOrder,
      campaigns,
    });
  } catch (error) {
    console.error("Error in getAllCampaignsLite:", error);
    await saveErrorLog(req, error, 500, "GET_ALL_CAMPAIGNS_LITE_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getFullyManagedCampaignsLite = async (req, res) => {
  try {
    const page = parsePositiveInt(req.body?.page, 1);
    const limit = parsePositiveInt(req.body?.limit, 10, { min: 1, max: 1000 });
    const search = String(req.body?.search || "").trim();
    const sortBy = String(req.body?.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, "desc");
    const statusFlag = Number.parseInt(req.body?.type, 10) || 0;
    const brandId = String(req.body?.brandId || "").trim();

    const actor = req.admin || {};
    const scopedAccess = await getScopedCampaignAccessForAdmin(actor);

    const filter = buildCampaignBaseFilter({
      search,
      statusFlag,
      brandKeys: scopedAccess.brandKeys,
      requestedBrandId: brandId,
    });

    if (Array.isArray(scopedAccess.campaignIds)) {
      filter._id = { $in: scopedAccess.campaignIds };
    }

    await applyFullyManagedCampaignFilter(filter);

    const field = getCampaignSortField(sortBy);
    const dir = sortOrder === "asc" ? 1 : -1;

    const total = await Campaign.countDocuments(filter);

    const rows = await Campaign.find(filter)
      .select(
        "_id brandId brandName campaignsId campaignTitle productOrServiceName goal budget applicantCount isActive isDraft byAi createdBy approvalMode campaignStatus timeline.startDate timeline.endDate createdAt brandWasFullyManagedAtCreation brandSubscriptionSnapshot isFullyManaged managementType"
      )
      .sort({ [field]: dir, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const rowsWithCreators = await enrichLiteCampaignCreatedBy(rows);
    const rowsWithBrandMeta = await enrichLiteCampaignBrandMeta(rowsWithCreators);
    const rowsWithAssignments = await enrichLiteCampaignAssignments(rowsWithBrandMeta);
    const campaigns = rowsWithAssignments.map(toCampaignSummary);

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      status: statusFlag,
      sortBy,
      sortOrder,
      campaigns,
    });
  } catch (error) {
    console.error("Error in getFullyManagedCampaignsLite:", error);
    await saveErrorLog(req, error, 500, "GET_FULLY_MANAGED_CAMPAIGNS_LITE_ERROR");
    return res.status(500).json({
      success: false,
      message: error?.message || "Internal server error",
    });
  }
};

exports.fullyManagedBrandList = async (req, res) => {
  try {
    const rawBrands = await Brand.find({
      $or: [
        { "subscription.planId": FULLY_MANAGED_PLAN_ID },
        { "subscription.planName": /fully managed/i },
      ],
    })
      .select("-password -__v")
      .lean();

    const enrichedBrands = await enrichBrandsWithAssignments(rawBrands);
    const data = enrichedBrands.filter((brand) => brand.fullyManagedSubscription);

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("fullyManagedBrandList error:", error);
    await saveErrorLog(req, error, 500, "FULLY_MANAGED_BRAND_LIST_ERROR");
    return res.status(500).json({
      success: false,
      message: error?.message || "Internal error",
    });
  }
};

exports.assignBrand = async (req, res) => {
  try {
    const brandId = String(req.body?.brandId || "").trim();
    const RHId = req.body?.RHId;
    const bdmId = req.body?.bdmId;
    const idmId = req.body?.idmId;
    const sdrId = req.body?.sdrId;

    if (!brandId) {
      return res.status(400).json({
        success: false,
        message: "brandId is required",
      });
    }

    if (!isObjectId(brandId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid brandId",
      });
    }

    const wantsRH = RHId !== undefined && RHId !== null && String(RHId).trim() !== "";
    const wantsTeam =
      bdmId !== undefined || idmId !== undefined || sdrId !== undefined;

    if (!wantsRH && !wantsTeam) {
      return res.status(400).json({
        success: false,
        message: "Send RHId to assign RH OR send bdmId/idmId/sdrId to assign team members",
      });
    }

    const normalizedBrandId = toObjectId(brandId);

    if (wantsRH) {
      const set = {
        RHId: RHId || null,
        status: "active",
      };

      if (bdmId !== undefined) set.bdmId = bdmId || null;
      if (idmId !== undefined) set.idmId = idmId || null;
      if (sdrId !== undefined) set.sdrId = sdrId || null;

      let doc = await BrandAssigned.findOneAndUpdate(
        { brandId: normalizedBrandId, status: "active" },
        { $set: set },
        { new: true }
      ).exec();

      if (!doc) {
        doc = await BrandAssigned.findOneAndUpdate(
          { brandId: normalizedBrandId },
          { $set: set },
          { new: true, sort: { updatedAt: -1, createdAt: -1 } }
        ).exec();
      }

      if (!doc) {
        doc = await BrandAssigned.create({
          brandId: normalizedBrandId,
          RHId: RHId || null,
          bdmId: bdmId || null,
          idmId: idmId || null,
          sdrId: sdrId || null,
          status: "active",
        });
      }

      await notifySafely("assignBrand", req, {
        brandId: String(normalizedBrandId),
        adminIds: await getBrandAdminNotificationRecipients(normalizedBrandId),
        type: "brand.assignment_updated",
        title: "Brand assignment updated",
        message: "A brand assignment was updated.",
        entityType: "brand",
        entityId: String(normalizedBrandId),
        actionPath: {
          brand: "/brand/notifications",
          admin: `/admin/brands/view?brandId=${normalizedBrandId}`,
        },
      });

      return res.status(200).json({
        success: true,
        message: "Brand assignment saved successfully",
        data: doc,
      });
    }

    const set = {};
    if (bdmId !== undefined) set.bdmId = bdmId || null;
    if (idmId !== undefined) set.idmId = idmId || null;
    if (sdrId !== undefined) set.sdrId = sdrId || null;

    let updated = await BrandAssigned.findOneAndUpdate(
      {
        brandId: normalizedBrandId,
        status: "active",
        RHId: { $exists: true, $ne: null },
      },
      { $set: set },
      { new: true }
    ).exec();

    if (!updated) {
      updated = await BrandAssigned.findOneAndUpdate(
        {
          brandId: normalizedBrandId,
          RHId: { $exists: true, $ne: null },
        },
        { $set: { ...set, status: "active" } },
        { new: true, sort: { updatedAt: -1, createdAt: -1 } }
      ).exec();
    }

    if (!updated) {
      return res.status(400).json({
        success: false,
        message: "RH is not assigned for this brand. Assign RH first, then add team members.",
      });
    }

    await notifySafely("assignBrand", req, {
      brandId: String(normalizedBrandId),
      adminIds: await getBrandAdminNotificationRecipients(normalizedBrandId),
      type: "brand.assignment_updated",
      title: "Brand assignment updated",
      message:
        bdmId || idmId
          ? "A brand was handed off to the assigned team."
          : "A brand assignment was updated.",
      entityType: "brand",
      entityId: String(normalizedBrandId),
      actionPath: {
        brand: "/brand/notifications",
        admin: `/admin/brands/view?brandId=${normalizedBrandId}`,
      },
    });

    return res.status(200).json({
      success: true,
      message:
        bdmId || idmId
          ? "Brand handed off successfully"
          : "Brand assignment updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("assignBrand error:", error);
    await saveErrorLog(req, error, 500, "ASSIGN_BRAND_ERROR");
    return res.status(500).json({
      success: false,
      message: error?.message || "Internal error",
    });
  }
};

exports.getCampaignsByInfluencerId = async (req, res) => {
  try {
    const params = {
      ...(req.query || {}),
      ...(req.body || {}),
    };

    const influencerMongoId = String(
      params._id || params.id || params.influencerId || ""
    ).trim();

    const page = parsePositiveInt(params.page, 1);
    const limit = parsePositiveInt(params.limit, 10);
    const search = String(params.search || "").trim();
    const sortBy = String(params.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(params.sortOrder, "desc");
    const statusFilter = String(params.status || "all").trim().toLowerCase();

    const debug =
      params.debug === true ||
      String(params.debug || "").toLowerCase() === "true";

    if (!influencerMongoId) {
      return res.status(400).json({ message: "influencer _id is required" });
    }

    if (!isObjectId(influencerMongoId)) {
      return res.status(400).json({ message: "Invalid influencer _id" });
    }

    const influencerId = String(influencerMongoId);
    const influencerObjectId = toObjectId(influencerMongoId);

    const influencer = await Influencer.findById(influencerObjectId)
      .select("_id name email")
      .lean();

    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const rawActor = req.admin || req.user || {};
    const actor = await resolveActorFromMaster(rawActor);
    const scopedAccess = await getScopedCampaignAccessForAdmin(actor);

    const visibleBrandKeys = scopedAccess.brandKeys;
    const visibleCampaignIds = scopedAccess.campaignIds;

    const applyRows = await ApplyCampaign.find({
      $or: [
        { "applicants.influencerId": influencerId },
        { "approved.influencerId": influencerId },
        { "applicants.influencerId": influencerObjectId },
        { "approved.influencerId": influencerObjectId },
      ],
    })
      .select("campaignId campaignsId applicants approved createdAt updatedAt")
      .lean();

    const invitations = await Invitation.find({
      influencerId,
    })
      .select("campaignId invitationId status createdAt updatedAt")
      .lean();

    const isSameInfluencer = (value) => String(value || "") === influencerId;

    const getMatchedApplicant = (row) => {
      const applicants = Array.isArray(row?.applicants) ? row.applicants : [];
      const approved = Array.isArray(row?.approved) ? row.approved : [];

      const approvedMatch = approved.find((item) =>
        isSameInfluencer(item?.influencerId)
      );

      if (approvedMatch) {
        return {
          applicant: approvedMatch,
          fromApprovedArray: true,
        };
      }

      const applicantMatch = applicants.find((item) =>
        isSameInfluencer(item?.influencerId)
      );

      return {
        applicant: applicantMatch || null,
        fromApprovedArray: false,
      };
    };

    const getApplicantStatus = (applicant, fromApprovedArray = false) => {
      const statusBrand = String(applicant?.statusBrand || "").toLowerCase();
      const statusInfluencer = String(applicant?.statusInfluencer || "").toLowerCase();

      if (
        Number(applicant?.isRejected || 0) === 1 ||
        statusBrand.includes("rejected") ||
        statusInfluencer.includes("rejected")
      ) {
        return "rejected";
      }

      if (
        fromApprovedArray ||
        statusBrand.includes("contractaccept") ||
        statusInfluencer.includes("contractaccept")
      ) {
        return "approved";
      }

      if (Number(applicant?.isShortlisted || 0) === 1) {
        return "shortlisted";
      }

      if (Number(applicant?.isUndicided || 0) === 1) {
        return "undecided";
      }

      if (statusBrand) return statusBrand;
      if (statusInfluencer) return statusInfluencer;

      return "active";
    };

    const applyMap = new Map();

    for (const row of applyRows) {
      const campaignId = String(row?.campaignId || row?.campaignsId || "").trim();
      if (!campaignId) continue;

      const { applicant, fromApprovedArray } = getMatchedApplicant(row);
      if (!applicant) continue;

      applyMap.set(campaignId, {
        campaignId,
        applicant,
        fromApprovedArray,
        status: getApplicantStatus(applicant, fromApprovedArray),
        appliedAt: applicant?.appliedAt || row?.createdAt || null,
      });
    }

    const appliedCampaignIds = [...applyMap.keys()];

    if (!appliedCampaignIds.length) {
      return res.status(200).json({
        success: true,
        page,
        limit,
        total: 0,
        pages: 1,
        totalPages: 1,
        count: 0,
        campaigns: [],
        influencer: {
          _id: String(influencer._id),
          name: influencer.name || "",
          email: influencer.email || "",
        },
        ...(debug
          ? {
            debug: {
              reason: "No ApplyCampaign rows found for this influencer",
              influencerId,
              applyRowsFound: applyRows.length,
              invitationsFound: invitations.length,
            },
          }
          : {}),
      });
    }

    const campaignObjectIds = appliedCampaignIds
      .filter((id) => isObjectId(id))
      .map((id) => toObjectId(id));

    const andFilters = [
      {
        $or: [
          ...(campaignObjectIds.length
            ? [{ _id: { $in: campaignObjectIds } }]
            : []),
          { campaignsId: { $in: appliedCampaignIds } },
          { campaignId: { $in: appliedCampaignIds } },
        ],
      },
    ];

    if (Array.isArray(visibleBrandKeys)) {
      if (!visibleBrandKeys.length) {
        return res.status(200).json({
          success: true,
          page,
          limit,
          total: 0,
          pages: 1,
          totalPages: 1,
          count: 0,
          campaigns: [],
          influencer: {
            _id: String(influencer._id),
            name: influencer.name || "",
            email: influencer.email || "",
          },
          ...(debug
            ? {
              debug: {
                reason: "Admin has no visible brand keys",
                rawActor,
                resolvedActor: actor,
                appliedCampaignIds,
              },
            }
            : {}),
        });
      }

      const visibleBrandObjectIds = visibleBrandKeys
        .filter((id) => isObjectId(id))
        .map((id) => toObjectId(id));

      andFilters.push({
        $or: [
          { brandId: { $in: visibleBrandKeys } },
          { brandId: { $in: visibleBrandObjectIds } },
        ],
      });
    }

    if (Array.isArray(visibleCampaignIds)) {
      if (!visibleCampaignIds.length) {
        return res.status(200).json({
          success: true,
          page,
          limit,
          total: 0,
          pages: 1,
          totalPages: 1,
          count: 0,
          campaigns: [],
          influencer: {
            _id: String(influencer._id),
            name: influencer.name || "",
            email: influencer.email || "",
          },
          ...(debug
            ? {
              debug: {
                reason: "Admin has no visible campaign ids",
                rawActor,
                resolvedActor: actor,
                appliedCampaignIds,
              },
            }
            : {}),
        });
      }

      andFilters.push({
        _id: { $in: visibleCampaignIds },
      });
    }

    const re = safeRegex(search);

    if (re) {
      andFilters.push({
        $or: [
          { campaignTitle: re },
          { productOrServiceName: re },
          { brandName: re },
          { description: re },
          { goal: re },
        ],
      });
    }

    const campaignFilter = { $and: andFilters };

    const campaignDocs = await Campaign.find(campaignFilter)
      .select(
        "_id brandId brandName campaignsId campaignId campaignTitle productOrServiceName goal budget applicantCount isActive isDraft campaignStatus timeline.startDate timeline.endDate createdAt updatedAt"
      )
      .lean();

    const normalized = campaignDocs.map((doc) => {
      const summary = toCampaignSummary(doc);

      const possibleCampaignKeys = [
        String(doc._id || ""),
        String(doc.campaignsId || ""),
        String(doc.campaignId || ""),
      ].filter(Boolean);

      const applyInfo =
        possibleCampaignKeys.map((key) => applyMap.get(key)).find(Boolean) || null;

      const applicant = applyInfo?.applicant || {};
      const status = applyInfo?.status || "active";

      return {
        _id: String(doc._id || ""),
        id: summary.campaignId,
        campaignId: summary.campaignId,

        name: summary.name,
        campaignName: summary.name,

        brandId: String(doc.brandId || ""),
        brandName: doc.brandName || "—",

        appliedDate: applyInfo?.appliedAt || doc.createdAt || null,

        status,
        statusBrand: applicant.statusBrand || "",
        statusInfluencer: applicant.statusInfluencer || "",

        isShortlisted: Number(applicant.isShortlisted || 0),
        isUndicided: Number(applicant.isUndicided || 0),
        isRejected: Number(applicant.isRejected || 0),
        contractId: applicant.contractId || "",

        startDate: summary.startDate,
        endDate: summary.endDate,
        goal: summary.goal,
        applicantCount: summary.applicantCount,
        isActive: summary.isActive,
      };
    });

    const filteredByStatus =
      statusFilter === "all"
        ? normalized
        : normalized.filter((item) => {
          if (statusFilter === "active") {
            return item.status !== "rejected";
          }

          return (
            item.status === statusFilter ||
            String(item.statusBrand || "").toLowerCase() === statusFilter ||
            String(item.statusInfluencer || "").toLowerCase() === statusFilter
          );
        });

    const field = getCampaignSortField(sortBy);
    const dir = sortOrder === "asc" ? 1 : -1;

    const getSortValue = (item) => {
      switch (field) {
        case "campaignTitle":
          return item.name || "";

        case "goal":
          return item.goal || "";

        case "timeline.startDate":
          return new Date(item.startDate || 0).getTime();

        case "timeline.endDate":
          return new Date(item.endDate || 0).getTime();

        case "applicantCount":
          return Number(item.applicantCount || 0);

        case "isActive":
          return Number(item.isActive || 0);

        case "createdAt":
        default:
          return new Date(item.appliedDate || 0).getTime();
      }
    };

    const sorted = [...filteredByStatus].sort((a, b) => {
      const aVal = getSortValue(a);
      const bVal = getSortValue(b);

      if (typeof aVal === "number" && typeof bVal === "number") {
        return (aVal - bVal) * dir;
      }

      return (
        String(aVal).localeCompare(String(bVal), undefined, {
          numeric: true,
          sensitivity: "base",
        }) * dir
      );
    });

    const total = sorted.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const campaigns = sorted.slice((page - 1) * limit, page * limit);

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      pages,
      totalPages: pages,
      count: campaigns.length,
      campaigns,
      influencer: {
        _id: String(influencer._id),
        name: influencer.name || "",
        email: influencer.email || "",
      },
      ...(debug
        ? {
          debug: {
            rawActor,
            resolvedActor: actor,
            visibleBrandKeys,
            visibleCampaignIds,
            influencerId,
            applyRowsFound: applyRows.length,
            invitationsFound: invitations.length,
            appliedCampaignIds,
            campaignDocsFound: campaignDocs.length,
          },
        }
        : {}),
    });
  } catch (error) {
    console.error("Error in getCampaignsByInfluencerId:", error);
    await saveErrorLog(req, error, 500, "GET_CAMPAIGNS_BY_INFLUENCER_ID_ERROR");
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.enableCampaignShare = async (req, res) => {
  try {
    const { campaignId, brandId } = req.body;

    if (!campaignId || !String(campaignId).trim()) {
      return res.status(400).json({ message: "Valid campaignId is required" });
    }

    const filter = {
      $or: [{ campaignsId: String(campaignId).trim() }],
    };

    if (mongoose.Types.ObjectId.isValid(String(campaignId))) {
      filter.$or.push({ _id: new mongoose.Types.ObjectId(String(campaignId)) });
    }

    const campaign = await Campaign.findOne(filter);

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    if (
      brandId &&
      String(brandId).trim() &&
      String(campaign.brandId) !== String(brandId).trim()
    ) {
      return res.status(404).json({ message: "Campaign not found for this brand" });
    }

    if (!campaign.publicShareToken) {
      campaign.publicShareToken = crypto.randomBytes(16).toString("hex");
    }

    campaign.isPublic = true;
    await campaign.save();

    const ALLOWED_FRONTEND_ORIGINS = [
      "https://collabglam.com",
      "http://localhost:3000",
      "http://192.168.1.57:3000",
    ];

    const requestOrigin = String(req.headers.origin || "").trim();

    const frontendBase = ALLOWED_FRONTEND_ORIGINS.includes(requestOrigin)
      ? requestOrigin
      : "https://collabglam.com";

    const shareUrl = `${frontendBase}/campaign/share/${campaign.publicShareToken}`;

    return res.status(200).json({
      message: "Public share link enabled",
      shareUrl,
      publicShareToken: campaign.publicShareToken,
      isPublic: true,
    });
  } catch (err) {
    console.error("enableCampaignShare error:", err);
    await saveErrorLog(req, err, 500, "ENABLE_CAMPAIGN_SHARE_ERROR");
    return res.status(500).json({
      message: "Internal server error",
      error: err.message,
    });
  }
};

exports.disableCampaignShare = async (req, res) => {
  try {
    const { campaignId, brandId } = req.body;

    if (!campaignId || !String(campaignId).trim()) {
      return res.status(400).json({ message: "Valid campaignId is required" });
    }

    const filter = {
      $or: [{ campaignsId: String(campaignId).trim() }],
    };

    if (mongoose.Types.ObjectId.isValid(String(campaignId))) {
      filter.$or.push({ _id: new mongoose.Types.ObjectId(String(campaignId)) });
    }

    const campaign = await Campaign.findOne(filter);

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    if (
      brandId &&
      String(brandId).trim() &&
      String(campaign.brandId) !== String(brandId).trim()
    ) {
      return res.status(404).json({ message: "Campaign not found for this brand" });
    }

    campaign.isPublic = false;
    await campaign.save();

    return res.status(200).json({
      message: "Public share link disabled",
      isPublic: false,
    });
  } catch (err) {
    console.error("disableCampaignShare error:", err);
    await saveErrorLog(req, err, 500, "DISABLE_CAMPAIGN_SHARE_ERROR");
    return res.status(500).json({
      message: "Internal server error",
      error: err.message,
    });
  }
};

exports.getPublicCampaignByToken = async (req, res) => {
  try {
    const { token } = req.params;

    if (!token || !String(token).trim()) {
      return res.status(400).json({ message: "Valid token is required" });
    }

    const campaign = await Campaign.findOne({
      publicShareToken: String(token).trim(),
      isPublic: true,
    }).lean();

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found or not public" });
    }

    return res.status(200).json({
      doc: {
        _id: campaign._id,
        campaignId: campaign.campaignsId || String(campaign._id),
        campaignTitle: campaign.campaignTitle || "",
        description: campaign.description || "",
        campaignType: campaign.campaignType || "",
        campaignBudget: campaign.campaignBudget || 0,
        budget: campaign.budget || 0,
        paymentType: campaign.paymentType || "",
        platformSelection: campaign.platformSelection || [],
        targetCountryIds: campaign.targetCountryIds || [],
        targetAgeRanges: campaign.targetAgeRanges || [],
        productImages: campaign.productImages || [],
        productLink: campaign.productLink || "",
        videoLink: campaign.videoLink || "",
        additionalNotes: campaign.additionalNotes || "",
        startAt: campaign.startAt || campaign.timeline?.startDate || null,
        endAt: campaign.endAt || campaign.timeline?.endDate || null,
        status: campaign.status || campaign.campaignStatus || "",
        brandName: campaign.brandName || "",
        categoryId: campaign.categoryId || null,
        subcategoryIds: campaign.subcategoryIds || [],
        contentFormats: campaign.contentFormats || [],
        contentLanguageIds: campaign.contentLanguageIds || [],
        preferredHashtags: campaign.preferredHashtags || [],
        campaignGoals: campaign.campaignGoals || [],
      },
    });
  } catch (err) {
    console.error("getPublicCampaignByToken error:", err);
    await saveErrorLog(req, err, 500, "GET_PUBLIC_CAMPAIGN_BY_TOKEN_ERROR");
    return res.status(500).json({
      message: "Internal server error",
      error: err.message,
    });
  }
};

exports.adminAddCampaignFunds = async (req, res) => {
  try {
    const brandId = String(req.body?.brandId || "").trim();
    const campaignId = String(req.body?.campaignId || "").trim();
    const currency = String(req.body?.currency || "usd").trim().toLowerCase();
    const note = String(
      req.body?.note || "Admin added campaign funds manually"
    ).trim();
    const amount = Number(req.body?.amount || 0);

    const adminId = String(req.admin?.adminId || req.admin?._id || "").trim();
    const adminEmail = String(req.admin?.email || "").trim();

    if (!brandId) {
      return res.status(400).json({
        success: false,
        message: "brandId is required",
      });
    }

    if (!campaignId) {
      return res.status(400).json({
        success: false,
        message: "campaignId is required",
      });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "amount must be a valid number greater than 0",
      });
    }

    const campaignFilter = {
      $or: [{ campaignsId: campaignId }],
    };

    if (mongoose.Types.ObjectId.isValid(campaignId)) {
      campaignFilter.$or.push({ _id: new mongoose.Types.ObjectId(campaignId) });
    }

    const campaign = await Campaign.findOne(campaignFilter).lean();

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: "Campaign not found",
      });
    }

    if (String(campaign.brandId) !== String(brandId)) {
      return res.status(400).json({
        success: false,
        message: "This campaign does not belong to the provided brandId",
      });
    }

    const normalizedCampaignId = String(campaign.campaignsId || campaign._id);

    const wallet = await getOrCreateWallet(brandId);
    wallet.topups = Array.isArray(wallet.topups) ? wallet.topups : [];

    wallet.walletBalance = Math.max(
      0,
      Number(wallet.walletBalance || 0) + amount
    );

    const campaignFreeze = ensureCampaignFreeze(
      wallet,
      brandId,
      normalizedCampaignId
    );

    campaignFreeze.totalFrozenAmount =
      Number(campaignFreeze.totalFrozenAmount || 0) + amount;

    syncCampaignFreeze(campaignFreeze);

    wallet.topups.push({
      amount,
      currency,
      campaignId: normalizedCampaignId,
      status: "success",
      paymentIntentId: null,
      stripeSessionId: null,
      stripePaymentIntentId: null,
      source: "admin_manual",
      note,
      addedByAdminId: adminId || null,
      addedByAdminEmail: adminEmail || null,
      createdAt: new Date(),
    });

    wallet.markModified("freezes");
    wallet.markModified("topups");

    const walletSnap = syncUsableBalance(wallet);
    await wallet.save();

    return res.status(200).json({
      success: true,
      message: "Campaign funds added and frozen successfully",
      data: {
        brandId,
        campaignId: normalizedCampaignId,
        campaignMongoId: String(campaign._id),
        addedAmount: amount,
        currency,
        wallet: {
          walletBalance: walletSnap.walletBalance,
          frozenBalance: walletSnap.frozenBalance,
          usableBalance: walletSnap.usableBalance,
        },
        campaignFreeze: {
          brandId: campaignFreeze.brandId,
          campaignId: campaignFreeze.campaignId,
          totalFrozenAmount: Number(campaignFreeze.totalFrozenAmount || 0),
          currentFrozenAmount: Number(campaignFreeze.currentFrozenAmount || 0),
          totalAllocatedAmount: Number(campaignFreeze.totalAllocatedAmount || 0),
          totalReleasedAmount: Number(campaignFreeze.totalReleasedAmount || 0),
          availableToAllocate: Number(campaignFreeze.availableToAllocate || 0),
          influencerAllocations: campaignFreeze.influencerAllocations || [],
        },
      },
    });
  } catch (error) {
    console.error("adminAddCampaignFunds error:", error);
    await saveErrorLog(req, error, 500, "ADMIN_ADD_CAMPAIGN_FUNDS_ERROR");
    return res.status(500).json({
      success: false,
      message: error?.message || "Internal server error",
    });
  }
};

const ADMIN_BRAND_CREATE_ROLES = new Set([
  ROLES.SUPER_ADMIN,
  ROLES.REVENUE_HEAD,
  ROLES.BME,
]);

function normalizeBrandEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isPendingAdminCreatedBrand(doc = {}) {
  return doc?.isAdminCreated === true && doc?.signupCompleted === false;
}

async function resolveAdminActor(actor = {}) {
  const adminId = String(actor?.adminId || actor?._id || "").trim();

  if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
    return null;
  }

  return AdminModel.findById(adminId)
    .select("_id name email role parentAdmin rootAdmin status")
    .lean();
}

async function buildBrandAssignmentPayload(assignment) {
  if (!assignment) {
    return {
      assignedRh: "",
      assignedBme: "",
      assignedRm: "",
      assignedBm: "",
      RHId: null,
      bdmId: null,
      assignmentId: null,
      assignmentStatus: null,
    };
  }

  const ids = [assignment.RHId, assignment.bdmId]
    .filter(Boolean)
    .map((id) => String(id))
    .filter((id) => mongoose.Types.ObjectId.isValid(id));

  const admins = ids.length
    ? await AdminModel.find({
      _id: {
        $in: ids.map((id) => new mongoose.Types.ObjectId(id)),
      },
    })
      .select("_id name email")
      .lean()
    : [];

  const adminMap = {};
  admins.forEach((admin) => {
    adminMap[String(admin._id)] = admin.name || admin.email || "";
  });

  const assignedRh = assignment.RHId
    ? adminMap[String(assignment.RHId)] || ""
    : "";

  const assignedBme = assignment.bdmId
    ? adminMap[String(assignment.bdmId)] || ""
    : "";

  return {
    assignedRh,
    assignedBme,

    assignedRm: assignedRh,
    assignedBm: assignedBme,

    RHId: assignment.RHId || null,
    bdmId: assignment.bdmId || null,

    assignmentId: assignment._id || null,
    assignmentStatus: assignment.status || null,
  };
}

async function ensureBrandAssignmentForCreator({ brandId, actor }) {
  const role = String(actor?.role || "").toLowerCase();
  const normalizedBrandId = new mongoose.Types.ObjectId(String(brandId));

  if (role !== ROLES.REVENUE_HEAD && role !== ROLES.BME) {
    return null;
  }

  const set = {
    status: "active",
  };

  if (role === ROLES.REVENUE_HEAD) {
    set.RHId = actor._id;
    set.bdmId = null;
  }

  if (role === ROLES.BME) {
    if (!actor.parentAdmin) {
      throw new Error("This BME is not mapped under any RH. Please assign RH first.");
    }

    const rh = await AdminModel.findOne({
      _id: actor.parentAdmin,
      role: ROLES.REVENUE_HEAD,
      status: "active",
    }).select("_id");

    if (!rh) {
      throw new Error("Mapped RH for this BME is not active or not found.");
    }

    set.RHId = actor.parentAdmin;
    set.bdmId = actor._id;
  }

  return BrandAssigned.findOneAndUpdate(
    {
      brandId: normalizedBrandId,
      status: "active",
    },
    {
      $setOnInsert: {
        brandId: normalizedBrandId,
      },
      $set: set,
      $unset: {
        idmId: "",
        sdrId: "",
      },
    },
    {
      new: true,
      upsert: true,
    }
  ).exec();
}

async function buildBrandAssignmentPayload(assignment) {
  if (!assignment) {
    return {
      assignedRh: "",
      assignedBme: "",
      assignedRm: "",
      assignedBm: "",
      RHId: null,
      bdmId: null,
      assignmentId: null,
      assignmentStatus: null,
    };
  }

  const ids = [assignment.RHId, assignment.bdmId]
    .filter(Boolean)
    .map((id) => String(id))
    .filter((id) => mongoose.Types.ObjectId.isValid(id));

  const admins = ids.length
    ? await AdminModel.find({
      _id: {
        $in: ids.map((id) => new mongoose.Types.ObjectId(id)),
      },
    })
      .select("_id name email")
      .lean()
    : [];

  const adminMap = {};
  admins.forEach((admin) => {
    adminMap[String(admin._id)] = admin.name || admin.email || "";
  });

  const assignedRh = assignment.RHId
    ? adminMap[String(assignment.RHId)] || ""
    : "";

  const assignedBme = assignment.bdmId
    ? adminMap[String(assignment.bdmId)] || ""
    : "";

  return {
    assignedRh,
    assignedBme,

    // backward-compatible aliases for frontend
    assignedRm: assignedRh,
    assignedBm: assignedBme,

    RHId: assignment.RHId || null,
    bdmId: assignment.bdmId || null,

    assignmentId: assignment._id || null,
    assignmentStatus: assignment.status || null,
  };
}

exports.adminCreateBrand = async (req, res) => {
  try {
    const actor = await resolveAdminActor(req.admin || {});

    if (!actor || actor.status !== "active") {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const actorRole = String(actor.role || "").toLowerCase();

    if (!ADMIN_BRAND_CREATE_ROLES.has(actorRole)) {
      return res.status(403).json({
        success: false,
        message: "Only Super Admin, Revenue Head, or BME can create a brand.",
      });
    }

    if (actorRole === ROLES.BME && !actor.parentAdmin) {
      return res.status(400).json({
        success: false,
        message: "This BME is not mapped under any RH. Please assign RH first.",
      });
    }

    if (actorRole === ROLES.BME) {
      const rh = await AdminModel.findOne({
        _id: actor.parentAdmin,
        role: ROLES.REVENUE_HEAD,
        status: "active",
      }).select("_id");

      if (!rh) {
        return res.status(400).json({
          success: false,
          message: "Mapped RH for this BME is not active or not found.",
        });
      }
    }

    const brandName = String(req.body?.brandName || req.body?.name || "").trim();
    const email = normalizeBrandEmail(req.body?.email);

    if (!brandName) {
      return res.status(400).json({
        success: false,
        message: "Brand name is required",
      });
    }

    if (!email || !EMAIL_RX.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Valid email is required",
      });
    }

    const existingBrand = await Brand.findOne({ email })
      .select("_id email brandName name isAdminCreated signupCompleted subscription")
      .lean();

    if (existingBrand && !isPendingAdminCreatedBrand(existingBrand)) {
      return res.status(409).json({
        success: false,
        message: "Brand already exists with this email.",
      });
    }

    const freePlan = await SubscriptionPlan.findOne({
      role: "Brand",
      name: "free",
      status: "active",
    }).lean();

    const placeholderPayload = {
      email,
      brandName,
      name: brandName,
      companySize: "",
      industry: "",
      isAdminCreated: true,
      signupCompleted: false,
      createdByAdmin: actor._id,
      adminCreatedRole: actorRole,
      adminCreatedAt: new Date(),
      subscriptionExpired: false,
    };

    if (freePlan) {
      placeholderPayload.subscription = buildSubscriptionFromPlan(freePlan, {
        billingCycle: "monthly",
      });
    }

    let brandDoc;

    if (existingBrand) {
      brandDoc = await Brand.findByIdAndUpdate(
        existingBrand._id,
        {
          $set: placeholderPayload,
        },
        {
          new: true,
          runValidators: true,
        }
      )
        .select("-password -__v")
        .lean();
    } else {
      const created = await Brand.create(placeholderPayload);
      brandDoc = created.toObject();
      delete brandDoc.password;
      delete brandDoc.__v;
    }

    const assignment = await ensureBrandAssignmentForCreator({
      brandId: brandDoc._id,
      actor,
    });

    const assignmentPayload = await buildBrandAssignmentPayload(assignment);

    const creatorPayload = buildCreatorPayload(
      brandDoc,
      await getAdminMapByIds([brandDoc.createdByAdmin]),
      "Brand"
    );

    await notifySafely("adminCreateBrand", req, {
      brandId: String(brandDoc._id),
      adminIds: await getBrandAdminNotificationRecipients(brandDoc._id),
      type: existingBrand ? "brand.placeholder_updated" : "brand.created_by_admin",
      title: existingBrand ? "Brand placeholder updated" : "Brand created by admin",
      message: `${brandDoc.brandName || brandDoc.name || "Brand"} was ${existingBrand ? "updated" : "created"} by ${formatAdminRoleLabel(actorRole)}.`,
      entityType: "brand",
      entityId: String(brandDoc._id),
      actionPath: {
        brand: "/brand/notifications",
        admin: `/admin/brands/view?brandId=${brandDoc._id}`,
      },
    });

    return res.status(existingBrand ? 200 : 201).json({
      success: true,
      message:
        actorRole === ROLES.BME
          ? "Brand created and automatically assigned to BME with its RH."
          : existingBrand
            ? "Brand placeholder updated successfully."
            : "Brand created successfully.",
      brand: {
        ...brandDoc,
        brandId: String(brandDoc._id),
        ...assignmentPayload,
        ...creatorPayload,
        ...buildSignupCurrentStatus(brandDoc),
      },
    });
  } catch (error) {
    console.error("adminCreateBrand error:", error);
    await saveErrorLog(req, error, 500, "ADMIN_CREATE_BRAND_ERROR");

    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Brand already exists with this email.",
      });
    }

    return res.status(500).json({
      success: false,
      message: error?.message || "Internal server error",
    });
  }
};

const ADMIN_INFLUENCER_CREATE_ROLES = new Set([
  ROLES.SUPER_ADMIN,
  ROLES.REVENUE_HEAD,
  ROLES.IME,
]);

function normalizeAdminInfluencerPlatform(value) {
  const v = String(value || "").trim().toLowerCase();

  if (["yt", "youtube", "youTube"].map(String).map(x => x.toLowerCase()).includes(v)) {
    return "youtube";
  }

  if (["ig", "instagram"].includes(v)) {
    return "instagram";
  }

  if (["tk", "tt", "tiktok", "tikTok"].map(String).map(x => x.toLowerCase()).includes(v)) {
    return "tiktok";
  }

  return "";
}

function normalizeAdminInfluencerUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .trim();
}

exports.adminCreateInfluencer = async (req, res) => {
  try {
    const actor = await resolveActorFromMaster(req.admin || req.user || {});
    const actorRole = String(actor?.role || "").trim().toLowerCase();
    const actorId = actor?.adminId && isObjectId(actor.adminId)
      ? toObjectId(actor.adminId)
      : null;

    if (!ADMIN_INFLUENCER_CREATE_ROLES.has(actorRole)) {
      return res.status(403).json({
        success: false,
        message: "Only Super Admin, Revenue Head, or IME can create influencers.",
      });
    }

    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const platform = normalizeAdminInfluencerPlatform(req.body?.platform);
    const username = normalizeAdminInfluencerUsername(req.body?.username);

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Influencer name is required.",
      });
    }

    if (!email || !EMAIL_RX.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Valid influencer email is required.",
      });
    }

    if (!platform) {
      return res.status(400).json({
        success: false,
        message: "Platform is required. Allowed values: youtube, instagram, tiktok.",
      });
    }

    if (!username) {
      return res.status(400).json({
        success: false,
        message: "Username is required.",
      });
    }

    const handle = normalizeHandle(username);

    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        success: false,
        message: "Invalid username format.",
      });
    }

    const emailRegexCI = new RegExp(`^${escapeRegex(email)}$`, "i");

    const existingBrand = await Brand.findOne({ email: emailRegexCI })
      .select("_id email brandName name")
      .lean();

    if (existingBrand) {
      return res.status(409).json({
        success: false,
        message: "This email is already registered as a brand. Please use another email.",
      });
    }

    const existingInfluencer = await Influencer.findOne({ email: emailRegexCI })
      .select("+password")
      .exec();

    if (
      existingInfluencer &&
      !(
        existingInfluencer.isAdminCreated === true &&
        existingInfluencer.signupCompleted === false
      )
    ) {
      return res.status(409).json({
        success: false,
        message: "Influencer already exists with this email.",
      });
    }

    const page1Profile = {
      platform,
      provider: platform,
      username,
      handle,
      isPrimary: true,
      addedByAdmin: true,
      addedAt: new Date(),
    };

    let influencerDoc;

    if (existingInfluencer) {
      existingInfluencer.name = name;
      existingInfluencer.email = email;

      existingInfluencer.countryName = existingInfluencer.countryName || "";
      existingInfluencer.country = existingInfluencer.country || "";
      existingInfluencer.location = existingInfluencer.location || "";

      existingInfluencer.languages = existingInfluencer.languages || [];
      existingInfluencer.categories = existingInfluencer.categories || [];

      existingInfluencer.primaryPlatform = platform;
      existingInfluencer.page1 = [page1Profile];
      existingInfluencer.page2 = [];
      existingInfluencer.page3 = [];

      existingInfluencer.ispage2Skip = false;
      existingInfluencer.ispage3Skip = false;

      existingInfluencer.isAdminCreated = true;
      existingInfluencer.signupCompleted = false;
      existingInfluencer.createdByAdmin = actorId;
      existingInfluencer.adminCreatedRole = actorRole;
      existingInfluencer.adminCreatedAt =
        existingInfluencer.adminCreatedAt || new Date();

      influencerDoc = await existingInfluencer.save();
    } else {
      influencerDoc = await Influencer.create({
        name,
        email,

        countryName: "",
        country: "",
        location: "",

        languages: [],
        categories: [],

        primaryPlatform: platform,

        page1: [page1Profile],
        page2: [],
        page3: [],

        ispage2Skip: false,
        ispage3Skip: false,

        isAdminCreated: true,
        signupCompleted: false,
        createdByAdmin: actorId,
        adminCreatedRole: actorRole,
        adminCreatedAt: new Date(),
      });
    }

    await Modash.findOneAndUpdate(
      {
        provider: platform,
        userId: username,
      },
      {
        $set: {
          influencer: influencerDoc._id,

          // Existing Modash schema field name is influencerId.
          // Store MongoDB _id string here.
          influencerId: String(influencerDoc._id),

          provider: platform,
          userId: username,
          username,
          handle,
          followers: 0,
          url: null,
          picture: null,
          providerRaw: {
            source: "admin_create",
            platform,
            username,
            handle,
          },
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    const influencer = influencerDoc.toObject();
    delete influencer.password;
    delete influencer.__v;

    await notifySafely("adminCreateInfluencer", req, {
      influencerId: String(influencerDoc._id),
      type: existingInfluencer ? "influencer.placeholder_updated" : "influencer.created_by_admin",
      title: existingInfluencer ? "Influencer placeholder updated" : "Influencer created by admin",
      message: `${influencerDoc.name || "Influencer"} was ${existingInfluencer ? "updated" : "created"} by ${formatAdminRoleLabel(actorRole)}.`,
      entityType: "influencer",
      entityId: String(influencerDoc._id),
      actionPath: {
        influencer: "/influencer/notifications",
        admin: `/admin/influencers/view?influencerId=${influencerDoc._id}`,
      },
    });

    return res.status(existingInfluencer ? 200 : 201).json({
      success: true,
      message: existingInfluencer
        ? "Influencer placeholder updated successfully."
        : "Influencer created successfully.",
      influencer: {
        ...influencer,
        _id: String(influencer._id),
        primaryPlatform: platform,
        ...buildCreatorPayload(
          influencer,
          await getAdminMapByIds([influencer.createdByAdmin]),
          "Influencer"
        ),
        ...buildSignupCurrentStatus(influencer),
        socialProfiles: [
          {
            provider: platform,
            username,
            handle,
            followers: 0,
            url: null,
            picture: null,
          },
        ],
      },
    });
  } catch (error) {
    console.error("adminCreateInfluencer error:", error);
    await saveErrorLog(req, error, 500, "ADMIN_CREATE_INFLUENCER_ERROR");

    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Influencer already exists with this email.",
      });
    }

    return res.status(500).json({
      success: false,
      message: error?.message || "Internal server error",
    });
  }
};

exports.getBrandAssignedPlanHistoryList = async (req, res) => {
  try {
    const params = {
      ...(req.query || {}),
      ...(req.body || {}),
    };

    const brandId = String(params.brandId || params._id || "").trim();
    const page = parsePositiveInt(params.page, 1, { min: 1, max: 100000 });
    const limit = parsePositiveInt(params.limit, 10, { min: 1, max: 100 });
    const sortBy = String(params.sortBy || "createdAt").trim();
    const sortOrder = normalizeSortOrder(params.sortOrder, "desc");
    const status = String(params.status || "").trim();

    if (!brandId) {
      return res.status(400).json({
        success: false,
        message: "brandId is required",
      });
    }

    if (!isObjectId(brandId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid brandId",
      });
    }

    const brand = await Brand.findById(brandId)
      .select("_id brandName name email proxyEmail")
      .lean();

    if (!brand) {
      return res.status(404).json({
        success: false,
        message: "Brand not found",
      });
    }

    const filter = {
      brandId: toObjectId(brandId),
    };

    if (status && status !== "all") {
      filter.status = status;
    }

    const allowedSortFields = new Set([
      "createdAt",
      "updatedAt",
      "startedAt",
      "expiresAt",
      "oldPlanName",
      "newPlanName",
      "billingCycle",
      "status",
    ]);

    const finalSortBy = allowedSortFields.has(sortBy) ? sortBy : "createdAt";
    const dir = sortOrder === "asc" ? 1 : -1;

    const [total, rawHistories] = await Promise.all([
      BrandAssignedPlanHistory.countDocuments(filter),

      BrandAssignedPlanHistory.find(filter)
        .sort({ [finalSortBy]: dir, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const adminIds = [
      ...new Set(
        rawHistories
          .map((history) => String(history?.assignedByAdminId || "").trim())
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      ),
    ];

    const admins = adminIds.length
      ? await AdminModel.find({
        _id: {
          $in: adminIds.map((id) => new mongoose.Types.ObjectId(id)),
        },
      })
        .select("_id name email role")
        .lean()
      : [];

    const adminMap = new Map(
      admins.map((admin) => [
        String(admin._id),
        {
          _id: admin._id,
          name: admin.name || "",
          email: admin.email || "",
          role: admin.role || "",
        },
      ])
    );

    const histories = rawHistories.map((history) => {
      const adminId = String(history?.assignedByAdminId || "").trim();
      const assignedByAdmin = adminMap.get(adminId) || null;

      return {
        ...history,
        assignedByAdminId: assignedByAdmin,
        assignedByAdmin: assignedByAdmin,
      };
    });

    return res.status(200).json({
      success: true,
      message: "Brand assigned plan history fetched successfully",
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      sortBy: finalSortBy,
      sortOrder,
      brand: {
        _id: brand._id,
        brandId: String(brand._id),
        name: brand.name || brand.brandName || "",
        email: brand.email || brand.proxyEmail || "",
      },
      histories,
    });
  } catch (error) {
    console.error("getBrandAssignedPlanHistoryList error:", error);
    await saveErrorLog(
      req,
      error,
      500,
      "GET_BRAND_ASSIGNED_PLAN_HISTORY_LIST_ERROR"
    );

    return res.status(500).json({
      success: false,
      message: error?.message || "Internal server error",
    });
  }
};

exports.adminEditCampaign = async (req, res) => {
  try {
    const campaignId = String(
      req.body?.campaignId || req.body?.id || req.body?._id || ""
    ).trim();

    const brandId = String(req.body?.brandId || "").trim();

    if (!campaignId) {
      return res.status(400).json({
        success: false,
        message: "campaignId is required",
      });
    }

    if (!brandId) {
      return res.status(400).json({
        success: false,
        message: "brandId is required",
      });
    }

    const campaignFilter = {
      $or: [{ campaignsId: campaignId }],
    };

    if (mongoose.Types.ObjectId.isValid(campaignId)) {
      campaignFilter.$or.push({
        _id: new mongoose.Types.ObjectId(campaignId),
      });
    }

    const campaign = await Campaign.findOne(campaignFilter);

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: "Campaign not found",
      });
    }

    if (String(campaign.brandId) !== String(brandId)) {
      return res.status(400).json({
        success: false,
        message: "This campaign does not belong to the provided brandId",
      });
    }

    const set = {};

    const assignIfProvided = (field, value) => {
      if (value !== undefined) {
        set[field] = value;
      }
    };

    assignIfProvided("campaignTitle", req.body?.campaignTitle);
    assignIfProvided("description", req.body?.description);
    assignIfProvided("campaignType", req.body?.campaignType);
    assignIfProvided("categoryId", req.body?.categoryId);
    assignIfProvided("subcategoryIds", req.body?.subcategoryIds);
    assignIfProvided("productLink", req.body?.productLink);
    assignIfProvided("productImages", req.body?.productImages);
    assignIfProvided("campaignGoals", req.body?.campaignGoals);
    assignIfProvided("influencerTierIds", req.body?.influencerTierIds);
    assignIfProvided("contentFormats", req.body?.contentFormats);
    assignIfProvided("contentLanguageIds", req.body?.contentLanguageIds);
    assignIfProvided("platformSelection", req.body?.platformSelection);
    assignIfProvided("targetCountryIds", req.body?.targetCountryIds);
    assignIfProvided("targetAgeRanges", req.body?.targetAgeRanges);
    assignIfProvided("preferredHashtags", req.body?.preferredHashtags);
    assignIfProvided("paymentType", req.body?.paymentType);
    assignIfProvided("additionalNotes", req.body?.additionalNotes);

    if (req.body?.numberOfInfluencers !== undefined) {
      set.numberOfInfluencers = Number(req.body.numberOfInfluencers || 0);
    }

    if (req.body?.minFollowers !== undefined) {
      set.minFollowers = Number(req.body.minFollowers || 0);
    }

    if (req.body?.maxFollowers !== undefined) {
      set.maxFollowers = Number(req.body.maxFollowers || 0);
    }

    if (req.body?.campaignBudget !== undefined) {
      const campaignBudget = Number(req.body.campaignBudget || 0);
      set.campaignBudget = campaignBudget;
      set.budget = campaignBudget;
    }

    if (req.body?.budget !== undefined && req.body?.campaignBudget === undefined) {
      const budget = Number(req.body.budget || 0);
      set.budget = budget;
      set.campaignBudget = budget;
    }

    if (req.body?.startAt !== undefined) {
      set.startAt = req.body.startAt || null;
      set["timeline.startDate"] = req.body.startAt || null;
    }

    if (req.body?.endAt !== undefined) {
      set.endAt = req.body.endAt || null;
      set["timeline.endDate"] = req.body.endAt || null;
    }

    /*
      Status is optional.
      Admin can edit any campaign regardless of current status.
      Only update status if frontend sends status.
    */
    if (req.body?.status !== undefined) {
      const status = String(req.body.status || "").trim().toLowerCase();

      set.status = status;
      set.campaignStatus = status;

      if (status === "active") {
        set.isActive = 1;
        set.isDraft = 0;
      }

      if (status === "paused") {
        set.isActive = 0;
        set.isDraft = 0;
      }

      if (status === "completed") {
        set.isActive = 0;
        set.isDraft = 0;
      }

      if (status === "draft") {
        set.isActive = 0;
        set.isDraft = 1;
      }
    }

    if (!Object.keys(set).length) {
      return res.status(400).json({
        success: false,
        message: "No campaign fields provided for update",
      });
    }

    set.updatedByAdmin = {
      adminId: req.admin?.adminId || req.admin?._id || null,
      email: req.admin?.email || "",
      role: req.admin?.role || "",
      updatedAt: new Date(),
    };

    const nextMinFollowers =
      set.minFollowers !== undefined
        ? Number(set.minFollowers)
        : Number(campaign.minFollowers || 0);

    const nextMaxFollowers =
      set.maxFollowers !== undefined
        ? Number(set.maxFollowers)
        : Number(campaign.maxFollowers || 0);

    if (
      nextMinFollowers > 0 &&
      nextMaxFollowers > 0 &&
      nextMaxFollowers < nextMinFollowers
    ) {
      return res.status(400).json({
        success: false,
        message: "maxFollowers must be greater than or equal to minFollowers",
      });
    }

    campaign.set(set);

    const savedCampaign = await campaign.save();

    const updatedCampaign = savedCampaign.toObject();

    await notifySafely("adminEditCampaign", req, {
      brandId: String(updatedCampaign.brandId),
      adminIds: await getCampaignAdminNotificationRecipients({
        campaignId: updatedCampaign._id,
        brandId: updatedCampaign.brandId,
      }),
      type: "campaign.updated_by_admin",
      title: "Campaign updated",
      message: `${updatedCampaign.campaignTitle || "Campaign"} was updated by admin.`,
      entityType: "campaign",
      entityId: String(updatedCampaign._id),
      actionPath: {
        brand: `/brand/campaigns/${updatedCampaign._id}`,
        admin: `/admin/campaigns/view?id=${updatedCampaign._id}`,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Campaign updated successfully",
      data: updatedCampaign,
    });
  } catch (error) {
    console.error("adminEditCampaign error:", error);
    await saveErrorLog(req, error, 500, "ADMIN_EDIT_CAMPAIGN_ERROR");

    return res.status(500).json({
      success: false,
      message: error?.message || "Internal server error",
    });
  }
};