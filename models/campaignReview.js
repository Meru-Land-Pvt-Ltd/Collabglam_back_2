const mongoose = require("mongoose");
const crypto = require("crypto");

const REVIEW_TYPES = Object.freeze({
  BRAND_TO_INFLUENCER: "brand_to_influencer",
  INFLUENCER_TO_BRAND: "influencer_to_brand",
  BRAND_TO_PLATFORM: "brand_to_platform",
  INFLUENCER_TO_PLATFORM: "influencer_to_platform",
});

const REVIEW_STATUS = Object.freeze({
  PENDING: "pending",
  SUBMITTED: "submitted",
  SKIPPED: "skipped",
  EXPIRED: "expired",
  REVOKED: "revoked",
});

const SUBMITTED_VIA = Object.freeze({
  PUBLIC_LINK: "public_link",
  BRAND_MODAL: "brand_modal",
  INFLUENCER_MODAL: "influencer_modal",
  BRAND_PLATFORM_MODAL: "brand_platform_modal",
  INFLUENCER_PLATFORM_MODAL: "influencer_platform_modal",
  PUBLIC_PLATFORM_PAGE: "public_platform_page",
  ADMIN: "admin",
});

const REVIEW_ROLES = Object.freeze({
  BRAND: "brand",
  INFLUENCER: "influencer",
  PLATFORM: "platform",
  ADMIN: "admin",
});

const REVIEW_TARGET_TABS = Object.freeze({
  BRAND: "brand",
  INFLUENCER: "influencer",
  CAMPAIGN: "campaign",
  PLATFORM: "platform",
  ALL: "all",
});

const DEFAULT_PLATFORM_TARGET = Object.freeze({
  key: "collabglam",
  name: "CollabGlam",
});

const QUESTIONNAIRE_VERSION = 6;

const ANSWER_TYPES = Object.freeze({
  EMOJI_RATING: "emoji_rating",
  SINGLE_SELECT: "single_select",
  MULTI_SELECT: "multi_select",
  TEXT: "text",
});

const EMOJI_RATING_OPTIONS = [
  { value: 5, emoji: "😍", label: "Excellent", score: 5 },
  { value: 4, emoji: "😊", label: "Great", score: 4 },
  { value: 3, emoji: "🙂", label: "Good", score: 3 },
  { value: 2, emoji: "😐", label: "Okay", score: 2 },
  { value: 1, emoji: "😕", label: "Difficult", score: 1 },
];

const RELIABILITY_OPTIONS = [
  { value: "extremely_reliable", label: "Extremely reliable", score: 5 },
  { value: "very_reliable", label: "Very reliable", score: 4 },
  { value: "reliable", label: "Reliable", score: 3 },
  { value: "somewhat_reliable", label: "Somewhat reliable", score: 2 },
  { value: "not_reliable", label: "Not reliable", score: 1 },
];

const VISION_MATCH_OPTIONS = [
  { value: "perfectly", label: "Perfectly", score: 5 },
  { value: "very_closely", label: "Very closely", score: 4 },
  { value: "mostly", label: "Mostly", score: 3 },
  { value: "partially", label: "Partially", score: 2 },
  { value: "not_at_all", label: "Not at all", score: 1 },
];

const BRAND_TO_INFLUENCER_QUALITY_OPTIONS = [
  { value: "creative", label: "Creative" },
  { value: "professional", label: "Professional" },
  { value: "on_time", label: "On time" },
  { value: "clear_communication", label: "Clear communication" },
  { value: "easy_to_work_with", label: "Easy to work with" },
  { value: "high_quality_content", label: "High quality content" },
  { value: "brand_aligned", label: "Brand aligned" },
];

const INFLUENCER_TO_BRAND_QUALITY_OPTIONS = [
  { value: "clear_brief", label: "Clear brief" },
  { value: "professional", label: "Professional" },
  { value: "fast_approval", label: "Fast approval" },
  { value: "clear_communication", label: "Clear communication" },
  { value: "respectful", label: "Respectful" },
  { value: "creator_friendly", label: "Creator friendly" },
  { value: "smooth_payment", label: "Smooth payment" },
];

const BRAND_PLATFORM_VALUE_OPTIONS = [
  { value: "campaign_management", label: "🚀 Campaign Management" },
  { value: "influencer_collaboration", label: "🤝 Influencer Collaboration" },
  { value: "payment_workflow", label: "💸 Payment Workflow" },
  { value: "deliverable_tracking", label: "📦 Deliverable Tracking" },
  { value: "influencer_tracking", label: "📊 Influencer Tracking" },
  { value: "creator_discovery", label: "🎯 Creator Discovery" },
  { value: "platform_simplicity", label: "🧠 Platform Simplicity" },
  { value: "approval_workflow", label: "⚡ Approval Workflow" },
  { value: "overall_experience", label: "🔥 Overall Experience" },
];

const INFLUENCER_PLATFORM_VALUE_OPTIONS = [
  { value: "campaign_management", label: "🚀 Campaign Management" },
  { value: "brand_collaboration", label: "🤝 Brand Collaboration" },
  { value: "payment_workflow", label: "💸 Payment Workflow" },
  { value: "deliverable_tracking", label: "📦 Deliverable Tracking" },
  { value: "profile_growth", label: "📈 Profile Growth" },
  { value: "creator_discovery", label: "🎯 Creator Discovery" },
  { value: "platform_simplicity", label: "🧠 Platform Simplicity" },
  { value: "approval_workflow", label: "⚡ Approval Workflow" },
  { value: "overall_experience", label: "🔥 Overall Experience" },
];


const NOTE_STAR_RATING_OPTIONS = [1, 2, 3, 4, 5].map((value) => ({
  value,
  label: `${value} star${value === 1 ? "" : "s"}`,
  score: value,
}));

const NOTE_META = {
  type: ANSWER_TYPES.TEXT,
  required: true,
  maxLength: 1200,
  noteStarRating: {
    enabled: true,
    key: "note_star_rating",
    label: "Overall star rating",
    required: true,
    min: 1,
    max: 5,
    options: NOTE_STAR_RATING_OPTIONS,
  },
};

const REVIEW_QUESTIONNAIRES = Object.freeze({
  [REVIEW_TYPES.BRAND_TO_INFLUENCER]: {
    version: QUESTIONNAIRE_VERSION,
    reviewType: REVIEW_TYPES.BRAND_TO_INFLUENCER,
    title: "Review {{influencerName}}",
    description: "Brand reviews the influencer after the campaign.",
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
        placeholder: "Write your overall note for this creator...",
        ...NOTE_META,
      },
    ],
  },

  [REVIEW_TYPES.INFLUENCER_TO_BRAND]: {
    version: QUESTIONNAIRE_VERSION,
    reviewType: REVIEW_TYPES.INFLUENCER_TO_BRAND,
    title: "Review {{brandName}}",
    description: "Influencer reviews the brand after the campaign.",
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
        label: "Did the campaign brief and expectations match what was discussed?",
        type: ANSWER_TYPES.SINGLE_SELECT,
        required: true,
        options: VISION_MATCH_OPTIONS,
      },
      {
        key: "note",
        label: "Leave a overall note for {{brandName}}.",
        placeholder: "Write your overall note for this brand...",
        ...NOTE_META,
      },
    ],
  },

  [REVIEW_TYPES.BRAND_TO_PLATFORM]: {
    version: QUESTIONNAIRE_VERSION,
    reviewType: REVIEW_TYPES.BRAND_TO_PLATFORM,
    title: "Time to rate us",
    description: "Brand shares feedback about their CollabGlam platform experience.",
    questions: [
      {
        key: "working_feel_rating",
        label: "How has your overall experience with CollabGlam been?",
        type: ANSWER_TYPES.EMOJI_RATING,
        required: true,
        options: EMOJI_RATING_OPTIONS,
      },
      {
        key: "standout_qualities",
        label: "What parts of CollabGlam have been most valuable to you?",
        type: ANSWER_TYPES.MULTI_SELECT,
        required: true,
        options: BRAND_PLATFORM_VALUE_OPTIONS,
      },
      {
        key: "note",
        label: "Anything you'd love to share with the CollabGlam team?",
        placeholder: "Add Notes",
        ...NOTE_META,
        required: false,
      },
    ],
  },

  [REVIEW_TYPES.INFLUENCER_TO_PLATFORM]: {
    version: QUESTIONNAIRE_VERSION,
    reviewType: REVIEW_TYPES.INFLUENCER_TO_PLATFORM,
    title: "Time to rate us",
    description: "Creator shares feedback about their CollabGlam platform experience.",
    questions: [
      {
        key: "working_feel_rating",
        label: "How has your overall experience with CollabGlam been?",
        type: ANSWER_TYPES.EMOJI_RATING,
        required: true,
        options: EMOJI_RATING_OPTIONS,
      },
      {
        key: "standout_qualities",
        label: "What parts of CollabGlam have been most valuable to you?",
        type: ANSWER_TYPES.MULTI_SELECT,
        required: true,
        options: INFLUENCER_PLATFORM_VALUE_OPTIONS,
      },
      {
        key: "note",
        label: "Anything you'd love to share with the CollabGlam team?",
        placeholder: "Add Notes",
        ...NOTE_META,
        required: false,
      },
    ],
  },
});

function defaultTokenHash() {
  return crypto
    .createHash("sha256")
    .update(crypto.randomBytes(32).toString("hex"))
    .digest("hex");
}

function defaultExpiryDate() {
  return new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
}

const ReviewEntitySnapshotSchema = new mongoose.Schema(
  {
    role: { type: String, enum: Object.values(REVIEW_ROLES), required: true },
    entityId: { type: String, default: "", trim: true, index: true },
    name: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    handle: { type: String, default: "", trim: true },
    image: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const ReviewMetricsSchema = new mongoose.Schema(
  {
    workQuality: { type: Number, min: 1, max: 5, default: null },
    communication: { type: Number, min: 1, max: 5, default: null },
    timeliness: { type: Number, min: 1, max: 5, default: null },
    professionalism: { type: Number, min: 1, max: 5, default: null },
    valueForMoney: { type: Number, min: 1, max: 5, default: null },
    platformExperience: { type: Number, min: 1, max: 5, default: null },
    supportExperience: { type: Number, min: 1, max: 5, default: null },
    wouldRecommend: { type: Number, min: 1, max: 5, default: null },
  },
  { _id: false }
);

const ReviewAnswerSchema = new mongoose.Schema(
  {
    questionKey: { type: String, required: true, trim: true },
    questionLabel: { type: String, required: true, trim: true },
    answerType: { type: String, required: true, trim: true },
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

    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", default: null, index: true },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: "Brand", default: null, index: true },
    influencerId: { type: mongoose.Schema.Types.ObjectId, ref: "Influencer", default: null, index: true },

    reviewType: { type: String, enum: Object.values(REVIEW_TYPES), required: true, index: true },

    reviewerRole: {
      type: String,
      enum: [REVIEW_ROLES.BRAND, REVIEW_ROLES.INFLUENCER, REVIEW_ROLES.ADMIN],
      required: true,
      index: true,
    },
    revieweeRole: {
      type: String,
      enum: [REVIEW_ROLES.BRAND, REVIEW_ROLES.INFLUENCER, REVIEW_ROLES.PLATFORM],
      required: true,
      index: true,
    },

    reviewerBrandId: { type: mongoose.Schema.Types.ObjectId, ref: "Brand", default: null, index: true },
    reviewerInfluencerId: { type: mongoose.Schema.Types.ObjectId, ref: "Influencer", default: null, index: true },
    revieweeBrandId: { type: mongoose.Schema.Types.ObjectId, ref: "Brand", default: null, index: true },
    revieweeInfluencerId: { type: mongoose.Schema.Types.ObjectId, ref: "Influencer", default: null, index: true },

    reviewerSnapshot: { type: ReviewEntitySnapshotSchema, default: null },
    revieweeSnapshot: { type: ReviewEntitySnapshotSchema, default: null },

    platformKey: {
      type: String,
      default: DEFAULT_PLATFORM_TARGET.key,
      trim: true,
      lowercase: true,
      index: true,
    },
    platformName: { type: String, default: DEFAULT_PLATFORM_TARGET.name, trim: true },

    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
      select: false,
      default: defaultTokenHash,
    },
    publicUrl: { type: String, default: "", trim: true },
    tokenExpiresAt: { type: Date, default: defaultExpiryDate, index: true },

    status: { type: String, enum: Object.values(REVIEW_STATUS), default: REVIEW_STATUS.PENDING, index: true },
    submittedVia: { type: String, enum: Object.values(SUBMITTED_VIA), default: SUBMITTED_VIA.PUBLIC_LINK, index: true },

    sourceEntityType: { type: String, default: "campaign", trim: true, lowercase: true, index: true },
    sourceEntityId: { type: String, default: null, trim: true, index: true },

    questionnaireVersion: { type: Number, default: QUESTIONNAIRE_VERSION, index: true },
    responses: { type: [ReviewAnswerSchema], default: [] },
    responseMap: { type: mongoose.Schema.Types.Mixed, default: {} },

    rating: { type: Number, min: 1, max: 5, default: null, index: true },
    noteStarRating: { type: Number, min: 1, max: 5, default: null, index: true },

    reviewTitle: { type: String, default: "", trim: true, maxlength: 160 },
    reviewText: { type: String, default: "", trim: true, maxlength: 3000 },
    privateFeedback: { type: String, default: "", trim: true, maxlength: 3000 },

    tags: { type: [String], default: [], index: true },

    metrics: { type: ReviewMetricsSchema, default: () => ({}) },
    ratings: { type: ReviewMetricsSchema, default: () => ({}) },

    firstSubmittedAt: { type: Date, default: null, index: true },
    submittedAt: { type: Date, default: null, index: true },
    reviewUpdatedAt: { type: Date, default: null, index: true },
    reviewUpdateCount: { type: Number, default: 0, min: 0 },

    skippedAt: { type: Date, default: null, index: true },
    skippedVia: { type: String, enum: [...Object.values(SUBMITTED_VIA), null], default: null, index: true },
    skipReason: { type: String, default: "", trim: true, maxlength: 500 },

    submittedIp: { type: String, default: "" },
    submittedUserAgent: { type: String, default: "" },

    generatedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "Master", default: null, index: true },
    generatedByAdminName: { type: String, default: "", trim: true },
    generatedByAdminEmail: { type: String, default: "", trim: true, lowercase: true },
    generatedByAdminRole: { type: String, default: "", trim: true },

    revokedAt: { type: Date, default: null, index: true },
    revokedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "Master", default: null },
  },
  { timestamps: true }
);

CampaignReviewSchema.index({ status: 1, submittedAt: -1 });
CampaignReviewSchema.index({ reviewType: 1, status: 1, submittedAt: -1 });
CampaignReviewSchema.index({ reviewerRole: 1, status: 1, submittedAt: -1 });
CampaignReviewSchema.index({ revieweeRole: 1, status: 1, submittedAt: -1 });
CampaignReviewSchema.index({ questionnaireVersion: 1, reviewType: 1 });
CampaignReviewSchema.index({ campaignId: 1, status: 1, rating: -1 });
CampaignReviewSchema.index({ campaignId: 1, brandId: 1, influencerId: 1, reviewType: 1, status: 1 });
CampaignReviewSchema.index({ revieweeRole: 1, revieweeBrandId: 1, status: 1, rating: -1 });
CampaignReviewSchema.index({ revieweeRole: 1, revieweeInfluencerId: 1, status: 1, rating: -1 });
CampaignReviewSchema.index({ revieweeRole: 1, platformKey: 1, status: 1, rating: -1 });
CampaignReviewSchema.index({ reviewerBrandId: 1, reviewType: 1, sourceEntityType: 1, sourceEntityId: 1 });
CampaignReviewSchema.index({ reviewerInfluencerId: 1, reviewType: 1, sourceEntityType: 1, sourceEntityId: 1 });
CampaignReviewSchema.index({ sourceEntityType: 1, sourceEntityId: 1, reviewType: 1, status: 1 });
CampaignReviewSchema.index({ createdAt: -1 });

module.exports = {
  CampaignReview:
    mongoose.models.CampaignReview ||
    mongoose.model("CampaignReview", CampaignReviewSchema),
  REVIEW_TYPES,
  REVIEW_STATUS,
  SUBMITTED_VIA,
  REVIEW_ROLES,
  REVIEW_TARGET_TABS,
  DEFAULT_PLATFORM_TARGET,
  QUESTIONNAIRE_VERSION,
  ANSWER_TYPES,
  REVIEW_QUESTIONNAIRES,
  BRAND_PLATFORM_VALUE_OPTIONS,
  INFLUENCER_PLATFORM_VALUE_OPTIONS,
};