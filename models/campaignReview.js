// models/campaignReview.js
const mongoose = require("mongoose");
const crypto = require("crypto");

const REVIEW_TYPES = {
    BRAND_TO_INFLUENCER: "brand_to_influencer",
    INFLUENCER_TO_BRAND: "influencer_to_brand",
};

const REVIEW_STATUS = {
    PENDING: "pending",
    SUBMITTED: "submitted",
    EXPIRED: "expired",
    REVOKED: "revoked",
};

const CampaignReviewSchema = new mongoose.Schema(
    {
        reviewRequestId: {
            type: String,
            required: true,
            unique: true,
            default: () => crypto.randomUUID(),
            index: true,
        },

        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Campaign",
            required: true,
            index: true,
        },

        brandId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Brand",
            required: true,
            index: true,
        },

        influencerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Influencer",
            required: true,
            index: true,
        },

        reviewType: {
            type: String,
            enum: Object.values(REVIEW_TYPES),
            required: true,
            index: true,
        },

        reviewerRole: {
            type: String,
            enum: ["brand", "influencer"],
            required: true,
            index: true,
        },

        revieweeRole: {
            type: String,
            enum: ["brand", "influencer"],
            required: true,
            index: true,
        },

        reviewerBrandId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Brand",
            default: null,
            index: true,
        },

        reviewerInfluencerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Influencer",
            default: null,
            index: true,
        },

        revieweeBrandId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Brand",
            default: null,
            index: true,
        },

        revieweeInfluencerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Influencer",
            default: null,
            index: true,
        },

        tokenHash: {
            type: String,
            required: true,
            unique: true,
            index: true,
            select: false,
        },

        publicUrl: {
            type: String,
            default: "",
        },

        tokenExpiresAt: {
            type: Date,
            required: true,
            index: true,
        },

        status: {
            type: String,
            enum: Object.values(REVIEW_STATUS),
            default: REVIEW_STATUS.PENDING,
            index: true,
        },

        rating: {
            type: Number,
            min: 1,
            max: 5,
            default: null,
            index: true,
        },

        ratings: {
            workQuality: { type: Number, min: 1, max: 5, default: null },
            communication: { type: Number, min: 1, max: 5, default: null },
            timeliness: { type: Number, min: 1, max: 5, default: null },
            professionalism: { type: Number, min: 1, max: 5, default: null },
            wouldRecommend: { type: Number, min: 1, max: 5, default: null },
        },

        reviewTitle: {
            type: String,
            default: "",
            trim: true,
            maxlength: 160,
        },

        reviewText: {
            type: String,
            default: "",
            trim: true,
            maxlength: 3000,
        },

        privateFeedback: {
            type: String,
            default: "",
            trim: true,
            maxlength: 3000,
        },

        tags: {
            type: [String],
            default: [],
        },

        submittedAt: {
            type: Date,
            default: null,
            index: true,
        },

        submittedIp: {
            type: String,
            default: "",
        },

        submittedUserAgent: {
            type: String,
            default: "",
        },

        generatedByAdminId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Master",
            default: null,
            index: true,
        },

        generatedByAdminName: {
            type: String,
            default: "",
        },

        generatedByAdminEmail: {
            type: String,
            default: "",
        },

        generatedByAdminRole: {
            type: String,
            default: "",
        },

        revokedAt: {
            type: Date,
            default: null,
        },

        revokedByAdminId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Master",
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

CampaignReviewSchema.index({
    campaignId: 1,
    brandId: 1,
    influencerId: 1,
    reviewType: 1,
    status: 1,
});

CampaignReviewSchema.index({
    revieweeRole: 1,
    revieweeBrandId: 1,
    status: 1,
    rating: -1,
});

CampaignReviewSchema.index({
    revieweeRole: 1,
    revieweeInfluencerId: 1,
    status: 1,
    rating: -1,
});

CampaignReviewSchema.index({
    createdAt: -1,
});

module.exports = {
    CampaignReview:
        mongoose.models.CampaignReview ||
        mongoose.model("CampaignReview", CampaignReviewSchema),
    REVIEW_TYPES,
    REVIEW_STATUS,
};