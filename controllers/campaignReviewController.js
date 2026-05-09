const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  CampaignReview,
  REVIEW_TYPES,
  REVIEW_STATUS,
  SUBMITTED_VIA,
  ANSWER_TYPES,
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

const BRAND_PUBLIC_SELECT =
  "brandName name companyName email profilePic logo image avatar profileImage brandLogo picture page1 page2 page3";

const INFLUENCER_PUBLIC_SELECT =
  "name fullName influencerName username email handle image avatar profileImage profilePicture profilePic picture page1 page2 page3";

const CAMPAIGN_PUBLIC_SELECT =
  "campaignTitle productOrServiceName title name brandId brandName companyName campaignsId campaignId status isActive";

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

function optionalRatingValue(value) {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    Number(value) === 0
  ) {
    return null;
  }

  return ratingValue(value);
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

function replaceTemplateVars(value = "", context = {}) {
  return String(value || "")
    .replace(/\{\{brandName\}\}/g, context.brandName || "Brand")
    .replace(/\{\{influencerName\}\}/g, context.influencerName || "Influencer")
    .replace(/\{\{campaignName\}\}/g, context.campaignName || "Campaign");
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

/* =========================
   AVATAR / IMAGE HELPERS
========================= */

function pickFirstNonEmptyString(...values) {
  return (
    values
      .map((value) => String(value || "").trim())
      .find(Boolean) || ""
  );
}

function looksLikeImageUrl(value = "") {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^data:image\//i.test(text)) return true;
  if (!/^https?:\/\//i.test(text)) return false;

  return (
    /\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i.test(text) ||
    /cloudinary|amazonaws|googleusercontent|fbcdn|instagram|cdn|images|media/i.test(text)
  );
}

function findImageInMixed(value, depth = 0) {
  if (!value || depth > 5) return "";

  if (typeof value === "string") {
    return looksLikeImageUrl(value) ? value.trim() : "";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageInMixed(item, depth + 1);
      if (found) return found;
    }
    return "";
  }

  if (typeof value === "object") {
    const direct = pickFirstNonEmptyString(
      value.profilePic,
      value.profile_pic,
      value.profilePicture,
      value.profile_picture,
      value.profileImage,
      value.profile_image,
      value.avatar,
      value.image,
      value.picture,
      value.photo,
      value.logo,
      value.brandLogo,
      value.brand_logo,
      value.url
    );

    if (looksLikeImageUrl(direct)) return direct;

    for (const nested of Object.values(value)) {
      const found = findImageInMixed(nested, depth + 1);
      if (found) return found;
    }
  }

  return "";
}

function getBrandAvatar(brand = {}) {
  return pickFirstNonEmptyString(
    brand.profilePic,
    brand.logo,
    brand.brandLogo,
    brand.image,
    brand.avatar,
    brand.profileImage,
    brand.picture,
    findImageInMixed(brand.page1),
    findImageInMixed(brand.page2),
    findImageInMixed(brand.page3)
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
    findImageInMixed(influencer.page1),
    findImageInMixed(influencer.page2),
    findImageInMixed(influencer.page3),
    modashProfile?.picture
  );
}

async function findInfluencerModashProfile(influencerId) {
  if (!influencerId) return null;

  const id = String(influencerId?._id || influencerId || "").trim();
  if (!id) return null;

  const query = {
    $or: [{ influencerId: id }],
    picture: { $nin: ["", null] },
  };

  if (isObjectId(id)) {
    query.$or.push({ influencer: toObjectId(id) });
  }

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
    const keys = uniqueStrings([row.influencerId, row.influencer]);

    for (const key of keys) {
      if (!map.has(key)) {
        map.set(key, row);
      }
    }
  }

  return map;
}

function brandAvatarPayload(brand = {}) {
  const avatar = getBrandAvatar(brand);

  return {
    profilePic: avatar,
    logo: avatar,
    image: avatar,
    avatar,
    profileImage: avatar,
    brandLogo: avatar,
    picture: avatar,
  };
}

function influencerAvatarPayload(influencer = {}, modashProfile = null) {
  const avatar = getInfluencerAvatar(influencer, modashProfile);

  return {
    image: avatar,
    avatar,
    profileImage: avatar,
    profilePicture: avatar,
    profilePic: avatar,
    picture: avatar,
  };
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
  if (Number(applicant.isAccepted || 0) === 1) return true;
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
      rows.push({ ...item, fromApprovedArray: true });
    }
  }

  for (const item of applicants) {
    if (isReviewableApplicant(item, false)) {
      rows.push({ ...item, fromApprovedArray: false });
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
   QUESTIONNAIRE HELPERS
========================= */

function getQuestionnaireTemplate(reviewType) {
  const type = normalizeReviewType(reviewType);
  return REVIEW_QUESTIONNAIRES[type] || null;
}

function hydrateQuestionnaire(reviewType, context = {}) {
  const template = getQuestionnaireTemplate(reviewType);
  if (!template) return null;

  return {
    ...template,
    title: replaceTemplateVars(template.title, context),
    description: replaceTemplateVars(template.description, context),
    questions: template.questions.map((question) => ({
      ...question,
      label: replaceTemplateVars(question.label, context),
      description: replaceTemplateVars(question.description || "", context),
      placeholder: replaceTemplateVars(question.placeholder || "", context),
      noteStarRating: question.noteStarRating
        ? {
            ...question.noteStarRating,
            label: replaceTemplateVars(question.noteStarRating.label || "", context),
            options: Array.isArray(question.noteStarRating.options)
              ? question.noteStarRating.options
              : [],
          }
        : undefined,
      options: Array.isArray(question.options)
        ? question.options.map((option) => ({
            ...option,
            label: replaceTemplateVars(option.label, context),
          }))
        : [],
    })),
  };
}

function getOptionByValue(question, value) {
  if (!question || !Array.isArray(question.options)) return null;

  return (
    question.options.find((option) => String(option.value) === String(value)) ||
    null
  );
}

function getNoteStarConfig(template = {}) {
  const noteQuestion = (template.questions || []).find(
    (question) => question.key === "note" && question.noteStarRating?.enabled
  );

  if (!noteQuestion) return null;

  return {
    noteQuestion,
    config: noteQuestion.noteStarRating,
  };
}

function validateNoteStarRating({ template, questionnaire, input }) {
  const noteStarMeta = getNoteStarConfig(template);
  if (!noteStarMeta) return null;

  const { noteQuestion, config } = noteStarMeta;
  const key = config.key || "note_star_rating";
  const rawValue = input[key];

  const isEmpty =
    rawValue === undefined ||
    rawValue === null ||
    rawValue === "" ||
    Number(rawValue) === 0;

  if (config.required && isEmpty) {
    const error = new Error(`${config.label || "Overall note rating"} is required`);
    error.statusCode = 400;
    throw error;
  }

  if (isEmpty) return null;

  const score = ratingValue(rawValue);

  if (!score) {
    const error = new Error(
      `${config.label || "Overall note rating"} must be between 1 and 5`
    );
    error.statusCode = 400;
    throw error;
  }

  const hydratedNoteQuestion = questionnaire.questions.find(
    (question) => question.key === noteQuestion.key
  );

  const option =
    Array.isArray(config.options) &&
    config.options.find((item) => String(item.value) === String(score));

  return {
    questionKey: key,
    questionLabel:
      config.label ||
      hydratedNoteQuestion?.noteStarRating?.label ||
      "Overall note rating",
    answerType: ANSWER_TYPES.STAR_RATING,
    value: score,
    displayValue: option?.label || `${score} star${score === 1 ? "" : "s"}`,
    score,
  };
}

function getNoteStarRatingFromResponseMap(responseMap = {}) {
  const value =
    responseMap?.note_star_rating?.score ??
    responseMap?.note_star_rating?.value;

  return optionalRatingValue(value);
}

function normalizeAnswerInput(body = {}) {
  const src =
    body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
      ? body.answers
      : body;

  return {
    ...src,

    working_feel_rating:
      src.working_feel_rating ??
      src.workingFeelRating ??
      src.rating ??
      src.overallRating,

    reliability:
      src.reliability ??
      src.creatorReliability ??
      src.brand_communication ??
      src.brandCommunication ??
      src.collaboration_support ??
      src.collaborationSupport,

    content_vision_match:
      src.content_vision_match ??
      src.contentVisionMatch ??
      src.visionMatch ??
      src.brief_clarity ??
      src.briefClarity,

    standout_qualities:
      src.standout_qualities ??
      src.standoutQualities ??
      src.tags,

    note:
      src.note ??
      src.reviewText ??
      src.privateFeedback,

    note_star_rating:
      src.note_star_rating ??
      src.noteStarRating ??
      src.noteRating ??
      src.finalRating,
  };
}

function validateReviewAnswers({ reviewType, body, context = {} }) {
  const questionnaire = hydrateQuestionnaire(reviewType, context);
  const template = getQuestionnaireTemplate(reviewType);

  if (!questionnaire || !template) {
    const error = new Error("Invalid review type");
    error.statusCode = 400;
    throw error;
  }

  const input = normalizeAnswerInput(body);
  const responses = [];
  const responseMap = {};

  for (const question of template.questions) {
    const hydratedQuestion = questionnaire.questions.find(
      (item) => item.key === question.key
    );

    const rawValue = input[question.key];
    const isEmpty =
      rawValue === undefined ||
      rawValue === null ||
      rawValue === "" ||
      Number(rawValue) === 0 ||
      (Array.isArray(rawValue) && rawValue.length === 0);

    if (question.required && isEmpty) {
      const error = new Error(`${hydratedQuestion.label} is required`);
      error.statusCode = 400;
      throw error;
    }

    if (!question.required && isEmpty) {
      continue;
    }

    if (question.type === ANSWER_TYPES.EMOJI_RATING) {
      const score = ratingValue(rawValue);

      if (!score) {
        const error = new Error(`${hydratedQuestion.label} must be between 1 and 5`);
        error.statusCode = 400;
        throw error;
      }

      const option = getOptionByValue(question, score);

      const answer = {
        questionKey: question.key,
        questionLabel: hydratedQuestion.label,
        answerType: question.type,
        value: score,
        displayValue: option
          ? `${option.emoji || ""} ${option.label || ""}`.trim()
          : String(score),
        score,
      };

      responses.push(answer);
      responseMap[question.key] = answer;
      continue;
    }

    if (question.type === ANSWER_TYPES.SINGLE_SELECT) {
      const option = getOptionByValue(question, rawValue);

      if (!option) {
        const error = new Error(`${hydratedQuestion.label} has an invalid option`);
        error.statusCode = 400;
        throw error;
      }

      const answer = {
        questionKey: question.key,
        questionLabel: hydratedQuestion.label,
        answerType: question.type,
        value: option.value,
        displayValue: option.label,
        score: option.score || null,
      };

      responses.push(answer);
      responseMap[question.key] = answer;
      continue;
    }

    if (question.type === ANSWER_TYPES.MULTI_SELECT) {
      const list = Array.isArray(rawValue)
        ? rawValue
        : String(rawValue || "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);

      const uniqueValues = uniqueStrings(list);
      const invalid = uniqueValues.find((value) => !getOptionByValue(question, value));

      if (invalid) {
        const error = new Error(`${hydratedQuestion.label} has an invalid option`);
        error.statusCode = 400;
        throw error;
      }

      const selectedOptions = uniqueValues.map((value) =>
        getOptionByValue(question, value)
      );

      const answer = {
        questionKey: question.key,
        questionLabel: hydratedQuestion.label,
        answerType: question.type,
        value: selectedOptions.map((option) => option.value),
        displayValue: selectedOptions.map((option) => option.label),
        score: null,
      };

      responses.push(answer);
      responseMap[question.key] = answer;
      continue;
    }

    if (question.type === ANSWER_TYPES.TEXT) {
      const text = String(rawValue || "").trim();
      const maxLength = Number(question.maxLength || 3000);

      if (text.length > maxLength) {
        const error = new Error(
          `${hydratedQuestion.label} cannot exceed ${maxLength} characters`
        );
        error.statusCode = 400;
        throw error;
      }

      const answer = {
        questionKey: question.key,
        questionLabel: hydratedQuestion.label,
        answerType: question.type,
        value: text,
        displayValue: text,
        score: null,
      };

      responses.push(answer);
      responseMap[question.key] = answer;
    }
  }

  const noteStarAnswer = validateNoteStarRating({
    template,
    questionnaire,
    input,
  });

  if (noteStarAnswer) {
    responses.push(noteStarAnswer);
    responseMap[noteStarAnswer.questionKey] = noteStarAnswer;
    input.note_star_rating = noteStarAnswer.value;
  }

  return {
    questionnaire,
    responses,
    responseMap,
    input,
  };
}

function answerScore(responseMap, key) {
  const value = responseMap?.[key]?.score;
  const number = Number(value);

  if (!Number.isFinite(number)) return null;
  if (number < 1 || number > 5) return null;

  return Math.round(number);
}

function answerValue(responseMap, key, fallback = null) {
  if (!responseMap || !responseMap[key]) return fallback;
  return responseMap[key].value ?? fallback;
}

function buildLegacyReviewFields({ reviewType, responseMap, brandName, influencerName }) {
  const overallRating = answerScore(responseMap, "working_feel_rating");
  const note = String(answerValue(responseMap, "note", "") || "").trim();
  const standoutQualities = Array.isArray(
    answerValue(responseMap, "standout_qualities", [])
  )
    ? answerValue(responseMap, "standout_qualities", [])
    : [];

  const base = {
    rating: overallRating,
    ratings: {
      workQuality: answerScore(responseMap, "content_vision_match"),
      communication: answerScore(responseMap, "reliability"),
      timeliness: answerScore(responseMap, "reliability"),
      professionalism: answerScore(responseMap, "reliability"),
      wouldRecommend: overallRating,
    },
    reviewText: note,
    privateFeedback: note,
    tags: standoutQualities,
  };

  if (reviewType === REVIEW_TYPES.BRAND_TO_INFLUENCER) {
    return {
      ...base,
      reviewTitle: `Review for ${influencerName}`,
    };
  }

  return {
    ...base,
    reviewTitle: `Review for ${brandName}`,
  };
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
    Campaign.findById(campaignId).select(CAMPAIGN_PUBLIC_SELECT).lean(),
    Brand.findById(brandId).select(BRAND_PUBLIC_SELECT).lean(),
    Influencer.findById(influencerId).select(INFLUENCER_PUBLIC_SELECT).lean(),
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
  allowMissingApplyRecord = false,
}) {
  const campaignBrandId = String(campaign.brandId || "").trim();
  const brandId = String(brand._id || "").trim();
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

  if (!isReviewable && !allowMissingApplyRecord) {
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
  const modashProfile = docs.modashProfile || null;

  const campaignName = getCampaignName(campaign);
  const brandName = getBrandName(brand);
  const influencerName = getInfluencerName(influencer);
  const brandAvatar = brandAvatarPayload(brand);
  const influencerAvatar = influencerAvatarPayload(influencer, modashProfile);

  return {
    _id: review._id,
    reviewRequestId: review.reviewRequestId,
    reviewType: review.reviewType,
    reviewerRole: review.reviewerRole,
    revieweeRole: review.revieweeRole,
    status: review.status,
    questionnaireVersion: review.questionnaireVersion || QUESTIONNAIRE_VERSION,
    tokenExpiresAt: review.tokenExpiresAt,
    sourceEntityType: review.sourceEntityType || null,
    sourceEntityId: review.sourceEntityId || null,
    submittedVia: review.submittedVia || SUBMITTED_VIA.PUBLIC_LINK,
    firstSubmittedAt: review.firstSubmittedAt,
    submittedAt: review.submittedAt,
    reviewUpdatedAt: review.reviewUpdatedAt,
    reviewUpdateCount: review.reviewUpdateCount || 0,
    skippedAt: review.skippedAt || null,
    skippedVia: review.skippedVia || null,
    skipReason: review.skipReason || "",

    rating: review.rating,
    noteStarRating: review.noteStarRating,
    responses: review.responses || [],
    responseMap: review.responseMap || {},

    campaign: {
      _id: campaign?._id || "",
      name: campaignName,
    },

    brand: {
      _id: brand?._id || "",
      name: brandName,
      email: brand?.email || "",
      ...brandAvatar,
    },

    influencer: {
      _id: influencer?._id || "",
      name: influencerName,
      email: influencer?.email || "",
      handle: influencer?.handle || influencer?.username || "",
      ...influencerAvatar,
    },

    questionnaire: hydrateQuestionnaire(review.reviewType, {
      campaignName,
      brandName,
      influencerName,
    }),
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

function applyReviewSubmissionFields({
  review,
  reviewType,
  responses,
  responseMap,
  legacy,
  noteStarRating = null,
  submittedVia = SUBMITTED_VIA.PUBLIC_LINK,
  sourceEntityType = null,
  sourceEntityId = null,
  req,
}) {
  const wasAlreadySubmitted = review.status === REVIEW_STATUS.SUBMITTED;

  review.questionnaireVersion = QUESTIONNAIRE_VERSION;
  review.responses = responses;
  review.responseMap = responseMap;

  review.rating = legacy.rating;
  review.noteStarRating = noteStarRating;

  review.ratings = legacy.ratings;
  review.reviewTitle = legacy.reviewTitle;
  review.reviewText = legacy.reviewText;
  review.privateFeedback = legacy.privateFeedback;
  review.tags = legacy.tags;

  review.status = REVIEW_STATUS.SUBMITTED;

  if (!review.firstSubmittedAt) {
    review.firstSubmittedAt = new Date();
  }

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

  review.reviewType = reviewType;
  review.submittedVia = submittedVia;

  if (sourceEntityType !== undefined) {
    review.sourceEntityType = sourceEntityType;
  }

  if (sourceEntityId !== undefined) {
    review.sourceEntityId = sourceEntityId;
  }

  return wasAlreadySubmitted;
}

/* =========================
   QUESTIONNAIRE API
========================= */

exports.getReviewQuestionnaires = async (req, res) => {
  try {
    const reviewType = normalizeReviewType(req.query.reviewType);

    const context = {
      brandName: String(req.query.brandName || "Brand"),
      influencerName: String(req.query.influencerName || "Influencer"),
      campaignName: String(req.query.campaignName || "Campaign"),
    };

    if (reviewType) {
      return res.status(200).json({
        success: true,
        data: hydrateQuestionnaire(reviewType, context),
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        [REVIEW_TYPES.BRAND_TO_INFLUENCER]: hydrateQuestionnaire(
          REVIEW_TYPES.BRAND_TO_INFLUENCER,
          context
        ),
        [REVIEW_TYPES.INFLUENCER_TO_BRAND]: hydrateQuestionnaire(
          REVIEW_TYPES.INFLUENCER_TO_BRAND,
          context
        ),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load questionnaires",
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
      .select(CAMPAIGN_PUBLIC_SELECT)
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
      ? await ApplyCampaign.find({ campaignId: { $in: uniqueCampaignKeys } }).lean()
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
        getReviewableApplicantsFromApplyRecord(record).map(
          (applicant) => applicant.influencerId
        )
      )
    ).filter(isObjectId);

    const [brands, influencers, modashByInfluencerId] = await Promise.all([
      brandIds.length
        ? Brand.find({ _id: { $in: brandIds.map(toObjectId) } })
            .select(BRAND_PUBLIC_SELECT)
            .lean()
        : [],

      influencerIds.length
        ? Influencer.find({ _id: { $in: influencerIds.map(toObjectId) } })
            .select(INFLUENCER_PUBLIC_SELECT)
            .lean()
        : [],

      findModashProfilesForInfluencers(influencerIds),
    ]);

    const brandById = new Map(brands.map((brand) => [String(brand._id), brand]));
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

            if (!influencerId || !isObjectId(influencerId)) return null;
            if (seenInfluencers.has(influencerId)) return null;
            seenInfluencers.add(influencerId);

            const influencerDoc = influencerById.get(influencerId);
            const modashProfile = modashByInfluencerId.get(influencerId);

            return {
              _id: influencerId,
              name: getInfluencerName(influencerDoc || {}, applicant.name),
              email: influencerDoc?.email || "",
              username: influencerDoc?.username || influencerDoc?.handle || "",
              handle: influencerDoc?.handle || influencerDoc?.username || "",
              ...influencerAvatarPayload(influencerDoc || {}, modashProfile),
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
            name: getBrandName(brandDoc || {}, campaign.brandName || campaign.companyName),
            email: brandDoc?.email || "",
            ...brandAvatarPayload(brandDoc || {}),
          },
          influencers: influencersForCampaign,
        };
      })
      .filter((campaign) => campaign.brand._id && campaign.influencers.length > 0);

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
            sampleApplyCampaignIds: applyRecords.slice(0, 10).map((item) => item.campaignId),
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

function booleanFromBody(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

async function findExistingReviewLink({ campaignId, brandId, influencerId, reviewType }) {
  const baseQuery = { campaignId, brandId, influencerId, reviewType };

  const submitted = await CampaignReview.findOne({
    ...baseQuery,
    status: REVIEW_STATUS.SUBMITTED,
  }).select("+tokenHash");

  if (submitted) return submitted;

  const skipped = await CampaignReview.findOne({
    ...baseQuery,
    status: REVIEW_STATUS.SKIPPED,
  }).select("+tokenHash");

  if (skipped) return skipped;

  const pending = await CampaignReview.findOne({
    ...baseQuery,
    status: REVIEW_STATUS.PENDING,
  }).select("+tokenHash");

  if (pending) return pending;

  return null;
}

async function notifyReviewLinkGenerated({
  review,
  req,
  campaign,
  brand,
  influencer,
  reviewType,
  token,
  isExistingLink,
  regenerated,
}) {
  if (isExistingLink && !regenerated) return;

  const actor = getActorFromReq(req);
  const campaignName = getCampaignName(campaign);
  const brandName = getBrandName(brand);
  const influencerName = getInfluencerName(influencer);

  if (reviewType === REVIEW_TYPES.BRAND_TO_INFLUENCER) {
    await notifySafely("brand review link generated", {
      brandId: String(brand._id),
      type: regenerated
        ? "review.link.regenerated.brand_to_influencer"
        : "review.link.brand_to_influencer",
      title: regenerated ? "Review link regenerated" : "Review influencer work",
      message: regenerated
        ? `A new review link was generated for ${influencerName}'s work on ${campaignName}.`
        : `Please review ${influencerName}'s work for ${campaignName}.`,
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
      influencerId: String(influencer._id),
      type: regenerated
        ? "review.link.regenerated.influencer_to_brand"
        : "review.link.influencer_to_brand",
      title: regenerated ? "Review link regenerated" : "Review brand collaboration",
      message: regenerated
        ? `A new review link was generated for your collaboration with ${brandName} on ${campaignName}.`
        : `Please review your collaboration with ${brandName} for ${campaignName}.`,
      entityType: "campaign_review",
      entityId: String(review._id),
      actionPath: {
        influencer: `/rating-review/${token}`,
        admin: `/admin/rating-reviews?reviewId=${review._id}`,
      },
      ...actor,
    });
  }
}

async function createSingleReviewLink({
  req,
  campaign,
  brand,
  influencer,
  reviewType,
  expiresInDays,
  regenerate = false,
}) {
  const actor = getActorFromReq(req);
  const campaignId = campaign._id;
  const brandId = brand._id;
  const influencerId = influencer._id;

  const rolePayload = buildReviewRolePayload({ reviewType, brandId, influencerId });

  const existingReview = await findExistingReviewLink({
    campaignId,
    brandId,
    influencerId,
    reviewType,
  });

  if (existingReview) {
    const hasStoredPublicUrl = String(existingReview.publicUrl || "").trim();
    const isExpired = existingReview.tokenExpiresAt && existingReview.tokenExpiresAt < new Date();
    const shouldRegenerate = regenerate || !hasStoredPublicUrl || Boolean(isExpired);

    existingReview.reviewType = reviewType;
    Object.assign(existingReview, rolePayload);
    existingReview.sourceEntityType = existingReview.sourceEntityType || "campaign";
    existingReview.sourceEntityId = existingReview.sourceEntityId || String(campaignId);

    if (!shouldRegenerate) {
      await existingReview.save();

      return {
        review: existingReview,
        token: null,
        publicUrl: existingReview.publicUrl,
        isExistingLink: true,
        regenerated: false,
        isUpdateLink: existingReview.status === REVIEW_STATUS.SUBMITTED,
        isSkippedLink: existingReview.status === REVIEW_STATUS.SKIPPED,
        wasExpired: false,
      };
    }

    const token = makeToken();
    const publicUrl = buildPublicReviewUrl(req, token);

    existingReview.tokenHash = hashToken(token);
    existingReview.publicUrl = publicUrl;
    existingReview.tokenExpiresAt = parseExpiresAt(expiresInDays);

    await existingReview.save();

    await notifyReviewLinkGenerated({
      review: existingReview,
      req,
      campaign,
      brand,
      influencer,
      reviewType,
      token,
      isExistingLink: true,
      regenerated: true,
    });

    return {
      review: existingReview,
      token,
      publicUrl,
      isExistingLink: true,
      regenerated: true,
      isUpdateLink: existingReview.status === REVIEW_STATUS.SUBMITTED,
      isSkippedLink: existingReview.status === REVIEW_STATUS.SKIPPED,
      wasExpired: Boolean(isExpired),
    };
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

  const token = makeToken();
  const publicUrl = buildPublicReviewUrl(req, token);

  const review = await CampaignReview.create({
    campaignId,
    brandId,
    influencerId,
    reviewType,
    ...rolePayload,
    tokenHash: hashToken(token),
    publicUrl,
    tokenExpiresAt: parseExpiresAt(expiresInDays),
    sourceEntityType: "campaign",
    sourceEntityId: String(campaignId),
    submittedVia: SUBMITTED_VIA.PUBLIC_LINK,
    questionnaireVersion: QUESTIONNAIRE_VERSION,
    generatedByAdminId: actor.actorAdminId,
    generatedByAdminName: actor.actorName,
    generatedByAdminEmail: actor.actorEmail,
    generatedByAdminRole: actor.actorRole,
  });

  await notifyReviewLinkGenerated({
    review,
    req,
    campaign,
    brand,
    influencer,
    reviewType,
    token,
    isExistingLink: false,
    regenerated: false,
  });

  return {
    review,
    token,
    publicUrl,
    isExistingLink: false,
    regenerated: false,
    isUpdateLink: false,
    isSkippedLink: false,
    wasExpired: false,
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

    const regenerate =
      booleanFromBody(req.body?.regenerate) ||
      booleanFromBody(req.body?.forceRegenerate);

    const { campaign, brand, influencer } = await findRequiredDocs({
      campaignId,
      brandId,
      influencerId,
    });

    await ensureReviewPairBelongsToCampaign({
      campaign,
      brand,
      influencer,
      allowMissingApplyRecord: false,
    });

    const requestedTypes = Array.isArray(reviewTypes)
      ? reviewTypes.map(normalizeReviewType).filter(Boolean)
      : reviewType
        ? [normalizeReviewType(reviewType)]
        : [REVIEW_TYPES.BRAND_TO_INFLUENCER, REVIEW_TYPES.INFLUENCER_TO_BRAND];

    const uniqueTypes = [...new Set(requestedTypes)];

    if (!uniqueTypes.length) {
      return res.status(400).json({
        success: false,
        message: "reviewType must be brand_to_influencer or influencer_to_brand",
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
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to generate review link",
    });
  }
};

/* =========================
   DIRECT SUBMIT / UPDATE
========================= */

async function submitDirectReview(req, res, { reviewType, submittedVia }) {
  try {
    const {
      campaignId,
      brandId,
      influencerId,
      sourceEntityType = "campaign",
      sourceEntityId = null,
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
      allowMissingApplyRecord: true,
    });

    const campaignName = getCampaignName(campaign);
    const brandName = getBrandName(brand);
    const influencerName = getInfluencerName(influencer);

    const { responses, responseMap, input } = validateReviewAnswers({
      reviewType,
      body: req.body || {},
      context: { campaignName, brandName, influencerName },
    });

    const legacy = buildLegacyReviewFields({
      reviewType,
      responseMap,
      brandName,
      influencerName,
    });

    const noteStarRating =
      getNoteStarRatingFromResponseMap(responseMap) ||
      optionalRatingValue(input.note_star_rating);

    const rolePayload = buildReviewRolePayload({
      reviewType,
      brandId: brand._id,
      influencerId: influencer._id,
    });

    let review = await CampaignReview.findOne({
      campaignId: campaign._id,
      brandId: brand._id,
      influencerId: influencer._id,
      reviewType,
      status: REVIEW_STATUS.SUBMITTED,
    }).select("+tokenHash");

    if (!review) {
      review = await CampaignReview.findOne({
        campaignId: campaign._id,
        brandId: brand._id,
        influencerId: influencer._id,
        reviewType,
        status: REVIEW_STATUS.SKIPPED,
      }).select("+tokenHash");
    }

    if (!review) {
      review = await CampaignReview.findOne({
        campaignId: campaign._id,
        brandId: brand._id,
        influencerId: influencer._id,
        reviewType,
        status: REVIEW_STATUS.PENDING,
      }).select("+tokenHash");
    }

    if (!review) {
      review = new CampaignReview({
        campaignId: campaign._id,
        brandId: brand._id,
        influencerId: influencer._id,
        reviewType,
        ...rolePayload,
        tokenHash: hashToken(makeToken()),
        publicUrl: "",
        tokenExpiresAt: parseExpiresAt(180),
        questionnaireVersion: QUESTIONNAIRE_VERSION,
      });
    }

    review.reviewType = reviewType;
    Object.assign(review, rolePayload);

    if (!review.tokenHash) review.tokenHash = hashToken(makeToken());
    if (!review.tokenExpiresAt) review.tokenExpiresAt = parseExpiresAt(180);

    const wasUpdate = applyReviewSubmissionFields({
      review,
      reviewType,
      responses,
      responseMap,
      legacy,
      noteStarRating,
      submittedVia,
      sourceEntityType: sanitizeSourceEntityType(sourceEntityType || "campaign"),
      sourceEntityId: sanitizeSourceEntityId(sourceEntityId || campaign._id),
      req,
    });

    await review.save();

    if (reviewType === REVIEW_TYPES.BRAND_TO_INFLUENCER) {
      await notifySafely("brand direct review submitted influencer notification", {
        influencerId: String(influencer._id),
        type: wasUpdate
          ? "review.updated.brand_to_influencer"
          : "review.submitted.brand_to_influencer",
        title: wasUpdate
          ? "Brand updated your campaign review"
          : "Brand reviewed your campaign work",
        message: `${brandName} ${wasUpdate ? "updated their review of" : "reviewed"} your work for ${campaignName} with ${legacy.rating || 0}/5.`,
        entityType: "campaign_review",
        entityId: String(review._id),
        actionPath: {
          influencer: `/influencer/reviews?reviewId=${review._id}`,
          admin: `/admin/rating-reviews?reviewId=${review._id}`,
        },
      });
    }

    if (reviewType === REVIEW_TYPES.INFLUENCER_TO_BRAND) {
      await notifySafely("influencer direct review submitted brand notification", {
        brandId: String(brand._id),
        type: wasUpdate
          ? "review.updated.influencer_to_brand"
          : "review.submitted.influencer_to_brand",
        title: wasUpdate
          ? "Influencer updated your campaign review"
          : "Influencer reviewed your brand collaboration",
        message: `${influencerName} ${wasUpdate ? "updated their review of" : "reviewed"} ${brandName} for ${campaignName} with ${legacy.rating || 0}/5.`,
        entityType: "campaign_review",
        entityId: String(review._id),
        actionPath: {
          brand: `/brand/reviews?reviewId=${review._id}`,
          admin: `/admin/rating-reviews?reviewId=${review._id}`,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: wasUpdate ? "Review updated successfully" : "Review submitted successfully",
      data: {
        _id: review._id,
        reviewRequestId: review.reviewRequestId,
        status: review.status,
        questionnaireVersion: review.questionnaireVersion,
        rating: review.rating,
        noteStarRating: review.noteStarRating,
        responses: review.responses,
        responseMap: review.responseMap,
        sourceEntityType: review.sourceEntityType,
        sourceEntityId: review.sourceEntityId,
        submittedVia: review.submittedVia,
        firstSubmittedAt: review.firstSubmittedAt,
        submittedAt: review.submittedAt,
        reviewUpdatedAt: review.reviewUpdatedAt,
        reviewUpdateCount: review.reviewUpdateCount,
        wasUpdate,
      },
    });
  } catch (error) {
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

/* =========================
   PROMPT STATE + SKIP
========================= */

async function getReviewPromptState(req, res, { reviewType }) {
  try {
    const { campaignId, brandId, influencerId } = req.body || {};

    const { campaign, brand, influencer } = await findRequiredDocs({
      campaignId,
      brandId,
      influencerId,
    });

    await ensureReviewPairBelongsToCampaign({
      campaign,
      brand,
      influencer,
      allowMissingApplyRecord: true,
    });

    const handledReview = await CampaignReview.findOne({
      campaignId: campaign._id,
      brandId: brand._id,
      influencerId: influencer._id,
      reviewType,
      status: { $in: [REVIEW_STATUS.SUBMITTED, REVIEW_STATUS.SKIPPED] },
    })
      .select(
        "_id reviewRequestId status rating noteStarRating submittedAt firstSubmittedAt skippedAt skippedVia reviewUpdateCount"
      )
      .lean();

    if (handledReview) {
      return res.status(200).json({
        success: true,
        data: {
          shouldPrompt: false,
          reason:
            handledReview.status === REVIEW_STATUS.SUBMITTED
              ? "review_already_submitted"
              : "review_already_skipped",
          review: handledReview,
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        shouldPrompt: true,
        reason: "not_handled_yet",
        review: null,
      },
    });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to check review prompt state",
    });
  }
}

async function skipDirectReview(req, res, { reviewType, skippedVia }) {
  try {
    const {
      campaignId,
      brandId,
      influencerId,
      sourceEntityType = "campaign",
      sourceEntityId = null,
      skipReason = "",
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
      allowMissingApplyRecord: true,
    });

    const existingSubmitted = await CampaignReview.findOne({
      campaignId: campaign._id,
      brandId: brand._id,
      influencerId: influencer._id,
      reviewType,
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

    const rolePayload = buildReviewRolePayload({
      reviewType,
      brandId: brand._id,
      influencerId: influencer._id,
    });

    let review = await CampaignReview.findOne({
      campaignId: campaign._id,
      brandId: brand._id,
      influencerId: influencer._id,
      reviewType,
      status: { $in: [REVIEW_STATUS.SKIPPED, REVIEW_STATUS.PENDING] },
    }).select("+tokenHash");

    if (!review) {
      review = new CampaignReview({
        campaignId: campaign._id,
        brandId: brand._id,
        influencerId: influencer._id,
        reviewType,
        ...rolePayload,
        tokenHash: hashToken(makeToken()),
        publicUrl: "",
        tokenExpiresAt: parseExpiresAt(180),
        questionnaireVersion: QUESTIONNAIRE_VERSION,
      });
    }

    review.reviewType = reviewType;
    Object.assign(review, rolePayload);

    if (!review.tokenHash) review.tokenHash = hashToken(makeToken());
    if (!review.tokenExpiresAt) review.tokenExpiresAt = parseExpiresAt(180);

    review.status = REVIEW_STATUS.SKIPPED;
    review.submittedVia = skippedVia;
    review.skippedVia = skippedVia;
    review.skippedAt = review.skippedAt || new Date();
    review.skipReason = String(skipReason || "").trim();
    review.sourceEntityType = sanitizeSourceEntityType(sourceEntityType || "campaign");
    review.sourceEntityId = sanitizeSourceEntityId(sourceEntityId || campaign._id);

    await review.save();

    return res.status(200).json({
      success: true,
      message: "Review skipped",
      data: {
        shouldPrompt: false,
        status: review.status,
        reviewId: review._id,
        reviewRequestId: review.reviewRequestId,
        skippedAt: review.skippedAt,
        alreadyHandled: true,
      },
    });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to skip review",
    });
  }
}

exports.getBrandReviewPromptState = async (req, res) => {
  return getReviewPromptState(req, res, {
    reviewType: REVIEW_TYPES.BRAND_TO_INFLUENCER,
  });
};

exports.skipBrandReviewDirect = async (req, res) => {
  return skipDirectReview(req, res, {
    reviewType: REVIEW_TYPES.BRAND_TO_INFLUENCER,
    skippedVia: SUBMITTED_VIA.BRAND_MODAL,
  });
};

exports.getInfluencerReviewPromptState = async (req, res) => {
  return getReviewPromptState(req, res, {
    reviewType: REVIEW_TYPES.INFLUENCER_TO_BRAND,
  });
};

exports.skipInfluencerReviewDirect = async (req, res) => {
  return skipDirectReview(req, res, {
    reviewType: REVIEW_TYPES.INFLUENCER_TO_BRAND,
    skippedVia: SUBMITTED_VIA.INFLUENCER_MODAL,
  });
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

    const review = await CampaignReview.findOne({ tokenHash: hashToken(token) })
      .select("+tokenHash")
      .populate([
        {
          path: "campaignId",
          select: CAMPAIGN_PUBLIC_SELECT,
        },
        {
          path: "brandId",
          select: BRAND_PUBLIC_SELECT,
        },
        {
          path: "influencerId",
          select: INFLUENCER_PUBLIC_SELECT,
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

    if (review.tokenExpiresAt && review.tokenExpiresAt < new Date()) {
      review.status = REVIEW_STATUS.EXPIRED;
      await review.save();

      return res.status(410).json({
        success: false,
        message: "This review link has expired",
      });
    }

    const modashProfile = await findInfluencerModashProfile(
      review.influencerId?._id || review.influencerId
    );

    return res.status(200).json({
      success: true,
      canUpdate: review.status === REVIEW_STATUS.SUBMITTED,
      canSubmit: [
        REVIEW_STATUS.PENDING,
        REVIEW_STATUS.SUBMITTED,
        REVIEW_STATUS.SKIPPED,
      ].includes(review.status),
      data: publicReviewPayload(review, { modashProfile }),
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

    const review = await CampaignReview.findOne({ tokenHash: hashToken(token) })
      .select("+tokenHash");

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

    if (review.tokenExpiresAt && review.tokenExpiresAt < new Date()) {
      review.status = REVIEW_STATUS.EXPIRED;
      await review.save();

      return res.status(410).json({
        success: false,
        message: "This review link has expired",
      });
    }

    const [campaign, brand, influencer] = await Promise.all([
      Campaign.findById(review.campaignId).select(CAMPAIGN_PUBLIC_SELECT).lean(),
      Brand.findById(review.brandId).select(BRAND_PUBLIC_SELECT).lean(),
      Influencer.findById(review.influencerId).select(INFLUENCER_PUBLIC_SELECT).lean(),
    ]);

    const campaignName = getCampaignName(campaign);
    const brandName = getBrandName(brand);
    const influencerName = getInfluencerName(influencer);

    const { responses, responseMap, input } = validateReviewAnswers({
      reviewType: review.reviewType,
      body: req.body || {},
      context: { campaignName, brandName, influencerName },
    });

    const legacy = buildLegacyReviewFields({
      reviewType: review.reviewType,
      responseMap,
      brandName,
      influencerName,
    });

    const duplicateSubmitted = await CampaignReview.findOne({
      _id: { $ne: review._id },
      campaignId: review.campaignId,
      brandId: review.brandId,
      influencerId: review.influencerId,
      reviewType: review.reviewType,
      status: REVIEW_STATUS.SUBMITTED,
    }).lean();

    if (duplicateSubmitted && review.status !== REVIEW_STATUS.SUBMITTED) {
      return res.status(409).json({
        success: false,
        message: "A submitted review already exists for this campaign pair",
      });
    }

    const wasUpdate = applyReviewSubmissionFields({
      review,
      reviewType: review.reviewType,
      responses,
      responseMap,
      legacy,
      noteStarRating:
        getNoteStarRatingFromResponseMap(responseMap) ||
        optionalRatingValue(input.note_star_rating),
      submittedVia: SUBMITTED_VIA.PUBLIC_LINK,
      sourceEntityType: review.sourceEntityType || "campaign",
      sourceEntityId: review.sourceEntityId || String(review.campaignId),
      req,
    });

    await review.save();

    const generatedByAdmin = review.generatedByAdminId
      ? await AdminModel.findById(review.generatedByAdminId)
          .select("_id name email role")
          .lean()
      : null;

    const adminId = generatedByAdmin?._id ? String(generatedByAdmin._id) : "";

    if (adminId) {
      await notifySafely("review submitted admin notification", {
        adminId,
        type: wasUpdate ? "review.updated" : "review.submitted",
        title: wasUpdate ? "Campaign review updated" : "Campaign review submitted",
        message:
          review.reviewType === REVIEW_TYPES.BRAND_TO_INFLUENCER
            ? `${brandName} ${wasUpdate ? "updated their review of" : "reviewed"} ${influencerName} with ${legacy.rating}/5 for ${campaignName}.`
            : `${influencerName} ${wasUpdate ? "updated their review of" : "reviewed"} ${brandName} with ${legacy.rating}/5 for ${campaignName}.`,
        entityType: "campaign_review",
        entityId: String(review._id),
        actionPath: {
          admin: `/admin/rating-reviews?reviewId=${review._id}`,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: wasUpdate ? "Review updated successfully" : "Review submitted successfully",
      data: {
        _id: review._id,
        reviewRequestId: review.reviewRequestId,
        status: review.status,
        questionnaireVersion: review.questionnaireVersion,
        rating: review.rating,
        noteStarRating: review.noteStarRating,
        responses: review.responses,
        responseMap: review.responseMap,
        submittedVia: review.submittedVia,
        firstSubmittedAt: review.firstSubmittedAt,
        submittedAt: review.submittedAt,
        reviewUpdatedAt: review.reviewUpdatedAt,
        reviewUpdateCount: review.reviewUpdateCount,
        wasUpdate,
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

    if (isObjectId(req.query.campaignId)) query.campaignId = toObjectId(req.query.campaignId);
    if (isObjectId(req.query.brandId)) query.brandId = toObjectId(req.query.brandId);
    if (isObjectId(req.query.influencerId)) query.influencerId = toObjectId(req.query.influencerId);
    if (normalizeReviewType(req.query.reviewType)) query.reviewType = normalizeReviewType(req.query.reviewType);
    if (Object.values(REVIEW_STATUS).includes(String(req.query.status))) query.status = String(req.query.status);
    if (Object.values(SUBMITTED_VIA).includes(String(req.query.submittedVia))) query.submittedVia = String(req.query.submittedVia);
    if (req.query.sourceEntityType) query.sourceEntityType = String(req.query.sourceEntityType);
    if (req.query.sourceEntityId) query.sourceEntityId = String(req.query.sourceEntityId);

    const [data, total] = await Promise.all([
      CampaignReview.find(query)
        .populate([
          { path: "campaignId", select: CAMPAIGN_PUBLIC_SELECT },
          { path: "brandId", select: BRAND_PUBLIC_SELECT },
          { path: "influencerId", select: INFLUENCER_PUBLIC_SELECT },
          { path: "generatedByAdminId", select: "name email role" },
        ])
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      CampaignReview.countDocuments(query),
    ]);

    const influencerIds = uniqueStrings(data.map((review) => review.influencerId?._id));
    const modashByInfluencerId = await findModashProfilesForInfluencers(influencerIds);

    const hydratedData = data.map((review) => {
      const influencerId = String(review.influencerId?._id || "");
      const modashProfile = modashByInfluencerId.get(influencerId);

      return {
        ...review,
        brandId: review.brandId
          ? {
              ...review.brandId,
              ...brandAvatarPayload(review.brandId),
            }
          : review.brandId,
        influencerId: review.influencerId
          ? {
              ...review.influencerId,
              ...influencerAvatarPayload(review.influencerId, modashProfile),
            }
          : review.influencerId,
      };
    });

    return res.status(200).json({
      success: true,
      data: hydratedData,
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
          averageNoteStarRating: { $avg: "$noteStarRating" },
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
        "rating noteStarRating ratings reviewTitle reviewText tags responses responseMap questionnaireVersion firstSubmittedAt submittedAt reviewUpdatedAt reviewUpdateCount campaignId reviewerRole submittedVia sourceEntityType sourceEntityId"
      )
      .populate({ path: "campaignId", select: CAMPAIGN_PUBLIC_SELECT })
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
        averageNoteStarRating: summary?.averageNoteStarRating
          ? Number(summary.averageNoteStarRating.toFixed(2))
          : 0,
        metrics: {
          workQuality: summary?.workQuality ? Number(summary.workQuality.toFixed(2)) : 0,
          communication: summary?.communication ? Number(summary.communication.toFixed(2)) : 0,
          timeliness: summary?.timeliness ? Number(summary.timeliness.toFixed(2)) : 0,
          professionalism: summary?.professionalism ? Number(summary.professionalism.toFixed(2)) : 0,
          wouldRecommend: summary?.wouldRecommend ? Number(summary.wouldRecommend.toFixed(2)) : 0,
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
