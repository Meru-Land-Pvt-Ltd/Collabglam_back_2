// controllers/dashboardController.js
require("dotenv").config();

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = process.env;

const Brand = require("../models/brand");
const Campaign = require("../models/campaign");
const { InfluencerModel: Influencer } = require("../models/influencer");
const Milestone = require("../models/milestone");
const Dispute = require("../models/dispute");
const Contract = require("../models/contract");
const ApplyCampaign = require("../models/applyCampaign");
const { ProductServiceGoalModel } = require("../models/productServiceGoal");

const { CONTRACT_STATUS } = require("../constants/contract");

/**
 * Generic JWT verifier — populates req.user with the decoded token.
 */

exports.verifyToken = (req, res, next) => {
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(403).json({ message: "Token required" });
  }

  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(403).json({ message: "Invalid or expired token" });
  }
};

// ------------------------- helpers -------------------------

function toObjectIdStrict(id, fieldName = "brandId") {
  const clean = String(id || "").trim();
  if (!mongoose.isValidObjectId(clean)) {
    const err = new Error(`${fieldName} is invalid`);
    err.status = 400;
    throw err;
  }
  return new mongoose.Types.ObjectId(clean);
}

/**
 * During migration some collections may store brandId as ObjectId,
 * and some might still store as string. This returns both variants.
 */
function brandIdVariants(brandObjectId) {
  const oid = brandObjectId instanceof mongoose.Types.ObjectId
    ? brandObjectId
    : new mongoose.Types.ObjectId(String(brandObjectId));
  return [oid, oid.toString()];
}

function brandFilter(field, brandObjectId) {
  return { [field]: { $in: brandIdVariants(brandObjectId) } };
}

/**
 * ✅ IMPORTANT:
 * These filters make sure rejected/superseded contracts are not counted anywhere,
 * even if they were previously accepted/assigned.
 */
function baseActiveContractGuard() {
  return {
    isRejected: { $ne: 1 },
    status: { $nin: [CONTRACT_STATUS.REJECTED, CONTRACT_STATUS.SUPERSEDED] },
    $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: "" }],
  };
}

function acceptedContractFilter(extra = {}) {
  return {
    ...extra,
    isAssigned: 1,
    isAccepted: 1,
    ...baseActiveContractGuard(),
  };
}

function pendingContractFilter(extra = {}) {
  return {
    ...extra,
    isAssigned: 1,
    isAccepted: 0,
    ...baseActiveContractGuard(),
  };
}

// ------------------------- controllers -------------------------

/**
 * Brand dashboard (basic)
 * brandId = Brand._id (ObjectId string)
 */
// exports.getDashboard = async (req, res) => {
//   try {
//     const brandIdRaw = req.body?.brandId || req.user?.brandId;
//     if (!brandIdRaw) return res.status(400).json({ error: "brandId is required" });

//     const brandObjectId = toObjectIdStrict(brandIdRaw, "brandId");

//     // 1) Fetch brand by _id
//     const brand = await Brand.findById(brandObjectId).lean();
//     if (!brand) return res.status(404).json({ error: "Brand not found" });

//     // 2) All campaigns for this brand
//     const campaigns = await Campaign.find(brandFilter("brandId", brandObjectId), "campaignsId isActive").lean();
//     const totalCreatedCampaigns = campaigns.length;

//     const activeCampaignIds = campaigns
//       .filter((c) => Number(c.isActive) === 1)
//       .map((c) => String(c.campaignsId || ""))
//       .filter(Boolean);

//     // 3) Total hired influencers from ACTIVE campaigns (distinct)
//     let totalHiredInfluencers = 0;
//     if (activeCampaignIds.length > 0) {
//       const hiredAgg = await Contract.aggregate([
//         {
//           $match: acceptedContractFilter({
//             ...brandFilter("brandId", brandObjectId),
//             campaignId: { $in: activeCampaignIds },
//           }),
//         },
//         { $group: { _id: "$influencerId" } },
//         { $count: "total" },
//       ]);

//       totalHiredInfluencers = hiredAgg?.[0]?.total || 0;
//     }

//     // 4) Total influencers who have milestones with this brand
//     const milestoneAgg = await Milestone.aggregate([
//       { $match: brandFilter("brandId", brandObjectId) },
//       { $unwind: "$milestoneHistory" },
//       { $group: { _id: "$milestoneHistory.influencerId" } },
//       { $count: "total" },
//     ]);
//     const totalMilestoneInfluencers = milestoneAgg?.[0]?.total || 0;

//     // 5) Budget remaining (brand wallet)
//     const milestoneDoc = await Milestone.findOne(brandFilter("brandId", brandObjectId), "walletBalance").lean();
//     const budgetRemaining = Number(milestoneDoc?.walletBalance ?? 0);

//     return res.status(200).json({
//       brandId: brand._id.toString(),
//       brandName: brand.brandName || brand.name || "",
//       totalCreatedCampaigns,
//       totalHiredInfluencers,
//       totalMilestoneInfluencers,
//       budgetRemaining,
//     });
//   } catch (err) {
//     console.error("Dashboard error:", err);
//     return res.status(err?.status || 500).json({ error: err?.message || "Server error" });
//   }
// };

/**
 * Influencer dashboard:
 * - Requires req.user.influencerId
 */
exports.getDashboardInf = async (req, res) => {
  try {
    const { influencerId } = req.user || {};
    if (!influencerId) return res.status(403).json({ message: "Forbidden" });

    const now = new Date();

    const pendingApprovals = await Contract.countDocuments(pendingContractFilter({ influencerId }));

    const acceptedContracts = await Contract.find(acceptedContractFilter({ influencerId }), "campaignId").lean();
    const acceptedCampaignIds = acceptedContracts.map((c) => String(c.campaignId || "")).filter(Boolean);

    const activeCampaigns = acceptedCampaignIds.length
      ? await Campaign.countDocuments({
        campaignsId: { $in: acceptedCampaignIds },
        "timeline.startDate": { $lte: now },
        $or: [{ "timeline.endDate": { $exists: false } }, { "timeline.endDate": null }, { "timeline.endDate": { $gte: now } }],
      })
      : 0;

    const [releasedAgg] = await Milestone.aggregate([
      { $unwind: "$milestoneHistory" },
      {
        $match: {
          "milestoneHistory.influencerId": influencerId,
          "milestoneHistory.released": true,
        },
      },
      { $group: { _id: null, total: { $sum: "$milestoneHistory.amount" } } },
    ]);

    const [upcomingAgg] = await Milestone.aggregate([
      { $unwind: "$milestoneHistory" },
      {
        $match: {
          "milestoneHistory.influencerId": influencerId,
          "milestoneHistory.released": false,
        },
      },
      { $group: { _id: null, total: { $sum: "$milestoneHistory.amount" } } },
    ]);

    return res.status(200).json({
      influencerId,
      activeCampaigns,
      pendingApprovals,
      totalEarnings: releasedAgg?.total || 0,
      upcomingPayouts: upcomingAgg?.total || 0,
    });
  } catch (err) {
    console.error("Error in getDashboardInf:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getBrandDashboardHome = async (req, res) => {
  try {
    const brandIdRaw = req.body?.brandId || req.user?.brandId;
    if (!brandIdRaw) {
      return res.status(400).json({ error: "brandId is required" });
    }

    const brandObjectId = toObjectIdStrict(brandIdRaw, "brandId");

    // 1) Brand
    const brand = await Brand.findById(brandObjectId, "name brandName").lean();
    if (!brand) {
      return res.status(404).json({ error: "Brand not found" });
    }

    // 2) All campaigns (non-draft)
    const allCampaigns = await Campaign.find(
      { ...brandFilter("brandId", brandObjectId), isDraft: { $ne: 1 } },
      `
        _id
        campaignTitle
        campaignGoals
        campaignBudget
        budget
        status
        publishStatus
        campaignStatus
        isActive
        createdAt
        numberOfInfluencers
        platformSelection
      `
    )
      .sort({ createdAt: -1 })
      .lean();

    const totalCreatedCampaigns = allCampaigns.length;

    const campaignIds = allCampaigns
      .map((c) => String(c._id || ""))
      .filter(Boolean);

    // 2.1) Resolve campaign goal names
    const goalIds = [
      ...new Set(
        allCampaigns
          .flatMap((c) => (Array.isArray(c.campaignGoals) ? c.campaignGoals : []))
          .map((id) => String(id))
          .filter(Boolean)
      ),
    ];

    let goalMap = new Map();
    if (goalIds.length) {
      const goals = await ProductServiceGoalModel.find(
        { _id: { $in: goalIds.map((id) => new mongoose.Types.ObjectId(id)) } },
        "_id goal"
      ).lean();

      goalMap = new Map(goals.map((g) => [String(g._id), g.goal]));
    }

    // 3) Accepted contracts -> latest per campaign
    const acceptedContracts = await Contract.find(
      acceptedContractFilter({ ...brandFilter("brandId", brandObjectId) }),
      "campaignId contractId influencerId lastActionAt createdAt"
    )
      .sort({ lastActionAt: -1, createdAt: -1 })
      .lean();

    const contractByCampaign = new Map();
    for (const c of acceptedContracts) {
      const key = String(c.campaignId || "");
      if (!key) continue;

      if (!contractByCampaign.has(key)) {
        contractByCampaign.set(key, {
          contractId: c.contractId || null,
          influencerId: c.influencerId || null,
        });
      }
    }

    const acceptedCampaignIds = new Set(Array.from(contractByCampaign.keys()));
    const acceptedCount = acceptedCampaignIds.size;

    // 4) Applied influencers per campaign + total
    const appliedCountMap = new Map();
    let totalAppliedInfluencers = 0;

    if (campaignIds.length) {
      const agg = await ApplyCampaign.aggregate([
        { $match: { campaignId: { $in: campaignIds } } },
        { $unwind: "$applicants" },
        {
          $group: {
            _id: {
              campaignId: "$campaignId",
              influencerId: "$applicants.influencerId",
            },
          },
        },
        {
          $group: {
            _id: "$_id.campaignId",
            appliedInfluencersCount: { $sum: 1 },
          },
        },
        {
          $facet: {
            perCampaign: [{ $project: { _id: 1, appliedInfluencersCount: 1 } }],
            total: [
              {
                $group: {
                  _id: null,
                  totalAppliedInfluencers: { $sum: "$appliedInfluencersCount" },
                },
              },
            ],
          },
        },
      ]);

      const perCampaign = agg?.[0]?.perCampaign || [];
      const total = agg?.[0]?.total?.[0]?.totalAppliedInfluencers || 0;

      totalAppliedInfluencers = Number(total) || 0;
      perCampaign.forEach((row) => {
        appliedCountMap.set(String(row._id), Number(row.appliedInfluencersCount || 0));
      });
    }

    // 5) Show list rule
    const anyUnaccepted = allCampaigns.some((camp) => {
      const id = String(camp._id || "");
      return id && !acceptedCampaignIds.has(id);
    });

    const showAll = acceptedCount === 0 || anyUnaccepted;
    const campaignsMode = showAll ? "all" : "accepted";

    const baseList = showAll
      ? allCampaigns
      : allCampaigns.filter((c) => acceptedCampaignIds.has(String(c._id || "")));

    const campaigns = baseList.map((c) => {
      const id = String(c._id || "");
      const meta = contractByCampaign.get(id) || {};

      const goalNames = (Array.isArray(c.campaignGoals) ? c.campaignGoals : [])
        .map((gid) => goalMap.get(String(gid)))
        .filter(Boolean);

      return {
        // campaignId: id,
        id, // optional

        campaignTitle: c.campaignTitle || "",
        productOrServiceName: c.campaignTitle || "",

        goals: goalNames,
        goal: goalNames[0] || "",

        campaignBudget: Number(c.campaignBudget || 0),
        budget: Number(c.campaignBudget || c.budget || 0),

        status: c.status || "",
        publishStatus: c.publishStatus || "",
        campaignStatus: c.campaignStatus || "",

        isActive: Number(c.isActive || 0),
        createdAt: c.createdAt || null,

        numberOfInfluencers: Number(c.numberOfInfluencers || 0),
        platformSelection: Array.isArray(c.platformSelection) ? c.platformSelection : [],

        hasAcceptedInfluencer: acceptedCampaignIds.has(id),
        influencerId: meta.influencerId ?? null,
        contractId: meta.contractId ?? null,

        appliedInfluencersCount: appliedCountMap.get(id) || 0,
      };
    });

    // 6) Total hired influencers from ACTIVE campaigns only
    const activeCampaignIds = allCampaigns
      .filter(
        (c) =>
          Number(c.isActive) === 1 &&
          c.status !== "draft" &&
          c.status !== "archived"
      )
      .map((c) => String(c._id || ""))
      .filter(Boolean);

    let totalHiredInfluencers = 0;
    if (activeCampaignIds.length) {
      const hiredAgg = await Contract.aggregate([
        {
          $match: acceptedContractFilter({
            ...brandFilter("brandId", brandObjectId),
            campaignId: { $in: activeCampaignIds },
          }),
        },
        { $group: { _id: "$influencerId" } },
        { $count: "total" },
      ]);

      totalHiredInfluencers = hiredAgg?.[0]?.total || 0;
    }

    // 7) Budget remaining
    const milestone = await Milestone.findOne(
      brandFilter("brandId", brandObjectId),
      "walletBalance"
    ).lean();

    const budgetRemaining = Number(milestone?.walletBalance ?? 0);

    return res.status(200).json({
      brandId: String(brand._id),
      brandName: brand.brandName || brand.name || "",
      totalCreatedCampaigns,
      totalHiredInfluencers,
      totalAppliedInfluencers,
      budgetRemaining,
      campaignsMode,
      campaigns,
    });
  } catch (err) {
    console.error("getBrandDashboardHome error:", err);
    return res
      .status(err?.status || 500)
      .json({ error: err?.message || "Server error" });
  }
};
const ROLES = {
  SUPER_ADMIN: "super_admin",
  REVENUE_HEAD: "revenue_head",
  IME: "ime",
  BME: "bme",
};

// ------------------------- basic helpers -------------------------

const parsePositiveInt = (value, fallback = 1) => {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) && num > 0 ? num : fallback;
};

const normalizeSortOrder = (value, fallback = "desc") => {
  const clean = String(value || "").trim().toLowerCase();

  if (clean === "asc" || clean === "1") return "asc";
  if (clean === "desc" || clean === "-1") return "desc";

  return fallback;
};

const escapeRegex = (value = "") => {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const safeRegex = (value) => {
  const clean = String(value || "").trim();
  if (!clean) return null;
  return new RegExp(escapeRegex(clean), "i");
};

const isObjectId = (id) => mongoose.isValidObjectId(String(id || ""));

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

const normalizeRole = (req) => {
  return String(
    req.admin?.role ||
    req.user?.role ||
    req.adminUser?.role ||
    req.auth?.role ||
    ""
  )
    .trim()
    .toLowerCase();
};

const getActor = (req) => {
  return req.admin || req.user || req.adminUser || req.auth || {};
};

const getPagination = (req, key = "") => {
  const body = req.body || {};
  const query = req.query || {};

  const pageKey = key ? `${key}Page` : "page";
  const limitKey = key ? `${key}Limit` : "limit";

  return {
    page: parsePositiveInt(body[pageKey] || query[pageKey] || body.page || query.page, 1),
    limit: parsePositiveInt(body[limitKey] || query[limitKey] || body.limit || query.limit, 10),
  };
};

const getSearch = (req, key = "") => {
  const body = req.body || {};
  const query = req.query || {};

  const searchKey = key ? `${key}Search` : "search";

  return String(body[searchKey] || query[searchKey] || body.search || query.search || "").trim();
};

const brandIdVariantsFromValues = (values = []) => {
  const stringValues = values.map((id) => String(id || "").trim()).filter(Boolean);

  const objectIds = stringValues
    .filter((id) => isObjectId(id))
    .map((id) => toObjectId(id));

  return {
    stringValues,
    objectIds,
  };
};

const makeBrandScopeFilter = (brandKeys = []) => {
  const { stringValues, objectIds } = brandIdVariantsFromValues(brandKeys);

  if (!stringValues.length && !objectIds.length) {
    return { _id: null };
  }

  return {
    $or: [
      { brandId: { $in: stringValues } },
      { brandId: { $in: objectIds } },
      { _id: { $in: objectIds } },
    ],
  };
};

const getAdminIdentityValues = (actor = {}) => {
  return [
    actor._id,
    actor.id,
    actor.adminId,
    actor.userId,
    actor.email,
    actor.name,
    actor.fullName,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
};

// ------------------------- brand assignment helpers -------------------------

const isEmptyAssignment = (value) => {
  const normalized = String(value || "").trim().toLowerCase();

  return (
    !normalized ||
    normalized === "—" ||
    normalized === "-" ||
    normalized === "null" ||
    normalized === "undefined" ||
    normalized === "unassigned" ||
    normalized === "not assigned"
  );
};

const isUnassignedBrand = (brand = {}) => {
  return [
    "assignedRh",
    "assignedRm",
    "assignedBme",
    "assignedBm",
    "assignedIme",
    "assignedIm",
    "revenueHead",
    "revenueManager",
    "bme",
    "bm",
    "ime",
    "im",
  ].every((field) => isEmptyAssignment(brand?.[field]));
};

const getRoleBrandScopeFilter = (role, actor = {}) => {
  if (role === ROLES.SUPER_ADMIN || role === ROLES.REVENUE_HEAD) {
    return {};
  }

  const values = getAdminIdentityValues(actor);

  if (!values.length) {
    return { _id: null };
  }

  if (role === ROLES.IME) {
    return {
      $or: [
        { assignedIme: { $in: values } },
        { assignedIm: { $in: values } },
        { ime: { $in: values } },
        { im: { $in: values } },
        { assignedImeId: { $in: values } },
        { assignedImId: { $in: values } },
      ],
    };
  }

  if (role === ROLES.BME) {
    return {
      $or: [
        { assignedBme: { $in: values } },
        { assignedBm: { $in: values } },
        { bme: { $in: values } },
        { bm: { $in: values } },
        { assignedBmeId: { $in: values } },
        { assignedBmId: { $in: values } },
      ],
    };
  }

  return { _id: null };
};

const getScopedBrandKeysForRole = async (role, actor = {}) => {
  const scopeFilter = getRoleBrandScopeFilter(role, actor);

  if (!Object.keys(scopeFilter).length) {
    return null;
  }

  const brands = await Brand.find(scopeFilter).select("_id brandId").lean();

  return brands.flatMap((brand) =>
    [
      String(brand._id || ""),
      String(brand.brandId || ""),
    ].filter(Boolean)
  );
};

// ------------------------- dashboard summary helpers -------------------------

const getDateRanges = () => {
  const now = new Date();

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
  const startOfQuarter = new Date(now.getFullYear(), quarterStartMonth, 1);

  const startOfYear = new Date(now.getFullYear(), 0, 1);

  return {
    now,
    startOfMonth,
    startOfQuarter,
    startOfYear,
  };
};

const buildCampaignMatch = ({ brandKeys = null, extraFilters = [] } = {}) => {
  const andFilters = [
    {
      $or: [
        { isDraft: { $exists: false } },
        { isDraft: false },
        { isDraft: 0 },
      ],
    },
    ...extraFilters,
  ];

  if (Array.isArray(brandKeys)) {
    andFilters.push(makeBrandScopeFilter(brandKeys));
  }

  return { $and: andFilters };
};

const getRevenueTotal = async ({ startDate, endDate, brandKeys = null }) => {
  const match = buildCampaignMatch({
    brandKeys,
    extraFilters: [
      {
        createdAt: {
          $gte: startDate,
          $lte: endDate,
        },
      },
    ],
  });

  const result = await Campaign.aggregate([
    { $match: match },
    {
      $addFields: {
        dashboardRevenueNumber: {
          $convert: {
            input: {
              $ifNull: ["$budget", "$campaignBudget"],
            },
            to: "double",
            onError: 0,
            onNull: 0,
          },
        },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: "$dashboardRevenueNumber" },
      },
    },
  ]);

  return Number(result?.[0]?.total || 0);
};

const getCampaignCounts = async ({ brandKeys = null } = {}) => {
  const now = new Date();

  const activeMatch = buildCampaignMatch({
    brandKeys,
    extraFilters: [
      {
        $or: [
          { isActive: true },
          { isActive: 1 },
          { campaignStatus: { $regex: "active", $options: "i" } },
          {
            $and: [
              { "timeline.startDate": { $lte: now } },
              {
                $or: [
                  { "timeline.endDate": { $exists: false } },
                  { "timeline.endDate": null },
                  { "timeline.endDate": { $gte: now } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  const completedMatch = buildCampaignMatch({
    brandKeys,
    extraFilters: [
      {
        $or: [
          { campaignStatus: { $regex: "completed", $options: "i" } },
          { campaignStatus: { $regex: "complete", $options: "i" } },
          { "timeline.endDate": { $lt: now } },
        ],
      },
    ],
  });

  const [activeCampaigns, completedCampaigns] = await Promise.all([
    Campaign.countDocuments(activeMatch),
    Campaign.countDocuments(completedMatch),
  ]);

  return {
    activeCampaigns,
    completedCampaigns,
  };
};

const getRevenueMetrics = async ({ brandKeys = null } = {}) => {
  const { now, startOfMonth, startOfQuarter, startOfYear } = getDateRanges();

  const [
    totalRevenueThisMonth,
    totalRevenueThisQuarter,
    totalRevenueThisYear,
    campaignCounts,
  ] = await Promise.all([
    getRevenueTotal({
      startDate: startOfMonth,
      endDate: now,
      brandKeys,
    }),
    getRevenueTotal({
      startDate: startOfQuarter,
      endDate: now,
      brandKeys,
    }),
    getRevenueTotal({
      startDate: startOfYear,
      endDate: now,
      brandKeys,
    }),
    getCampaignCounts({ brandKeys }),
  ]);

  return {
    totalRevenueThisMonth,
    totalRevenueThisQuarter,
    totalRevenueThisYear,
    activeCampaigns: campaignCounts.activeCampaigns,
    completedCampaigns: campaignCounts.completedCampaigns,
  };
};

// ------------------------- brands list -------------------------

const getBrandsList = async (req, options = {}) => {
  const { page, limit } = getPagination(req, "brands");
  const search = getSearch(req, "brands");

  const sortBy = String(
    req.body?.brandsSortBy ||
    req.query?.brandsSortBy ||
    req.body?.sortBy ||
    req.query?.sortBy ||
    "createdAt"
  ).trim();

  const sortOrder = normalizeSortOrder(
    req.body?.brandsSortOrder ||
    req.query?.brandsSortOrder ||
    req.body?.sortOrder ||
    req.query?.sortOrder,
    "desc"
  );

  const allowedSortFields = new Set([
    "name",
    "brandName",
    "email",
    "phone",
    "planName",
    "createdAt",
    "expiresAt",
    "status",
    "assignedRh",
    "assignedRm",
    "assignedBme",
    "assignedBm",
    "assignedIme",
    "assignedIm",
  ]);

  const field = allowedSortFields.has(sortBy) ? sortBy : "createdAt";
  const dir = sortOrder === "asc" ? 1 : -1;

  const filter = {
    ...(options.extraFilter || {}),
  };

  const re = safeRegex(search);

  if (re) {
    filter.$or = [
      { name: re },
      { brandName: re },
      { email: re },
      { phone: re },
      { callingcode: re },
      { companySize: re },
      { industry: re },
      { planName: re },
      { status: re },
      { assignedRh: re },
      { assignedRm: re },
      { assignedBme: re },
      { assignedBm: re },
      { assignedIme: re },
      { assignedIm: re },
    ];
  }

  const total = await Brand.countDocuments(filter);

  const brands = await Brand.find(filter)
    .select("-password -__v")
    .sort({ [field]: dir, createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    sortBy: field,
    sortOrder,
    brands,
  };
};

const getUnassignedBrands = async (req, options = {}) => {
  const { page, limit } = getPagination(req, "unassignedBrands");
  const search = getSearch(req, "unassignedBrands");

  const filter = {
    ...(options.extraFilter || {}),
  };

  const re = safeRegex(search);

  if (re) {
    filter.$or = [
      { name: re },
      { brandName: re },
      { email: re },
      { phone: re },
      { companySize: re },
      { industry: re },
      { planName: re },
      { status: re },
    ];
  }

  const rawBrands = await Brand.find(filter)
    .select("-password -__v")
    .sort({ createdAt: -1 })
    .lean();

  const filtered = rawBrands.filter(isUnassignedBrand);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const brands = filtered.slice((page - 1) * limit, page * limit);

  return {
    page,
    limit,
    total,
    totalPages,
    brands,
  };
};

// ------------------------- influencers list -------------------------
const getModelCount = async (Model, filter = {}) => {
  if (Model && typeof Model.countDocuments === "function") {
    return Model.countDocuments(filter);
  }

  if (Model && typeof Model.find === "function") {
    const rows = await Model.find(filter).select("_id").lean();
    return rows.length;
  }

  return 0;
};

const getFirstValue = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return "";
};

const flattenPageData = (influencer = {}) => {
  return [
    ...(Array.isArray(influencer.page1) ? influencer.page1 : []),
    ...(Array.isArray(influencer.page2) ? influencer.page2 : []),
    ...(Array.isArray(influencer.page3) ? influencer.page3 : []),
  ];
};

const extractPrimaryPlatform = (influencer = {}) => {
  if (influencer.primaryPlatform) {
    return influencer.primaryPlatform;
  }

  const pages = flattenPageData(influencer);

  const found = pages.find((item) => {
    return item?.primaryPlatform || item?.platform || item?.provider;
  });

  return getFirstValue(
    found?.primaryPlatform,
    found?.platform,
    found?.provider
  );
};

const extractSocialProfiles = (influencer = {}) => {
  if (Array.isArray(influencer.socialProfiles)) {
    return influencer.socialProfiles.map((profile) => ({
      provider: profile.provider || "",
      handle: profile.handle || "",
      username: profile.username || "",
      followers: Number(profile.followers || 0),
      url: profile.url || "",
      picture: profile.picture || "",
    }));
  }

  const pages = flattenPageData(influencer);

  const profiles = [];

  for (const item of pages) {
    if (Array.isArray(item?.socialProfiles)) {
      profiles.push(...item.socialProfiles);
      continue;
    }

    if (
      item?.provider ||
      item?.platform ||
      item?.handle ||
      item?.username ||
      item?.followers ||
      item?.url
    ) {
      profiles.push(item);
    }
  }

  return profiles.map((profile) => ({
    provider: profile.provider || profile.platform || "",
    handle: profile.handle || "",
    username: profile.username || "",
    followers: Number(profile.followers || profile.followerCount || 0),
    url: profile.url || profile.profileUrl || "",
    picture: profile.picture || profile.profilePicture || profile.image || "",
  }));
};

const toInfluencerDashboardRow = (influencer = {}) => {
  return {
    _id: String(influencer._id || ""),
    influencerId: String(influencer._id || ""),

    email: influencer.email || "",
    name: influencer.name || "",

    country: {
      _id: influencer.countryId ? String(influencer.countryId) : "",
      name: influencer.countryName || "",
    },

    languages: Array.isArray(influencer.languages)
      ? influencer.languages.map((item) => ({
        _id: item?._id ? String(item._id) : "",
        name: item?.name || "",
      }))
      : [],

    categories: Array.isArray(influencer.categories)
      ? influencer.categories.map((item) => ({
        _id: item?._id ? String(item._id) : "",
        name: item?.name || "",
      }))
      : [],

    proxyEmail: influencer.proxyEmail || "",

    primaryPlatform: extractPrimaryPlatform(influencer),

    socialProfiles: extractSocialProfiles(influencer),

    pageCounts: {
      page1: Array.isArray(influencer.page1) ? influencer.page1.length : 0,
      page2: Array.isArray(influencer.page2) ? influencer.page2.length : 0,
      page3: Array.isArray(influencer.page3) ? influencer.page3.length : 0,
    },

    onboarding: {
      route: "campaign",
      page1Done: Array.isArray(influencer.page1) && influencer.page1.length > 0,
      page2Done:
        Boolean(influencer.ispage2Skip) ||
        (Array.isArray(influencer.page2) && influencer.page2.length > 0),
      page3Done:
        Boolean(influencer.ispage3Skip) ||
        (Array.isArray(influencer.page3) && influencer.page3.length > 0),
      ispage2Skip: Boolean(influencer.ispage2Skip),
      ispage3Skip: Boolean(influencer.ispage3Skip),
    },

    createdAt: influencer.createdAt || null,
    updatedAt: influencer.updatedAt || null,
  };
};

const getInfluencersList = async (req) => {
  const { page, limit } = getPagination(req, "influencers");
  const search = getSearch(req, "influencers");

  const sortBy = String(
    req.body?.influencersSortBy ||
    req.query?.influencersSortBy ||
    "name"
  ).trim();

  const sortOrder = normalizeSortOrder(
    req.body?.influencersSortOrder || req.query?.influencersSortOrder,
    "asc"
  );

  const allowedSortFields = new Set([
    "name",
    "email",
    "countryName",
    "createdAt",
  ]);

  const field = allowedSortFields.has(sortBy) ? sortBy : "name";
  const dir = sortOrder === "desc" ? -1 : 1;

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

  const rows = await Influencer.find(filter)
    .select(
      `
        _id
        email
        name
        countryId
        countryName
        languages
        categories
        proxyEmail
        primaryPlatform
        socialProfiles
        page1
        page2
        page3
        ispage2Skip
        ispage3Skip
        createdAt
        updatedAt
      `
    )
    .sort({ [field]: dir, createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const influencers = rows.map(toInfluencerDashboardRow);

  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    sortBy: field,
    sortOrder,
    influencers,
  };
};

// ------------------------- campaigns list -------------------------

const getCampaignSortField = (sortBy = "createdAt") => {
  const allowed = new Set([
    "createdAt",
    "updatedAt",
    "campaignTitle",
    "productOrServiceName",
    "brandName",
    "budget",
    "campaignBudget",
    "applicantCount",
    "isActive",
    "timeline.startDate",
    "timeline.endDate",
  ]);

  return allowed.has(sortBy) ? sortBy : "createdAt";
};

const toCampaignSummary = (doc = {}) => {
  const timeline = doc.timeline || {};

  const campaignId = String(
    doc.campaignsId ||
    doc.campaignId ||
    doc._id ||
    ""
  );

  return {
    _id: String(doc._id || ""),
    id: campaignId,
    campaignId,
    campaignsId: doc.campaignsId || "",

    brandId: String(doc.brandId || ""),
    brandName: doc.brandName || "",

    name: doc.campaignTitle || "",
    campaignName: doc.campaignTitle || "",
    campaignTitle: doc.campaignTitle || "",

    productOrServiceName: doc.productOrServiceName || "",
    goal: doc.goal || "",

    budget: Number(doc.budget || doc.campaignBudget || 0),
    campaignBudget: Number(doc.campaignBudget || doc.budget || 0),

    applicantCount: Number(doc.applicantCount || 0),
    isActive: Number(doc.isActive || 0),
    isDraft: Number(doc.isDraft || 0),
    byAi: doc.byAi || false,
    createdBy: doc.createdBy || null,

    campaignStatus: doc.campaignStatus || "",
    startDate: timeline.startDate || null,
    endDate: timeline.endDate || null,

    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
};

const getCampaignsList = async (req, options = {}) => {
  const { page, limit } = getPagination(req, "campaigns");
  const search = getSearch(req, "campaigns");

  const sortBy = String(
    req.body?.campaignsSortBy ||
    req.query?.campaignsSortBy ||
    "createdAt"
  ).trim();

  const sortOrder = normalizeSortOrder(
    req.body?.campaignsSortOrder || req.query?.campaignsSortOrder,
    "desc"
  );

  const status = String(
    req.body?.campaignStatus ||
    req.query?.campaignStatus ||
    req.body?.status ||
    req.query?.status ||
    "all"
  )
    .trim()
    .toLowerCase();

  const brandId = String(req.body?.brandId || req.query?.brandId || "").trim();

  const andFilters = [];

  if (Array.isArray(options.brandKeys)) {
    andFilters.push(makeBrandScopeFilter(options.brandKeys));
  }

  if (brandId) {
    const { stringValues, objectIds } = brandIdVariantsFromValues([brandId]);

    andFilters.push({
      $or: [
        { brandId: { $in: stringValues } },
        { brandId: { $in: objectIds } },
      ],
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
        { campaignStatus: re },
      ],
    });
  }

  if (status !== "all") {
    if (status === "active") {
      andFilters.push({
        $or: [
          { isActive: true },
          { isActive: 1 },
          { campaignStatus: { $regex: "active", $options: "i" } },
        ],
      });
    } else if (status === "completed" || status === "complete") {
      andFilters.push({
        $or: [
          { campaignStatus: { $regex: "completed", $options: "i" } },
          { campaignStatus: { $regex: "complete", $options: "i" } },
          { "timeline.endDate": { $lt: new Date() } },
        ],
      });
    } else if (status === "draft") {
      andFilters.push({
        $or: [
          { isDraft: true },
          { isDraft: 1 },
          { campaignStatus: { $regex: "draft", $options: "i" } },
        ],
      });
    } else {
      andFilters.push({
        campaignStatus: { $regex: status, $options: "i" },
      });
    }
  }

  const filter = andFilters.length ? { $and: andFilters } : {};

  const field = getCampaignSortField(sortBy);
  const dir = sortOrder === "asc" ? 1 : -1;

  const total = await Campaign.countDocuments(filter);

  const rows = await Campaign.find(filter)
    .select(
      `
        _id
        brandId
        brandName
        campaignsId
        campaignId
        campaignTitle
        productOrServiceName
        goal
        budget
        campaignBudget
        applicantCount
        isActive
        isDraft
        byAi
        createdBy
        campaignStatus
        timeline.startDate
        timeline.endDate
        createdAt
        updatedAt
      `
    )
    .sort({ [field]: dir, createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const campaigns = rows.map(toCampaignSummary);

  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    status,
    sortBy: field,
    sortOrder,
    campaigns,
  };
};

// ------------------------- disputes list -------------------------

const normalizeStatusInput = (value) => {
  const clean = String(value || "").trim();

  if (!clean || clean === "0" || clean.toLowerCase() === "all") {
    return "__ALL__";
  }

  return clean;
};

const getDisputesList = async (req) => {
  const { page, limit } = getPagination(req, "disputes");

  const status = req.body?.disputeStatus || req.query?.disputeStatus || req.body?.status;
  const campaignId = req.body?.campaignId || req.query?.campaignId;
  const brandId = req.body?.brandId || req.query?.brandId;
  const influencerId = req.body?.influencerId || req.query?.influencerId;
  const appliedBy = req.body?.appliedBy || req.query?.appliedBy;
  const search = getSearch(req, "disputes");

  const filter = {};

  const normalizedStatus = normalizeStatusInput(status);

  if (normalizedStatus && normalizedStatus !== "__ALL__") {
    filter.status = normalizedStatus;
  }

  if (campaignId) filter.campaignId = String(campaignId);
  if (brandId) filter.brandId = String(brandId);
  if (influencerId) filter.influencerId = String(influencerId);

  const re = safeRegex(search);

  if (re) {
    filter.$or = [
      { subject: re },
      { description: re },
      { disputeId: re },
    ];
  }

  if (appliedBy && typeof appliedBy === "string") {
    const role = String(appliedBy).toLowerCase();

    if (role === "brand") filter["createdBy.role"] = "Brand";
    if (role === "influencer") filter["createdBy.role"] = "Influencer";
  }

  const total = await Dispute.countDocuments(filter);

  const rows = await Dispute.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const brandIds = [...new Set(rows.map((r) => String(r.brandId || "")).filter(Boolean))];
  const influencerIds = [...new Set(rows.map((r) => String(r.influencerId || "")).filter(Boolean))];
  const campaignIds = [...new Set(rows.map((r) => String(r.campaignId || "")).filter(Boolean))];

  const brandObjectIds = brandIds.filter(isObjectId).map(toObjectId);
  const influencerObjectIds = influencerIds.filter(isObjectId).map(toObjectId);
  const campaignObjectIds = campaignIds.filter(isObjectId).map(toObjectId);

  const [brands, influencers, campaigns] = await Promise.all([
    brandIds.length
      ? Brand.find({
        $or: [
          { _id: { $in: brandObjectIds } },
          { brandId: { $in: brandIds } },
        ],
      })
        .select("_id brandId name brandName")
        .lean()
      : [],

    influencerIds.length
      ? Influencer.find({
        $or: [
          { _id: { $in: influencerObjectIds } },
          { influencerId: { $in: influencerIds } },
        ],
      })
        .select("_id influencerId name")
        .lean()
      : [],

    campaignIds.length
      ? Campaign.find({
        $or: [
          { _id: { $in: campaignObjectIds } },
          { campaignsId: { $in: campaignIds } },
          { campaignId: { $in: campaignIds } },
        ],
      })
        .select("_id campaignsId campaignId campaignTitle")
        .lean()
      : [],
  ]);

  const brandMap = new Map();
  brands.forEach((brand) => {
    const name = brand.brandName || brand.name || null;
    brandMap.set(String(brand._id), name);
    if (brand.brandId) brandMap.set(String(brand.brandId), name);
  });

  const influencerMap = new Map();
  influencers.forEach((influencer) => {
    influencerMap.set(String(influencer._id), influencer.name || null);
    if (influencer.influencerId) {
      influencerMap.set(String(influencer.influencerId), influencer.name || null);
    }
  });

  const campaignMap = new Map();
  campaigns.forEach((campaign) => {
    campaignMap.set(String(campaign._id), campaign.campaignTitle || null);
    if (campaign.campaignsId) {
      campaignMap.set(String(campaign.campaignsId), campaign.campaignTitle || null);
    }
    if (campaign.campaignId) {
      campaignMap.set(String(campaign.campaignId), campaign.campaignTitle || null);
    }
  });

  const disputes = rows.map((row) => {
    return {
      ...row,
      brandName: brandMap.get(String(row.brandId || "")) || null,
      influencerName: influencerMap.get(String(row.influencerId || "")) || null,
      campaignName: campaignMap.get(String(row.campaignId || "")) || null,
      raisedByRole: row.createdBy?.role || null,
      raisedById: row.createdBy?.id || null,
    };
  });

  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    disputes,
  };
};

// ------------------------- influencer campaigns using ApplyCampaign -------------------------

const getApplicantStatus = (applicant = {}, fromApprovedArray = false) => {
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

const getCampaignsByInfluencerIdDashboard = async (req, options = {}) => {
  const influencerId = String(
    req.body?.influencerId ||
    req.query?.influencerId ||
    req.params?.influencerId ||
    req.body?.id ||
    ""
  ).trim();

  const { page, limit } = getPagination(req, "influencerCampaigns");
  const search = getSearch(req, "influencerCampaigns");

  const sortBy = String(
    req.body?.influencerCampaignsSortBy ||
    req.query?.influencerCampaignsSortBy ||
    "createdAt"
  ).trim();

  const sortOrder = normalizeSortOrder(
    req.body?.influencerCampaignsSortOrder ||
    req.query?.influencerCampaignsSortOrder,
    "desc"
  );

  const statusFilter = String(
    req.body?.influencerCampaignStatus ||
    req.query?.influencerCampaignStatus ||
    "all"
  )
    .trim()
    .toLowerCase();

  if (!influencerId) {
    return null;
  }

  const influencerFilter = isObjectId(influencerId)
    ? {
      $or: [
        { _id: toObjectId(influencerId) },
        { influencerId },
      ],
    }
    : { influencerId };

  const influencer = await Influencer.findOne(influencerFilter)
    .select("_id influencerId name email")
    .lean();

  if (!influencer) {
    return {
      success: false,
      message: "Influencer not found",
      page,
      limit,
      total: 0,
      totalPages: 1,
      count: 0,
      campaigns: [],
    };
  }

  const influencerLookupValues = [
    influencerId,
    String(influencer._id || ""),
    String(influencer.influencerId || ""),
  ].filter(Boolean);

  const applyRows = await ApplyCampaign.find({
    $or: [
      { "applicants.influencerId": { $in: influencerLookupValues } },
      { "approved.influencerId": { $in: influencerLookupValues } },
    ],
  })
    .select("campaignId applicants approved createdAt updatedAt")
    .lean();

  const applyMap = new Map();

  for (const row of applyRows) {
    const campaignId = String(row?.campaignId || "").trim();
    if (!campaignId) continue;

    const applicants = Array.isArray(row?.applicants) ? row.applicants : [];
    const approved = Array.isArray(row?.approved) ? row.approved : [];

    let applicant =
      approved.find((item) =>
        influencerLookupValues.includes(String(item?.influencerId || ""))
      ) || null;

    let fromApprovedArray = false;

    if (applicant) {
      fromApprovedArray = true;
    } else {
      applicant =
        applicants.find((item) =>
          influencerLookupValues.includes(String(item?.influencerId || ""))
        ) || null;
    }

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
    return {
      success: true,
      page,
      limit,
      total: 0,
      totalPages: 1,
      count: 0,
      campaigns: [],
      influencer: {
        _id: String(influencer._id || ""),
        influencerId: influencer.influencerId || influencerId,
        name: influencer.name || "",
        email: influencer.email || "",
      },
    };
  }

  const campaignObjectIds = appliedCampaignIds.filter(isObjectId).map(toObjectId);

  const andFilters = [
    {
      $or: [
        { _id: { $in: campaignObjectIds } },
        { campaignsId: { $in: appliedCampaignIds } },
        { campaignId: { $in: appliedCampaignIds } },
      ],
    },
  ];

  if (Array.isArray(options.brandKeys)) {
    andFilters.push(makeBrandScopeFilter(options.brandKeys));
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

  const campaignDocs = await Campaign.find({ $and: andFilters })
    .select(
      `
        _id
        brandId
        brandName
        campaignsId
        campaignId
        campaignTitle
        productOrServiceName
        goal
        budget
        campaignBudget
        applicantCount
        isActive
        isDraft
        campaignStatus
        timeline.startDate
        timeline.endDate
        createdAt
        updatedAt
      `
    )
    .lean();

  const normalized = campaignDocs.map((doc) => {
    const summary = toCampaignSummary(doc);

    const possibleKeys = [
      String(doc._id || ""),
      String(doc.campaignsId || ""),
      String(doc.campaignId || ""),
    ].filter(Boolean);

    const applyInfo =
      possibleKeys.map((key) => applyMap.get(key)).find(Boolean) || null;

    const applicant = applyInfo?.applicant || {};

    return {
      ...summary,
      appliedDate: applyInfo?.appliedAt || doc.createdAt || null,
      status: applyInfo?.status || "active",
      statusBrand: applicant.statusBrand || "",
      statusInfluencer: applicant.statusInfluencer || "",
      isShortlisted: Number(applicant.isShortlisted || 0),
      isUndicided: Number(applicant.isUndicided || 0),
      isRejected: Number(applicant.isRejected || 0),
      contractId: applicant.contractId || "",
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

  const sorted = [...filteredByStatus].sort((a, b) => {
    let aValue;
    let bValue;

    switch (field) {
      case "campaignTitle":
        aValue = a.campaignTitle || "";
        bValue = b.campaignTitle || "";
        break;

      case "productOrServiceName":
        aValue = a.productOrServiceName || "";
        bValue = b.productOrServiceName || "";
        break;

      case "brandName":
        aValue = a.brandName || "";
        bValue = b.brandName || "";
        break;

      case "budget":
      case "campaignBudget":
        aValue = Number(a.budget || a.campaignBudget || 0);
        bValue = Number(b.budget || b.campaignBudget || 0);
        break;

      case "isActive":
        aValue = Number(a.isActive || 0);
        bValue = Number(b.isActive || 0);
        break;

      case "timeline.startDate":
        aValue = new Date(a.startDate || 0).getTime();
        bValue = new Date(b.startDate || 0).getTime();
        break;

      case "timeline.endDate":
        aValue = new Date(a.endDate || 0).getTime();
        bValue = new Date(b.endDate || 0).getTime();
        break;

      case "updatedAt":
        aValue = new Date(a.updatedAt || 0).getTime();
        bValue = new Date(b.updatedAt || 0).getTime();
        break;

      case "createdAt":
      default:
        aValue = new Date(a.appliedDate || a.createdAt || 0).getTime();
        bValue = new Date(b.appliedDate || b.createdAt || 0).getTime();
        break;
    }

    if (typeof aValue === "number" && typeof bValue === "number") {
      return (aValue - bValue) * dir;
    }

    return (
      String(aValue).localeCompare(String(bValue), undefined, {
        numeric: true,
        sensitivity: "base",
      }) * dir
    );
  });

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const campaigns = sorted.slice((page - 1) * limit, page * limit);

  return {
    success: true,
    page,
    limit,
    total,
    totalPages,
    count: campaigns.length,
    sortBy: field,
    sortOrder,
    status: statusFilter,
    campaigns,
    influencer: {
      _id: String(influencer._id || ""),
      influencerId: influencer.influencerId || influencerId,
      name: influencer.name || "",
      email: influencer.email || "",
    },
  };
};

// ------------------------- dashboard builders -------------------------

const getSuperAdminDashboard = async (req) => {
  const [
    revenueMetrics,
    brands,
    influencers,
    campaigns,
    disputes,
    totalBrands,
    totalInfluencers,
    totalCampaigns,
    totalDisputes,
  ] = await Promise.all([
    getRevenueMetrics(),
    getBrandsList(req),
    getInfluencersList(req),
    getCampaignsList(req),
    getDisputesList(req),
    getModelCount(Brand, {}),
    getModelCount(Influencer, {}),
    getModelCount(Campaign, {}),
    getModelCount(Dispute, {}),
  ]);

  const influencerCampaigns = await getCampaignsByInfluencerIdDashboard(req);

  return {
    summary: {
      totalBrands,
      totalInfluencers,
      totalCampaigns,
      totalDisputes,
      ...revenueMetrics,
    },
    brands,
    influencers,
    campaigns,
    disputes,
    ...(influencerCampaigns ? { influencerCampaigns } : {}),
  };
};

const getRevenueHeadDashboard = async (req) => {
  const [revenueMetrics, unassignedBrands] = await Promise.all([
    getRevenueMetrics(),
    getUnassignedBrands(req),
  ]);

  return {
    totalRevenueThisMonth: revenueMetrics.totalRevenueThisMonth,
    totalRevenueThisQuarter: revenueMetrics.totalRevenueThisQuarter,
    totalRevenueThisYear: revenueMetrics.totalRevenueThisYear,
    activeCampaigns: revenueMetrics.activeCampaigns,
    completedCampaigns: revenueMetrics.completedCampaigns,
    unassignedBrands,
  };
};

const getImeBmeDashboard = async (req, role) => {
  const actor = getActor(req);
  const brandScopeFilter = getRoleBrandScopeFilter(role, actor);
  const brandKeys = await getScopedBrandKeysForRole(role, actor);

  if (Array.isArray(brandKeys) && !brandKeys.length) {
    return {
      summary: {
        totalAssignedBrands: 0,
        assignedCampaigns: 0,
        activeCampaigns: 0,
        completedCampaigns: 0,
      },
      brands: {
        page: 1,
        limit: 10,
        total: 0,
        totalPages: 1,
        brands: [],
      },
      campaigns: {
        page: 1,
        limit: 10,
        total: 0,
        totalPages: 1,
        campaigns: [],
      },
    };
  }

  const [brands, campaigns, campaignCounts] = await Promise.all([
    getBrandsList(req, { extraFilter: brandScopeFilter }),
    getCampaignsList(req, { brandKeys }),
    getCampaignCounts({ brandKeys }),
  ]);

  return {
    summary: {
      totalAssignedBrands: brands.total,
      assignedCampaigns: campaigns.total,
      activeCampaigns: campaignCounts.activeCampaigns,
      completedCampaigns: campaignCounts.completedCampaigns,
    },
    brands,
    campaigns,
  };
};

// ------------------------- single combined admin dashboard API -------------------------

exports.getDashboard = async (req, res) => {
  try {
    const role = normalizeRole(req);

    if (!role) {
      return res.status(403).json({
        success: false,
        message: "Admin role not found",
      });
    }

    if (!Object.values(ROLES).includes(role)) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized dashboard role",
        role,
      });
    }

    let dashboard;

    if (role === ROLES.SUPER_ADMIN) {
      dashboard = await getSuperAdminDashboard(req);
    }

    if (role === ROLES.REVENUE_HEAD) {
      dashboard = await getRevenueHeadDashboard(req);
    }

    if (role === ROLES.IME || role === ROLES.BME) {
      dashboard = await getImeBmeDashboard(req, role);
    }

    return res.status(200).json({
      success: true,
      role,
      dashboard,
    });
  } catch (error) {
    console.error("Error in dashboard getDashboard:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};