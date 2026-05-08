// controllers/campaignReviewController.js
const crypto = require("crypto");
const mongoose = require("mongoose");

const {
    CampaignReview,
    REVIEW_TYPES,
    REVIEW_STATUS,
} = require("../models/campaignReview");

const Campaign = require("../models/campaign");
const Brand = require("../models/brand");
const ApplyCampaign = require("../models/applyCampaign");
const { InfluencerModel: Influencer } = require("../models/influencer");
const { AdminModel } = require("../models/master");
const { createAndEmit } = require("../utils/notifier");

/* =========================
   BASIC HELPERS
========================= */

function toStringId(value = "") {
    return String(value || "").trim();
}

function isObjectId(value) {
    return mongoose.Types.ObjectId.isValid(String(value || ""));
}

function toObjectId(value) {
    return new mongoose.Types.ObjectId(String(value));
}

function makeToken() {
    return crypto.randomBytes(32).toString("hex");
}

function hashToken(token = "") {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function escapeRegex(value = "") {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values = []) {
    return [
        ...new Set(
            values
                .filter(Boolean)
                .map((value) => String(value).trim())
                .filter(Boolean)
        ),
    ];
}

function getBaseUrl(req) {
    return (
        process.env.FRONTEND_URL ||
        process.env.CLIENT_URL ||
        `${req.protocol}://${req.get("host")}`
    ).replace(/\/+$/, "");
}

function buildPublicReviewUrl(req, token) {
    return `${getBaseUrl(req)}/rating-review/${token}`;
}

function normalizeReviewType(value = "") {
    const type = String(value || "").trim().toLowerCase();

    if (type === REVIEW_TYPES.BRAND_TO_INFLUENCER) {
        return REVIEW_TYPES.BRAND_TO_INFLUENCER;
    }

    if (type === REVIEW_TYPES.INFLUENCER_TO_BRAND) {
        return REVIEW_TYPES.INFLUENCER_TO_BRAND;
    }

    return "";
}

function getActorFromReq(req = {}) {
    const admin = req.admin || req.user || {};
    const actorAdminId = toStringId(admin.adminId || admin._id);

    return {
        actorAdminId: isObjectId(actorAdminId) ? actorAdminId : null,
        actorName: toStringId(admin.name),
        actorEmail: toStringId(admin.email).toLowerCase(),
        actorRole: toStringId(admin.role).toLowerCase(),
    };
}

function ratingValue(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) return null;
    if (number < 1 || number > 5) return null;

    return Math.round(number);
}

function sanitizeTags(tags) {
    if (!Array.isArray(tags)) return [];

    return [
        ...new Set(
            tags
                .map((tag) => String(tag || "").trim())
                .filter(Boolean)
                .slice(0, 12)
        ),
    ];
}

function parseExpiresAt(days = 30) {
    const safeDays = Math.min(Math.max(Number(days) || 30, 1), 180);
    return new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000);
}

function getCampaignName(campaign = {}) {
    return (
        campaign.campaignTitle ||
        campaign.productOrServiceName ||
        campaign.title ||
        campaign.name ||
        "Untitled Campaign"
    );
}

function getBrandName(brand = {}, fallback = "") {
    return (
        brand.brandName ||
        brand.name ||
        brand.companyName ||
        brand.email ||
        fallback ||
        "Brand"
    );
}

function getInfluencerName(influencer = {}, fallback = "") {
    return (
        influencer.name ||
        influencer.fullName ||
        influencer.influencerName ||
        influencer.username ||
        influencer.email ||
        fallback ||
        "Influencer"
    );
}

function buildCampaignKeys(campaign = {}) {
    return uniqueStrings([
        campaign._id,
        campaign.campaignsId,
        campaign.campaignId,
    ]);
}

/* =========================
   APPLY CAMPAIGN HELPERS
========================= */

function isRejectedApplicant(applicant = {}) {
    const statusBrand = String(applicant.statusBrand || "").toLowerCase();
    const statusInfluencer = String(applicant.statusInfluencer || "").toLowerCase();

    return (
        Number(applicant.isRejected || 0) === 1 ||
        statusBrand.includes("rejected") ||
        statusInfluencer.includes("rejected")
    );
}

function isReviewableApplicant(applicant = {}, fromApprovedArray = false) {
    if (!applicant) return false;
    if (isRejectedApplicant(applicant)) return false;

    const statusBrand = String(applicant.statusBrand || "").toLowerCase();
    const statusInfluencer = String(applicant.statusInfluencer || "").toLowerCase();
    const contractId = String(applicant.contractId || "").trim();

    if (fromApprovedArray) return true;

    if (Number(applicant.isShortlisted || 0) === 1) return true;

    if (contractId) return true;

    if (
        statusBrand.includes("contractaccept") ||
        statusInfluencer.includes("contractaccept") ||
        statusBrand.includes("active") ||
        statusInfluencer.includes("active") ||
        statusBrand.includes("completed") ||
        statusInfluencer.includes("completed") ||
        statusBrand.includes("final") ||
        statusInfluencer.includes("final") ||
        statusBrand.includes("sign") ||
        statusInfluencer.includes("sign")
    ) {
        return true;
    }

    return false;
}

function getReviewableApplicantsFromApplyRecord(record = {}) {
    const approved = Array.isArray(record.approved) ? record.approved : [];
    const applicants = Array.isArray(record.applicants) ? record.applicants : [];

    const rows = [];

    for (const item of approved) {
        if (isReviewableApplicant(item, true)) {
            rows.push({
                ...item,
                fromApprovedArray: true,
            });
        }
    }

    for (const item of applicants) {
        if (isReviewableApplicant(item, false)) {
            rows.push({
                ...item,
                fromApprovedArray: false,
            });
        }
    }

    const seen = new Set();

    return rows.filter((item) => {
        const influencerId = String(item.influencerId || "").trim();

        if (!influencerId) return false;
        if (seen.has(influencerId)) return false;

        seen.add(influencerId);
        return true;
    });
}

/* =========================
   REVIEW HELPERS
========================= */

async function findRequiredDocs({ campaignId, brandId, influencerId }) {
    if (!isObjectId(campaignId)) {
        const error = new Error("Valid campaignId is required");
        error.statusCode = 400;
        throw error;
    }

    if (!isObjectId(brandId)) {
        const error = new Error("Valid brandId is required");
        error.statusCode = 400;
        throw error;
    }

    if (!isObjectId(influencerId)) {
        const error = new Error("Valid influencerId is required");
        error.statusCode = 400;
        throw error;
    }

    const [campaign, brand, influencer] = await Promise.all([
        Campaign.findById(campaignId).lean(),
        Brand.findById(brandId).lean(),
        Influencer.findById(influencerId).lean(),
    ]);

    if (!campaign) {
        const error = new Error("Campaign not found");
        error.statusCode = 404;
        throw error;
    }

    if (!brand) {
        const error = new Error("Brand not found");
        error.statusCode = 404;
        throw error;
    }

    if (!influencer) {
        const error = new Error("Influencer not found");
        error.statusCode = 404;
        throw error;
    }

    return { campaign, brand, influencer };
}

async function ensureReviewPairBelongsToCampaign({
    campaign,
    brand,
    influencer,
}) {
    const campaignBrandId = String(campaign.brandId || "").trim();
    const brandId = String(brand._id || "").trim();
    const campaignId = String(campaign._id || "").trim();
    const influencerId = String(influencer._id || "").trim();

    if (campaignBrandId && campaignBrandId !== brandId) {
        const error = new Error("Selected brand does not belong to this campaign");
        error.statusCode = 400;
        throw error;
    }

    const campaignKeys = buildCampaignKeys(campaign);

    const applyRecords = await ApplyCampaign.find({
        campaignId: { $in: campaignKeys },
    }).lean();

    const isReviewable = applyRecords.some((record) => {
        return getReviewableApplicantsFromApplyRecord(record).some(
            (applicant) => String(applicant.influencerId || "") === influencerId
        );
    });

    if (!isReviewable) {
        const error = new Error(
            "Selected influencer is not approved/active for this campaign"
        );
        error.statusCode = 400;
        throw error;
    }

    return true;
}

function buildReviewRolePayload({ reviewType, brandId, influencerId }) {
    if (reviewType === REVIEW_TYPES.BRAND_TO_INFLUENCER) {
        return {
            reviewerRole: "brand",
            revieweeRole: "influencer",
            reviewerBrandId: brandId,
            reviewerInfluencerId: null,
            revieweeBrandId: null,
            revieweeInfluencerId: influencerId,
        };
    }

    if (reviewType === REVIEW_TYPES.INFLUENCER_TO_BRAND) {
        return {
            reviewerRole: "influencer",
            revieweeRole: "brand",
            reviewerBrandId: null,
            reviewerInfluencerId: influencerId,
            revieweeBrandId: brandId,
            revieweeInfluencerId: null,
        };
    }

    const error = new Error("Invalid reviewType");
    error.statusCode = 400;
    throw error;
}

function publicReviewPayload(review, docs = {}) {
    const campaign = docs.campaign || review.campaignId || {};
    const brand = docs.brand || review.brandId || {};
    const influencer = docs.influencer || review.influencerId || {};

    return {
        _id: review._id,
        reviewRequestId: review.reviewRequestId,
        reviewType: review.reviewType,
        reviewerRole: review.reviewerRole,
        revieweeRole: review.revieweeRole,
        status: review.status,
        tokenExpiresAt: review.tokenExpiresAt,

        campaign: {
            _id: campaign?._id || "",
            name: getCampaignName(campaign),
        },

        brand: {
            _id: brand?._id || "",
            name: getBrandName(brand),
            email: brand?.email || "",
        },

        influencer: {
            _id: influencer?._id || "",
            name: getInfluencerName(influencer),
            email: influencer?.email || "",
            handle: influencer?.handle || influencer?.username || "",
        },
    };
}

async function notifySafely(context, payload) {
    try {
        return await createAndEmit(payload);
    } catch (error) {
        console.warn(`${context} notification failed:`, error?.message || error);
        return null;
    }
}

/* =========================
   ADMIN OPTIONS
========================= */

exports.listAdminReviewOptions = async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 300);
        const debugEnabled = String(req.query.debug || "").toLowerCase() === "true";

        const campaignQuery = {};

        if (search) {
            const rx = new RegExp(escapeRegex(search), "i");

            campaignQuery.$or = [
                { campaignTitle: rx },
                { productOrServiceName: rx },
                { title: rx },
                { name: rx },
                { brandName: rx },
                { campaignsId: rx },
                { campaignId: rx },
            ];
        }

        const campaigns = await Campaign.find(campaignQuery)
            .select(
                "_id campaignsId campaignId campaignTitle productOrServiceName title name brandId brandName companyName status isActive createdAt updatedAt"
            )
            .sort({ createdAt: -1, updatedAt: -1 })
            .limit(limit)
            .lean();

        const campaignKeyToMongoId = new Map();
        const allCampaignKeys = [];

        for (const campaign of campaigns) {
            const campaignMongoId = String(campaign._id);
            const keys = buildCampaignKeys(campaign);

            for (const key of keys) {
                campaignKeyToMongoId.set(String(key), campaignMongoId);
                allCampaignKeys.push(String(key));
            }
        }

        const uniqueCampaignKeys = uniqueStrings(allCampaignKeys);

        const applyRecords = uniqueCampaignKeys.length
            ? await ApplyCampaign.find({
                campaignId: { $in: uniqueCampaignKeys },
            }).lean()
            : [];

        const applyByCampaignMongoId = new Map();

        for (const record of applyRecords) {
            const key = String(record.campaignId || "").trim();
            const campaignMongoId = campaignKeyToMongoId.get(key);

            if (!campaignMongoId) continue;

            const existing = applyByCampaignMongoId.get(campaignMongoId) || [];
            existing.push(record);
            applyByCampaignMongoId.set(campaignMongoId, existing);
        }

        const brandIds = uniqueStrings(
            campaigns.map((campaign) => campaign.brandId)
        ).filter((id) => mongoose.Types.ObjectId.isValid(id));

        const influencerIds = uniqueStrings(
            applyRecords.flatMap((record) =>
                getReviewableApplicantsFromApplyRecord(record).map(
                    (applicant) => applicant.influencerId
                )
            )
        ).filter((id) => mongoose.Types.ObjectId.isValid(id));

        const [brands, influencers] = await Promise.all([
            brandIds.length
                ? Brand.find({
                    _id: {
                        $in: brandIds.map((id) => new mongoose.Types.ObjectId(id)),
                    },
                })
                    .select("_id brandName name companyName email")
                    .lean()
                : [],

            influencerIds.length
                ? Influencer.find({
                    _id: {
                        $in: influencerIds.map((id) => new mongoose.Types.ObjectId(id)),
                    },
                })
                    .select("_id name fullName influencerName username email handle")
                    .lean()
                : [],
        ]);

        const brandById = new Map(
            brands.map((brand) => [String(brand._id), brand])
        );

        const influencerById = new Map(
            influencers.map((influencer) => [String(influencer._id), influencer])
        );

        const data = campaigns
            .map((campaign) => {
                const campaignMongoId = String(campaign._id);
                const brandId = String(campaign.brandId || "");
                const brandDoc = brandById.get(brandId);

                const records = applyByCampaignMongoId.get(campaignMongoId) || [];

                const reviewableApplicants = records.flatMap((record) =>
                    getReviewableApplicantsFromApplyRecord(record)
                );

                const seenInfluencers = new Set();

                const influencersForCampaign = reviewableApplicants
                    .map((applicant) => {
                        const influencerId = String(applicant.influencerId || "").trim();

                        if (
                            !influencerId ||
                            !mongoose.Types.ObjectId.isValid(influencerId)
                        ) {
                            return null;
                        }

                        if (seenInfluencers.has(influencerId)) return null;
                        seenInfluencers.add(influencerId);

                        const influencerDoc = influencerById.get(influencerId);

                        return {
                            _id: influencerId,
                            name: getInfluencerName(influencerDoc || {}, applicant.name),
                            email: influencerDoc?.email || "",
                            username: influencerDoc?.username || influencerDoc?.handle || "",
                            statusBrand: applicant.statusBrand || "",
                            statusInfluencer: applicant.statusInfluencer || "",
                            contractId: applicant.contractId || "",
                            fromApprovedArray: Boolean(applicant.fromApprovedArray),
                        };
                    })
                    .filter(Boolean);

                return {
                    _id: campaignMongoId,
                    campaignId: campaignMongoId,
                    campaignsId: campaign.campaignsId || "",
                    customCampaignId: campaign.campaignId || "",
                    title: getCampaignName(campaign),
                    status: campaign.status || "",
                    isActive: campaign.isActive ?? null,
                    brand: {
                        _id: brandId,
                        name: getBrandName(
                            brandDoc || {},
                            campaign.brandName || campaign.companyName
                        ),
                        email: brandDoc?.email || "",
                    },
                    influencers: influencersForCampaign,
                };
            })
            .filter((campaign) => {
                return campaign.brand._id && campaign.influencers.length > 0;
            });

        return res.status(200).json({
            success: true,
            data,
            debug: debugEnabled
                ? {
                    campaignsFound: campaigns.length,
                    campaignKeysChecked: uniqueCampaignKeys.length,
                    applyRecordsFound: applyRecords.length,
                    brandIdsFound: brandIds.length,
                    influencerIdsFound: influencerIds.length,
                    optionsReturned: data.length,
                    sampleApplyCampaignIds: applyRecords
                        .slice(0, 10)
                        .map((item) => item.campaignId),
                }
                : undefined,
        });
    } catch (error) {
        console.error("listAdminReviewOptions error:", error);

        return res.status(500).json({
            success: false,
            message: error.message || "Failed to load review options",
        });
    }
};

/* =========================
   GENERATE REVIEW LINKS
========================= */

async function createSingleReviewLink({
    req,
    campaign,
    brand,
    influencer,
    reviewType,
    expiresInDays,
}) {
    const actor = getActorFromReq(req);
    const token = makeToken();
    const publicUrl = buildPublicReviewUrl(req, token);
    const tokenHash = hashToken(token);

    const campaignId = campaign._id;
    const brandId = brand._id;
    const influencerId = influencer._id;

    const rolePayload = buildReviewRolePayload({
        reviewType,
        brandId,
        influencerId,
    });

    const existingSubmitted = await CampaignReview.findOne({
        campaignId,
        brandId,
        influencerId,
        reviewType,
        status: REVIEW_STATUS.SUBMITTED,
    }).lean();

    if (existingSubmitted) {
        const error = new Error("Review already submitted for this campaign pair");
        error.statusCode = 409;
        throw error;
    }

    await CampaignReview.updateMany(
        {
            campaignId,
            brandId,
            influencerId,
            reviewType,
            status: REVIEW_STATUS.PENDING,
        },
        {
            $set: {
                status: REVIEW_STATUS.REVOKED,
                revokedAt: new Date(),
                revokedByAdminId: actor.actorAdminId,
            },
        }
    );

    const review = await CampaignReview.create({
        campaignId,
        brandId,
        influencerId,
        reviewType,
        ...rolePayload,

        tokenHash,
        publicUrl,
        tokenExpiresAt: parseExpiresAt(expiresInDays),

        generatedByAdminId: actor.actorAdminId,
        generatedByAdminName: actor.actorName,
        generatedByAdminEmail: actor.actorEmail,
        generatedByAdminRole: actor.actorRole,
    });

    const campaignName = getCampaignName(campaign);
    const brandName = getBrandName(brand);
    const influencerName = getInfluencerName(influencer);

    if (reviewType === REVIEW_TYPES.BRAND_TO_INFLUENCER) {
        await notifySafely("brand review link generated", {
            brandId: String(brandId),
            type: "review.link.brand_to_influencer",
            title: "Review influencer work",
            message: `Please review ${influencerName}'s work for ${campaignName}.`,
            entityType: "campaign_review",
            entityId: String(review._id),
            actionPath: {
                brand: `/rating-review/${token}`,
                admin: `/admin/rating-reviews?reviewId=${review._id}`,
            },
            ...actor,
        });
    }

    if (reviewType === REVIEW_TYPES.INFLUENCER_TO_BRAND) {
        await notifySafely("influencer review link generated", {
            influencerId: String(influencerId),
            type: "review.link.influencer_to_brand",
            title: "Review brand collaboration",
            message: `Please review your collaboration with ${brandName} for ${campaignName}.`,
            entityType: "campaign_review",
            entityId: String(review._id),
            actionPath: {
                influencer: `/rating-review/${token}`,
                admin: `/admin/rating-reviews?reviewId=${review._id}`,
            },
            ...actor,
        });
    }

    return {
        review,
        token,
        publicUrl,
    };
}

exports.generateReviewLinks = async (req, res) => {
    try {
        const {
            campaignId,
            brandId,
            influencerId,
            reviewType,
            reviewTypes,
            expiresInDays = 30,
        } = req.body || {};

        const { campaign, brand, influencer } = await findRequiredDocs({
            campaignId,
            brandId,
            influencerId,
        });

        await ensureReviewPairBelongsToCampaign({
            campaign,
            brand,
            influencer,
        });

        const requestedTypes = Array.isArray(reviewTypes)
            ? reviewTypes.map(normalizeReviewType).filter(Boolean)
            : reviewType
                ? [normalizeReviewType(reviewType)]
                : [
                    REVIEW_TYPES.BRAND_TO_INFLUENCER,
                    REVIEW_TYPES.INFLUENCER_TO_BRAND,
                ];

        const uniqueTypes = [...new Set(requestedTypes)];

        if (!uniqueTypes.length) {
            return res.status(400).json({
                success: false,
                message:
                    "reviewType must be brand_to_influencer or influencer_to_brand",
            });
        }

        const results = [];

        for (const type of uniqueTypes) {
            const result = await createSingleReviewLink({
                req,
                campaign,
                brand,
                influencer,
                reviewType: type,
                expiresInDays,
            });

            results.push({
                _id: result.review._id,
                reviewRequestId: result.review.reviewRequestId,
                reviewType: result.review.reviewType,
                reviewerRole: result.review.reviewerRole,
                revieweeRole: result.review.revieweeRole,
                publicUrl: result.publicUrl,
                expiresAt: result.review.tokenExpiresAt,
            });
        }

        return res.status(201).json({
            success: true,
            message: "Review link generated successfully",
            data: results,
        });
    } catch (error) {
        return res.status(error?.statusCode || 500).json({
            success: false,
            message: error.message || "Failed to generate review link",
        });
    }
};

/* =========================
   PUBLIC REVIEW LINK
========================= */

exports.getReviewByToken = async (req, res) => {
    try {
        const token = toStringId(req.params.token);

        if (!token) {
            return res.status(400).json({
                success: false,
                message: "Review token is required",
            });
        }

        const review = await CampaignReview.findOne({
            tokenHash: hashToken(token),
        })
            .select("+tokenHash")
            .populate([
                {
                    path: "campaignId",
                    select: "campaignTitle productOrServiceName title name",
                },
                {
                    path: "brandId",
                    select: "brandName name companyName email",
                },
                {
                    path: "influencerId",
                    select: "name fullName influencerName username email handle",
                },
            ]);

        if (!review) {
            return res.status(404).json({
                success: false,
                message: "Review link not found",
            });
        }

        if (review.status === REVIEW_STATUS.REVOKED) {
            return res.status(410).json({
                success: false,
                message: "This review link has been revoked",
            });
        }

        if (review.status === REVIEW_STATUS.SUBMITTED) {
            return res.status(409).json({
                success: false,
                message: "This review has already been submitted",
                data: publicReviewPayload(review),
            });
        }

        if (review.tokenExpiresAt && review.tokenExpiresAt < new Date()) {
            review.status = REVIEW_STATUS.EXPIRED;
            await review.save();

            return res.status(410).json({
                success: false,
                message: "This review link has expired",
            });
        }

        return res.status(200).json({
            success: true,
            data: publicReviewPayload(review),
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to load review link",
        });
    }
};

exports.submitReviewByToken = async (req, res) => {
    try {
        const token = toStringId(req.params.token);

        if (!token) {
            return res.status(400).json({
                success: false,
                message: "Review token is required",
            });
        }

        const review = await CampaignReview.findOne({
            tokenHash: hashToken(token),
        }).select("+tokenHash");

        if (!review) {
            return res.status(404).json({
                success: false,
                message: "Review link not found",
            });
        }

        if (review.status === REVIEW_STATUS.REVOKED) {
            return res.status(410).json({
                success: false,
                message: "This review link has been revoked",
            });
        }

        if (review.status === REVIEW_STATUS.SUBMITTED) {
            return res.status(409).json({
                success: false,
                message: "This review has already been submitted",
            });
        }

        if (review.tokenExpiresAt && review.tokenExpiresAt < new Date()) {
            review.status = REVIEW_STATUS.EXPIRED;
            await review.save();

            return res.status(410).json({
                success: false,
                message: "This review link has expired",
            });
        }

        const overallRating = ratingValue(req.body?.rating);

        if (!overallRating) {
            return res.status(400).json({
                success: false,
                message: "rating is required and must be between 1 and 5",
            });
        }

        const ratings = req.body?.ratings || {};

        const duplicateSubmitted = await CampaignReview.findOne({
            _id: { $ne: review._id },
            campaignId: review.campaignId,
            brandId: review.brandId,
            influencerId: review.influencerId,
            reviewType: review.reviewType,
            status: REVIEW_STATUS.SUBMITTED,
        }).lean();

        if (duplicateSubmitted) {
            return res.status(409).json({
                success: false,
                message: "A submitted review already exists for this campaign pair",
            });
        }

        review.rating = overallRating;
        review.ratings = {
            workQuality: ratingValue(ratings.workQuality),
            communication: ratingValue(ratings.communication),
            timeliness: ratingValue(ratings.timeliness),
            professionalism: ratingValue(ratings.professionalism),
            wouldRecommend: ratingValue(ratings.wouldRecommend),
        };
        review.reviewTitle = toStringId(req.body?.reviewTitle).slice(0, 160);
        review.reviewText = toStringId(req.body?.reviewText).slice(0, 3000);
        review.privateFeedback = toStringId(req.body?.privateFeedback).slice(
            0,
            3000
        );
        review.tags = sanitizeTags(req.body?.tags);
        review.status = REVIEW_STATUS.SUBMITTED;
        review.submittedAt = new Date();
        review.submittedIp = req.ip || "";
        review.submittedUserAgent = req.headers["user-agent"] || "";

        await review.save();

        const [campaign, brand, influencer, generatedByAdmin] = await Promise.all([
            Campaign.findById(review.campaignId)
                .select("campaignTitle productOrServiceName title name")
                .lean(),
            Brand.findById(review.brandId)
                .select("brandName name companyName email")
                .lean(),
            Influencer.findById(review.influencerId)
                .select("name fullName influencerName username email")
                .lean(),
            review.generatedByAdminId
                ? AdminModel.findById(review.generatedByAdminId)
                    .select("_id name email role")
                    .lean()
                : null,
        ]);

        const campaignName = getCampaignName(campaign);
        const brandName = getBrandName(brand);
        const influencerName = getInfluencerName(influencer);

        const adminId = generatedByAdmin?._id ? String(generatedByAdmin._id) : "";

        if (adminId) {
            await notifySafely("review submitted admin notification", {
                adminId,
                type: "review.submitted",
                title: "Campaign review submitted",
                message:
                    review.reviewType === REVIEW_TYPES.BRAND_TO_INFLUENCER
                        ? `${brandName} rated ${influencerName} ${overallRating}/5 for ${campaignName}.`
                        : `${influencerName} rated ${brandName} ${overallRating}/5 for ${campaignName}.`,
                entityType: "campaign_review",
                entityId: String(review._id),
                actionPath: {
                    admin: `/admin/rating-reviews?reviewId=${review._id}`,
                },
            });
        }

        return res.status(200).json({
            success: true,
            message: "Review submitted successfully",
            data: {
                _id: review._id,
                reviewRequestId: review.reviewRequestId,
                status: review.status,
                rating: review.rating,
                submittedAt: review.submittedAt,
            },
        });
    } catch (error) {
        return res.status(error?.statusCode || 500).json({
            success: false,
            message: error.message || "Failed to submit review",
        });
    }
};

/* =========================
   ADMIN LIST / REVOKE
========================= */

exports.listAdminReviews = async (req, res) => {
    try {
        const page = Math.max(Number(req.query.page || 1), 1);
        const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);

        const query = {};

        if (isObjectId(req.query.campaignId)) {
            query.campaignId = toObjectId(req.query.campaignId);
        }

        if (isObjectId(req.query.brandId)) {
            query.brandId = toObjectId(req.query.brandId);
        }

        if (isObjectId(req.query.influencerId)) {
            query.influencerId = toObjectId(req.query.influencerId);
        }

        if (normalizeReviewType(req.query.reviewType)) {
            query.reviewType = normalizeReviewType(req.query.reviewType);
        }

        if (Object.values(REVIEW_STATUS).includes(String(req.query.status))) {
            query.status = String(req.query.status);
        }

        const [data, total] = await Promise.all([
            CampaignReview.find(query)
                .populate([
                    {
                        path: "campaignId",
                        select: "campaignTitle productOrServiceName title name",
                    },
                    {
                        path: "brandId",
                        select: "brandName name companyName email",
                    },
                    {
                        path: "influencerId",
                        select: "name fullName influencerName username email handle",
                    },
                    {
                        path: "generatedByAdminId",
                        select: "name email role",
                    },
                ])
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),

            CampaignReview.countDocuments(query),
        ]);

        return res.status(200).json({
            success: true,
            data,
            total,
            page,
            limit,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to list reviews",
        });
    }
};

exports.revokeReviewLink = async (req, res) => {
    try {
        const reviewId = toStringId(req.params.id);

        if (!isObjectId(reviewId)) {
            return res.status(400).json({
                success: false,
                message: "Valid review id is required",
            });
        }

        const actor = getActorFromReq(req);

        const review = await CampaignReview.findById(reviewId);

        if (!review) {
            return res.status(404).json({
                success: false,
                message: "Review request not found",
            });
        }

        if (review.status !== REVIEW_STATUS.PENDING) {
            return res.status(400).json({
                success: false,
                message: "Only pending review links can be revoked",
            });
        }

        review.status = REVIEW_STATUS.REVOKED;
        review.revokedAt = new Date();
        review.revokedByAdminId = actor.actorAdminId;

        await review.save();

        return res.status(200).json({
            success: true,
            message: "Review link revoked successfully",
            data: review,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to revoke review link",
        });
    }
};

/* =========================
   SUMMARY
========================= */

exports.getReviewSummary = async (req, res) => {
    try {
        const targetType = String(req.query.targetType || "").trim().toLowerCase();
        const targetId = toStringId(req.query.targetId);

        if (!["brand", "influencer"].includes(targetType)) {
            return res.status(400).json({
                success: false,
                message: "targetType must be brand or influencer",
            });
        }

        if (!isObjectId(targetId)) {
            return res.status(400).json({
                success: false,
                message: "Valid targetId is required",
            });
        }

        const match =
            targetType === "brand"
                ? {
                    status: REVIEW_STATUS.SUBMITTED,
                    reviewType: REVIEW_TYPES.INFLUENCER_TO_BRAND,
                    revieweeBrandId: toObjectId(targetId),
                }
                : {
                    status: REVIEW_STATUS.SUBMITTED,
                    reviewType: REVIEW_TYPES.BRAND_TO_INFLUENCER,
                    revieweeInfluencerId: toObjectId(targetId),
                };

        const [summary] = await CampaignReview.aggregate([
            { $match: match },
            {
                $group: {
                    _id: null,
                    totalReviews: { $sum: 1 },
                    averageRating: { $avg: "$rating" },
                    workQuality: { $avg: "$ratings.workQuality" },
                    communication: { $avg: "$ratings.communication" },
                    timeliness: { $avg: "$ratings.timeliness" },
                    professionalism: { $avg: "$ratings.professionalism" },
                    wouldRecommend: { $avg: "$ratings.wouldRecommend" },
                },
            },
        ]);

        const reviews = await CampaignReview.find(match)
            .select(
                "rating ratings reviewTitle reviewText tags submittedAt campaignId reviewerRole"
            )
            .populate({
                path: "campaignId",
                select: "campaignTitle productOrServiceName title name",
            })
            .sort({ submittedAt: -1 })
            .limit(20)
            .lean();

        return res.status(200).json({
            success: true,
            data: {
                targetType,
                targetId,
                totalReviews: summary?.totalReviews || 0,
                averageRating: summary?.averageRating
                    ? Number(summary.averageRating.toFixed(2))
                    : 0,
                metrics: {
                    workQuality: summary?.workQuality
                        ? Number(summary.workQuality.toFixed(2))
                        : 0,
                    communication: summary?.communication
                        ? Number(summary.communication.toFixed(2))
                        : 0,
                    timeliness: summary?.timeliness
                        ? Number(summary.timeliness.toFixed(2))
                        : 0,
                    professionalism: summary?.professionalism
                        ? Number(summary.professionalism.toFixed(2))
                        : 0,
                    wouldRecommend: summary?.wouldRecommend
                        ? Number(summary.wouldRecommend.toFixed(2))
                        : 0,
                },
                reviews,
            },
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to load review summary",
        });
    }
};