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
const Modash = require("../models/modash");
const { ProductServiceGoalModel } = require("../models/productServiceGoal");
const { AdminModel, ROLES: MASTER_ROLES } = require("../models/master");
const BrandAssigned = require("../models/brandAssigned");

const { CONTRACT_STATUS } = require("../constants/contract");
const saveErrorLog = require("../services/errorLog.service");

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
  } catch (error) {
    saveErrorLog(req, error, 403, "VERIFY_TOKEN_ERROR").catch((logError) => {
      console.error("Error log save failed:", logError.message);
    });

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
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "GET_DASHBOARD_INF_ERROR");
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

    const brand = await Brand.findById(brandObjectId, "name brandName").lean();

    if (!brand) {
      return res.status(404).json({ error: "Brand not found" });
    }

    const getCampaignKeys = (campaign = {}) => {
      return [
        campaign?._id ? String(campaign._id) : "",
        campaign?.campaignsId ? String(campaign.campaignsId) : "",
        campaign?.campaignId ? String(campaign.campaignId) : "",
      ].filter(Boolean);
    };

    const unique = (arr = []) => [...new Set(arr.filter(Boolean))];

    const getNested = (obj, path) => {
      try {
        return path
          .split(".")
          .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
      } catch {
        return undefined;
      }
    };

    const toNumber = (value) => {
      if (value == null) return 0;
      if (typeof value === "number" && Number.isFinite(value)) return value;

      const cleaned = String(value).replace(/[%,$\s,]/g, "");
      const num = Number(cleaned);

      return Number.isFinite(num) ? num : 0;
    };

    const getFirstText = (obj, paths = []) => {
      for (const path of paths) {
        const value = getNested(obj, path);

        if (value != null && String(value).trim()) {
          return String(value).trim();
        }
      }

      return "";
    };

    const getFirstNumber = (obj, paths = []) => {
      for (const path of paths) {
        const value = getNested(obj, path);
        const num = toNumber(value);

        if (num) return num;
      }

      return 0;
    };

    const normalizeHandle = (value) => {
      const handle = String(value || "").trim();

      if (!handle) return "";
      return handle.startsWith("@") ? handle : `@${handle}`;
    };

    const getCampaignStartAt = (campaign = {}) => {
      return (
        campaign.startAt ||
        campaign.startDate ||
        campaign.campaignStartAt ||
        campaign.campaignStartDate ||
        campaign.timelineStartAt ||
        campaign.timelineStartDate ||
        campaign.timeline?.startAt ||
        campaign.timeline?.startDate ||
        campaign.duration?.startAt ||
        campaign.duration?.startDate ||
        null
      );
    };

    const getCampaignEndAt = (campaign = {}) => {
      return (
        campaign.endAt ||
        campaign.endDate ||
        campaign.campaignEndAt ||
        campaign.campaignEndDate ||
        campaign.timelineEndAt ||
        campaign.timelineEndDate ||
        campaign.timeline?.endAt ||
        campaign.timeline?.endDate ||
        campaign.duration?.endAt ||
        campaign.duration?.endDate ||
        null
      );
    };

    const getFollowersFromProfile = (profile) => {
      return getFirstNumber(profile, [
        "followers",
        "followerCount",
        "followersCount",
        "audienceSize",
        "audience_size",
        "stats.followers",
        "metrics.followers",
        "profile.followers",
      ]);
    };

    const getEngagementRateFromProfile = (profile) => {
      let value = getFirstNumber(profile, [
        "engagementRate",
        "engagement_rate",
        "avgEngagementRate",
        "avg_engagement_rate",
        "er",
        "stats.engagementRate",
        "metrics.engagementRate",
        "engagement.rate",
      ]);

      if (!value) return 0;

      if (value > 0 && value <= 1) {
        value = value * 100;
      }

      return Number(value.toFixed(2));
    };

    const getPlatformFromProfile = (profile) => {
      return getFirstText(profile, [
        "provider",
        "platform",
        "channel",
        "source",
        "network",
      ]);
    };

    const getProfileImage = (influencer, profile) => {
      return (
        getFirstText(influencer, [
          "profileImage",
          "profile_image",
          "image",
          "avatar",
          "avatarUrl",
          "profilePicture",
          "profilePic",
          "photo",
          "photoUrl",
        ]) ||
        getFirstText(profile, [
          "profileImage",
          "profile_image",
          "image",
          "avatar",
          "avatarUrl",
          "picture",
          "pictureUrl",
          "profile.picture",
          "profile.image",
        ])
      );
    };

    const getInfluencerHandle = (influencer, profile) => {
      const raw =
        getFirstText(profile, [
          "handle",
          "username",
          "fullname",
          "profile.username",
          "profile.handle",
        ]) ||
        getFirstText(influencer, [
          "handle",
          "username",
          "instagramHandle",
          "youtubeHandle",
          "tiktokHandle",
          "socialHandle",
        ]);

      return normalizeHandle(raw);
    };

    const pickBestModashProfile = (profiles = []) => {
      if (!Array.isArray(profiles) || !profiles.length) return null;

      return (
        profiles
          .slice()
          .sort(
            (a, b) =>
              Number(getFollowersFromProfile(b) || 0) -
              Number(getFollowersFromProfile(a) || 0)
          )[0] || null
      );
    };

    const allCampaigns = await Campaign.find(
      { ...brandFilter("brandId", brandObjectId), isDraft: { $ne: 1 } },
      `
        _id
        campaignsId
        campaignId
        campaignTitle
        productOrServiceName
        campaignGoals
        campaignBudget
        budget
        status
        publishStatus
        campaignStatus
        isActive
        createdAt
        updatedAt
        startAt
        endAt
        startDate
        endDate
        campaignStartAt
        campaignEndAt
        campaignStartDate
        campaignEndDate
        timelineStartAt
        timelineEndAt
        timelineStartDate
        timelineEndDate
        timeline
        duration
        numberOfInfluencers
        platformSelection
      `
    )
      .sort({ createdAt: -1 })
      .lean();

    const totalCreatedCampaigns = allCampaigns.length;

    const campaignIds = allCampaigns
      .map((campaign) => String(campaign._id || ""))
      .filter(Boolean);

    const campaignKeys = unique(allCampaigns.flatMap(getCampaignKeys));

    const goalIds = [
      ...new Set(
        allCampaigns
          .flatMap((campaign) =>
            Array.isArray(campaign.campaignGoals) ? campaign.campaignGoals : []
          )
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

      goalMap = new Map(goals.map((goal) => [String(goal._id), goal.goal]));
    }

    const acceptedContracts = await Contract.find(
      acceptedContractFilter({ ...brandFilter("brandId", brandObjectId) }),
      `
        _id
        contractId
        campaignId
        influencerId
        status
        contractStatus
        lifecycleStatus
        currentStatus
        isAssigned
        isAccepted
        lastActionAt
        createdAt
        updatedAt
      `
    )
      .sort({ lastActionAt: -1, createdAt: -1 })
      .lean();

    const contractsByCampaignKey = new Map();

    for (const contract of acceptedContracts) {
      const key = String(contract.campaignId || "");

      if (!key) continue;

      if (!contractsByCampaignKey.has(key)) {
        contractsByCampaignKey.set(key, []);
      }

      contractsByCampaignKey.get(key).push(contract);
    }

    const acceptedCampaignIds = new Set(
      Array.from(contractsByCampaignKey.keys())
    );

    const acceptedCount = acceptedCampaignIds.size;

    const activeInfluencerIds = unique(
      acceptedContracts
        .map((contract) => String(contract.influencerId || ""))
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    );

    const activeInfluencerObjectIds = activeInfluencerIds.map(
      (id) => new mongoose.Types.ObjectId(id)
    );

    const [activeInfluencerDocs, modashProfiles] = await Promise.all([
      activeInfluencerObjectIds.length
        ? Influencer.find({
          $or: [
            { _id: { $in: activeInfluencerObjectIds } },
            { influencerId: { $in: activeInfluencerIds } },
          ],
        })
          .select(
            `
                _id
                influencerId
                name
                email
                handle
                username
                instagramHandle
                youtubeHandle
                tiktokHandle
                socialHandle
                profileImage
                profile_image
                image
                avatar
                avatarUrl
                profilePicture
                profilePic
                photo
                photoUrl
              `
          )
          .lean()
        : [],

      activeInfluencerIds.length
        ? Modash.find({
          $or: [
            { influencerId: { $in: activeInfluencerIds } },
            { influencer: { $in: activeInfluencerObjectIds } },
          ],
        }).lean()
        : [],
    ]);

    const influencerById = new Map();

    activeInfluencerDocs.forEach((influencer) => {
      influencerById.set(String(influencer._id), influencer);

      if (influencer.influencerId) {
        influencerById.set(String(influencer.influencerId), influencer);
      }
    });

    const modashByInfluencerId = new Map();

    for (const profile of modashProfiles) {
      const keys = [
        profile.influencerId ? String(profile.influencerId) : "",
        profile.influencer ? String(profile.influencer) : "",
      ].filter(Boolean);

      for (const key of keys) {
        if (!modashByInfluencerId.has(key)) {
          modashByInfluencerId.set(key, []);
        }

        modashByInfluencerId.get(key).push(profile);
      }
    }

    const serializeActiveInfluencer = (contract) => {
      const influencerId = String(contract.influencerId || "");
      const influencer = influencerById.get(influencerId) || null;
      const profiles = modashByInfluencerId.get(influencerId) || [];
      const profile = pickBestModashProfile(profiles);

      return {
        influencerId,
        name: influencer?.name || "",
        handle: getInfluencerHandle(influencer, profile),
        profileImage: getProfileImage(influencer, profile),
        platform: getPlatformFromProfile(profile),
        followers: getFollowersFromProfile(profile),
        engagementRate: getEngagementRateFromProfile(profile),

        contractId: contract.contractId || null,
        contractMongoId: contract._id ? String(contract._id) : null,
        contractStatus:
          contract.status ||
          contract.contractStatus ||
          contract.lifecycleStatus ||
          contract.currentStatus ||
          null,

        lastActionAt: contract.lastActionAt || null,
        assignedAt: contract.createdAt || null,
      };
    };

    const appliedCountMap = new Map();
    let totalAppliedInfluencers = 0;

    if (campaignKeys.length) {
      const agg = await ApplyCampaign.aggregate([
        { $match: { campaignId: { $in: campaignKeys } } },
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
            perCampaign: [
              { $project: { _id: 1, appliedInfluencersCount: 1 } },
            ],
            total: [
              {
                $group: {
                  _id: null,
                  totalAppliedInfluencers: {
                    $sum: "$appliedInfluencersCount",
                  },
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
        appliedCountMap.set(
          String(row._id),
          Number(row.appliedInfluencersCount || 0)
        );
      });
    }

    const getContractsForCampaign = (campaign) => {
      const keys = getCampaignKeys(campaign);
      const map = new Map();

      keys.forEach((key) => {
        const contracts = contractsByCampaignKey.get(key) || [];

        contracts.forEach((contract) => {
          const contractKey = String(contract._id || contract.contractId || "");
          if (!contractKey) return;

          if (!map.has(contractKey)) {
            map.set(contractKey, contract);
          }
        });
      });

      return Array.from(map.values());
    };

    const getAppliedCountForCampaign = (campaign) => {
      return getCampaignKeys(campaign).reduce((sum, key) => {
        return sum + Number(appliedCountMap.get(key) || 0);
      }, 0);
    };

    const hasAcceptedCampaign = (campaign) => {
      return getCampaignKeys(campaign).some((key) => acceptedCampaignIds.has(key));
    };

    const anyUnaccepted = allCampaigns.some((campaign) => {
      return !hasAcceptedCampaign(campaign);
    });

    const showAll = acceptedCount === 0 || anyUnaccepted;
    const campaignsMode = showAll ? "all" : "accepted";

    const baseList = showAll
      ? allCampaigns
      : allCampaigns.filter((campaign) => hasAcceptedCampaign(campaign));

    const campaigns = baseList.map((campaign) => {
      const id = String(campaign._id || "");
      const activeContracts = getContractsForCampaign(campaign);

      const activeInfluencerMap = new Map();

      activeContracts.forEach((contract) => {
        const influencerId = String(contract.influencerId || "");
        if (!influencerId || activeInfluencerMap.has(influencerId)) return;

        activeInfluencerMap.set(
          influencerId,
          serializeActiveInfluencer(contract)
        );
      });

      const activeInfluencers = Array.from(activeInfluencerMap.values());

      const firstActiveContract = activeContracts[0] || null;

      const goalNames = (
        Array.isArray(campaign.campaignGoals) ? campaign.campaignGoals : []
      )
        .map((goalId) => goalMap.get(String(goalId)))
        .filter(Boolean);

      return {
        id,
        campaignId: id,
        campaignsId: campaign.campaignsId || null,

        campaignTitle:
          campaign.campaignTitle ||
          campaign.productOrServiceName ||
          "",

        productOrServiceName:
          campaign.productOrServiceName ||
          campaign.campaignTitle ||
          "",

        startAt: getCampaignStartAt(campaign),
        endAt: getCampaignEndAt(campaign),

        goals: goalNames,
        goal: goalNames[0] || "",

        campaignBudget: Number(campaign.campaignBudget || 0),
        budget: Number(campaign.campaignBudget || campaign.budget || 0),

        status: campaign.status || "",
        publishStatus: campaign.publishStatus || "",
        campaignStatus: campaign.campaignStatus || "",

        isActive: Number(campaign.isActive || 0),
        createdAt: campaign.createdAt || null,
        updatedAt: campaign.updatedAt || null,

        numberOfInfluencers: Number(campaign.numberOfInfluencers || 0),
        platformSelection: Array.isArray(campaign.platformSelection)
          ? campaign.platformSelection
          : [],

        hasAcceptedInfluencer: activeInfluencers.length > 0,
        influencerId: firstActiveContract?.influencerId || null,
        contractId: firstActiveContract?.contractId || null,

        appliedInfluencersCount: getAppliedCountForCampaign(campaign),

        activeInfluencerCount: activeInfluencers.length,
        activeInfluencers,
      };
    });

    const activeCampaignKeySet = new Set(
      allCampaigns
        .filter(
          (campaign) =>
            Number(campaign.isActive) === 1 &&
            campaign.status !== "draft" &&
            campaign.status !== "archived"
        )
        .flatMap(getCampaignKeys)
    );

    const totalHiredInfluencers = unique(
      acceptedContracts
        .filter((contract) =>
          activeCampaignKeySet.has(String(contract.campaignId || ""))
        )
        .map((contract) => String(contract.influencerId || ""))
    ).length;

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
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "GET_BRAND_DASHBOARD_HOME_ERROR");

    return res
      .status(err?.status || 500)
      .json({ error: err?.message || "Server error" });
  }
};



const DASH_ROLES = {
  SUPER_ADMIN: "super_admin",
  REVENUE_HEAD: "revenue_head",
  IME: "ime",
  BME: "bme",
};

// ------------------------- basic dashboard helpers -------------------------

const dashGetActor = (req) => {
  return req.admin || req.user || req.adminUser || req.auth || {};
};

const dashNormalizeRole = (req) => {
  const actor = dashGetActor(req);

  const rawRole = String(
    actor.role ||
    actor.adminRole ||
    actor.roleName ||
    actor.type ||
    actor.userType ||
    req.body?.role ||
    req.query?.role ||
    ""
  )
    .trim()
    .toLowerCase();

  const cleanRole = rawRole.replace(/\s+/g, "_").replace(/-/g, "_");

  if (
    cleanRole === "super_admin" ||
    cleanRole === "superadmin" ||
    cleanRole === "admin" ||
    cleanRole === "super"
  ) {
    return DASH_ROLES.SUPER_ADMIN;
  }

  if (
    cleanRole === "revenue_head" ||
    cleanRole === "revenuehead" ||
    cleanRole === "rh"
  ) {
    return DASH_ROLES.REVENUE_HEAD;
  }

  if (cleanRole === "ime") return DASH_ROLES.IME;
  if (cleanRole === "bme") return DASH_ROLES.BME;

  return cleanRole;
};

const dashReadValue = (req, keys = [], fallback = "") => {
  const body = req.body || {};
  const query = req.query || {};
  const params = req.params || {};

  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== "") {
      return body[key];
    }

    if (query[key] !== undefined && query[key] !== null && query[key] !== "") {
      return query[key];
    }

    if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
      return params[key];
    }
  }

  return fallback;
};

const dashReadArray = (req, keys = []) => {
  const value = dashReadValue(req, keys, []);

  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
};

const dashNormalizeSortOrder = (value, fallback = "desc") => {
  const clean = String(value || "").trim().toLowerCase();

  if (clean === "asc" || clean === "1") return "asc";
  if (clean === "desc" || clean === "-1") return "desc";

  return fallback;
};

const dashEscapeRegex = (value = "") => {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const dashSafeRegex = (value) => {
  const clean = String(value || "").trim();
  if (!clean) return null;

  return new RegExp(dashEscapeRegex(clean), "i");
};

const dashIsObjectId = (id) => {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
};

const dashToObjectId = (id) => {
  return new mongoose.Types.ObjectId(String(id));
};

const dashBrandIdVariantsFromValues = (values = []) => {
  const stringValues = values
    .map((id) => String(id || "").trim())
    .filter(Boolean);

  const objectIds = stringValues
    .filter((id) => dashIsObjectId(id))
    .map((id) => dashToObjectId(id));

  return {
    stringValues,
    objectIds,
  };
};

const dashMakeBrandScopeFilter = (brandKeys = []) => {
  const { stringValues, objectIds } = dashBrandIdVariantsFromValues(brandKeys);

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

const dashGetSearch = (req, key = "") => {
  const searchKey = key ? `${key}Search` : "search";
  return String(dashReadValue(req, [searchKey, "search"], "")).trim();
};

const dashGetModelCount = async (Model, filter = {}) => {
  if (Model && typeof Model.countDocuments === "function") {
    return Model.countDocuments(filter);
  }

  if (Model && typeof Model.find === "function") {
    const rows = await Model.find(filter).select("_id").lean();
    return rows.length;
  }

  return 0;
};

// ------------------------- role / brand scope helpers -------------------------

const dashGetAdminIdentityValues = (actor = {}) => {
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

const dashGetRoleBrandScopeFilter = (role, actor = {}) => {
  if (role === DASH_ROLES.SUPER_ADMIN || role === DASH_ROLES.REVENUE_HEAD) {
    return {};
  }

  const values = dashGetAdminIdentityValues(actor);

  if (!values.length) {
    return { _id: null };
  }

  if (role === DASH_ROLES.IME) {
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

  if (role === DASH_ROLES.BME) {
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

const dashGetScopedBrandKeysForRole = async (role, actor = {}) => {
  const scopeFilter = dashGetRoleBrandScopeFilter(role, actor);

  if (!Object.keys(scopeFilter).length) {
    return null;
  }

  const brands = await Brand.find(scopeFilter).select("_id brandId").lean();

  return brands.flatMap((brand) =>
    [String(brand._id || ""), String(brand.brandId || "")].filter(Boolean)
  );
};

const dashGetVisibleBrandKeysForAdmin = async (req) => {
  const actor = dashGetActor(req);
  const role = dashNormalizeRole(req);

  if (role === DASH_ROLES.SUPER_ADMIN || role === DASH_ROLES.REVENUE_HEAD) {
    return null;
  }

  return dashGetScopedBrandKeysForRole(role, actor);
};

// ------------------------- revenue helpers -------------------------

const dashGetDateRanges = () => {
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

const dashBuildCampaignMatch = ({ brandKeys = null, extraFilters = [] } = {}) => {
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
    andFilters.push(dashMakeBrandScopeFilter(brandKeys));
  }

  return { $and: andFilters };
};

const dashGetRevenueTotal = async ({ startDate, endDate, brandKeys = null }) => {
  const match = dashBuildCampaignMatch({
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

const dashGetCampaignCounts = async ({ brandKeys = null } = {}) => {
  const now = new Date();

  const activeMatch = dashBuildCampaignMatch({
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

  const completedMatch = dashBuildCampaignMatch({
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

const dashGetRevenueMetrics = async ({ brandKeys = null } = {}) => {
  const { now, startOfMonth, startOfQuarter, startOfYear } = dashGetDateRanges();

  const [
    totalRevenueThisMonth,
    totalRevenueThisQuarter,
    totalRevenueThisYear,
    campaignCounts,
  ] = await Promise.all([
    dashGetRevenueTotal({
      startDate: startOfMonth,
      endDate: now,
      brandKeys,
    }),
    dashGetRevenueTotal({
      startDate: startOfQuarter,
      endDate: now,
      brandKeys,
    }),
    dashGetRevenueTotal({
      startDate: startOfYear,
      endDate: now,
      brandKeys,
    }),
    dashGetCampaignCounts({ brandKeys }),
  ]);

  return {
    totalRevenueThisMonth,
    totalRevenueThisQuarter,
    totalRevenueThisYear,
    activeCampaigns: campaignCounts.activeCampaigns,
    completedCampaigns: campaignCounts.completedCampaigns,
  };
};

// ------------------------- brands list - no pagination -------------------------

const dashGetBrandsList = async (req, options = {}) => {
  const search = dashGetSearch(req, "brands");

  const sortBy = String(
    dashReadValue(req, ["brandsSortBy", "brandSortBy", "sortBy"], "createdAt")
  ).trim();

  const sortOrder = dashNormalizeSortOrder(
    dashReadValue(req, ["brandsSortOrder", "brandSortOrder", "sortOrder"], "desc"),
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

  const re = dashSafeRegex(search);

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

  const brands = await Brand.find(filter)
    .select("-password -__v -profilePic")
    .sort({ [field]: dir, createdAt: -1 })
    .lean();

  const total = brands.length;

  return {
    page: 1,
    limit: total,
    total,
    totalPages: 1,
    sortBy: field,
    sortOrder,
    brands,
  };
};

// ------------------------- influencers list - same response shape, no pagination -------------------------

const dashComputeInfluencerRouteFallback = (doc = {}) => {
  const page1Done = Array.isArray(doc.page1) && doc.page1.length > 0;

  const page2Done =
    Boolean(doc.ispage2Skip) ||
    (Array.isArray(doc.page2) && doc.page2.length > 0);

  const page3Done =
    Boolean(doc.ispage3Skip) ||
    (Array.isArray(doc.page3) && doc.page3.length > 0);

  let route = "campaign";

  if (!page1Done) route = "page1";
  else if (!page2Done) route = "page2";
  else if (!page3Done) route = "page3";

  return {
    route,
    page1Done,
    page2Done,
    page3Done,
  };
};

const dashNormalizeSocialProfile = (profile = {}) => {
  return {
    provider: String(profile.provider || profile.platform || "").toLowerCase(),
    handle: profile.handle || "",
    username: profile.username || profile.userName || "",
    followers: Number(profile.followers || profile.followerCount || 0),
    url: profile.url || profile.profileUrl || "",
    picture:
      profile.picture ||
      profile.profilePicture ||
      profile.profileImage ||
      profile.image ||
      profile.avatar ||
      "",
  };
};

const dashExtractSocialProfilesFromInfluencer = (doc = {}) => {
  if (Array.isArray(doc.socialProfiles) && doc.socialProfiles.length) {
    return doc.socialProfiles.map(dashNormalizeSocialProfile);
  }

  const pages = [
    ...(Array.isArray(doc.page1) ? doc.page1 : []),
    ...(Array.isArray(doc.page2) ? doc.page2 : []),
    ...(Array.isArray(doc.page3) ? doc.page3 : []),
  ];

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
      item?.followerCount ||
      item?.url ||
      item?.profileUrl ||
      item?.picture ||
      item?.profilePicture ||
      item?.profileImage ||
      item?.image ||
      item?.avatar
    ) {
      profiles.push(item);
    }
  }

  return profiles.map(dashNormalizeSocialProfile);
};

const dashGetPrimaryPlatformFromProfiles = (doc = {}, profiles = []) => {
  if (doc.primaryPlatform) {
    return String(doc.primaryPlatform).toLowerCase();
  }

  const pages = [
    ...(Array.isArray(doc.page1) ? doc.page1 : []),
    ...(Array.isArray(doc.page2) ? doc.page2 : []),
    ...(Array.isArray(doc.page3) ? doc.page3 : []),
  ];

  const primaryPageProfile =
    pages.find((item) => item?.isPrimary) || pages[0] || null;

  return String(
    primaryPageProfile?.platform ||
    primaryPageProfile?.provider ||
    profiles?.[0]?.provider ||
    ""
  ).toLowerCase() || null;
};

const dashNormalizeHandle = (value, username = "") => {
  const raw = value || username || "";
  if (!raw) return null;

  const clean = String(raw).trim();
  return clean.startsWith("@") ? clean.toLowerCase() : `@${clean}`.toLowerCase();
};

const dashLoadSocialProfilesFromModashBulk = async (influencerIds = []) => {
  const ids = influencerIds
    .map((id) => String(id || "").trim())
    .filter(Boolean);

  const objectIds = ids
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (!ids.length && !objectIds.length) {
    return {};
  }

  const docs = await Modash.find(
    {
      $or: [
        { influencerId: { $in: ids } },
        { influencer: { $in: objectIds } },
      ],
    },
    "influencer influencerId provider handle username followers url picture"
  ).lean();

  const grouped = {};

  for (const d of docs) {
    const profile = {
      provider: d.provider || "",
      handle: dashNormalizeHandle(d.handle, d.username),
      username: d.username || null,
      followers: Number(d.followers) || 0,
      url: d.url || null,
      picture: d.picture || null,
    };

    const keys = [
      d.influencer ? String(d.influencer) : "",
      d.influencerId ? String(d.influencerId) : "",
    ].filter(Boolean);

    for (const key of keys) {
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(profile);
    }
  }

  return grouped;
};

const dashGetAdminInfluencerList = async (req) => {
  const source = {
    ...(req.query || {}),
    ...(req.body || {}),
  };

  const {
    search = "",
    countryId = "",
    languageId = "",
    categoryId = "",
    hasProxyEmail,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = source;

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
    const rx = new RegExp(dashEscapeRegex(q), "i");

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
    filter.$or = [
      ...(filter.$or || []),
      { proxyEmail: { $exists: false } },
      { proxyEmail: "" },
      { proxyEmail: null },
    ];
  }

  const docs = await Influencer.find(filter)
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
        "createdAt",
        "updatedAt",
      ].join(" ")
    )
    .sort({ [finalSortBy]: order, _id: -1 })
    .lean();

  const total = docs.length;

  let socialProfilesMap = {};

  try {
    socialProfilesMap = await dashLoadSocialProfilesFromModashBulk(
      docs.map((doc) => doc._id)
    );
  } catch (error) {
    console.error("Error loading dashboard influencer social profiles:", error);
    socialProfilesMap = {};
  }

  const influencers = docs.map((doc) => {
    const routeInfo =
      typeof computeInfluencerNextRoute === "function"
        ? computeInfluencerNextRoute(doc)
        : dashComputeInfluencerRouteFallback(doc);

    const page1Profiles = Array.isArray(doc.page1) ? doc.page1 : [];

    const primaryPage1Profile =
      page1Profiles.find((item) => item?.isPrimary) ||
      page1Profiles[0] ||
      null;

    const socialProfiles = socialProfilesMap[String(doc._id)] || [];

    const primaryPlatform = primaryPage1Profile
      ? String(
        primaryPage1Profile.platform ||
        primaryPage1Profile.provider ||
        socialProfiles?.[0]?.provider ||
        ""
      ).toLowerCase() || null
      : socialProfiles?.[0]?.provider || null;

    return {
      _id: doc._id,
      influencerId: String(doc._id),
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

      primaryPlatform,
      socialProfiles,

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

  return {
    success: true,
    page: 1,
    limit: total,
    total,
    pages: 1,
    count: influencers.length,
    influencers,
  };
};

// ------------------------- campaigns list - no pagination -------------------------

const dashGetCampaignSortField = (sortBy = "createdAt") => {
  const allowed = new Set([
    "createdAt",
    "updatedAt",
    "campaignTitle",
    "productOrServiceName",
    "brandName",
    "goal",
    "budget",
    "campaignBudget",
    "applicantCount",
    "isActive",
    "timeline.startDate",
    "timeline.endDate",
  ]);

  return allowed.has(sortBy) ? sortBy : "createdAt";
};

const dashToCampaignSummary = (doc = {}) => {
  const timeline = doc.timeline || {};

  const campaignId = String(doc.campaignsId || doc.campaignId || doc._id || "");

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

const dashBuildCampaignLiteFilter = ({
  search,
  statusFlag,
  brandKeys,
  requestedBrandId,
}) => {
  const andFilters = [];

  if (Array.isArray(brandKeys)) {
    andFilters.push(dashMakeBrandScopeFilter(brandKeys));
  }

  if (requestedBrandId) {
    const { stringValues, objectIds } = dashBrandIdVariantsFromValues([
      requestedBrandId,
    ]);

    andFilters.push({
      $or: [
        { brandId: { $in: stringValues } },
        { brandId: { $in: objectIds } },
        { _id: { $in: objectIds } },
      ],
    });
  }

  const re = dashSafeRegex(search);

  if (re) {
    andFilters.push({
      $or: [
        { campaignTitle: re },
        { productOrServiceName: re },
        { brandName: re },
        { description: re },
        { goal: re },
        { campaignStatus: re },
        { campaignsId: re },
        { campaignId: re },
      ],
    });
  }

  if (Number(statusFlag) === 1) {
    andFilters.push({
      $or: [
        { isActive: true },
        { isActive: 1 },
        { campaignStatus: { $regex: "active", $options: "i" } },
      ],
    });
  }

  if (Number(statusFlag) === 2) {
    andFilters.push({
      $or: [
        { isActive: false },
        { isActive: 0 },
        { campaignStatus: { $regex: "inactive", $options: "i" } },
      ],
    });
  }

  if (Number(statusFlag) === 3) {
    andFilters.push({
      $or: [
        { isDraft: true },
        { isDraft: 1 },
        { campaignStatus: { $regex: "draft", $options: "i" } },
      ],
    });
  }

  return andFilters.length ? { $and: andFilters } : {};
};

const dashGetCampaignsLite = async (req, options = {}) => {
  const search = String(
    dashReadValue(req, ["campaignsSearch", "campaignSearch", "search"], "")
  ).trim();

  const sortBy = String(
    dashReadValue(req, ["campaignsSortBy", "campaignSortBy", "sortBy"], "createdAt")
  ).trim();

  const sortOrder = dashNormalizeSortOrder(
    dashReadValue(req, ["campaignsSortOrder", "campaignSortOrder", "sortOrder"], "desc"),
    "desc"
  );

  const statusFlag =
    Number.parseInt(
      dashReadValue(req, ["campaignsType", "campaignType", "type"], 0),
      10
    ) || 0;

  const brandId = String(
    dashReadValue(req, ["campaignsBrandId", "campaignBrandId", "brandId"], "")
  ).trim();

  const visibleBrandKeys =
    options.visibleBrandKeys !== undefined
      ? options.visibleBrandKeys
      : await dashGetVisibleBrandKeysForAdmin(req);

  const filter = dashBuildCampaignLiteFilter({
    search,
    statusFlag,
    brandKeys: visibleBrandKeys,
    requestedBrandId: brandId,
  });

  const field = dashGetCampaignSortField(sortBy);
  const dir = sortOrder === "asc" ? 1 : -1;

  const rows = await Campaign.find(filter)
    .select(
      "_id brandId brandName campaignsId campaignId campaignTitle productOrServiceName goal budget campaignBudget applicantCount isActive isDraft byAi createdBy campaignStatus timeline.startDate timeline.endDate createdAt updatedAt"
    )
    .sort({ [field]: dir, createdAt: -1 })
    .lean();

  const campaigns = rows.map(dashToCampaignSummary);
  const total = campaigns.length;

  return {
    page: 1,
    limit: total,
    total,
    totalPages: 1,
    status: statusFlag,
    sortBy,
    sortOrder,
    campaigns,
  };
};

// ------------------------- disputes list - no pagination -------------------------

const dashNormalizeStatusInput = (value) => {
  const clean = String(value || "").trim();

  if (!clean || clean === "0" || clean.toLowerCase() === "all") {
    return "__ALL__";
  }

  return clean;
};

const dashGetAdminDisputesList = async (req) => {
  const status = dashReadValue(
    req,
    ["disputeStatus", "disputesStatus", "status"],
    undefined
  );

  const campaignId = dashReadValue(
    req,
    ["disputeCampaignId", "disputesCampaignId", "campaignId"],
    ""
  );

  const brandId = dashReadValue(
    req,
    ["disputeBrandId", "disputesBrandId", "brandId"],
    ""
  );

  const influencerId = dashReadValue(
    req,
    ["disputeInfluencerId", "disputesInfluencerId", "influencerId"],
    ""
  );

  const search = dashReadValue(
    req,
    ["disputesSearch", "disputeSearch", "search"],
    ""
  );

  const appliedBy = dashReadValue(
    req,
    ["disputesAppliedBy", "disputeAppliedBy", "appliedBy"],
    ""
  );

  const filter = {};

  const normalizedStatus = dashNormalizeStatusInput(status);

  if (normalizedStatus && normalizedStatus !== "__ALL__") {
    filter.status = normalizedStatus;
  }

  if (campaignId) filter.campaignId = String(campaignId);
  if (brandId) filter.brandId = String(brandId);
  if (influencerId) filter.influencerId = String(influencerId);

  const searchTerm = typeof search === "string" ? search.trim() : "";

  if (searchTerm) {
    const pattern = dashEscapeRegex(searchTerm);
    const re = new RegExp(pattern, "i");

    filter.$or = [{ subject: re }, { description: re }, { disputeId: re }];
  }

  if (appliedBy && typeof appliedBy === "string") {
    const role = String(appliedBy).toLowerCase();

    if (role === "brand") filter["createdBy.role"] = "Brand";
    if (role === "influencer") filter["createdBy.role"] = "Influencer";
  }

  const rows = await Dispute.find(filter)
    .sort({ createdAt: -1 })
    .lean();

  const total = rows.length;

  try {
    const brandIds = Array.from(
      new Set(rows.map((r) => r.brandId).filter(Boolean))
    ).map(String);

    const influencerIds = Array.from(
      new Set(rows.map((r) => r.influencerId).filter(Boolean))
    ).map(String);

    const campaignIds = Array.from(
      new Set(rows.map((r) => r.campaignId).filter(Boolean))
    ).map(String);

    const brandObjectIds = brandIds.filter(dashIsObjectId).map(dashToObjectId);
    const influencerObjectIds = influencerIds
      .filter(dashIsObjectId)
      .map(dashToObjectId);
    const campaignObjectIds = campaignIds
      .filter(dashIsObjectId)
      .map(dashToObjectId);

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

    const infMap = new Map();

    influencers.forEach((influencer) => {
      infMap.set(String(influencer._id), influencer.name || null);

      if (influencer.influencerId) {
        infMap.set(String(influencer.influencerId), influencer.name || null);
      }
    });

    const campMap = new Map();

    campaigns.forEach((campaign) => {
      campMap.set(String(campaign._id), campaign.campaignTitle || null);

      if (campaign.campaignsId) {
        campMap.set(String(campaign.campaignsId), campaign.campaignTitle || null);
      }

      if (campaign.campaignId) {
        campMap.set(String(campaign.campaignId), campaign.campaignTitle || null);
      }
    });

    const disputes = rows.map((r) => ({
      ...r,
      brandName: brandMap.get(String(r.brandId || "")) || null,
      influencerName: infMap.get(String(r.influencerId || "")) || null,
      campaignName: r.campaignId ? campMap.get(String(r.campaignId)) || null : null,
      raisedByRole: r.createdBy?.role || null,
      raisedById: r.createdBy?.id || null,
    }));

    return {
      page: 1,
      limit: total,
      total,
      totalPages: 1,
      disputes,
    };
  } catch (e) {
    console.error("Error enriching dashboard disputes:", e);

    return {
      page: 1,
      limit: total,
      total,
      totalPages: 1,
      disputes: rows,
    };
  }
};

// ------------------------- campaign by influencer - no pagination -------------------------

const dashGetApplicantStatus = (applicant = {}, fromApprovedArray = false) => {
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

const dashGetCampaignsByInfluencerId = async (req, options = {}) => {
  try {
    const influencerId = String(
      options.influencerId ||
      dashReadValue(
        req,
        ["influencerCampaignInfluencerId", "campaignInfluencerId", "influencerId", "id"],
        ""
      )
    ).trim();

    const search = String(
      dashReadValue(
        req,
        ["influencerCampaignsSearch", "influencerCampaignSearch", "search"],
        ""
      )
    ).trim();

    const sortBy = String(
      dashReadValue(
        req,
        [
          "influencerCampaignsSortBy",
          "influencerCampaignsSortField",
          "influencerCampaignSortBy",
          "sortBy",
          "sortField",
        ],
        "createdAt"
      )
    ).trim();

    const rawSortOrder = dashReadValue(
      req,
      ["influencerCampaignsSortOrder", "influencerCampaignSortOrder", "sortOrder"],
      "desc"
    );

    const sortOrder =
      rawSortOrder === 1 ||
        rawSortOrder === "1" ||
        String(rawSortOrder).toLowerCase() === "asc"
        ? "asc"
        : "desc";

    const statusFilter = String(
      dashReadValue(
        req,
        ["influencerCampaignsStatus", "influencerCampaignStatus", "filterStatus", "status"],
        "all"
      )
    )
      .trim()
      .toLowerCase();

    const debug =
      String(dashReadValue(req, ["debug"], "")).toLowerCase() === "true";

    if (!influencerId) {
      return {
        success: false,
        message: "influencerId is required",
        page: 1,
        limit: 0,
        total: 0,
        pages: 1,
        totalPages: 1,
        count: 0,
        campaigns: [],
      };
    }

    if (!dashIsObjectId(influencerId)) {
      return {
        success: false,
        message: "Invalid influencerId",
        influencerId,
        page: 1,
        limit: 0,
        total: 0,
        pages: 1,
        totalPages: 1,
        count: 0,
        campaigns: [],
      };
    }

    const influencerObjectId = dashToObjectId(influencerId);

    const influencer = await Influencer.findById(influencerObjectId)
      .select("_id name email")
      .lean();

    if (!influencer) {
      return {
        success: false,
        message: "Influencer not found",
        influencerId,
        page: 1,
        limit: 0,
        total: 0,
        pages: 1,
        totalPages: 1,
        count: 0,
        campaigns: [],
      };
    }

    const visibleBrandKeys =
      options.visibleBrandKeys !== undefined ? options.visibleBrandKeys : null;

    const influencerLookupValues = [
      influencerId,
      influencerObjectId,
      String(influencer._id),
    ];

    const influencerLookupStrings = influencerLookupValues
      .map((value) => String(value || ""))
      .filter(Boolean);

    const applyRows = await ApplyCampaign.find({
      $or: [
        { "applicants.influencerId": { $in: influencerLookupValues } },
        { "approved.influencerId": { $in: influencerLookupValues } },
      ],
    })
      .select("campaignId applicants approved createdAt updatedAt")
      .lean();

    const matchesInfluencer = (item) => {
      return influencerLookupStrings.includes(String(item?.influencerId || ""));
    };

    const getMatchedApplicant = (row) => {
      const applicants = Array.isArray(row?.applicants) ? row.applicants : [];
      const approved = Array.isArray(row?.approved) ? row.approved : [];

      const approvedMatch = approved.find(matchesInfluencer);

      if (approvedMatch) {
        return {
          applicant: approvedMatch,
          fromApprovedArray: true,
        };
      }

      const applicantMatch = applicants.find(matchesInfluencer);

      return {
        applicant: applicantMatch || null,
        fromApprovedArray: false,
      };
    };

    const applyMap = new Map();

    for (const row of applyRows) {
      const campaignId = String(row?.campaignId || "").trim();
      if (!campaignId) continue;

      const { applicant, fromApprovedArray } = getMatchedApplicant(row);
      if (!applicant) continue;

      applyMap.set(campaignId, {
        campaignId,
        applicant,
        fromApprovedArray,
        status: dashGetApplicantStatus(applicant, fromApprovedArray),
        appliedAt: applicant?.appliedAt || row?.createdAt || null,
      });
    }

    const appliedCampaignIds = [...applyMap.keys()];

    if (!appliedCampaignIds.length) {
      return {
        success: true,
        page: 1,
        limit: 0,
        total: 0,
        pages: 1,
        totalPages: 1,
        count: 0,
        campaigns: [],
        influencer: {
          influencerId: String(influencer._id),
          name: influencer.name || "",
          email: influencer.email || "",
        },
        ...(debug
          ? {
            debug: {
              reason: "No ApplyCampaign rows found for this influencer",
              influencerId,
              applyRowsFound: applyRows.length,
            },
          }
          : {}),
      };
    }

    const campaignObjectIds = appliedCampaignIds
      .filter((id) => dashIsObjectId(id))
      .map((id) => dashToObjectId(id));

    const andFilters = [
      {
        $or: [
          { _id: { $in: campaignObjectIds } },
          { campaignsId: { $in: appliedCampaignIds } },
          { campaignId: { $in: appliedCampaignIds } },
        ],
      },
    ];

    if (Array.isArray(visibleBrandKeys)) {
      if (!visibleBrandKeys.length) {
        return {
          success: true,
          page: 1,
          limit: 0,
          total: 0,
          pages: 1,
          totalPages: 1,
          count: 0,
          campaigns: [],
          influencer: {
            influencerId: String(influencer._id),
            name: influencer.name || "",
            email: influencer.email || "",
          },
          ...(debug
            ? {
              debug: {
                reason: "Admin has no visible brand keys",
                appliedCampaignIds,
              },
            }
            : {}),
        };
      }

      const visibleBrandObjectIds = visibleBrandKeys
        .filter((id) => dashIsObjectId(id))
        .map((id) => dashToObjectId(id));

      andFilters.push({
        $or: [
          { brandId: { $in: visibleBrandKeys } },
          { brandId: { $in: visibleBrandObjectIds } },
        ],
      });
    }

    const re = dashSafeRegex(search);

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
        "_id brandId brandName campaignsId campaignId campaignTitle productOrServiceName goal budget applicantCount isActive isDraft campaignStatus timeline.startDate timeline.endDate createdAt updatedAt"
      )
      .lean();

    const normalized = campaignDocs.map((doc) => {
      const summary = dashToCampaignSummary(doc);

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

    const field = dashGetCampaignSortField(sortBy);
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

    const campaigns = [...filteredByStatus].sort((a, b) => {
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

    const total = campaigns.length;

    return {
      success: true,
      page: 1,
      limit: total,
      total,
      pages: 1,
      totalPages: 1,
      count: campaigns.length,
      campaigns,
      influencer: {
        influencerId: String(influencer._id),
        name: influencer.name || "",
        email: influencer.email || "",
      },
      ...(debug
        ? {
          debug: {
            influencerId,
            visibleBrandKeys,
            applyRowsFound: applyRows.length,
            appliedCampaignIds,
            campaignDocsFound: campaignDocs.length,
          },
        }
        : {}),
    };
  } catch (error) {
    console.error("Error in dashGetCampaignsByInfluencerId:", error);

    return {
      success: false,
      message: "Internal server error",
      error: error.message,
      page: 1,
      limit: 0,
      total: 0,
      pages: 1,
      totalPages: 1,
      count: 0,
      campaigns: [],
    };
  }
};

const dashGetInfluencerIds = (req, influencersResponse = {}) => {
  const requestedIds = dashReadArray(req, [
    "influencerIds",
    "influencerIdArray",
    "campaignInfluencerIds",
  ]);

  if (requestedIds.length) {
    return [...new Set(requestedIds)];
  }

  const influencers = Array.isArray(influencersResponse.influencers)
    ? influencersResponse.influencers
    : [];

  return [
    ...new Set(
      influencers
        .map((item) => item.influencerId || item._id)
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    ),
  ];
};

const dashGetInfluencerCampaignsBulk = async (
  req,
  influencerIds = [],
  options = {}
) => {
  const uniqueInfluencerIds = [
    ...new Set(influencerIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ];

  const results = await Promise.all(
    uniqueInfluencerIds.map((influencerId) =>
      dashGetCampaignsByInfluencerId(req, {
        ...options,
        influencerId,
      })
    )
  );

  return {
    success: true,
    influencerIds: uniqueInfluencerIds,
    totalInfluencers: uniqueInfluencerIds.length,
    count: results.length,
    results,
  };
};

// ------------------------- super admin dashboard builder -------------------------

const dashGetSuperAdminDashboard = async (req) => {
  const visibleBrandKeys = await dashGetVisibleBrandKeysForAdmin(req);

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
    dashGetRevenueMetrics({ brandKeys: visibleBrandKeys }),
    dashGetBrandsList(req),
    dashGetAdminInfluencerList(req),
    dashGetCampaignsLite(req, { visibleBrandKeys }),
    dashGetAdminDisputesList(req),
    dashGetModelCount(Brand, {}),
    dashGetModelCount(Influencer, {}),
    dashGetModelCount(Campaign, {}),
    dashGetModelCount(Dispute, {}),
  ]);

  const influencerIds = dashGetInfluencerIds(req, influencers);

  const influencerCampaigns = await dashGetInfluencerCampaignsBulk(
    req,
    influencerIds,
    { visibleBrandKeys }
  );

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

    // campaign/byinfluencer style response for each influencer
    influencerCampaigns,
  };
};

// ------------------------- final getDashboard API -------------------------

exports.getDashboard = async (req, res) => {
  try {
    const role = dashNormalizeRole(req);

    if (!role) {
      return res.status(403).json({
        success: false,
        message: "Admin role not found",
      });
    }

    if (role !== DASH_ROLES.SUPER_ADMIN) {
      return res.status(200).json({
        success: true,
        role,
        message: "Dashboard for this admin role is not enabled yet",
        dashboard: {
          summary: {},
          brands: null,
          influencers: null,
          campaigns: null,
          disputes: null,
          influencerCampaigns: null,
        },
      });
    }

    const dashboard = await dashGetSuperAdminDashboard(req);

    return res.status(200).json({
      success: true,
      role,
      dashboard,
    });
  } catch (error) {
    console.error("Error in dashboard getDashboard:", error);
    await saveErrorLog(req, error, error?.status || error?.statusCode || 500, "GET_DASHBOARD_ERROR");

    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};


// ------------------------- Revenue Head Details Dashboard -------------------------

const rhDashIsObjectId = (id) => {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
};

const rhDashToObjectId = (id) => {
  return new mongoose.Types.ObjectId(String(id));
};

const rhDashNormalizeRole = (role) => {
  return String(role || "").trim().toLowerCase();
};

const rhDashSerializeAdmin = (admin) => {
  if (!admin) return null;

  return {
    _id: String(admin._id || admin.adminId || ""),
    adminId: String(admin._id || admin.adminId || ""),
    name: admin.name || "",
    email: admin.email || "",
    role: rhDashNormalizeRole(admin.role),
    status: admin.status || "",
    proxyEmail: admin.proxyEmail || "",
    teamType: admin.teamType || null,
  };
};

const rhDashGetAdminId = (admin = {}) => {
  return String(admin.adminId || admin._id || admin.id || "").trim();
};

const rhDashGetTargetRevenueHeadId = (req) => {
  const admin = req.admin || {};
  const role = rhDashNormalizeRole(admin.role);

  if (role === MASTER_ROLES.REVENUE_HEAD) {
    return rhDashGetAdminId(admin);
  }

  if (role === MASTER_ROLES.SUPER_ADMIN) {
    return String(
      req.body?.rhId ||
      req.body?.RHId ||
      req.body?.revenueHeadId ||
      req.body?.adminId ||
      req.query?.rhId ||
      req.query?.RHId ||
      req.query?.revenueHeadId ||
      req.query?.adminId ||
      ""
    ).trim();
  }

  return "";
};

const rhDashBrandIdVariants = (brandIds = []) => {
  const stringIds = brandIds
    .map((id) => String(id || "").trim())
    .filter(Boolean);

  const objectIds = stringIds
    .filter((id) => rhDashIsObjectId(id))
    .map((id) => rhDashToObjectId(id));

  return {
    stringIds,
    objectIds,
  };
};

const rhDashCampaignBrandFilter = (brandIds = []) => {
  const { stringIds, objectIds } = rhDashBrandIdVariants(brandIds);

  return {
    $or: [
      { brandId: { $in: objectIds } },
      { brandId: { $in: stringIds } },
    ],
  };
};

const rhDashGetBrandDisplayName = (brand = {}) => {
  return brand.brandName || brand.name || brand.companyName || "";
};

const rhDashGetBrandPlan = (brand = {}) => {
  return {
    planId: brand.subscription?.planId || brand.planId || null,
    planName:
      brand.subscription?.planName ||
      brand.planName ||
      brand.plan ||
      "",
    status:
      brand.subscription?.status ||
      brand.subscriptionStatus ||
      brand.status ||
      "",
    billingCycle: brand.subscription?.billingCycle || null,
    startedAt: brand.subscription?.startedAt || null,
    expiresAt: brand.subscription?.expiresAt || brand.expiresAt || null,
    subscription: brand.subscription || null,
  };
};

const rhDashApplicantStatus = (applicant = {}, fromApprovedArray = false) => {
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
    statusInfluencer.includes("contractaccept") ||
    statusBrand.includes("approved") ||
    statusInfluencer.includes("approved") ||
    statusBrand.includes("accepted") ||
    statusInfluencer.includes("accepted")
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

const rhDashNormalizeApplicant = ({
  applicant,
  fromApprovedArray = false,
  influencerMap = new Map(),
}) => {
  const influencerId = String(applicant?.influencerId || "").trim();
  const influencer = influencerMap.get(influencerId) || null;

  return {
    ...applicant,
    influencerId,
    computedStatus: rhDashApplicantStatus(applicant, fromApprovedArray),
    fromApprovedArray,
    influencer: influencer
      ? {
        _id: String(influencer._id || ""),
        influencerId: String(influencer._id || influencer.influencerId || ""),
        name: influencer.name || "",
        email: influencer.email || "",
        proxyEmail: influencer.proxyEmail || "",
        countryName: influencer.countryName || "",
      }
      : null,
  };
};

const rhDashIsWorkingApplicant = (applicant = {}, fromApprovedArray = false) => {
  const status = rhDashApplicantStatus(applicant, fromApprovedArray);

  return ["approved", "contractaccept", "accepted"].some((item) =>
    String(status || "").toLowerCase().includes(item)
  );
};

const rhDashRefId = (value) => {
  if (!value) return "";

  if (typeof value === "object") {
    if (value._id) return String(value._id);
    if (value.id) return String(value.id);
  }

  return String(value || "").trim();
};

const rhDashPickRefId = (doc = {}, keys = []) => {
  for (const key of keys) {
    const value = doc?.[key];
    const id = rhDashRefId(value);

    if (id) return id;
  }

  return "";
};

const rhDashUniqueObjectIds = (ids = []) => {
  return [
    ...new Set(
      ids
        .map((id) => String(id || "").trim())
        .filter((id) => id && rhDashIsObjectId(id))
    ),
  ].map((id) => rhDashToObjectId(id));
};

const rhDashGetAssignmentBmeId = (assignment = {}) => {
  return rhDashPickRefId(assignment, [
    "bdmId",
    "bmeId",
    "BMEId",
    "assignedBmeId",
    "assignedBMEId",
    "assignedBme",
    "assignedBME",
    "bme",
    "bdm",
  ]);
};

const rhDashGetAssignmentImeId = (assignment = {}) => {
  return rhDashPickRefId(assignment, [
    "idmId",
    "imeId",
    "IMEId",
    "assignedImeId",
    "assignedIMEId",
    "assignedIme",
    "assignedIME",
    "ime",
    "idm",
  ]);
};

const rhDashBuildAdminMap = async (adminIds = []) => {
  const objectIds = rhDashUniqueObjectIds(adminIds);

  if (!objectIds.length) {
    return new Map();
  }

  const admins = await AdminModel.find({ _id: { $in: objectIds } })
    .select("_id name email role status proxyEmail teamType createdAt updatedAt")
    .lean();

  return new Map(admins.map((admin) => [String(admin._id), admin]));
};

const rhDashGetAdminFromMap = (adminMap, id) => {
  const cleanId = String(id || "").trim();
  if (!cleanId) return null;

  return adminMap.get(cleanId) || null;
};

exports.getRevenueHeadDetails = async (req, res) => {
  try {
    const loggedInAdmin = req.admin || {};
    const loggedInRole = rhDashNormalizeRole(loggedInAdmin.role);

    if (!loggedInAdmin?.adminId && !loggedInAdmin?._id) {
      return res.status(401).json({
        success: false,
        message: "Admin authentication required",
      });
    }

    if (
      loggedInRole !== MASTER_ROLES.REVENUE_HEAD &&
      loggedInRole !== MASTER_ROLES.SUPER_ADMIN
    ) {
      return res.status(403).json({
        success: false,
        message: "Only Revenue Head or Super Admin can access this dashboard",
        role: loggedInRole,
      });
    }

    const revenueHeadId = rhDashGetTargetRevenueHeadId(req);

    if (!revenueHeadId) {
      return res.status(400).json({
        success: false,
        message:
          loggedInRole === MASTER_ROLES.SUPER_ADMIN
            ? "revenueHeadId / rhId is required for super admin"
            : "Revenue Head id not found in token",
      });
    }

    if (!rhDashIsObjectId(revenueHeadId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Revenue Head id",
      });
    }

    const revenueHeadObjectId = rhDashToObjectId(revenueHeadId);

    const revenueHead = await AdminModel.findById(revenueHeadObjectId)
      .select("_id name email role status proxyEmail teamType createdAt updatedAt")
      .lean();

    if (!revenueHead) {
      return res.status(404).json({
        success: false,
        message: "Revenue Head not found",
      });
    }

    if (rhDashNormalizeRole(revenueHead.role) !== MASTER_ROLES.REVENUE_HEAD) {
      return res.status(400).json({
        success: false,
        message: "Selected admin is not a Revenue Head",
        selectedRole: revenueHead.role,
      });
    }

    const [brandAssignments, employees] = await Promise.all([
      // IMPORTANT:
      // No populate here. This avoids StrictPopulateError for bmeId / imeId / idmId
      // when your real BrandAssigned schema uses different field names.
      BrandAssigned.find({ RHId: revenueHeadObjectId })
        .sort({ createdAt: -1 })
        .lean(),

      AdminModel.find({
        $or: [
          { createdBy: revenueHeadObjectId },
          { parentAdmin: revenueHeadObjectId },
          { rootAdmin: revenueHeadObjectId },
        ],
        role: {
          $in: [
            MASTER_ROLES.BME,
            MASTER_ROLES.IME,
            MASTER_ROLES.SDR,
          ],
        },
      })
        .select("_id name email role status proxyEmail teamType createdAt updatedAt")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const assignmentAdminIds = brandAssignments.flatMap((assignment) => {
      return [
        rhDashRefId(assignment.RHId),
        rhDashGetAssignmentBmeId(assignment),
        rhDashGetAssignmentImeId(assignment),
      ].filter(Boolean);
    });

    const assignmentAdminMap = await rhDashBuildAdminMap([
      revenueHeadId,
      ...assignmentAdminIds,
    ]);

    const assignedBrandIds = [
      ...new Set(
        brandAssignments
          .map((item) => rhDashRefId(item.brandId))
          .filter(Boolean)
      ),
    ];

    const brandObjectIds = assignedBrandIds
      .filter((id) => rhDashIsObjectId(id))
      .map((id) => rhDashToObjectId(id));

    const brands = brandObjectIds.length
      ? await Brand.find({ _id: { $in: brandObjectIds } })
        .select("-password -__v -profilePic")
        .lean()
      : [];

    const brandMap = new Map(
      brands.map((brand) => [String(brand._id), brand])
    );

    const assignedBrands = brandAssignments.map((assignment) => {
      const brandId = rhDashRefId(assignment.brandId);
      const brand = brandMap.get(brandId) || null;

      const assignedRH =
        rhDashSerializeAdmin(
          rhDashGetAdminFromMap(
            assignmentAdminMap,
            rhDashRefId(assignment.RHId)
          )
        ) || rhDashSerializeAdmin(revenueHead);

      const assignedBME = rhDashSerializeAdmin(
        rhDashGetAdminFromMap(
          assignmentAdminMap,
          rhDashGetAssignmentBmeId(assignment)
        )
      );

      const assignedIME = rhDashSerializeAdmin(
        rhDashGetAdminFromMap(
          assignmentAdminMap,
          rhDashGetAssignmentImeId(assignment)
        )
      );

      const isFullyManaged = Boolean(assignedBME && assignedIME);

      return {
        assignmentId: String(assignment._id || ""),
        assignmentStatus: assignment.status || "",
        assignedAt: assignment.createdAt || null,
        updatedAt: assignment.updatedAt || null,

        isFullyManaged,

        assignedPersons: {
          revenueHead: assignedRH,
          bme: assignedBME,
          ime: assignedIME,
        },

        plan: brand ? rhDashGetBrandPlan(brand) : null,

        brand: brand
          ? {
            ...brand,
            _id: String(brand._id || ""),
            brandId: String(brand._id || ""),
            brandName: rhDashGetBrandDisplayName(brand),
            planName:
              brand.subscription?.planName ||
              brand.planName ||
              brand.plan ||
              "free",
            fullyManagedSubscription: isFullyManaged,
            isFullyManaged,
          }
          : {
            _id: brandId,
            brandId,
            brandName: "",
            planName: "",
            fullyManagedSubscription: isFullyManaged,
            isFullyManaged,
          },
      };
    });

    const employeeRows = employees
      .map(rhDashSerializeAdmin)
      .filter(Boolean);

    const employeesByRole = {
      bme: employeeRows.filter((item) => item.role === MASTER_ROLES.BME),
      ime: employeeRows.filter((item) => item.role === MASTER_ROLES.IME),
      sdr: employeeRows.filter((item) => item.role === MASTER_ROLES.SDR),
    };

    const campaignFilter = assignedBrandIds.length
      ? rhDashCampaignBrandFilter(assignedBrandIds)
      : { _id: null };

    const campaignsRaw = await Campaign.find(campaignFilter)
      .select("-__v")
      .sort({ createdAt: -1 })
      .lean();

    const campaignKeys = [
      ...new Set(
        campaignsRaw
          .flatMap((campaign) => [
            String(campaign._id || ""),
            String(campaign.campaignsId || ""),
            String(campaign.campaignId || ""),
          ])
          .filter(Boolean)
      ),
    ];

    const applyRows = campaignKeys.length
      ? await ApplyCampaign.find({ campaignId: { $in: campaignKeys } })
        .select("campaignId applicants approved createdAt updatedAt")
        .lean()
      : [];

    const influencerIds = [
      ...new Set(
        applyRows
          .flatMap((row) => [
            ...(Array.isArray(row.applicants) ? row.applicants : []),
            ...(Array.isArray(row.approved) ? row.approved : []),
          ])
          .map((item) => String(item?.influencerId || "").trim())
          .filter(Boolean)
      ),
    ];

    const influencerObjectIds = influencerIds
      .filter((id) => rhDashIsObjectId(id))
      .map((id) => rhDashToObjectId(id));

    const influencers = influencerObjectIds.length
      ? await Influencer.find({
        $or: [
          { _id: { $in: influencerObjectIds } },
          { influencerId: { $in: influencerIds } },
        ],
      })
        .select("_id influencerId name email proxyEmail countryName")
        .lean()
      : [];

    const influencerMap = new Map();

    influencers.forEach((influencer) => {
      influencerMap.set(String(influencer._id), influencer);

      if (influencer.influencerId) {
        influencerMap.set(String(influencer.influencerId), influencer);
      }
    });

    const applyMap = new Map();

    for (const row of applyRows) {
      const key = String(row.campaignId || "").trim();
      if (!key) continue;

      if (!applyMap.has(key)) {
        applyMap.set(key, []);
      }

      applyMap.get(key).push(row);
    }

    let totalApplicants = 0;
    let totalApprovedApplicants = 0;
    let totalWorkingApplicants = 0;

    const campaigns = campaignsRaw.map((campaign) => {
      const possibleKeys = [
        String(campaign._id || ""),
        String(campaign.campaignsId || ""),
        String(campaign.campaignId || ""),
      ].filter(Boolean);

      const campaignApplyRows = possibleKeys.flatMap(
        (key) => applyMap.get(key) || []
      );

      const applicants = campaignApplyRows.flatMap((row) =>
        Array.isArray(row.applicants) ? row.applicants : []
      );

      const approved = campaignApplyRows.flatMap((row) =>
        Array.isArray(row.approved) ? row.approved : []
      );

      const normalizedApplicants = applicants.map((applicant) =>
        rhDashNormalizeApplicant({
          applicant,
          fromApprovedArray: false,
          influencerMap,
        })
      );

      const normalizedApproved = approved.map((applicant) =>
        rhDashNormalizeApplicant({
          applicant,
          fromApprovedArray: true,
          influencerMap,
        })
      );

      const workingApplicants = [
        ...normalizedApproved,
        ...normalizedApplicants.filter((item) =>
          rhDashIsWorkingApplicant(item, false)
        ),
      ];

      totalApplicants += normalizedApplicants.length;
      totalApprovedApplicants += normalizedApproved.length;
      totalWorkingApplicants += workingApplicants.length;

      const campaignBrandId = rhDashRefId(campaign.brandId);
      const brand = brandMap.get(campaignBrandId) || null;

      return {
        ...campaign,
        _id: String(campaign._id || ""),

        brandId: campaignBrandId,
        brandName:
          campaign.brandName ||
          (brand ? rhDashGetBrandDisplayName(brand) : ""),

        brand: brand
          ? {
            _id: String(brand._id || ""),
            brandId: String(brand._id || ""),
            brandName: rhDashGetBrandDisplayName(brand),
            email: brand.email || "",
            plan: rhDashGetBrandPlan(brand),
          }
          : null,

        applicantCount:
          Number(campaign.applicantCount || 0) ||
          normalizedApplicants.length + normalizedApproved.length,

        applicationSummary: {
          totalApplyRows: campaignApplyRows.length,
          totalApplicants: normalizedApplicants.length,
          totalApprovedApplicants: normalizedApproved.length,
          totalWorkingApplicants: workingApplicants.length,
        },

        applicants: normalizedApplicants,
        approvedApplicants: normalizedApproved,
        workingApplicants,
      };
    });

    return res.status(200).json({
      success: true,
      role: loggedInRole,

      revenueHead: rhDashSerializeAdmin(revenueHead),

      summary: {
        totalAssignedBrands: assignedBrands.length,
        fullyManagedBrands: assignedBrands.filter((item) => item.isFullyManaged)
          .length,
        partiallyManagedBrands: assignedBrands.filter(
          (item) => !item.isFullyManaged
        ).length,

        totalEmployees: employeeRows.length,
        totalBME: employeesByRole.bme.length,
        totalIME: employeesByRole.ime.length,
        totalSDR: employeesByRole.sdr.length,

        totalCampaigns: campaigns.length,
        totalApplicants,
        totalApprovedApplicants,
        totalWorkingApplicants,
      },

      assignedBrands,

      employees: {
        all: employeeRows,
        ...employeesByRole,
      },

      campaigns,
    });
  } catch (error) {
    console.error("Error in getRevenueHeadDetails:", error);
    await saveErrorLog(req, error, error?.status || error?.statusCode || 500, "GET_REVENUE_HEAD_DETAILS_ERROR");

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal server error",
      error: error.message,
    });
  }
};