const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  CampaignReview,
  REVIEW_TYPES,
  REVIEW_STATUS,
  SUBMITTED_VIA,
  REVIEW_ROLES,
  REVIEW_TARGET_TABS,
  DEFAULT_PLATFORM_TARGET,
  QUESTIONNAIRE_VERSION,
  REVIEW_QUESTIONNAIRES,
} = require("../models/campaignReview");

const Campaign = require("../models/campaign");
const Brand = require("../models/brand");
const ApplyCampaign = require("../models/applyCampaign");
const { InfluencerModel: Influencer } = require("../models/influencer");
const { AdminModel } = require("../models/master");
const Modash = require("../models/modash");
const { createAndEmit } = require("../utils/notifier");
const saveErrorLog = require("../services/errorLog.service");

const BRAND_PUBLIC_SELECT =
  "brandName name companyName email profilePic logo image avatar profileImage brandLogo picture page1 page2 page3";

const INFLUENCER_PUBLIC_SELECT =
  "name fullName influencerName username email handle image avatar profileImage profilePicture profilePic picture page1 page2 page3";

const CAMPAIGN_PUBLIC_SELECT =
  "campaignTitle productOrServiceName title name brandId brandName companyName campaignsId campaignId status isActive";

const REVIEW_POPULATE = [
  { path: "campaignId", select: CAMPAIGN_PUBLIC_SELECT },
  { path: "brandId", select: BRAND_PUBLIC_SELECT },
  { path: "influencerId", select: INFLUENCER_PUBLIC_SELECT },
  { path: "reviewerBrandId", select: BRAND_PUBLIC_SELECT },
  { path: "reviewerInfluencerId", select: INFLUENCER_PUBLIC_SELECT },
  { path: "revieweeBrandId", select: BRAND_PUBLIC_SELECT },
  { path: "revieweeInfluencerId", select: INFLUENCER_PUBLIC_SELECT },
  { path: "generatedByAdminId", select: "name email role" },
];

/* =========================
   BASIC HELPERS
========================= */

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

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

function uniqueStrings(values = []) {
  return [
    ...new Set(
      values
        .filter((value) => value !== undefined && value !== null)
        .map((value) => String(value).trim())
        .filter(Boolean)
    ),
  ];
}

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getFrontendBaseUrl() {
  return String(
    process.env.FRONTEND_URL ||
    process.env.CLIENT_URL ||
    process.env.NEXT_PUBLIC_FRONTEND_URL ||
    "http://localhost:3000"
  ).replace(/\/+$/, "");
}

/* Public review pages live on the frontend app, not on the API host. */
function buildPublicReviewUrl(token) {
  return `${getFrontendBaseUrl()}/rating-review/${token}`;
}

function parseExpiresAt(days = 30) {
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 180);
  return new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000);
}

function getActorFromReq(req = {}) {
  const admin = req.admin || req.user || {};
  const actorAdminId = toStringId(admin.adminId || admin._id);

  return {
    actorAdminId: isObjectId(actorAdminId) ? toObjectId(actorAdminId) : null,
    actorName: toStringId(admin.name),
    actorEmail: toStringId(admin.email).toLowerCase(),
    actorRole: toStringId(admin.role).toLowerCase(),
  };
}

function sanitizeText(value = "", maxLength = 3000) {
  const text = String(value || "").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizeSourceEntityType(value = "") {
  const type = String(value || "").trim().toLowerCase();
  if (!type) return "campaign";
  return type.replace(/[^a-z0-9_.-]/g, "_").slice(0, 80);
}

function sanitizeSourceEntityId(value = null) {
  if (value === undefined || value === null) return null;
  const id = String(value || "").trim();
  return id || null;
}

function booleanFromBody(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function requiredRating(value, label = "Rating") {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 1 || number > 5) {
    throw httpError(`${label} must be between 1 and 5`, 400);
  }

  return Math.round(number);
}

function optionalRating(value) {
  if (value === undefined || value === null || value === "" || Number(value) === 0) {
    return null;
  }

  return requiredRating(value);
}

function normalizeTags(value = []) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
      .split(",")
      .map((item) => item.trim());

  return uniqueStrings(raw)
    .map((tag) => tag.slice(0, 60))
    .slice(0, 20);
}

function normalizeMetrics(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};

  const keys = [
    "workQuality",
    "communication",
    "timeliness",
    "professionalism",
    "valueForMoney",
    "platformExperience",
    "supportExperience",
    "wouldRecommend",
  ];

  const metrics = {};

  for (const key of keys) {
    const normalized = optionalRating(source[key]);
    if (normalized !== null) metrics[key] = normalized;
  }

  return metrics;
}


/* =========================
   FIXED 5-QUESTION HELPERS
========================= */

function getQuestionnaire(reviewType) {
  return REVIEW_QUESTIONNAIRES[normalizeReviewType(reviewType)] || null;
}

function renderTemplate(value = "", variables = {}) {
  return String(value || "")
    .replace(/{{brandName}}/g, variables.brandName || "the brand")
    .replace(/{{influencerName}}/g, variables.influencerName || "the creator")
    .replace(/{{campaignName}}/g, variables.campaignName || "the campaign");
}

function renderQuestionnaire(reviewType, docs = {}) {
  const questionnaire = getQuestionnaire(reviewType);
  if (!questionnaire) return null;

  const variables = {
    brandName: getBrandName(docs.brand || {}),
    influencerName: getInfluencerName(docs.influencer || {}),
    campaignName: getCampaignName(docs.campaign || {}),
  };

  return {
    ...questionnaire,
    title: renderTemplate(questionnaire.title, variables),
    description: renderTemplate(questionnaire.description, variables),
    questions: questionnaire.questions.map((question) => ({
      ...question,
      label: renderTemplate(question.label, variables),
      placeholder: renderTemplate(question.placeholder || "", variables),
    })),
  };
}

function normalizeAnswerInput(body = {}) {
  const src =
    body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
      ? body.answers
      : body;

  return {
    working_feel_rating:
      src.working_feel_rating ?? src.workingFeelRating ?? src.rating ?? src.overallRating,
    reliability:
      src.reliability ?? src.creatorReliability ?? src.brandReliability ?? src.brand_reliability,
    standout_qualities:
      src.standout_qualities ?? src.standoutQualities ?? src.tags,
    content_vision_match:
      src.content_vision_match ?? src.contentVisionMatch ?? src.visionMatch ?? src.briefClarity,
    note:
      src.note ?? src.reviewText ?? src.privateFeedback ?? src.comment ?? src.feedback,
    note_star_rating:
      src.note_star_rating ?? src.noteStarRating ?? src.rating ?? src.overallRating,
  };
}

function hasQuestionnaireAnswers(body = {}) {
  const input = normalizeAnswerInput(body);
  return [
    input.working_feel_rating,
    input.reliability,
    input.standout_qualities,
    input.content_vision_match,
    input.note,
    input.note_star_rating,
  ].some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
}

function findOption(question = {}, rawValue) {
  const options = Array.isArray(question.options) ? question.options : [];
  return options.find((option) => String(option.value) === String(rawValue));
}

function displayValueForQuestion(question = {}, value) {
  if (Array.isArray(value)) {
    return value
      .map((single) => findOption(question, single)?.label || String(single))
      .filter(Boolean);
  }
  return findOption(question, value)?.label || value;
}

function scoreForQuestion(question = {}, value) {
  if (Array.isArray(value)) return null;
  const option = findOption(question, value);
  if (option && Number.isFinite(Number(option.score))) return Number(option.score);
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 && number <= 5 ? Math.round(number) : null;
}

function validateQuestionAnswer(question = {}, value) {
  if (!question.required) return;
  if (Array.isArray(value) && value.length > 0) return;
  if (value !== undefined && value !== null && String(value).trim() !== "") return;
  throw httpError(`${question.label || question.key} is required`, 400);
}

function buildQuestionnaireSubmission({ reviewType, docs = {}, body = {} }) {
  const questionnaire = renderQuestionnaire(reviewType, docs);
  if (!questionnaire) return null;

  const input = normalizeAnswerInput(body);
  const responseMap = {};
  const responses = [];

  for (const question of questionnaire.questions) {
    const value = input[question.key];
    validateQuestionAnswer(question, value);

    const answer = {
      questionKey: question.key,
      questionLabel: question.label,
      answerType: question.type,
      value,
      displayValue: displayValueForQuestion(question, value),
      score: scoreForQuestion(question, value),
    };

    responses.push(answer);
    responseMap[question.key] = answer;

    if (question.key === "note" && question.noteStarRating?.enabled) {
      const ratingValue = input[question.noteStarRating.key];
      const rating = requiredRating(ratingValue, question.noteStarRating.label || "Overall star rating");
      const ratingAnswer = {
        questionKey: question.noteStarRating.key,
        questionLabel: question.noteStarRating.label || "Overall star rating",
        answerType: "star_rating",
        value: rating,
        displayValue: `${rating}/5`,
        score: rating,
      };
      responses.push(ratingAnswer);
      responseMap[question.noteStarRating.key] = ratingAnswer;
    }
  }

  const note = sanitizeText(responseMap.note?.value || "", 3000);
  const noteStarRating = requiredRating(responseMap.note_star_rating?.value, "Overall star rating");
  const workingFeel = responseMap.working_feel_rating?.score || noteStarRating;
  const reliability = responseMap.reliability?.score || noteStarRating;
  const visionMatch = responseMap.content_vision_match?.score || noteStarRating;
  const tags = normalizeTags(responseMap.standout_qualities?.value || []);

  const type = normalizeReviewType(reviewType);
  const isBrandToInfluencer = type === REVIEW_TYPES.BRAND_TO_INFLUENCER;
  const brandName = getBrandName(docs.brand || {});
  const influencerName = getInfluencerName(docs.influencer || {});

  return {
    questionnaireVersion: questionnaire.version || QUESTIONNAIRE_VERSION,
    responses,
    responseMap,
    input: {
      rating: noteStarRating,
      noteStarRating,
      reviewTitle: isPlatformReviewType(type)
        ? "CollabGlam platform review"
        : isBrandToInfluencer
          ? `Review for ${influencerName}`
          : `Review for ${brandName}`,
      reviewText: note,
      privateFeedback: note,
      tags,
      metrics: isPlatformReviewType(type)
        ? {
          platformExperience: workingFeel,
          supportExperience: noteStarRating,
          wouldRecommend: noteStarRating,
        }
        : {
          workQuality: visionMatch,
          communication: reliability,
          timeliness: reliability,
          professionalism: workingFeel,
          wouldRecommend: noteStarRating,
        },
    },
  };
}

function round2(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(2));
}

/* =========================
   TYPE / ROLE HELPERS
========================= */

function normalizeReviewType(value = "") {
  const type = String(value || "").trim().toLowerCase();

  const aliases = {
    [REVIEW_TYPES.BRAND_TO_INFLUENCER]: REVIEW_TYPES.BRAND_TO_INFLUENCER,
    brand: REVIEW_TYPES.BRAND_TO_INFLUENCER,
    brand_review: REVIEW_TYPES.BRAND_TO_INFLUENCER,
    brand_to_creator: REVIEW_TYPES.BRAND_TO_INFLUENCER,

    [REVIEW_TYPES.INFLUENCER_TO_BRAND]: REVIEW_TYPES.INFLUENCER_TO_BRAND,
    influencer: REVIEW_TYPES.INFLUENCER_TO_BRAND,
    influencer_review: REVIEW_TYPES.INFLUENCER_TO_BRAND,
    creator_to_brand: REVIEW_TYPES.INFLUENCER_TO_BRAND,

    [REVIEW_TYPES.BRAND_TO_PLATFORM]: REVIEW_TYPES.BRAND_TO_PLATFORM,
    brand_to_collabglam: REVIEW_TYPES.BRAND_TO_PLATFORM,
    brand_platform: REVIEW_TYPES.BRAND_TO_PLATFORM,
    platform_by_brand: REVIEW_TYPES.BRAND_TO_PLATFORM,

    [REVIEW_TYPES.INFLUENCER_TO_PLATFORM]: REVIEW_TYPES.INFLUENCER_TO_PLATFORM,
    influencer_to_collabglam: REVIEW_TYPES.INFLUENCER_TO_PLATFORM,
    influencer_platform: REVIEW_TYPES.INFLUENCER_TO_PLATFORM,
    platform_by_influencer: REVIEW_TYPES.INFLUENCER_TO_PLATFORM,
  };

  return aliases[type] || "";
}

function isCampaignPairReviewType(reviewType) {
  return [REVIEW_TYPES.BRAND_TO_INFLUENCER, REVIEW_TYPES.INFLUENCER_TO_BRAND].includes(
    normalizeReviewType(reviewType)
  );
}

function isPlatformReviewType(reviewType) {
  return [REVIEW_TYPES.BRAND_TO_PLATFORM, REVIEW_TYPES.INFLUENCER_TO_PLATFORM].includes(
    normalizeReviewType(reviewType)
  );
}

const PLATFORM_REVIEW_REMIND_LATER_DAYS = 7;

function getPlatformReviewNextPromptAt(skippedAt) {
  if (!skippedAt) return null;

  const date = new Date(skippedAt);
  if (Number.isNaN(date.getTime())) return null;

  date.setDate(date.getDate() + PLATFORM_REVIEW_REMIND_LATER_DAYS);
  return date;
}

function shouldForceSimplePlatformRating({ reviewType, submittedVia }) {
  return (
    isPlatformReviewType(reviewType) &&
    [
      SUBMITTED_VIA.BRAND_PLATFORM_MODAL,
      SUBMITTED_VIA.INFLUENCER_PLATFORM_MODAL,
    ].includes(submittedVia)
  );
}

function buildSimplePlatformMetrics(rating, existingMetrics = {}) {
  const incoming = normalizeMetrics(existingMetrics);

  return {
    platformExperience: incoming.platformExperience || rating,
    supportExperience: incoming.supportExperience || rating,
    wouldRecommend: incoming.wouldRecommend || rating,
  };
}

function buildReviewRolePayload({ reviewType, brandId = null, influencerId = null }) {
  const type = normalizeReviewType(reviewType);
  const brandObjectId = brandId && isObjectId(brandId) ? toObjectId(brandId) : null;
  const influencerObjectId = influencerId && isObjectId(influencerId) ? toObjectId(influencerId) : null;

  if (type === REVIEW_TYPES.BRAND_TO_INFLUENCER) {
    return {
      reviewerRole: REVIEW_ROLES.BRAND,
      revieweeRole: REVIEW_ROLES.INFLUENCER,
      reviewerBrandId: brandObjectId,
      reviewerInfluencerId: null,
      revieweeBrandId: null,
      revieweeInfluencerId: influencerObjectId,
    };
  }

  if (type === REVIEW_TYPES.INFLUENCER_TO_BRAND) {
    return {
      reviewerRole: REVIEW_ROLES.INFLUENCER,
      revieweeRole: REVIEW_ROLES.BRAND,
      reviewerBrandId: null,
      reviewerInfluencerId: influencerObjectId,
      revieweeBrandId: brandObjectId,
      revieweeInfluencerId: null,
    };
  }

  if (type === REVIEW_TYPES.BRAND_TO_PLATFORM) {
    return {
      reviewerRole: REVIEW_ROLES.BRAND,
      revieweeRole: REVIEW_ROLES.PLATFORM,
      reviewerBrandId: brandObjectId,
      reviewerInfluencerId: null,
      revieweeBrandId: null,
      revieweeInfluencerId: null,
    };
  }

  if (type === REVIEW_TYPES.INFLUENCER_TO_PLATFORM) {
    return {
      reviewerRole: REVIEW_ROLES.INFLUENCER,
      revieweeRole: REVIEW_ROLES.PLATFORM,
      reviewerBrandId: null,
      reviewerInfluencerId: influencerObjectId,
      revieweeBrandId: null,
      revieweeInfluencerId: null,
    };
  }

  throw httpError("Invalid reviewType", 400);
}

function defaultSourceForReview({ reviewType, campaignId }) {
  if (isPlatformReviewType(reviewType)) {
    return {
      sourceEntityType: "platform",
      sourceEntityId: DEFAULT_PLATFORM_TARGET.key,
    };
  }

  return {
    sourceEntityType: "campaign",
    sourceEntityId: campaignId ? String(campaignId) : null,
  };
}

/* =========================
   NAME / IMAGE HELPERS
========================= */

function pickFirstNonEmptyString(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
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
  return brand.brandName || brand.name || brand.companyName || brand.email || fallback || "Brand";
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

function getBrandAvatar(brand = {}) {
  return pickFirstNonEmptyString(
    brand.profilePic,
    brand.logo,
    brand.brandLogo,
    brand.image,
    brand.avatar,
    brand.profileImage,
    brand.picture
  );
}

function getInfluencerAvatar(influencer = {}, modashProfile = null) {
  return pickFirstNonEmptyString(
    influencer.image,
    influencer.avatar,
    influencer.profileImage,
    influencer.profilePicture,
    influencer.profilePic,
    influencer.picture,
    modashProfile?.picture
  );
}

async function findInfluencerModashProfile(influencerId) {
  const id = String(influencerId?._id || influencerId || "").trim();
  if (!id) return null;

  const query = {
    $or: [{ influencerId: id }],
    picture: { $nin: ["", null] },
  };

  if (isObjectId(id)) query.$or.push({ influencer: toObjectId(id) });

  return Modash.findOne(query)
    .select("picture provider username fullname handle updatedAt")
    .sort({ updatedAt: -1 })
    .lean();
}

async function findModashProfilesForInfluencers(influencerIds = []) {
  const ids = uniqueStrings(influencerIds);
  if (!ids.length) return new Map();

  const objectIds = ids.filter(isObjectId).map(toObjectId);

  const rows = await Modash.find({
    $or: [
      { influencerId: { $in: ids } },
      ...(objectIds.length ? [{ influencer: { $in: objectIds } }] : []),
    ],
    picture: { $nin: ["", null] },
  })
    .select("influencer influencerId picture provider username fullname handle updatedAt")
    .sort({ updatedAt: -1 })
    .lean();

  const map = new Map();

  for (const row of rows) {
    for (const key of uniqueStrings([row.influencerId, row.influencer])) {
      if (!map.has(key)) map.set(key, row);
    }
  }

  return map;
}

function brandPayload(brand = {}) {
  if (!brand) return null;
  const avatar = getBrandAvatar(brand);
  return {
    _id: brand._id || "",
    name: getBrandName(brand),
    email: brand.email || "",
    profilePic: avatar,
    logo: avatar,
    image: avatar,
    avatar,
    profileImage: avatar,
    brandLogo: avatar,
    picture: avatar,
  };
}

function influencerPayload(influencer = {}, modashProfile = null) {
  if (!influencer) return null;
  const avatar = getInfluencerAvatar(influencer, modashProfile);
  return {
    _id: influencer._id || "",
    name: getInfluencerName(influencer),
    email: influencer.email || "",
    handle: influencer.handle || influencer.username || "",
    username: influencer.username || influencer.handle || "",
    image: avatar,
    avatar,
    profileImage: avatar,
    profilePicture: avatar,
    profilePic: avatar,
    picture: avatar,
  };
}

function campaignPayload(campaign = {}) {
  if (!campaign) return null;
  return {
    _id: campaign._id || "",
    name: getCampaignName(campaign),
    campaignTitle: campaign.campaignTitle || "",
    productOrServiceName: campaign.productOrServiceName || "",
    campaignsId: campaign.campaignsId || "",
    campaignId: campaign.campaignId || "",
    status: campaign.status || "",
    isActive: campaign.isActive ?? null,
  };
}

function platformPayload() {
  return {
    key: DEFAULT_PLATFORM_TARGET.key,
    name: DEFAULT_PLATFORM_TARGET.name,
  };
}

function buildSnapshot({ role, brand = null, influencer = null, modashProfile = null }) {
  if (role === REVIEW_ROLES.BRAND) {
    const brandData = brandPayload(brand || {});
    return {
      role,
      entityId: String(brandData?._id || ""),
      name: brandData?.name || "Brand",
      email: brandData?.email || "",
      handle: "",
      image: brandData?.avatar || "",
    };
  }

  if (role === REVIEW_ROLES.INFLUENCER) {
    const influencerData = influencerPayload(influencer || {}, modashProfile);
    return {
      role,
      entityId: String(influencerData?._id || ""),
      name: influencerData?.name || "Influencer",
      email: influencerData?.email || "",
      handle: influencerData?.handle || "",
      image: influencerData?.avatar || "",
    };
  }

  return {
    role: REVIEW_ROLES.PLATFORM,
    entityId: DEFAULT_PLATFORM_TARGET.key,
    name: DEFAULT_PLATFORM_TARGET.name,
    email: "",
    handle: "",
    image: "",
  };
}

/* =========================
   APPLY CAMPAIGN VALIDATION
========================= */

function buildCampaignKeys(campaign = {}) {
  return uniqueStrings([campaign._id, campaign.campaignsId, campaign.campaignId]);
}

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
  if (!applicant || isRejectedApplicant(applicant)) return false;

  const statusBrand = String(applicant.statusBrand || "").toLowerCase();
  const statusInfluencer = String(applicant.statusInfluencer || "").toLowerCase();
  const contractId = String(applicant.contractId || "").trim();

  if (fromApprovedArray) return true;
  if (Number(applicant.isShortlisted || 0) === 1) return true;
  if (Number(applicant.isAccepted || 0) === 1) return true;
  if (contractId) return true;

  return [statusBrand, statusInfluencer].some((status) =>
    ["contractaccept", "active", "completed", "final", "sign"].some((needle) =>
      status.includes(needle)
    )
  );
}

function getReviewableApplicantsFromApplyRecord(record = {}) {
  const rows = [];

  for (const item of Array.isArray(record.approved) ? record.approved : []) {
    if (isReviewableApplicant(item, true)) rows.push({ ...item, fromApprovedArray: true });
  }

  for (const item of Array.isArray(record.applicants) ? record.applicants : []) {
    if (isReviewableApplicant(item, false)) rows.push({ ...item, fromApprovedArray: false });
  }

  const seen = new Set();

  return rows.filter((item) => {
    const influencerId = String(item.influencerId || "").trim();
    if (!influencerId || seen.has(influencerId)) return false;
    seen.add(influencerId);
    return true;
  });
}

async function ensureReviewPairBelongsToCampaign({ campaign, brand, influencer, allowMissingApplyRecord = false }) {
  const campaignBrandId = String(campaign.brandId || "").trim();
  const brandId = String(brand._id || "").trim();
  const influencerId = String(influencer._id || "").trim();

  if (campaignBrandId && campaignBrandId !== brandId) {
    throw httpError("Selected brand does not belong to this campaign", 400);
  }

  const campaignKeys = buildCampaignKeys(campaign);

  const applyRecords = await ApplyCampaign.find({
    campaignId: { $in: campaignKeys },
  }).lean();

  const isReviewable = applyRecords.some((record) =>
    getReviewableApplicantsFromApplyRecord(record).some(
      (applicant) => String(applicant.influencerId || "") === influencerId
    )
  );

  if (!isReviewable && !allowMissingApplyRecord) {
    throw httpError("Selected influencer is not approved/active for this campaign", 400);
  }

  return true;
}

/* =========================
   REVIEW DOC LOADING
========================= */

async function loadReviewDocs({ campaignId, brandId, influencerId, reviewType }) {
  const type = normalizeReviewType(reviewType);

  if (!type) throw httpError("Invalid reviewType", 400);

  if (isCampaignPairReviewType(type)) {
    if (!isObjectId(campaignId)) throw httpError("Valid campaignId is required", 400);
    if (!isObjectId(brandId)) throw httpError("Valid brandId is required", 400);
    if (!isObjectId(influencerId)) throw httpError("Valid influencerId is required", 400);
  }

  if (type === REVIEW_TYPES.BRAND_TO_PLATFORM && !isObjectId(brandId)) {
    throw httpError("Valid brandId is required", 400);
  }

  if (type === REVIEW_TYPES.INFLUENCER_TO_PLATFORM && !isObjectId(influencerId)) {
    throw httpError("Valid influencerId is required", 400);
  }

  const [campaign, brand, influencer] = await Promise.all([
    isObjectId(campaignId)
      ? Campaign.findById(campaignId).select(CAMPAIGN_PUBLIC_SELECT).lean()
      : null,
    isObjectId(brandId) ? Brand.findById(brandId).select(BRAND_PUBLIC_SELECT).lean() : null,
    isObjectId(influencerId)
      ? Influencer.findById(influencerId).select(INFLUENCER_PUBLIC_SELECT).lean()
      : null,
  ]);

  if (isObjectId(campaignId) && !campaign) throw httpError("Campaign not found", 404);
  if (isObjectId(brandId) && !brand) throw httpError("Brand not found", 404);
  if (isObjectId(influencerId) && !influencer) throw httpError("Influencer not found", 404);

  if (isCampaignPairReviewType(type)) {
    await ensureReviewPairBelongsToCampaign({
      campaign,
      brand,
      influencer,
      allowMissingApplyRecord: false,
    });
  }

  return { campaign, brand, influencer };
}

function getContextIdsFromDocs({ campaign, brand, influencer }) {
  return {
    campaignId: campaign?._id || null,
    brandId: brand?._id || null,
    influencerId: influencer?._id || null,
  };
}

function buildReviewIdentityQuery({ reviewType, campaignId, brandId, influencerId, sourceEntityType, sourceEntityId }) {
  const type = normalizeReviewType(reviewType);

  if (isCampaignPairReviewType(type)) {
    return {
      reviewType: type,
      campaignId,
      brandId,
      influencerId,
    };
  }

  if (type === REVIEW_TYPES.BRAND_TO_PLATFORM) {
    return {
      reviewType: type,
      reviewerBrandId: brandId,
      revieweeRole: REVIEW_ROLES.PLATFORM,
      sourceEntityType,
      sourceEntityId,
    };
  }

  if (type === REVIEW_TYPES.INFLUENCER_TO_PLATFORM) {
    return {
      reviewType: type,
      reviewerInfluencerId: influencerId,
      revieweeRole: REVIEW_ROLES.PLATFORM,
      sourceEntityType,
      sourceEntityId,
    };
  }

  throw httpError("Invalid reviewType", 400);
}

function normalizeReviewInput(body = {}, options = {}) {
  const nested =
    body.review && typeof body.review === "object" && !Array.isArray(body.review)
      ? body.review
      : {};

  const src = { ...body, ...nested };

  const rawRating =
    src.rating ??
    src.overallRating ??
    src.finalRating ??
    src.noteStarRating ??
    src.note_rating;

  if (options.forceSimplePlatformRating) {
    const rating = requiredRating(rawRating, "Rating");

    return {
      isQuestionnaireSubmission: false,
      answers: {},
      rating,
      noteStarRating: rating,
      reviewTitle: sanitizeText(src.reviewTitle ?? src.title ?? "", 160),
      reviewText: sanitizeText(src.reviewText ?? src.note ?? src.comment ?? src.feedback ?? "", 3000),
      privateFeedback: sanitizeText(src.privateFeedback ?? "", 3000),
      tags: normalizeTags(src.tags ?? []),
      metrics: buildSimplePlatformMetrics(rating, src.metrics ?? src.ratings ?? {}),
    };
  }

  if (hasQuestionnaireAnswers(src)) {
    const answers = normalizeAnswerInput(src);
    const rating = requiredRating(
      answers.note_star_rating ??
      src.rating ??
      src.overallRating ??
      src.finalRating ??
      src.noteStarRating,
      "Overall star rating"
    );

    return {
      isQuestionnaireSubmission: true,
      answers,
      rating,
      noteStarRating: rating,
      reviewTitle: sanitizeText(src.reviewTitle ?? src.title ?? "", 160),
      reviewText: sanitizeText(answers.note ?? src.reviewText ?? "", 3000),
      privateFeedback: sanitizeText(src.privateFeedback ?? answers.note ?? "", 3000),
      tags: normalizeTags(answers.standout_qualities ?? src.tags),
      metrics: normalizeMetrics(src.metrics ?? src.ratings ?? {}),
    };
  }

  const rating = requiredRating(rawRating, "Rating");

  return {
    isQuestionnaireSubmission: false,
    answers: {},
    rating,
    noteStarRating: rating,
    reviewTitle: sanitizeText(src.reviewTitle ?? src.title ?? "", 160),
    reviewText: sanitizeText(src.reviewText ?? src.note ?? src.comment ?? src.feedback ?? "", 3000),
    privateFeedback: sanitizeText(src.privateFeedback ?? "", 3000),
    tags: normalizeTags(src.tags ?? src.standoutQualities ?? src.standout_qualities),
    metrics: normalizeMetrics(src.metrics ?? src.ratings ?? {}),
  };
}

function getDefaultReviewTitle({ reviewType, brand, influencer, campaign }) {
  const type = normalizeReviewType(reviewType);
  const brandName = getBrandName(brand || {});
  const influencerName = getInfluencerName(influencer || {});
  const campaignName = getCampaignName(campaign || {});

  if (type === REVIEW_TYPES.BRAND_TO_INFLUENCER) return `Review for ${influencerName}`;
  if (type === REVIEW_TYPES.INFLUENCER_TO_BRAND) return `Review for ${brandName}`;
  if (type === REVIEW_TYPES.BRAND_TO_PLATFORM) return `${brandName}'s CollabGlam platform review`;
  if (type === REVIEW_TYPES.INFLUENCER_TO_PLATFORM) return `${influencerName}'s CollabGlam platform review`;

  return `Review for ${campaignName}`;
}

async function applyReviewSubmissionFields({
  review,
  reviewType,
  docs,
  input,
  submittedVia,
  sourceEntityType,
  sourceEntityId,
  req,
}) {
  const type = normalizeReviewType(reviewType);
  const { campaign, brand, influencer } = docs;
  const { campaignId, brandId, influencerId } = getContextIdsFromDocs(docs);
  const rolePayload = buildReviewRolePayload({ reviewType: type, brandId, influencerId });
  const wasAlreadySubmitted = review.status === REVIEW_STATUS.SUBMITTED;
  const modashProfile = influencer ? await findInfluencerModashProfile(influencer._id) : null;
  const questionnaireSubmission = input.isQuestionnaireSubmission
    ? buildQuestionnaireSubmission({ reviewType: type, docs, body: { answers: input.answers, ...input } })
    : null;
  const finalInput = questionnaireSubmission?.input
    ? { ...input, ...questionnaireSubmission.input }
    : input;

  review.reviewType = type;
  review.campaignId = campaignId;
  review.brandId = brandId;
  review.influencerId = influencerId;

  Object.assign(review, rolePayload);

  review.reviewerSnapshot =
    rolePayload.reviewerRole === REVIEW_ROLES.BRAND
      ? buildSnapshot({ role: REVIEW_ROLES.BRAND, brand })
      : buildSnapshot({ role: REVIEW_ROLES.INFLUENCER, influencer, modashProfile });

  review.revieweeSnapshot =
    rolePayload.revieweeRole === REVIEW_ROLES.BRAND
      ? buildSnapshot({ role: REVIEW_ROLES.BRAND, brand })
      : rolePayload.revieweeRole === REVIEW_ROLES.INFLUENCER
        ? buildSnapshot({ role: REVIEW_ROLES.INFLUENCER, influencer, modashProfile })
        : buildSnapshot({ role: REVIEW_ROLES.PLATFORM });

  review.platformKey = DEFAULT_PLATFORM_TARGET.key;
  review.platformName = DEFAULT_PLATFORM_TARGET.name;

  review.status = REVIEW_STATUS.SUBMITTED;
  review.submittedVia = submittedVia;
  review.sourceEntityType = sanitizeSourceEntityType(sourceEntityType);
  review.sourceEntityId = sanitizeSourceEntityId(sourceEntityId);

  review.rating = finalInput.rating;
  review.noteStarRating = finalInput.noteStarRating;
  review.reviewTitle = finalInput.reviewTitle || getDefaultReviewTitle({ reviewType: type, brand, influencer, campaign });
  review.reviewText = finalInput.reviewText;
  review.privateFeedback = finalInput.privateFeedback;
  review.tags = finalInput.tags;
  review.metrics = finalInput.metrics;
  review.ratings = finalInput.metrics;

  if (questionnaireSubmission) {
    review.questionnaireVersion = questionnaireSubmission.questionnaireVersion;
    review.responses = questionnaireSubmission.responses;
    review.responseMap = questionnaireSubmission.responseMap;
  }

  if (!review.firstSubmittedAt) review.firstSubmittedAt = new Date();
  review.submittedAt = new Date();
  review.reviewUpdatedAt = wasAlreadySubmitted ? new Date() : null;
  review.reviewUpdateCount = wasAlreadySubmitted
    ? Number(review.reviewUpdateCount || 0) + 1
    : Number(review.reviewUpdateCount || 0);

  review.skippedAt = null;
  review.skippedVia = null;
  review.skipReason = "";

  review.submittedIp = req.ip || "";
  review.submittedUserAgent = req.headers["user-agent"] || "";

  return wasAlreadySubmitted;
}

async function notifySafely(context, payload) {
  try {
    return await createAndEmit(payload);
  } catch (error) {
    console.warn(`${context} notification failed:`, error?.message || error);
    return null;
  }
}

async function notifyReviewSubmitted({ review, wasUpdate, reviewType, docs, rating }) {
  const type = normalizeReviewType(reviewType);
  const { campaign, brand, influencer } = docs;
  const campaignName = getCampaignName(campaign || {});
  const brandName = getBrandName(brand || {});
  const influencerName = getInfluencerName(influencer || {});

  if (type === REVIEW_TYPES.BRAND_TO_INFLUENCER && influencer?._id) {
    await notifySafely("brand review submitted influencer notification", {
      influencerId: String(influencer._id),
      type: wasUpdate ? "review.updated.brand_to_influencer" : "review.submitted.brand_to_influencer",
      title: wasUpdate ? "Brand updated your campaign review" : "Brand reviewed your campaign work",
      message: `${brandName} ${wasUpdate ? "updated their review of" : "reviewed"} your work for ${campaignName} with ${rating}/5.`,
      entityType: "campaign_review",
      entityId: String(review._id),
      actionPath: {
        influencer: `/influencer/reviews?reviewId=${review._id}`,
        admin: `/admin/rating-reviews?reviewId=${review._id}`,
      },
    });
  }

  if (type === REVIEW_TYPES.INFLUENCER_TO_BRAND && brand?._id) {
    await notifySafely("influencer review submitted brand notification", {
      brandId: String(brand._id),
      type: wasUpdate ? "review.updated.influencer_to_brand" : "review.submitted.influencer_to_brand",
      title: wasUpdate ? "Influencer updated your campaign review" : "Influencer reviewed your brand collaboration",
      message: `${influencerName} ${wasUpdate ? "updated their review of" : "reviewed"} ${brandName} for ${campaignName} with ${rating}/5.`,
      entityType: "campaign_review",
      entityId: String(review._id),
      actionPath: {
        brand: `/brand/reviews?reviewId=${review._id}`,
        admin: `/admin/rating-reviews?reviewId=${review._id}`,
      },
    });
  }
}

/* =========================
   PAYLOAD HYDRATION
========================= */

async function hydrateReview(review = {}) {
  const raw = review.toObject ? review.toObject() : review;
  const modashProfile = raw.influencerId?._id
    ? await findInfluencerModashProfile(raw.influencerId._id)
    : null;

  return {
    _id: raw._id,
    reviewRequestId: raw.reviewRequestId,
    reviewType: raw.reviewType,
    reviewerRole: raw.reviewerRole,
    revieweeRole: raw.revieweeRole,
    status: raw.status,
    submittedVia: raw.submittedVia,
    sourceEntityType: raw.sourceEntityType,
    sourceEntityId: raw.sourceEntityId,

    rating: raw.rating,
    noteStarRating: raw.noteStarRating,
    reviewTitle: raw.reviewTitle,
    reviewText: raw.reviewText,
    privateFeedback: raw.privateFeedback,
    tags: raw.tags || [],
    metrics: raw.metrics || raw.ratings || {},
    ratings: raw.ratings || raw.metrics || {},
    questionnaireVersion: raw.questionnaireVersion || QUESTIONNAIRE_VERSION,
    responses: raw.responses || [],
    responseMap: raw.responseMap || {},

    firstSubmittedAt: raw.firstSubmittedAt,
    submittedAt: raw.submittedAt,
    reviewUpdatedAt: raw.reviewUpdatedAt,
    reviewUpdateCount: raw.reviewUpdateCount || 0,
    skippedAt: raw.skippedAt,
    skippedVia: raw.skippedVia,
    skipReason: raw.skipReason,
    tokenExpiresAt: raw.tokenExpiresAt,
    publicUrl: raw.publicUrl,

    campaign: campaignPayload(raw.campaignId),
    brand: brandPayload(raw.brandId),
    influencer: influencerPayload(raw.influencerId, modashProfile),
    platform: platformPayload(),

    reviewer: raw.reviewerSnapshot || null,
    reviewee: raw.revieweeSnapshot || null,

    generatedByAdmin: raw.generatedByAdminId
      ? {
        _id: raw.generatedByAdminId._id,
        name: raw.generatedByAdminId.name || raw.generatedByAdminName || "",
        email: raw.generatedByAdminId.email || raw.generatedByAdminEmail || "",
        role: raw.generatedByAdminId.role || raw.generatedByAdminRole || "",
      }
      : null,
  };
}

async function publicReviewPayload(review, docs = {}) {
  const raw = review.toObject ? review.toObject() : review;
  const campaign = docs.campaign || raw.campaignId || null;
  const brand = docs.brand || raw.brandId || null;
  const influencer = docs.influencer || raw.influencerId || null;
  const modashProfile = influencer ? await findInfluencerModashProfile(influencer._id || influencer) : null;

  return {
    _id: raw._id,
    reviewRequestId: raw.reviewRequestId,
    reviewType: raw.reviewType,
    reviewerRole: raw.reviewerRole,
    revieweeRole: raw.revieweeRole,
    status: raw.status,
    submittedVia: raw.submittedVia,
    tokenExpiresAt: raw.tokenExpiresAt,
    canEdit: false,

    rating: raw.rating,
    noteStarRating: raw.noteStarRating,
    reviewTitle: raw.reviewTitle,
    reviewText: raw.reviewText,
    tags: raw.tags || [],
    metrics: raw.metrics || raw.ratings || {},

    campaign: campaignPayload(campaign),
    brand: brandPayload(brand),
    influencer: influencerPayload(influencer, modashProfile),
    platform: platformPayload(),
    reviewer: raw.reviewerSnapshot || null,
    reviewee: raw.revieweeSnapshot || null,
    questionnaire: renderQuestionnaire(raw.reviewType, { campaign, brand, influencer }),
    questionnaireVersion: raw.questionnaireVersion || QUESTIONNAIRE_VERSION,
    responses: raw.responses || [],
    responseMap: raw.responseMap || {},
  };
}

/* =========================
   DIRECT SUBMIT / UPDATE
========================= */

async function submitDirectReview(req, res, { reviewType, submittedVia }) {
  try {
    const type = normalizeReviewType(reviewType);
    const {
      campaignId,
      brandId,
      influencerId,
      sourceEntityType: sourceEntityTypeFromBody,
      sourceEntityId: sourceEntityIdFromBody,
    } = req.body || {};

    const docs = await loadReviewDocs({ campaignId, brandId, influencerId, reviewType: type });
    const contextIds = getContextIdsFromDocs(docs);
    const defaultSource = defaultSourceForReview({ reviewType: type, campaignId: contextIds.campaignId });

    const sourceEntityType = sanitizeSourceEntityType(sourceEntityTypeFromBody || defaultSource.sourceEntityType);
    const sourceEntityId = sanitizeSourceEntityId(sourceEntityIdFromBody || defaultSource.sourceEntityId);

    const input = normalizeReviewInput(req.body || {}, {
      reviewType: type,
      forceSimplePlatformRating: shouldForceSimplePlatformRating({
        reviewType: type,
        submittedVia,
      }),
    });
    const identityQuery = buildReviewIdentityQuery({
      reviewType: type,
      ...contextIds,
      sourceEntityType,
      sourceEntityId,
    });

    const existingSubmitted = await CampaignReview.findOne({
      ...identityQuery,
      status: REVIEW_STATUS.SUBMITTED,
    }).lean();

    if (existingSubmitted) {
      return res.status(409).json({
        success: false,
        message: "Review already submitted",
        data: {
          shouldPrompt: false,
          status: REVIEW_STATUS.SUBMITTED,
          reviewId: existingSubmitted._id,
          alreadyHandled: true,
        },
      });
    }

    let review = await CampaignReview.findOne({
      ...identityQuery,
      status: { $in: [REVIEW_STATUS.SKIPPED, REVIEW_STATUS.PENDING] },
    }).select("+tokenHash");

    if (!review) {
      const rolePayload = buildReviewRolePayload({
        reviewType: type,
        brandId: contextIds.brandId,
        influencerId: contextIds.influencerId,
      });

      review = new CampaignReview({
        ...identityQuery,
        ...contextIds,
        ...rolePayload,
        tokenHash: hashToken(makeToken()),
        tokenExpiresAt: parseExpiresAt(180),
        submittedVia,
        sourceEntityType,
        sourceEntityId,
      });
    }

    const wasUpdate = await applyReviewSubmissionFields({
      review,
      reviewType: type,
      docs,
      input,
      submittedVia,
      sourceEntityType,
      sourceEntityId,
      req,
    });

    await review.save();

    await notifyReviewSubmitted({
      review,
      wasUpdate,
      reviewType: type,
      docs,
      rating: input.rating,
    });

    return res.status(200).json({
      success: true,
      message: "Review submitted successfully",
      data: await hydrateReview(await CampaignReview.findById(review._id).populate(REVIEW_POPULATE).lean()),
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || 500, "SUBMIT_DIRECT_REVIEW_ERROR");
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to submit review",
    });
  }
}

exports.submitBrandReviewDirect = async (req, res) => {
  return submitDirectReview(req, res, {
    reviewType: REVIEW_TYPES.BRAND_TO_INFLUENCER,
    submittedVia: SUBMITTED_VIA.BRAND_MODAL,
  });
};

exports.submitInfluencerReviewDirect = async (req, res) => {
  return submitDirectReview(req, res, {
    reviewType: REVIEW_TYPES.INFLUENCER_TO_BRAND,
    submittedVia: SUBMITTED_VIA.INFLUENCER_MODAL,
  });
};

exports.submitBrandPlatformReviewDirect = async (req, res) => {
  return submitDirectReview(req, res, {
    reviewType: REVIEW_TYPES.BRAND_TO_PLATFORM,
    submittedVia: SUBMITTED_VIA.BRAND_PLATFORM_MODAL,
  });
};

exports.submitInfluencerPlatformReviewDirect = async (req, res) => {
  return submitDirectReview(req, res, {
    reviewType: REVIEW_TYPES.INFLUENCER_TO_PLATFORM,
    submittedVia: SUBMITTED_VIA.INFLUENCER_PLATFORM_MODAL,
  });
};

/* =========================
   PROMPT STATE + SKIP
========================= */

async function getReviewPromptState(req, res, { reviewType }) {
  try {
    const type = normalizeReviewType(reviewType);
    const { campaignId, brandId, influencerId } = req.body || {};

    const docs = await loadReviewDocs({ campaignId, brandId, influencerId, reviewType: type });
    const contextIds = getContextIdsFromDocs(docs);
    const defaultSource = defaultSourceForReview({
      reviewType: type,
      campaignId: contextIds.campaignId,
    });

    const sourceEntityType = sanitizeSourceEntityType(
      req.body?.sourceEntityType || defaultSource.sourceEntityType
    );
    const sourceEntityId = sanitizeSourceEntityId(
      req.body?.sourceEntityId || defaultSource.sourceEntityId
    );

    const handledReview = await CampaignReview.findOne({
      ...buildReviewIdentityQuery({
        reviewType: type,
        ...contextIds,
        sourceEntityType,
        sourceEntityId,
      }),
      status: { $in: [REVIEW_STATUS.SUBMITTED, REVIEW_STATUS.SKIPPED] },
    })
      .select(
        "_id reviewRequestId status rating submittedAt firstSubmittedAt skippedAt skippedVia reviewUpdateCount"
      )
      .sort({ submittedAt: -1, skippedAt: -1, updatedAt: -1, createdAt: -1 })
      .lean();

    if (handledReview?.status === REVIEW_STATUS.SUBMITTED) {
      return res.status(200).json({
        success: true,
        data: {
          shouldPrompt: false,
          showSendFeedbackButton: false,
          canManualSubmit: false,
          reason: "review_already_submitted",
          review: handledReview,
        },
      });
    }

    if (handledReview?.status === REVIEW_STATUS.SKIPPED) {
      if (isPlatformReviewType(type)) {
        const nextPromptAt = getPlatformReviewNextPromptAt(handledReview.skippedAt);
        const canPromptAgain = !nextPromptAt || nextPromptAt <= new Date();

        return res.status(200).json({
          success: true,
          data: {
            shouldPrompt: canPromptAgain,
            showSendFeedbackButton: true,
            canManualSubmit: true,
            reason: canPromptAgain
              ? "review_skip_window_expired"
              : "review_skipped_until",
            nextPromptAt,
            review: handledReview,
          },
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          shouldPrompt: false,
          showSendFeedbackButton: true,
          canManualSubmit: true,
          reason: "review_already_skipped",
          review: handledReview,
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        shouldPrompt: true,
        showSendFeedbackButton: false,
        canManualSubmit: true,
        reason: "not_handled_yet",
        review: null,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || 500, "GET_REVIEW_PROMPT_STATE_ERROR");
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to check review prompt state",
    });
  }
}

async function skipDirectReview(req, res, { reviewType, skippedVia }) {
  try {
    const type = normalizeReviewType(reviewType);
    const { campaignId, brandId, influencerId, skipReason = "" } = req.body || {};

    const docs = await loadReviewDocs({ campaignId, brandId, influencerId, reviewType: type });
    const contextIds = getContextIdsFromDocs(docs);
    const defaultSource = defaultSourceForReview({ reviewType: type, campaignId: contextIds.campaignId });

    const sourceEntityType = sanitizeSourceEntityType(req.body?.sourceEntityType || defaultSource.sourceEntityType);
    const sourceEntityId = sanitizeSourceEntityId(req.body?.sourceEntityId || defaultSource.sourceEntityId);

    const identityQuery = buildReviewIdentityQuery({
      reviewType: type,
      ...contextIds,
      sourceEntityType,
      sourceEntityId,
    });

    const existingSubmitted = await CampaignReview.findOne({
      ...identityQuery,
      status: REVIEW_STATUS.SUBMITTED,
    }).lean();

    if (existingSubmitted) {
      return res.status(200).json({
        success: true,
        message: "Review already submitted",
        data: {
          shouldPrompt: false,
          status: REVIEW_STATUS.SUBMITTED,
          reviewId: existingSubmitted._id,
          alreadyHandled: true,
        },
      });
    }

    let review = await CampaignReview.findOne({
      ...identityQuery,
      status: { $in: [REVIEW_STATUS.SKIPPED, REVIEW_STATUS.PENDING] },
    }).select("+tokenHash");

    if (!review) {
      const rolePayload = buildReviewRolePayload({
        reviewType: type,
        brandId: contextIds.brandId,
        influencerId: contextIds.influencerId,
      });

      review = new CampaignReview({
        ...identityQuery,
        ...contextIds,
        ...rolePayload,
        tokenHash: hashToken(makeToken()),
        tokenExpiresAt: parseExpiresAt(180),
        sourceEntityType,
        sourceEntityId,
      });
    }

    const skippedAt = new Date();
    const nextPromptAt = isPlatformReviewType(type)
      ? getPlatformReviewNextPromptAt(skippedAt)
      : null;

    review.status = REVIEW_STATUS.SKIPPED;
    review.submittedVia = skippedVia;
    review.skippedVia = skippedVia;
    review.skippedAt = skippedAt;
    review.skipReason = sanitizeText(skipReason, 500);
    review.sourceEntityType = sourceEntityType;
    review.sourceEntityId = sourceEntityId;

    await review.save();

    return res.status(200).json({
      success: true,
      message: "Review skipped",
      data: {
        shouldPrompt: false,
        showSendFeedbackButton: true,
        canManualSubmit: true,
        status: review.status,
        reviewId: review._id,
        reviewRequestId: review.reviewRequestId,
        skippedAt: review.skippedAt,
        nextPromptAt,
        alreadyHandled: true,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || 500, "SKIP_DIRECT_REVIEW_ERROR");
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to skip review",
    });
  }
}

exports.getBrandReviewPromptState = async (req, res) => {
  return getReviewPromptState(req, res, { reviewType: REVIEW_TYPES.BRAND_TO_INFLUENCER });
};

exports.skipBrandReviewDirect = async (req, res) => {
  return skipDirectReview(req, res, {
    reviewType: REVIEW_TYPES.BRAND_TO_INFLUENCER,
    skippedVia: SUBMITTED_VIA.BRAND_MODAL,
  });
};

exports.getInfluencerReviewPromptState = async (req, res) => {
  return getReviewPromptState(req, res, { reviewType: REVIEW_TYPES.INFLUENCER_TO_BRAND });
};

exports.skipInfluencerReviewDirect = async (req, res) => {
  return skipDirectReview(req, res, {
    reviewType: REVIEW_TYPES.INFLUENCER_TO_BRAND,
    skippedVia: SUBMITTED_VIA.INFLUENCER_MODAL,
  });
};

exports.getBrandPlatformReviewPromptState = async (req, res) => {
  return getReviewPromptState(req, res, { reviewType: REVIEW_TYPES.BRAND_TO_PLATFORM });
};

exports.skipBrandPlatformReviewDirect = async (req, res) => {
  return skipDirectReview(req, res, {
    reviewType: REVIEW_TYPES.BRAND_TO_PLATFORM,
    skippedVia: SUBMITTED_VIA.BRAND_PLATFORM_MODAL,
  });
};

exports.getInfluencerPlatformReviewPromptState = async (req, res) => {
  return getReviewPromptState(req, res, { reviewType: REVIEW_TYPES.INFLUENCER_TO_PLATFORM });
};

exports.skipInfluencerPlatformReviewDirect = async (req, res) => {
  return skipDirectReview(req, res, {
    reviewType: REVIEW_TYPES.INFLUENCER_TO_PLATFORM,
    skippedVia: SUBMITTED_VIA.INFLUENCER_PLATFORM_MODAL,
  });
};


/* =========================
   PUBLIC PLATFORM FEEDBACK PAGE
========================= */

function normalizePlatformAudienceRole(value = "") {
  const role = String(value || "").trim().toLowerCase();

  if (["brand", "business", "company", "advertiser"].includes(role)) {
    return REVIEW_ROLES.BRAND;
  }

  if (["influencer", "creator", "talent"].includes(role)) {
    return REVIEW_ROLES.INFLUENCER;
  }

  throw httpError("audienceRole must be brand or influencer", 400);
}

function reviewTypeForPlatformAudience(audienceRole) {
  if (audienceRole === REVIEW_ROLES.BRAND) return REVIEW_TYPES.BRAND_TO_PLATFORM;
  if (audienceRole === REVIEW_ROLES.INFLUENCER) return REVIEW_TYPES.INFLUENCER_TO_PLATFORM;
  throw httpError("audienceRole must be brand or influencer", 400);
}

function normalizePublicPlatformProfile(body = {}, audienceRole) {
  const profile = body.profile && typeof body.profile === "object" && !Array.isArray(body.profile)
    ? body.profile
    : {};
  const source = { ...body, ...profile };

  const name = sanitizeText(source.name || source.fullName || source.userName || "", 120);
  const organizationName = sanitizeText(
    source.organizationName || source.companyName || source.brandName || source.creatorName || "",
    160
  );
  const profileRole = sanitizeText(source.profileRole || source.roleTitle || source.organizationRole || "", 120);
  const email = sanitizeText(source.email || "", 160).toLowerCase();

  const displayName =
    audienceRole === REVIEW_ROLES.BRAND
      ? organizationName || name || "Brand"
      : name || organizationName || "Creator";

  return {
    name,
    organizationName,
    profileRole,
    email,
    displayName,
  };
}

function textResponse(questionKey, questionLabel, value) {
  const safeValue = sanitizeText(value || "", 3000);
  return {
    questionKey,
    questionLabel,
    answerType: "text",
    value: safeValue,
    displayValue: safeValue,
    score: null,
  };
}

function profileResponsesForPlatform(profile, audienceRole) {
  const roleLabel = audienceRole === REVIEW_ROLES.BRAND ? "I’m a Brand" : "I’m a Creator";

  return [
    textResponse("audience_role", "Reviewer type", roleLabel),
    textResponse("profile_name", "Tell us your name?", profile.name),
    textResponse(
      "organization_name",
      audienceRole === REVIEW_ROLES.BRAND ? "What’s your brand name?" : "What’s your creator / page name?",
      profile.organizationName
    ),
    textResponse("profile_role", "What’s your role in the organization?", profile.profileRole),
    textResponse("profile_email", "Email", profile.email),
  ].filter((item) => String(item.value || "").trim());
}

function getPublicPlatformFeedbackPayload() {
  return {
    pageType: "public_platform_feedback",
    title: "Time to rate us",
    description: "We’ll use these details to securely connect your feedback with your collaboration experience on CollabGlam.",
    roles: [
      { value: REVIEW_ROLES.BRAND, label: "I’m a Brand" },
      { value: REVIEW_ROLES.INFLUENCER, label: "I’m a Creator" },
    ],
    profileRoles: [
      "Founder / Owner",
      "Marketing Manager",
      "Creative Director",
      "Brand Manager",
      "Creator",
      "Influencer",
      "Talent Manager",
      "Other",
    ],
    questionnaires: {
      brand: REVIEW_QUESTIONNAIRES[REVIEW_TYPES.BRAND_TO_PLATFORM],
      influencer: REVIEW_QUESTIONNAIRES[REVIEW_TYPES.INFLUENCER_TO_PLATFORM],
    },
  };
}

exports.getPublicPlatformFeedbackQuestionnaire = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: getPublicPlatformFeedbackPayload(),
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || 500, "GET_PUBLIC_PLATFORM_FEEDBACK_QUESTIONNAIRE_ERROR");
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to load platform feedback questionnaire",
    });
  }
};

exports.submitPublicPlatformFeedback = async (req, res) => {
  try {
    const audienceRole = normalizePlatformAudienceRole(
      req.body?.audienceRole || req.body?.role || req.body?.userType || req.body?.reviewerRole
    );
    const reviewType = reviewTypeForPlatformAudience(audienceRole);
    const profile = normalizePublicPlatformProfile(req.body || {}, audienceRole);
    const input = normalizeReviewInput(req.body || {});
    const questionnaireSubmission = input.isQuestionnaireSubmission
      ? buildQuestionnaireSubmission({ reviewType, docs: {}, body: { answers: input.answers, ...input, ...(req.body || {}) } })
      : null;
    const finalInput = questionnaireSubmission?.input ? { ...input, ...questionnaireSubmission.input } : input;
    const sourceEntityId = sanitizeSourceEntityId(req.body?.sourceEntityId) || `${audienceRole}_${crypto.randomUUID()}`;
    const profileResponses = profileResponsesForPlatform(profile, audienceRole);
    const responseMap = {
      ...Object.fromEntries(profileResponses.map((item) => [item.questionKey, item])),
      ...(questionnaireSubmission?.responseMap || {}),
    };

    const review = new CampaignReview({
      reviewType,
      campaignId: null,
      brandId: null,
      influencerId: null,
      reviewerRole: audienceRole,
      revieweeRole: REVIEW_ROLES.PLATFORM,
      reviewerBrandId: null,
      reviewerInfluencerId: null,
      revieweeBrandId: null,
      revieweeInfluencerId: null,
      reviewerSnapshot: {
        role: audienceRole,
        entityId: sourceEntityId,
        name: profile.displayName,
        email: profile.email,
        handle: profile.profileRole,
        image: "",
      },
      revieweeSnapshot: buildSnapshot({ role: REVIEW_ROLES.PLATFORM }),
      platformKey: DEFAULT_PLATFORM_TARGET.key,
      platformName: DEFAULT_PLATFORM_TARGET.name,
      tokenHash: hashToken(makeToken()),
      tokenExpiresAt: parseExpiresAt(180),
      publicUrl: "",
      status: REVIEW_STATUS.SUBMITTED,
      submittedVia: SUBMITTED_VIA.PUBLIC_PLATFORM_PAGE || SUBMITTED_VIA.PUBLIC_LINK,
      sourceEntityType: "platform_feedback",
      sourceEntityId,
      questionnaireVersion: questionnaireSubmission?.questionnaireVersion || QUESTIONNAIRE_VERSION,
      responses: [...profileResponses, ...(questionnaireSubmission?.responses || [])],
      responseMap,
      rating: finalInput.rating,
      noteStarRating: finalInput.noteStarRating,
      reviewTitle: finalInput.reviewTitle || `${profile.displayName}'s CollabGlam platform review`,
      reviewText: finalInput.reviewText,
      privateFeedback: finalInput.privateFeedback,
      tags: finalInput.tags,
      metrics: finalInput.metrics,
      ratings: finalInput.metrics,
      firstSubmittedAt: new Date(),
      submittedAt: new Date(),
      submittedIp: req.ip || "",
      submittedUserAgent: req.headers["user-agent"] || "",
    });

    await review.save();

    return res.status(201).json({
      success: true,
      message: "Platform feedback submitted successfully",
      data: await hydrateReview(await CampaignReview.findById(review._id).populate(REVIEW_POPULATE).lean()),
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || 500, "SUBMIT_PUBLIC_PLATFORM_FEEDBACK_ERROR");
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to submit platform feedback",
    });
  }
};

/* =========================
   QUESTIONNAIRES
========================= */

exports.getReviewQuestionnaires = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: REVIEW_QUESTIONNAIRES,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || 500, "GET_REVIEW_QUESTIONNAIRES_ERROR");
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load review questionnaires",
    });
  }
};

/* =========================
   PUBLIC TOKEN REVIEW
========================= */

exports.getReviewByToken = async (req, res) => {
  try {
    const token = toStringId(req.params.token);

    if (!token) {
      return res.status(400).json({ success: false, message: "Review token is required" });
    }

    const review = await CampaignReview.findOne({ tokenHash: hashToken(token) })
      .select("+tokenHash")
      .populate(REVIEW_POPULATE);

    if (!review) {
      return res.status(404).json({ success: false, message: "Review link not found" });
    }

    if (review.status === REVIEW_STATUS.REVOKED) {
      return res.status(410).json({ success: false, message: "This review link has been revoked" });
    }

    if (review.tokenExpiresAt && review.tokenExpiresAt < new Date()) {
      review.status = REVIEW_STATUS.EXPIRED;
      await review.save();
      return res.status(410).json({ success: false, message: "This review link has expired" });
    }

    return res.status(200).json({
      success: true,
      canUpdate: false,
      canSubmit: [REVIEW_STATUS.PENDING, REVIEW_STATUS.SKIPPED].includes(review.status),
      data: await publicReviewPayload(review),
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || 500, "GET_REVIEW_BY_TOKEN_ERROR");
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
      return res.status(400).json({ success: false, message: "Review token is required" });
    }

    const review = await CampaignReview.findOne({ tokenHash: hashToken(token) }).select("+tokenHash");

    if (!review) {
      return res.status(404).json({ success: false, message: "Review link not found" });
    }

    if (review.status === REVIEW_STATUS.REVOKED) {
      return res.status(410).json({ success: false, message: "This review link has been revoked" });
    }

    if (review.tokenExpiresAt && review.tokenExpiresAt < new Date()) {
      review.status = REVIEW_STATUS.EXPIRED;
      await review.save();
      return res.status(410).json({ success: false, message: "This review link has expired" });
    }

    if (review.status === REVIEW_STATUS.SUBMITTED) {
      return res.status(409).json({
        success: false,
        message: "Review already submitted",
        data: {
          shouldPrompt: false,
          status: REVIEW_STATUS.SUBMITTED,
          reviewId: review._id,
          alreadyHandled: true,
        },
      });
    }

    const docs = await loadReviewDocs({
      campaignId: review.campaignId,
      brandId: review.brandId,
      influencerId: review.influencerId,
      reviewType: review.reviewType,
    });



    const input = normalizeReviewInput(req.body || {});
    await applyReviewSubmissionFields({
      review,
      reviewType: review.reviewType,
      docs,
      input,
      submittedVia: SUBMITTED_VIA.PUBLIC_LINK,
      sourceEntityType: review.sourceEntityType || defaultSourceForReview({ reviewType: review.reviewType, campaignId: review.campaignId }).sourceEntityType,
      sourceEntityId: review.sourceEntityId || defaultSourceForReview({ reviewType: review.reviewType, campaignId: review.campaignId }).sourceEntityId,
      req,
    });

    await review.save();

    const generatedByAdmin = review.generatedByAdminId
      ? await AdminModel.findById(review.generatedByAdminId).select("_id name email role").lean()
      : null;

    if (generatedByAdmin?._id) {
      await notifySafely("review submitted admin notification", {
        adminId: String(generatedByAdmin._id),
        type: "review.submitted",
        title: "Review submitted",
        message: `A ${review.reviewType} review was submitted with ${input.rating}/5.`,
        entityType: "campaign_review",
        entityId: String(review._id),
        actionPath: { admin: `/admin/rating-reviews?reviewId=${review._id}` },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Review submitted successfully",
      data: await hydrateReview(await CampaignReview.findById(review._id).populate(REVIEW_POPULATE).lean()),
    });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to submit review",
    });
  }
};

/* =========================
   ADMIN OPTIONS
========================= */

exports.listAdminReviewOptions = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 300);

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
      .select(CAMPAIGN_PUBLIC_SELECT)
      .sort({ createdAt: -1, updatedAt: -1 })
      .limit(limit)
      .lean();

    const campaignKeyToMongoId = new Map();
    const allCampaignKeys = [];

    for (const campaign of campaigns) {
      const campaignMongoId = String(campaign._id);
      for (const key of buildCampaignKeys(campaign)) {
        campaignKeyToMongoId.set(String(key), campaignMongoId);
        allCampaignKeys.push(String(key));
      }
    }

    const applyRecords = allCampaignKeys.length
      ? await ApplyCampaign.find({ campaignId: { $in: uniqueStrings(allCampaignKeys) } }).lean()
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

    const brandIds = uniqueStrings(campaigns.map((campaign) => campaign.brandId)).filter(isObjectId);
    const influencerIds = uniqueStrings(
      applyRecords.flatMap((record) =>
        getReviewableApplicantsFromApplyRecord(record).map((applicant) => applicant.influencerId)
      )
    ).filter(isObjectId);

    const [brands, influencers, modashByInfluencerId] = await Promise.all([
      brandIds.length
        ? Brand.find({ _id: { $in: brandIds.map(toObjectId) } }).select(BRAND_PUBLIC_SELECT).lean()
        : [],
      influencerIds.length
        ? Influencer.find({ _id: { $in: influencerIds.map(toObjectId) } }).select(INFLUENCER_PUBLIC_SELECT).lean()
        : [],
      findModashProfilesForInfluencers(influencerIds),
    ]);

    const brandById = new Map(brands.map((brand) => [String(brand._id), brand]));
    const influencerById = new Map(influencers.map((influencer) => [String(influencer._id), influencer]));

    const data = campaigns
      .map((campaign) => {
        const campaignMongoId = String(campaign._id);
        const brandId = String(campaign.brandId || "");
        const brandDoc = brandById.get(brandId);
        const records = applyByCampaignMongoId.get(campaignMongoId) || [];
        const reviewableApplicants = records.flatMap((record) => getReviewableApplicantsFromApplyRecord(record));
        const seenInfluencers = new Set();

        const influencersForCampaign = reviewableApplicants
          .map((applicant) => {
            const influencerId = String(applicant.influencerId || "").trim();
            if (!influencerId || !isObjectId(influencerId) || seenInfluencers.has(influencerId)) return null;
            seenInfluencers.add(influencerId);

            const influencerDoc = influencerById.get(influencerId);
            const modashProfile = modashByInfluencerId.get(influencerId);

            return {
              ...influencerPayload(influencerDoc || { _id: influencerId, name: applicant.name }, modashProfile),
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
          brand: brandPayload(brandDoc || { _id: brandId, brandName: campaign.brandName || campaign.companyName }),
          influencers: influencersForCampaign,
        };
      })
      .filter((campaign) => campaign.brand?._id && campaign.influencers.length > 0);

    return res.status(200).json({ success: true, data });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || 500, "LIST_ADMIN_REVIEW_OPTIONS_ERROR");
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load review options",
    });
  }
};

/* =========================
   ADMIN GENERATE LINKS
========================= */

async function findExistingReviewLink(identityQuery) {
  return CampaignReview.findOne({
    ...identityQuery,
    status: { $in: [REVIEW_STATUS.SUBMITTED, REVIEW_STATUS.SKIPPED, REVIEW_STATUS.PENDING] },
  })
    .select("+tokenHash")
    .sort({ submittedAt: -1, createdAt: -1 });
}

async function createSingleReviewLink({ req, reviewType, campaignId, brandId, influencerId, expiresInDays, regenerate }) {
  const type = normalizeReviewType(reviewType);
  const docs = await loadReviewDocs({ campaignId, brandId, influencerId, reviewType: type });
  const contextIds = getContextIdsFromDocs(docs);
  const defaultSource = defaultSourceForReview({ reviewType: type, campaignId: contextIds.campaignId });
  const sourceEntityType = sanitizeSourceEntityType(req.body?.sourceEntityType || defaultSource.sourceEntityType);
  const sourceEntityId = sanitizeSourceEntityId(req.body?.sourceEntityId || defaultSource.sourceEntityId);
  const identityQuery = buildReviewIdentityQuery({
    reviewType: type,
    ...contextIds,
    sourceEntityType,
    sourceEntityId,
  });

  const actor = getActorFromReq(req);
  const rolePayload = buildReviewRolePayload({
    reviewType: type,
    brandId: contextIds.brandId,
    influencerId: contextIds.influencerId,
  });

  let review = await findExistingReviewLink(identityQuery);

  if (review) {
    const isExpired = review.tokenExpiresAt && review.tokenExpiresAt < new Date();
    const shouldRegenerate = regenerate || !String(review.publicUrl || "").trim() || isExpired;

    Object.assign(review, contextIds, rolePayload, {
      sourceEntityType,
      sourceEntityId,
      platformKey: DEFAULT_PLATFORM_TARGET.key,
      platformName: DEFAULT_PLATFORM_TARGET.name,
    });

    if (!shouldRegenerate) {
      await review.save();
      return {
        review,
        publicUrl: review.publicUrl,
        isExistingLink: true,
        regenerated: false,
        isUpdateLink: false,
        isSkippedLink: review.status === REVIEW_STATUS.SKIPPED,
        wasExpired: false,
      };
    }

    const token = makeToken();
    review.tokenHash = hashToken(token);
    review.publicUrl = buildPublicReviewUrl(token);
    review.tokenExpiresAt = parseExpiresAt(expiresInDays);
    await review.save();

    return {
      review,
      publicUrl: review.publicUrl,
      isExistingLink: true,
      regenerated: true,
      isUpdateLink: false,
      isSkippedLink: review.status === REVIEW_STATUS.SKIPPED,
      wasExpired: Boolean(isExpired),
    };
  }

  const token = makeToken();

  review = await CampaignReview.create({
    ...identityQuery,
    ...contextIds,
    ...rolePayload,
    tokenHash: hashToken(token),
    publicUrl: buildPublicReviewUrl(token),
    tokenExpiresAt: parseExpiresAt(expiresInDays),
    sourceEntityType,
    sourceEntityId,
    submittedVia: SUBMITTED_VIA.PUBLIC_LINK,
    platformKey: DEFAULT_PLATFORM_TARGET.key,
    platformName: DEFAULT_PLATFORM_TARGET.name,
    generatedByAdminId: actor.actorAdminId,
    generatedByAdminName: actor.actorName,
    generatedByAdminEmail: actor.actorEmail,
    generatedByAdminRole: actor.actorRole,
  });

  return {
    review,
    publicUrl: review.publicUrl,
    isExistingLink: false,
    regenerated: false,
    isUpdateLink: false,
    isSkippedLink: false,
    wasExpired: false,
  };
}

exports.generateReviewLinks = async (req, res) => {
  try {
    const { campaignId, brandId, influencerId, reviewType, reviewTypes, expiresInDays = 30 } = req.body || {};
    const regenerate = booleanFromBody(req.body?.regenerate) || booleanFromBody(req.body?.forceRegenerate);

    const requestedTypes = Array.isArray(reviewTypes)
      ? reviewTypes.map(normalizeReviewType).filter(Boolean)
      : reviewType
        ? [normalizeReviewType(reviewType)]
        : [REVIEW_TYPES.BRAND_TO_INFLUENCER, REVIEW_TYPES.INFLUENCER_TO_BRAND];

    const uniqueTypes = [...new Set(requestedTypes)];

    if (!uniqueTypes.length) {
      return res.status(400).json({
        success: false,
        message:
          "reviewType must be brand_to_influencer, influencer_to_brand, brand_to_platform, or influencer_to_platform",
      });
    }

    const results = [];

    for (const type of uniqueTypes) {
      const result = await createSingleReviewLink({
        req,
        reviewType: type,
        campaignId,
        brandId,
        influencerId,
        expiresInDays,
        regenerate,
      });

      results.push({
        _id: result.review._id,
        reviewRequestId: result.review.reviewRequestId,
        reviewType: result.review.reviewType,
        reviewerRole: result.review.reviewerRole,
        revieweeRole: result.review.revieweeRole,
        publicUrl: result.publicUrl,
        expiresAt: result.review.tokenExpiresAt,
        isExistingLink: result.isExistingLink,
        regenerated: result.regenerated,
        isUpdateLink: result.isUpdateLink,
        isSkippedLink: result.isSkippedLink,
        wasExpired: result.wasExpired,
      });
    }

    const hasRegenerated = results.some((item) => item.regenerated);
    const allExisting = results.every((item) => item.isExistingLink);

    return res.status(200).json({
      success: true,
      message: hasRegenerated
        ? "Review link regenerated successfully"
        : allExisting
          ? "Existing review link returned"
          : "Review link generated successfully",
      data: results,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || 500, "GENERATE_REVIEW_LINKS_ERROR");
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to generate review link",
    });
  }
};


function reviewLinkPayload(review = {}) {
  return {
    _id: review._id,
    reviewRequestId: review.reviewRequestId,
    reviewType: review.reviewType,
    reviewerRole: review.reviewerRole,
    revieweeRole: review.revieweeRole,
    publicUrl: review.publicUrl || "",
    expiresAt: review.tokenExpiresAt,
    isExistingLink: true,
    regenerated: false,
    isUpdateLink: false,
    isSkippedLink: review.status === REVIEW_STATUS.SKIPPED,
    wasExpired: Boolean(review.tokenExpiresAt && review.tokenExpiresAt < new Date()),
  };
}

exports.listAdminReviewLinks = async (req, res) => {
  try {
    const { campaignId, brandId, influencerId, influencerIds, reviewType, reviewTypes } = req.query || {};

    if (!isObjectId(campaignId)) {
      return res.status(400).json({
        success: false,
        message: "Valid campaignId is required",
      });
    }

    const query = {
      campaignId: toObjectId(campaignId),
      reviewType: { $in: [REVIEW_TYPES.BRAND_TO_INFLUENCER, REVIEW_TYPES.INFLUENCER_TO_BRAND] },
      status: { $in: [REVIEW_STATUS.SUBMITTED, REVIEW_STATUS.SKIPPED, REVIEW_STATUS.PENDING] },
      publicUrl: { $nin: ["", null] },
    };

    if (isObjectId(brandId)) {
      query.brandId = toObjectId(brandId);
    }

    const requestedTypes = Array.isArray(reviewTypes)
      ? reviewTypes
      : String(reviewTypes || reviewType || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    const validTypes = uniqueStrings(requestedTypes.map(normalizeReviewType)).filter(isCampaignPairReviewType);
    if (validTypes.length) {
      query.reviewType = { $in: validTypes };
    }

    const requestedInfluencerIds = uniqueStrings(
      [
        ...(Array.isArray(influencerIds) ? influencerIds : String(influencerIds || "").split(",")),
        influencerId,
      ]
    ).filter(isObjectId);

    if (requestedInfluencerIds.length) {
      query.influencerId = { $in: requestedInfluencerIds.map(toObjectId) };
    }

    const rows = await CampaignReview.find(query)
      .populate(REVIEW_POPULATE)
      .sort({ createdAt: -1, tokenExpiresAt: -1 })
      .lean();

    const grouped = new Map();

    for (const review of rows) {
      const influencerDoc = review.influencerId || review.reviewerInfluencerId || review.revieweeInfluencerId || null;
      const influencerKey = toStringId(influencerDoc?._id || influencerDoc);

      if (!influencerKey) continue;

      const existing = grouped.get(influencerKey) || {
        influencerId: influencerKey,
        influencerName: getInfluencerName(influencerDoc || {}, "Influencer"),
        createdAt: review.createdAt || review.updatedAt || new Date(),
        links: [],
      };

      const link = reviewLinkPayload(review);
      const alreadyAt = existing.links.findIndex((item) => item.reviewType === link.reviewType);

      if (alreadyAt >= 0) {
        existing.links[alreadyAt] = link;
      } else {
        existing.links.push(link);
      }

      if (new Date(review.createdAt || 0).getTime() > new Date(existing.createdAt || 0).getTime()) {
        existing.createdAt = review.createdAt;
      }

      grouped.set(influencerKey, existing);
    }

    const data = Array.from(grouped.values()).map((group) => ({
      ...group,
      links: group.links.sort(
        (a, b) =>
          [REVIEW_TYPES.BRAND_TO_INFLUENCER, REVIEW_TYPES.INFLUENCER_TO_BRAND].indexOf(a.reviewType) -
          [REVIEW_TYPES.BRAND_TO_INFLUENCER, REVIEW_TYPES.INFLUENCER_TO_BRAND].indexOf(b.reviewType)
      ),
    }));

    return res.status(200).json({
      success: true,
      message: "Existing review links loaded",
      total: data.length,
      data,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || 500, "LIST_ADMIN_REVIEW_LINKS_ERROR");
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to load review links",
    });
  }
};

/* =========================
   ADMIN RAW LIST / REVOKE
========================= */

function buildAdminListQuery(queryParams = {}) {
  const query = {};

  if (isObjectId(queryParams.reviewId)) query._id = toObjectId(queryParams.reviewId);
  if (isObjectId(queryParams.campaignId)) query.campaignId = toObjectId(queryParams.campaignId);
  if (isObjectId(queryParams.brandId)) query.brandId = toObjectId(queryParams.brandId);
  if (isObjectId(queryParams.influencerId)) query.influencerId = toObjectId(queryParams.influencerId);

  const type = normalizeReviewType(queryParams.reviewType);
  if (type) query.reviewType = type;

  if (Object.values(REVIEW_STATUS).includes(String(queryParams.status))) {
    query.status = String(queryParams.status);
  }

  if (Object.values(SUBMITTED_VIA).includes(String(queryParams.submittedVia))) {
    query.submittedVia = String(queryParams.submittedVia);
  }

  if ([REVIEW_ROLES.BRAND, REVIEW_ROLES.INFLUENCER, REVIEW_ROLES.PLATFORM].includes(String(queryParams.revieweeRole))) {
    query.revieweeRole = String(queryParams.revieweeRole);
  }

  if ([REVIEW_ROLES.BRAND, REVIEW_ROLES.INFLUENCER].includes(String(queryParams.reviewerRole))) {
    query.reviewerRole = String(queryParams.reviewerRole);
  }

  if (queryParams.sourceEntityType) query.sourceEntityType = sanitizeSourceEntityType(queryParams.sourceEntityType);
  if (queryParams.sourceEntityId) query.sourceEntityId = String(queryParams.sourceEntityId);

  if (queryParams.search) {
    const rx = new RegExp(escapeRegex(queryParams.search), "i");
    query.$or = [{ reviewTitle: rx }, { reviewText: rx }, { tags: rx }];
  }

  return query;
}

exports.listAdminReviews = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
    const query = buildAdminListQuery(req.query);

    const [rows, total] = await Promise.all([
      CampaignReview.find(query)
        .populate(REVIEW_POPULATE)
        .sort({ submittedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CampaignReview.countDocuments(query),
    ]);

    const data = [];
    for (const row of rows) data.push(await hydrateReview(row));

    return res.status(200).json({ success: true, data, total, page, limit });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || 500, "LIST_ADMIN_REVIEWS_ERROR");
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to list reviews",
    });
  }
};

exports.revokeReviewLink = async (req, res) => {
  try {
    const reviewId = toStringId(req.params.id);
    if (!isObjectId(reviewId)) throw httpError("Valid review id is required", 400);

    const actor = getActorFromReq(req);
    const review = await CampaignReview.findById(reviewId);

    if (!review) throw httpError("Review request not found", 404);

    if (review.status !== REVIEW_STATUS.PENDING) {
      throw httpError("Only pending review links can be revoked", 400);
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
    await saveErrorLog(req, error, error?.statusCode || 500, "REVOKE_REVIEW_LINK_ERROR");
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to revoke review link",
    });
  }
};

/* =========================
   SUMMARY
========================= */

async function getAggregateSummary(match) {
  const [summary] = await CampaignReview.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalReviews: { $sum: 1 },
        averageRating: { $avg: "$rating" },
        workQuality: { $avg: "$metrics.workQuality" },
        communication: { $avg: "$metrics.communication" },
        timeliness: { $avg: "$metrics.timeliness" },
        professionalism: { $avg: "$metrics.professionalism" },
        valueForMoney: { $avg: "$metrics.valueForMoney" },
        platformExperience: { $avg: "$metrics.platformExperience" },
        supportExperience: { $avg: "$metrics.supportExperience" },
        wouldRecommend: { $avg: "$metrics.wouldRecommend" },
        fiveStar: { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
        fourStar: { $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] } },
        threeStar: { $sum: { $cond: [{ $eq: ["$rating", 3] }, 1, 0] } },
        twoStar: { $sum: { $cond: [{ $eq: ["$rating", 2] }, 1, 0] } },
        oneStar: { $sum: { $cond: [{ $eq: ["$rating", 1] }, 1, 0] } },
      },
    },
  ]);

  return {
    totalReviews: summary?.totalReviews || 0,
    averageRating: round2(summary?.averageRating),
    metrics: {
      workQuality: round2(summary?.workQuality),
      communication: round2(summary?.communication),
      timeliness: round2(summary?.timeliness),
      professionalism: round2(summary?.professionalism),
      valueForMoney: round2(summary?.valueForMoney),
      platformExperience: round2(summary?.platformExperience),
      supportExperience: round2(summary?.supportExperience),
      wouldRecommend: round2(summary?.wouldRecommend),
    },
    distribution: {
      5: summary?.fiveStar || 0,
      4: summary?.fourStar || 0,
      3: summary?.threeStar || 0,
      2: summary?.twoStar || 0,
      1: summary?.oneStar || 0,
    },
  };
}

exports.getReviewSummary = async (req, res) => {
  try {
    const targetType = String(req.query.targetType || "").trim().toLowerCase();
    const targetId = toStringId(req.query.targetId);

    let match = { status: REVIEW_STATUS.SUBMITTED };

    if (targetType === "brand") {
      if (!isObjectId(targetId)) throw httpError("Valid targetId is required", 400);
      match.revieweeRole = REVIEW_ROLES.BRAND;
      match.revieweeBrandId = toObjectId(targetId);
    } else if (targetType === "influencer") {
      if (!isObjectId(targetId)) throw httpError("Valid targetId is required", 400);
      match.revieweeRole = REVIEW_ROLES.INFLUENCER;
      match.revieweeInfluencerId = toObjectId(targetId);
    } else if (targetType === "campaign") {
      if (!isObjectId(targetId)) throw httpError("Valid targetId is required", 400);
      match.campaignId = toObjectId(targetId);
      match.reviewType = { $in: [REVIEW_TYPES.BRAND_TO_INFLUENCER, REVIEW_TYPES.INFLUENCER_TO_BRAND] };
    } else if (targetType === "platform") {
      match.revieweeRole = REVIEW_ROLES.PLATFORM;
      match.platformKey = DEFAULT_PLATFORM_TARGET.key;
    } else {
      throw httpError("targetType must be brand, influencer, campaign, or platform", 400);
    }

    const [summary, reviews] = await Promise.all([
      getAggregateSummary(match),
      CampaignReview.find(match)
        .populate(REVIEW_POPULATE)
        .sort({ submittedAt: -1, createdAt: -1 })
        .limit(20)
        .lean(),
    ]);

    const hydratedReviews = [];
    for (const review of reviews) hydratedReviews.push(await hydrateReview(review));

    return res.status(200).json({
      success: true,
      data: {
        targetType,
        targetId: targetType === "platform" ? DEFAULT_PLATFORM_TARGET.key : targetId,
        ...summary,
        reviews: hydratedReviews,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || 500, "GET_REVIEW_SUMMARY_ERROR");
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to load review summary",
    });
  }
};

/* =========================
   ADMIN 4-TAB PAGE API
========================= */

function buildSubmittedPageMatch(queryParams = {}) {
  const match = { status: REVIEW_STATUS.SUBMITTED };

  if (isObjectId(queryParams.campaignId)) match.campaignId = toObjectId(queryParams.campaignId);
  if (isObjectId(queryParams.brandId)) match.brandId = toObjectId(queryParams.brandId);
  if (isObjectId(queryParams.influencerId)) match.influencerId = toObjectId(queryParams.influencerId);

  const type = normalizeReviewType(queryParams.reviewType);
  if (type) match.reviewType = type;

  const rating = optionalRating(queryParams.rating);
  if (rating) match.rating = rating;

  if (queryParams.search) {
    const rx = new RegExp(escapeRegex(queryParams.search), "i");
    match.$or = [{ reviewTitle: rx }, { reviewText: rx }, { tags: rx }];
  }

  if (queryParams.from || queryParams.to) {
    match.submittedAt = {};
    if (queryParams.from) match.submittedAt.$gte = new Date(queryParams.from);
    if (queryParams.to) match.submittedAt.$lte = new Date(queryParams.to);
  }

  return match;
}

async function fetchEntityDocs({ tab, ids }) {
  const objectIds = uniqueStrings(ids).filter(isObjectId).map(toObjectId);
  if (!objectIds.length) return new Map();

  if (tab === REVIEW_TARGET_TABS.BRAND) {
    const rows = await Brand.find({ _id: { $in: objectIds } }).select(BRAND_PUBLIC_SELECT).lean();
    return new Map(rows.map((row) => [String(row._id), brandPayload(row)]));
  }

  if (tab === REVIEW_TARGET_TABS.INFLUENCER) {
    const rows = await Influencer.find({ _id: { $in: objectIds } }).select(INFLUENCER_PUBLIC_SELECT).lean();
    const modashByInfluencerId = await findModashProfilesForInfluencers(rows.map((row) => row._id));
    return new Map(
      rows.map((row) => [String(row._id), influencerPayload(row, modashByInfluencerId.get(String(row._id)))])
    );
  }

  if (tab === REVIEW_TARGET_TABS.CAMPAIGN) {
    const rows = await Campaign.find({ _id: { $in: objectIds } }).select(CAMPAIGN_PUBLIC_SELECT).lean();
    return new Map(rows.map((row) => [String(row._id), campaignPayload(row)]));
  }

  return new Map();
}

async function groupedRatingTab({ tab, baseMatch, page, limit }) {
  const groupFieldByTab = {
    [REVIEW_TARGET_TABS.BRAND]: "revieweeBrandId",
    [REVIEW_TARGET_TABS.INFLUENCER]: "revieweeInfluencerId",
    [REVIEW_TARGET_TABS.CAMPAIGN]: "campaignId",
  };

  const fieldName = groupFieldByTab[tab];
  if (!fieldName) throw httpError("Invalid grouped tab", 400);

  const tabMatch = { ...baseMatch };

  if (tab === REVIEW_TARGET_TABS.BRAND) {
    tabMatch.revieweeRole = REVIEW_ROLES.BRAND;
    tabMatch.revieweeBrandId = { $ne: null };
  }

  if (tab === REVIEW_TARGET_TABS.INFLUENCER) {
    tabMatch.revieweeRole = REVIEW_ROLES.INFLUENCER;
    tabMatch.revieweeInfluencerId = { $ne: null };
  }

  if (tab === REVIEW_TARGET_TABS.CAMPAIGN) {
    tabMatch.campaignId = { $ne: null };
    tabMatch.reviewType = { $in: [REVIEW_TYPES.BRAND_TO_INFLUENCER, REVIEW_TYPES.INFLUENCER_TO_BRAND] };
  }

  const [summary, result] = await Promise.all([
    getAggregateSummary(tabMatch),
    CampaignReview.aggregate([
      { $match: tabMatch },
      { $sort: { submittedAt: -1, createdAt: -1 } },
      {
        $group: {
          _id: `$${fieldName}`,
          totalReviews: { $sum: 1 },
          averageRating: { $avg: "$rating" },
          latestSubmittedAt: { $max: "$submittedAt" },
          latestReview: {
            $first: {
              _id: "$_id",
              reviewType: "$reviewType",
              reviewerRole: "$reviewerRole",
              revieweeRole: "$revieweeRole",
              rating: "$rating",
              reviewTitle: "$reviewTitle",
              reviewText: "$reviewText",
              tags: "$tags",
              submittedAt: "$submittedAt",
              reviewer: "$reviewerSnapshot",
              reviewee: "$revieweeSnapshot",
            },
          },
        },
      },
      { $sort: { latestSubmittedAt: -1 } },
      {
        $facet: {
          items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
          totalGroups: [{ $count: "count" }],
        },
      },
    ]),
  ]);

  const facet = result?.[0] || { items: [], totalGroups: [] };
  const totalGroups = facet.totalGroups?.[0]?.count || 0;
  const entityMap = await fetchEntityDocs({ tab, ids: facet.items.map((item) => item._id) });

  const items = facet.items.map((item) => ({
    _id: item._id,
    entity: entityMap.get(String(item._id)) || { _id: item._id },
    totalReviews: item.totalReviews || 0,
    averageRating: round2(item.averageRating),
    latestSubmittedAt: item.latestSubmittedAt,
    latestReview: item.latestReview || null,
  }));

  return {
    tab,
    page,
    limit,
    totalGroups,
    summary,
    items,
  };
}

async function platformRatingTab({ baseMatch, page, limit }) {
  const tabMatch = {
    ...baseMatch,
    revieweeRole: REVIEW_ROLES.PLATFORM,
    platformKey: DEFAULT_PLATFORM_TARGET.key,
  };

  const [summary, reviewerBreakdown, rows, total] = await Promise.all([
    getAggregateSummary(tabMatch),
    CampaignReview.aggregate([
      { $match: tabMatch },
      {
        $group: {
          _id: "$reviewerRole",
          totalReviews: { $sum: 1 },
          averageRating: { $avg: "$rating" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    CampaignReview.find(tabMatch)
      .populate(REVIEW_POPULATE)
      .sort({ submittedAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CampaignReview.countDocuments(tabMatch),
  ]);

  const reviews = [];
  for (const row of rows) reviews.push(await hydrateReview(row));

  return {
    tab: REVIEW_TARGET_TABS.PLATFORM,
    page,
    limit,
    total,
    platform: platformPayload(),
    summary,
    reviewerBreakdown: reviewerBreakdown.map((item) => ({
      reviewerRole: item._id,
      totalReviews: item.totalReviews || 0,
      averageRating: round2(item.averageRating),
    })),
    reviews,
  };
}

exports.getAdminReviewPage = async (req, res) => {
  try {
    const tab = String(req.query.tab || REVIEW_TARGET_TABS.ALL).trim().toLowerCase();
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 50);
    const baseMatch = buildSubmittedPageMatch(req.query);

    const allowedTabs = Object.values(REVIEW_TARGET_TABS);
    if (!allowedTabs.includes(tab)) {
      throw httpError("tab must be brand, influencer, campaign, platform, or all", 400);
    }

    const buildTab = async (tabName) => {
      if (tabName === REVIEW_TARGET_TABS.PLATFORM) {
        return platformRatingTab({ baseMatch, page, limit });
      }
      return groupedRatingTab({ tab: tabName, baseMatch, page, limit });
    };

    if (tab !== REVIEW_TARGET_TABS.ALL) {
      const selected = await buildTab(tab);
      return res.status(200).json({
        success: true,
        data: {
          activeTab: tab,
          tabs: { [tab]: selected },
        },
      });
    }

    const [brand, influencer, campaign, platform] = await Promise.all([
      buildTab(REVIEW_TARGET_TABS.BRAND),
      buildTab(REVIEW_TARGET_TABS.INFLUENCER),
      buildTab(REVIEW_TARGET_TABS.CAMPAIGN),
      buildTab(REVIEW_TARGET_TABS.PLATFORM),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        activeTab: REVIEW_TARGET_TABS.ALL,
        tabs: {
          brand,
          influencer,
          campaign,
          platform,
        },
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || 500, "GET_ADMIN_REVIEW_PAGE_ERROR");
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to load review page",
    });
  }
};