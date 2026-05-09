const mongoose = require("mongoose");
const crypto = require("crypto");

const REVIEW_TYPES = {
  BRAND_TO_INFLUENCER: "brand_to_influencer",
  INFLUENCER_TO_BRAND: "influencer_to_brand",
};

const REVIEW_STATUS = {
  PENDING: "pending",
  SUBMITTED: "submitted",
  SKIPPED: "skipped",
  EXPIRED: "expired",
  REVOKED: "revoked",
};

const SUBMITTED_VIA = {
  PUBLIC_LINK: "public_link",
  BRAND_MODAL: "brand_modal",
  INFLUENCER_MODAL: "influencer_modal",
  ADMIN: "admin",
};

const QUESTIONNAIRE_VERSION = 4;

const ANSWER_TYPES = {
  EMOJI_RATING: "emoji_rating",
  SINGLE_SELECT: "single_select",
  MULTI_SELECT: "multi_select",
  TEXT: "text",
  STAR_RATING: "star_rating",
};

const EMOJI_RATING_OPTIONS = [
  { value: 5, emoji: "😍", label: "Amazing", score: 5 },
  { value: 4, emoji: "😊", label: "Smooth", score: 4 },
  { value: 3, emoji: "🙂", label: "Good", score: 3 },
  { value: 2, emoji: "😐", label: "Average", score: 2 },
  { value: 1, emoji: "😕", label: "Difficult", score: 1 },
];

const NOTE_STAR_RATING_OPTIONS = [
  { value: 5, label: "5 stars", score: 5 },
  { value: 4, label: "4 stars", score: 4 },
  { value: 3, label: "3 stars", score: 3 },
  { value: 2, label: "2 stars", score: 2 },
  { value: 1, label: "1 star", score: 1 },
];

const RELIABILITY_OPTIONS = [
  { value: "super_fast_proactive", label: "Super fast & proactive", score: 5 },
  { value: "always_on_time", label: "Always on time", score: 4 },
  { value: "mostly_reliable", label: "Mostly reliable", score: 3 },
  { value: "needed_few_reminders", label: "Needed a few reminders", score: 2 },
  { value: "often_delayed", label: "Often delayed", score: 1 },
];

const VISION_MATCH_OPTIONS = [
  { value: "nailed_vibe_perfectly", label: "Nailed the vibe perfectly", score: 5 },
  { value: "fully_aligned", label: "Fully aligned", score: 4 },
  { value: "mostly_aligned", label: "Mostly aligned", score: 3 },
  { value: "needed_multiple_revisions", label: "Needed multiple revisions", score: 2 },
  { value: "missed_direction", label: "Missed the direction", score: 1 },
];

const BRAND_TO_INFLUENCER_QUALITY_OPTIONS = [
  { value: "easy_to_work_with", label: "🤝 Easy To Work With" },
  { value: "creative_thinker", label: "✨ Creative Thinker" },
  { value: "fast_responder", label: "⚡ Fast Responder" },
  { value: "strong_engagement", label: "📈 Strong Engagement" },
  { value: "professional", label: "🎯 Professional" },
  { value: "trend_aware", label: "🔥 Trend Aware" },
  { value: "would_recommend", label: "🌟 Would Recommend" },
  { value: "well_organised", label: "📋 Well Organised" },
  { value: "high_quality_content", label: "🎬 High Quality Content" },
];

const INFLUENCER_TO_BRAND_QUALITY_OPTIONS = [
  { value: "easy_to_work_with", label: "🤝 Easy To Work With" },
  { value: "clear_brief", label: "📋 Clear Brief" },
  { value: "fast_responder", label: "⚡ Fast Responder" },
  { value: "professional", label: "🎯 Professional" },
  { value: "creative_freedom", label: "✨ Creative Freedom" },
  { value: "timely_approval", label: "⏱️ Timely Approval" },
  { value: "fair_collaboration", label: "🤝 Fair Collaboration" },
  { value: "well_organised", label: "📋 Well Organised" },
  { value: "would_recommend", label: "🌟 Would Recommend" },
];

const NOTE_QUESTION_META = {
  type: ANSWER_TYPES.TEXT,
  required: false,
  maxLength: 3000,
  placeholder: "Add Notes",
  description:
    "Share a quick appreciation, feedback, or memorable takeaway from this collaboration.",
  noteStarRating: {
    enabled: true,
    key: "note_star_rating",
    label: "Overall note rating",
    required: true,
    min: 1,
    max: 5,
    options: NOTE_STAR_RATING_OPTIONS,
  },
};

const REVIEW_QUESTIONNAIRES = {
  [REVIEW_TYPES.BRAND_TO_INFLUENCER]: {
    version: QUESTIONNAIRE_VERSION,
    reviewType: REVIEW_TYPES.BRAND_TO_INFLUENCER,
    title: "Brand Review for Influencer",
    description: "Brand reviews the influencer based on campaign work.",
    questions: [
      {
        key: "working_feel_rating",
        label: "How did working with {{influencerName}} feel?",
        type: ANSWER_TYPES.EMOJI_RATING,
        required: true,
        options: EMOJI_RATING_OPTIONS,
      },
      {
        key: "reliability",
        label: "How reliable was the creator during the campaign?",
        type: ANSWER_TYPES.SINGLE_SELECT,
        required: true,
        options: RELIABILITY_OPTIONS,
      },
      {
        key: "standout_qualities",
        label: "Which qualities stood out the most?",
        type: ANSWER_TYPES.MULTI_SELECT,
        required: true,
        options: BRAND_TO_INFLUENCER_QUALITY_OPTIONS,
      },
      {
        key: "content_vision_match",
        label: "Did the content match your vision?",
        type: ANSWER_TYPES.SINGLE_SELECT,
        required: true,
        options: VISION_MATCH_OPTIONS,
      },
      {
        key: "note",
        label: "Leave a overall note for {{influencerName}}.",
        ...NOTE_QUESTION_META,
      },
    ],
  },

  [REVIEW_TYPES.INFLUENCER_TO_BRAND]: {
    version: QUESTIONNAIRE_VERSION,
    reviewType: REVIEW_TYPES.INFLUENCER_TO_BRAND,
    title: "Influencer Review for Brand",
    description: "Influencer reviews the brand based on campaign collaboration.",
    questions: [
      {
        key: "working_feel_rating",
        label: "How did working with {{brandName}} feel?",
        type: ANSWER_TYPES.EMOJI_RATING,
        required: true,
        options: EMOJI_RATING_OPTIONS,
      },
      {
        key: "reliability",
        label: "How reliable was the brand during the campaign?",
        type: ANSWER_TYPES.SINGLE_SELECT,
        required: true,
        options: RELIABILITY_OPTIONS,
      },
      {
        key: "standout_qualities",
        label: "Which qualities stood out the most?",
        type: ANSWER_TYPES.MULTI_SELECT,
        required: true,
        options: INFLUENCER_TO_BRAND_QUALITY_OPTIONS,
      },
      {
        key: "content_vision_match",
        label: "Did the collaboration match your expectations?",
        type: ANSWER_TYPES.SINGLE_SELECT,
        required: true,
        options: VISION_MATCH_OPTIONS,
      },
      {
        key: "note",
        label: "Leave a overall note for {{brandName}}.",
        ...NOTE_QUESTION_META,
      },
    ],
  },
};

const ReviewAnswerSchema = new mongoose.Schema(
  {
    questionKey: { type: String, required: true, trim: true },
    questionLabel: { type: String, default: "" },
    answerType: {
      type: String,
      enum: Object.values(ANSWER_TYPES),
      required: true,
    },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    displayValue: { type: mongoose.Schema.Types.Mixed, default: null },
    score: { type: Number, min: 1, max: 5, default: null },
  },
  { _id: false }
);

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

    questionnaireVersion: {
      type: Number,
      default: QUESTIONNAIRE_VERSION,
      index: true,
    },

    sourceEntityType: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    sourceEntityId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    submittedVia: {
      type: String,
      enum: Object.values(SUBMITTED_VIA),
      default: SUBMITTED_VIA.PUBLIC_LINK,
      index: true,
    },

    firstSubmittedAt: {
      type: Date,
      default: null,
      index: true,
    },

    submittedAt: {
      type: Date,
      default: null,
      index: true,
    },

    reviewUpdatedAt: {
      type: Date,
      default: null,
      index: true,
    },

    reviewUpdateCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    skippedAt: {
      type: Date,
      default: null,
      index: true,
    },

    skippedVia: {
      type: String,
      enum: Object.values(SUBMITTED_VIA),
      default: null,
      index: true,
    },

    skipReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    responses: {
      type: [ReviewAnswerSchema],
      default: [],
    },

    responseMap: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
      index: true,
    },

    noteStarRating: {
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
  campaignId: 1,
  brandId: 1,
  influencerId: 1,
  reviewType: 1,
  submittedVia: 1,
});

CampaignReviewSchema.index({
  campaignId: 1,
  brandId: 1,
  influencerId: 1,
  reviewType: 1,
  status: 1,
  skippedAt: -1,
});

CampaignReviewSchema.index({
  sourceEntityType: 1,
  sourceEntityId: 1,
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

CampaignReviewSchema.index({ createdAt: -1 });
CampaignReviewSchema.index({ submittedAt: -1 });
CampaignReviewSchema.index({ firstSubmittedAt: -1 });
CampaignReviewSchema.index({ reviewUpdatedAt: -1 });
CampaignReviewSchema.index({ skippedAt: -1 });
CampaignReviewSchema.index({ questionnaireVersion: 1, reviewType: 1 });
CampaignReviewSchema.index({ noteStarRating: -1 });

module.exports = {
  CampaignReview:
    mongoose.models.CampaignReview ||
    mongoose.model("CampaignReview", CampaignReviewSchema),
  REVIEW_TYPES,
  REVIEW_STATUS,
  SUBMITTED_VIA,
  ANSWER_TYPES,
  QUESTIONNAIRE_VERSION,
  REVIEW_QUESTIONNAIRES,
};