// models/campaignPerformance.js

const mongoose = require("mongoose");

const CampaignPerformanceSchema = new mongoose.Schema(
  {
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

    deliverableId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    platform: {
      type: String,
      enum: ["instagram", "youtube", "tiktok"],
      required: true,
    },

    contentType: {
      type: String,
      enum: ["reel", "story", "short", "long_video", "post", "other"],
      default: "other",
    },

    postUrl: String,
    postedAt: Date,

    metrics: {
      reach: { type: Number, default: 0 },
      views: { type: Number, default: 0 },
      likes: { type: Number, default: 0 },
      comments: { type: Number, default: 0 },
      shares: { type: Number, default: 0 },
      saves: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
      conversions: { type: Number, default: 0 },
      revenue: { type: Number, default: 0 },
    },

    audience: {
      gender: {
        male: { type: Number, default: 0 },
        female: { type: Number, default: 0 },
        other: { type: Number, default: 0 },
      },
      ageGroups: [
        {
          range: String,
          percentage: Number,
        },
      ],
      countries: [
        {
          country: String,
          percentage: Number,
        },
      ],
      interests: [String],
    },

    commentsSample: [
      {
        text: String,
        author: String,
        likeCount: Number,
        postedAt: Date,
      },
    ],

    aiCommentAnalysis: {
      positiveCount: { type: Number, default: 0 },
      negativeCount: { type: Number, default: 0 },
      neutralCount: { type: Number, default: 0 },
      purchaseIntentCount: { type: Number, default: 0 },
      priceQuestionCount: { type: Number, default: 0 },
      brandMentionCount: { type: Number, default: 0 },
      summary: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CampaignPerformance", CampaignPerformanceSchema);