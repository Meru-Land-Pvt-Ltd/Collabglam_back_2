// controllers/disputeController.js
const mongoose = require("mongoose");
const Dispute = require('../models/dispute');
const Campaign = require('../models/campaign');
const { AdminModel: Admin, ROLES } = require('../models/master');
const Brand = require('../models/brand');
const { InfluencerModel: Influencer } = require('../models/influencer');
const ApplyCampaign = require('../models/applyCampaign');
const Modash = require('../models/modash');
const Contract = require('../models/contract');
const BrandAssigned = require('../models/brandAssigned');
const CampaignAssigned = require('../models/CampaignAssigned');
const { Types } = require('mongoose');
const { createAndEmit } = require('../utils/notifier');
const { v4: uuidv4 } = require("uuid");
// ⬇️ Adjust this path to your GridFS helper file if needed
const { uploadToGridFS } = require('../utils/gridfs');
const saveErrorLog = require("../services/errorLog.service");

const {
  handleSendDisputeCreated,
  handleSendDisputeResolved,
  handleSendDisputeAgainstYou,
} = require('../emails/disputeEmailController');

// ---- STATUS CONFIG & HELPERS ----

const STATUS_ORDER = [
  "open",
  "in_review",
  "awaiting_user",
  "evidence_submitted",
  "in_negotiation",
  "resolution_proposed",
  "resolved",
  "rejected",
  "revoked",
];
const ALLOWED_STATUSES = new Set(STATUS_ORDER);
const FINALIZED_STATUSES = new Set(['resolved', 'rejected', 'revoked']);

const STATUS_LABELS = {
  open: "Open",
  in_review: "Under Review",
  awaiting_user: "Awaiting Response",
  evidence_submitted: "Evidence Submitted",
  in_negotiation: "In Negotiation",
  resolution_proposed: "Resolution Proposed",
  resolved: "Completed",
  rejected: "Rejected",
  revoked: "Withdrawn",
};

const STATUS_ALIASES = {
  open: "open",

  in_review: "in_review",
  review: "in_review",
  under_review: "in_review",

  awaiting_user: "awaiting_user",
  awaiting_response: "awaiting_user",

  evidence_submitted: "evidence_submitted",

  in_negotiation: "in_negotiation",

  resolution_proposed: "resolution_proposed",

  resolved: "resolved",
  completed: "resolved",

  rejected: "rejected",

  revoked: "revoked",
  withdrawn: "revoked",
};

/**
 * Escape a string so it can be safely used inside new RegExp(...)
 */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeStatusInput(raw, { allowZeroAll = false } = {}) {
  if (raw === undefined || raw === null || raw === "") return null;

  const s = String(raw).trim();
  if (!s) return null;

  const num = Number(s);
  if (!Number.isNaN(num)) {
    if (num === 0) {
      return allowZeroAll ? "__ALL__" : null;
    }

    const idx = num - 1;
    if (idx >= 0 && idx < STATUS_ORDER.length) {
      return STATUS_ORDER[idx];
    }
    return null;
  }

  const normalized = s.toLowerCase().replace(/[\s-]+/g, "_");

  if (ALLOWED_STATUSES.has(normalized)) {
    return normalized;
  }

  if (STATUS_ALIASES[normalized]) {
    return STATUS_ALIASES[normalized];
  }

  return null;
}

/**
 * Sanitize user-supplied attachments into the canonical shape.
 * This is for already-hosted attachments coming from body.
 */
function sanitizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((a) => a && a.url)
    .map((a) => ({
      url: a.url,
      originalName: a.originalName || null,
      mimeType: a.mimeType || null,
      size: typeof a.size === 'number' ? a.size : undefined,
    }));
}

/**
 * Build safe $or for campaign text search (influencerCampaignsForDispute).
 */
function buildSearchOr(term) {
  const safe = escapeRegex(term);

  const or = [
    { brandName: { $regex: safe, $options: 'i' } },
    { campaignTitle: { $regex: safe, $options: 'i' } },
    { description: { $regex: safe, $options: 'i' } },
    { 'categories.subcategoryName': { $regex: safe, $options: 'i' } },
    { 'categories.categoryName': { $regex: safe, $options: 'i' } },
  ];

  const num = Number(term);
  if (!isNaN(num)) {
    or.push({ budget: { $lte: num } });
  }

  return or;
}

function parseRemovedAttachmentUrlsPayload(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return [
      ...new Set(value.map((v) => String(v || "").trim()).filter(Boolean)),
    ];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return [
          ...new Set(parsed.map((v) => String(v || "").trim()).filter(Boolean)),
        ];
      }
    } catch (_) {
      // fall back to comma separated string
    }

    return [
      ...new Set(trimmed.split(",").map((v) => v.trim()).filter(Boolean)),
    ];
  }

  return [];
}

function getAttachmentUrls(attachment) {
  if (!attachment) return [];

  if (typeof attachment === "string") {
    return [attachment.trim()].filter(Boolean);
  }

  return [
    attachment.url,
    attachment.uri,
    attachment.fileUrl,
    attachment.attachmentUrl,
    attachment.location,
    attachment.path,
    attachment.secure_url,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
}

function getInfluencerIdFromReq(req) {
  return String(
    req.body?.influencerId ||
      req.query?.influencerId ||
      req.user?.influencerId ||
      req.user?.id ||
      req.user?._id ||
      req.user?.userId ||
      ""
  ).trim();
}

function buildInfluencerLookup(influencerId) {
  const id = String(influencerId || "").trim();
  const or = [{ influencerId: id }];

  if (mongoose.Types.ObjectId.isValid(id)) {
    or.push({ _id: new mongoose.Types.ObjectId(id) });
  }

  return { $or: or };
}

function getInfluencerPossibleIds(influencer) {
  return [
    influencer?._id,
    influencer?.influencerId,
    influencer?.userId,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}
/**
 * Helper: parse attachments from body (can be array or JSON string).
 */
function parseAttachmentsFromBody(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Combine any existing (already-hosted) attachments from body
 * with newly uploaded files in req.files (stored in GridFS).
 *
 * This is the central place that enables:
 * - multi-image attachments at dispute creation
 * - multi-image attachments in comments
 */
async function buildAttachmentsFromReq(req, attachmentsFromBody = []) {
  // 1) attachments from body (may be JSON string for multipart/form-data)
  const parsed = parseAttachmentsFromBody(attachmentsFromBody);
  const existing = sanitizeAttachments(parsed);

  // 2) new files from multipart/form-data
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return existing;

  const uploaded = await uploadToGridFS(files, {
    req,
    prefix: 'dispute',
    metadata: {
      source: 'dispute',
      path: req.originalUrl,
      uploadedByRole: req.user?.role || null,
      uploadedById: req.user?.id || null,
    },
  });

  const newOnes = uploaded.map((u) => ({
    url: u.url,
    originalName: u.originalName,
    mimeType: u.mimeType,
    size: u.size,
  }));

  return [...existing, ...newOnes];
}

function uniqueIdStrings(values = []) {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .map((value) => String(value).trim())
        .filter(Boolean)
    ),
  ];
}

function objectIdVariants(value) {
  const id = String(value || "").trim();
  if (!id) return [];

  const variants = [id];

  if (mongoose.Types.ObjectId.isValid(id)) {
    variants.push(new mongoose.Types.ObjectId(id));
  }

  return variants;
}

async function findAdminByAnyId(adminId) {
  const id = String(adminId || "").trim();
  if (!id) return null;

  const or = [];

  if (mongoose.Types.ObjectId.isValid(id)) {
    or.push({ _id: new mongoose.Types.ObjectId(id) });
  }

  if (id.includes("@")) {
    or.push({ email: id.toLowerCase() });
  }

  if (!or.length) return null;

  return Admin.findOne({ $or: or })
    .select("_id name email role parentAdmin rootAdmin status")
    .lean();
}

async function getAssignedAdminIdsForDispute(disputeLike = {}) {
  const recipients = [];
  const brandId = String(disputeLike.brandId || "").trim();
  const campaignId = String(disputeLike.campaignId || "").trim();

  if (disputeLike?.assignedTo?.adminId) {
    recipients.push(disputeLike.assignedTo.adminId);
  }

  const brandVariants = objectIdVariants(brandId);
  const campaignVariants = objectIdVariants(campaignId);

  if (campaignVariants.length) {
    const campaignAssignment = await CampaignAssigned.findOne({
      status: "active",
      campaignId: { $in: campaignVariants },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .select("RHId bdmId idmId brandId")
      .lean();

    if (campaignAssignment) {
      recipients.push(
        campaignAssignment.RHId,
        campaignAssignment.bdmId,
        campaignAssignment.idmId
      );

      if (!brandVariants.length && campaignAssignment.brandId) {
        brandVariants.push(...objectIdVariants(campaignAssignment.brandId));
      }
    }
  }

  if (brandVariants.length) {
    const brandAssignment = await BrandAssigned.findOne({
      status: "active",
      brandId: { $in: brandVariants },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .select("RHId bdmId")
      .lean();

    if (brandAssignment) {
      recipients.push(brandAssignment.RHId, brandAssignment.bdmId);
    }
  }

  return uniqueIdStrings(recipients);
}

async function getAdminNotificationRecipientsForDispute(disputeLike = {}) {
  try {
    return await getAssignedAdminIdsForDispute(disputeLike);
  } catch (error) {
    console.warn(
      "Failed to resolve dispute admin notification recipients:",
      error?.message || error
    );
    return [];
  }
}

const EDITABLE_ISSUE_TYPES = new Set([
  'content_not_as_expected',
  'delay_or_missed_deadline',
  'payment_issue',
  'revision_issue',
  'agreement_issue',
  'scope_change',
  'no_response',
  'other',
]);

function parseIssueTypePayload(rawIssueType) {
  if (!rawIssueType) return ['other'];

  if (Array.isArray(rawIssueType)) {
    const normalized = rawIssueType
      .map((item) => String(item).trim())
      .filter(Boolean);
    return normalized.length ? [...new Set(normalized)] : ['other'];
  }

  if (typeof rawIssueType === 'string') {
    const trimmed = rawIssueType.trim();
    if (!trimmed) return ['other'];

    try {
      const parsed = JSON.parse(trimmed);

      if (Array.isArray(parsed)) {
        const normalized = parsed
          .map((item) => String(item).trim())
          .filter(Boolean);
        return normalized.length ? [...new Set(normalized)] : ['other'];
      }

      if (Array.isArray(parsed?.type)) {
        const normalized = parsed.type
          .map((item) => String(item).trim())
          .filter(Boolean);
        return normalized.length ? [...new Set(normalized)] : ['other'];
      }

      if (typeof parsed?.type === 'string' && parsed.type.trim()) {
        return [parsed.type.trim()];
      }

      if (typeof parsed === 'string' && parsed.trim()) {
        return [parsed.trim()];
      }
    } catch {
      return [trimmed];
    }
  }

  return ['other'];
}

function normalizeOtherIssueDescription(issueTypes, rawDescription) {
  const text = String(rawDescription || "").trim();

  if (!Array.isArray(issueTypes) || !issueTypes.includes("other")) {
    return "";
  }

  return text;
}

function areStringArraysEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => String(value) === String(b[index]));
}

function toObjectIdOrNull(value) {
  const id = String(value || "").trim();

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }

  return new mongoose.Types.ObjectId(id);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }

  return "";
}

function getBestBrandImage(brand) {
  return firstNonEmpty(
    brand?.profilePic,
    brand?.profileImage,
    brand?.logoUrl,
    brand?.brandLogoUrl,
    brand?.avatarUrl,
    brand?.avatar,
    brand?.image,
    brand?.photo,
    brand?.companyLogo
  );
}

function getBestInfluencerImage(influencer, modash) {
  return firstNonEmpty(
    influencer?.profilePic,
    influencer?.profileImage,
    influencer?.avatarUrl,
    influencer?.avatar,
    influencer?.image,
    influencer?.photo,
    modash?.picture,
    modash?.profilePicture,
    modash?.profilePic,
    modash?.image
  );
}

function buildBrandLookup(id) {
  const value = String(id || "").trim();
  const objectId = toObjectIdOrNull(value);

  const or = [
    { brandId: value },
    { email: value },
  ];

  if (objectId) {
    or.unshift({ _id: objectId });
  }

  return { $or: or };
}

function buildInfluencerLookupForProfile(id) {
  const value = String(id || "").trim();
  const objectId = toObjectIdOrNull(value);

  const or = [
    { influencerId: value },
    { email: value },
    { userId: value },
  ];

  if (objectId) {
    or.unshift({ _id: objectId });
  }

  return { $or: or };
}

async function findCampaignByAnyId(campaignId) {
  const value = String(campaignId || "").trim();
  if (!value) return null;

  const objectId = toObjectIdOrNull(value);

  const or = [
    { campaignsId: value },
    { campaignId: value },
  ];

  if (objectId) {
    or.unshift({ _id: objectId });
  }

  return Campaign.findOne({ $or: or })
    .select("_id campaignTitle title name campaignsId campaignId")
    .lean();
}

async function findLatestModashForInfluencer(influencerId) {
  const value = String(influencerId || "").trim();
  if (!value) return null;

  const objectId = toObjectIdOrNull(value);

  const or = [
    { influencerId: value },
    { influencer: value },
  ];

  if (objectId) {
    or.push({ influencer: objectId });
  }

  return Modash.findOne({ $or: or })
    .select("influencerId influencer picture profilePicture profilePic image handle username provider updatedAt")
    .sort({ updatedAt: -1 })
    .lean();
}

function buildPartyProfile({ role, id, name, email, handle, provider, image, since }) {
  const safeImage = String(image || "").trim();

  return {
    role,
    id: String(id || ""),
    name: name || null,
    email: email || "",
    handle: handle || null,
    provider: provider || null,

    // Keep multiple aliases because the brand/influencer/admin UIs use different names.
    profilePic: safeImage || null,
    logoUrl: safeImage || null,
    imageUrl: safeImage || null,
    avatarUrl: safeImage || null,

    since: since || null,
  };
}

function formatSinceLabel(dateValue) {
  if (!dateValue) return null;

  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleString("en-US", {
    month: "short",
    year: "numeric",
  });
}

function hydrateCommentsWithProfiles(dispute, brandParty, influencerParty) {
  if (!Array.isArray(dispute.comments)) {
    dispute.comments = [];
    return dispute;
  }

  dispute.comments = dispute.comments.map((comment) => {
    let party = null;

    if (
      String(comment.authorRole) === "Brand" &&
      String(comment.authorId) === String(brandParty?.id)
    ) {
      party = brandParty;
    }

    if (
      String(comment.authorRole) === "Influencer" &&
      String(comment.authorId) === String(influencerParty?.id)
    ) {
      party = influencerParty;
    }

    return {
      ...comment,
      authorName:
        party?.name ||
        comment.authorName ||
        String(comment.authorRole || "User"),
      authorProfilePic:
        party?.profilePic ||
        comment.authorProfilePic ||
        null,
      authorLogoUrl:
        party?.logoUrl ||
        comment.authorLogoUrl ||
        null,
      authorImageUrl:
        party?.imageUrl ||
        comment.authorImageUrl ||
        null,
    };
  });

  return dispute;
}

async function enrichDisputeForResponse(disputeInput, options = {}) {
  const dispute =
    typeof disputeInput?.toObject === "function"
      ? disputeInput.toObject()
      : { ...(disputeInput || {}) };

  const [brand, influencer, campaign, modash] = await Promise.all([
    dispute.brandId
      ? Brand.findOne(buildBrandLookup(dispute.brandId))
          .select("_id brandId name brandName companyName email createdAt profilePic profileImage logoUrl brandLogoUrl avatarUrl avatar image photo companyLogo")
          .lean()
      : null,

    dispute.influencerId
      ? Influencer.findOne(buildInfluencerLookupForProfile(dispute.influencerId))
          .select("_id influencerId userId name fullName influencerName username email createdAt profilePic profileImage avatarUrl avatar image photo handle provider")
          .lean()
      : null,

    dispute.campaignId ? findCampaignByAnyId(dispute.campaignId) : null,
    dispute.influencerId ? findLatestModashForInfluencer(dispute.influencerId) : null,
  ]);

  const brandName =
    brand?.name ||
    brand?.brandName ||
    brand?.companyName ||
    dispute.brandName ||
    null;

  const influencerName =
    influencer?.name ||
    influencer?.fullName ||
    influencer?.influencerName ||
    influencer?.username ||
    dispute.influencerName ||
    null;

  const influencerHandle =
    modash?.handle ||
    modash?.username ||
    influencer?.handle ||
    dispute.influencerHandle ||
    null;

  const influencerProvider =
    modash?.provider ||
    influencer?.provider ||
    dispute.influencerProvider ||
    null;

  const brandImage = getBestBrandImage(brand);
  const influencerImage = getBestInfluencerImage(influencer, modash);

  const brandSince = formatSinceLabel(brand?.createdAt);
  const influencerSince = formatSinceLabel(influencer?.createdAt);

  const brandParty = buildPartyProfile({
    role: "Brand",
    id: brand?._id || dispute.brandId,
    name: brandName,
    email: brand?.email,
    image: brandImage,
    since: brandSince,
  });

  const influencerParty = buildPartyProfile({
    role: "Influencer",
    id: influencer?._id || dispute.influencerId,
    name: influencerName,
    email: influencer?.email,
    handle: influencerHandle,
    provider: influencerProvider,
    image: influencerImage,
    since: influencerSince,
  });

  const raisedByRole = dispute.createdBy?.role || dispute.raisedByRole || null;

  dispute.campaignName =
    campaign?.campaignTitle ||
    campaign?.title ||
    campaign?.name ||
    dispute.campaignName ||
    null;

  dispute.brandName = brandName;
  dispute.influencerName = influencerName;
  dispute.influencerHandle = influencerHandle;
  dispute.influencerProvider = influencerProvider;

  dispute.brandEmail = brand?.email || dispute.brandEmail || null;
  dispute.influencerEmail = influencer?.email || dispute.influencerEmail || null;

  dispute.brandLogoUrl = brandImage || null;
  dispute.brandProfilePic = brandImage || null;
  dispute.influencerProfileImage = influencerImage || null;
  dispute.influencerProfilePic = influencerImage || null;

  dispute.brandSince = brandSince;
  dispute.influencerSince = influencerSince;

  if (raisedByRole === "Brand") {
    dispute.raisedBy = brandParty;
    dispute.raisedAgainst = influencerParty;
  } else if (raisedByRole === "Influencer") {
    dispute.raisedBy = influencerParty;
    dispute.raisedAgainst = brandParty;
  } else {
    dispute.raisedBy = dispute.raisedBy || null;
    dispute.raisedAgainst = dispute.raisedAgainst || null;
  }

  dispute.raisedByRole = raisedByRole;
  dispute.raisedById = dispute.createdBy?.id || dispute.raisedBy?.id || null;

  if (typeof options.viewerRole === "string") {
    dispute.viewerIsRaiser = raisedByRole === options.viewerRole;
  } else if (typeof dispute.viewerIsRaiser !== "boolean") {
    dispute.viewerIsRaiser = false;
  }

  hydrateCommentsWithProfiles(dispute, brandParty, influencerParty);

  return dispute;
}

async function enrichDisputesForResponse(disputes, options = {}) {
  const rows = Array.isArray(disputes) ? disputes : [];
  return Promise.all(rows.map((row) => enrichDisputeForResponse(row, options)));
}

// ----------------- ID / MODEL HELPERS -----------------

/**
 * Extract brandId from body/query/params and load Brand.
 * Returns the Brand document (lean) or sends error + returns null.
 * (Currently unused by endpoints but kept for future reuse.)
 */
async function requireBrandModel(req, res) {
  const brandId =
    (req.body && req.body.brandId) ||
    (req.query && req.query.brandId) ||
    (req.params && req.params.brandId);

  if (!brandId) {
    res.status(400).json({ message: 'brandId is required' });
    return null;
  }

  const brand = await Brand.findOne(buildBrandLookup(brandId)).lean();
  if (!brand) {
    res.status(404).json({ message: 'Brand not found' });
    return null;
  }

  return brand;
}

/**
 * Extract influencerId from body/query/params and load Influencer.
 * (Currently unused by endpoints but kept for future reuse.)
 */
async function requireInfluencerModel(req, res) {
  const influencerId =
    (req.body && req.body.influencerId) ||
    (req.query && req.query.influencerId) ||
    (req.params && req.params.influencerId);

  if (!influencerId) {
    res.status(400).json({ message: 'influencerId is required' });
    return null;
  }

  const influencer = await Influencer.findOne(
    buildInfluencerLookupForProfile(influencerId)
  ).lean();

  if (!influencer) {
    res.status(404).json({ message: 'Influencer not found' });
    return null;
  }

  return influencer;
}

/**
 * Admin is "relaxed": we don't block if adminId is missing.
 * If adminId is provided (body/query/params), we try to load it.
 * Returns admin doc or null; never sends error.
 */
async function resolveAdminModel(req) {
  const adminId =
    (req.body && req.body.adminId) ||
    (req.query && req.query.adminId) ||
    (req.params && req.params.adminId);

  if (!adminId) return null;

  return findAdminByAnyId(adminId);
}

// ----------------- BRAND ENDPOINTS -----------------
// Brand revoke dispute
exports.brandRevokeDispute = async (req, res) => {
  try {
    const { id } = req.params;
    const { brandId, reason = "" } = req.body || {};

    if (!id) {
      return res.status(400).json({ message: "Dispute id is required" });
    }

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required" });
    }

    const brand = await Brand.findById(String(brandId)).lean();
    if (!brand) {
      return res.status(404).json({ message: "Brand not found" });
    }

    const dispute = await Dispute.findOne({ disputeId: id });
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (String(dispute.brandId) !== String(brandId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (
      dispute.createdBy?.role !== "Brand" ||
      String(dispute.createdBy?.id) !== String(brandId)
    ) {
      return res.status(403).json({
        message: "Only the user who raised this dispute can revoke it",
      });
    }

    if (FINALIZED_STATUSES.has(dispute.status)) {
      return res.status(400).json({
        message: `Cannot revoke a dispute that is already ${dispute.status}`,
      });
    }

    const trimmedReason = String(reason).trim();

    dispute.status = "revoked";
    dispute.comments.push({
      authorRole: "Brand",
      authorId: String(brandId),
      text: trimmedReason
        ? `Dispute revoked by Brand. Reason: ${trimmedReason}`
        : "Dispute revoked by Brand.",
      attachments: [],
    });

    await dispute.save();

    try {
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(dispute),
        influencerId: dispute.influencerId,
        type: "dispute.revoked",
        title: `Dispute #${dispute.disputeId} revoked`,
        message: `${brand?.name || "Brand"} revoked the dispute "${dispute.subject}".`,
        entityType: "dispute",
        entityId: dispute.disputeId,
        actionPath: {
          admin: `/admin/disputes/${dispute.disputeId}`,
          influencer: `/influencer/disputes/${dispute.disputeId}`,
        },
      });
    } catch (notifyErr) {
      console.warn(
        "In-app notify failed (brandRevokeDispute):",
        notifyErr?.message || notifyErr
      );
    }

    return res.status(200).json({
      message: "Dispute revoked successfully",
      disputeId: dispute.disputeId,
      status: dispute.status,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "BRAND_REVOKE_DISPUTE_ERROR");
    console.error("Error in brandRevokeDispute:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
exports.brandEditDispute = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      brandId,
      subject,
      description = '',
      issueType,
      otherIssueDescription = '',
      attachments = [],
      removedAttachmentUrls = [],
    } = req.body || {};

    const parseRemovedAttachmentUrlsPayload = (value) => {
      if (!value) return [];

      if (Array.isArray(value)) {
        return [...new Set(value.map((v) => String(v || '').trim()).filter(Boolean))];
      }

      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return [];

        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            return [...new Set(parsed.map((v) => String(v || '').trim()).filter(Boolean))];
          }
        } catch (_) {
          // ignore JSON parse error and fall back below
        }

        return [...new Set(trimmed.split(',').map((v) => v.trim()).filter(Boolean))];
      }

      return [];
    };

    const getAttachmentUrls = (attachment) => {
      if (!attachment) return [];

      if (typeof attachment === 'string') {
        return [attachment.trim()].filter(Boolean);
      }

      return [
        attachment?.url,
        attachment?.uri,
        attachment?.fileUrl,
        attachment?.attachmentUrl,
        attachment?.location,
        attachment?.path,
        attachment?.secure_url,
      ]
        .map((v) => String(v || '').trim())
        .filter(Boolean);
    };

    const trimmedBrandId = String(brandId || '').trim();
    const trimmedSubject = String(subject || '').trim();
    const trimmedDescription = String(description || '').trim();

    if (!id) {
      return res.status(400).json({ message: 'Dispute id is required' });
    }

    if (!trimmedBrandId) {
      return res.status(400).json({ message: 'brandId is required' });
    }

    if (!trimmedSubject) {
      return res.status(400).json({ message: 'Subject is required' });
    }

    const brand = await Brand.findById(trimmedBrandId).lean();
    if (!brand) {
      return res.status(404).json({ message: 'Brand not found' });
    }

    const dispute = await Dispute.findOne({ disputeId: id });
    if (!dispute) {
      return res.status(404).json({ message: 'Dispute not found' });
    }

    if (String(dispute.brandId) !== trimmedBrandId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (
      dispute.createdBy?.role !== 'Brand' ||
      String(dispute.createdBy?.id) !== trimmedBrandId
    ) {
      return res.status(403).json({
        message: 'Only the user who raised this dispute can edit it',
      });
    }

    if (FINALIZED_STATUSES.has(dispute.status)) {
      return res.status(400).json({
        message: `Cannot edit a dispute that is already ${dispute.status}`,
      });
    }

    const parsedIssueType = parseIssueTypePayload(issueType);
    const invalidIssueTypes = parsedIssueType.filter(
      (value) => !EDITABLE_ISSUE_TYPES.has(value)
    );

    if (invalidIssueTypes.length > 0) {
      return res.status(400).json({
        message: `Invalid issueType value(s): ${invalidIssueTypes.join(', ')}`,
      });
    }

    const normalizedOtherIssueDescription = normalizeOtherIssueDescription(
      parsedIssueType,
      otherIssueDescription
    );

    const parsedRemovedAttachmentUrls =
      parseRemovedAttachmentUrlsPayload(removedAttachmentUrls);

    const uploadedAttachments = await buildAttachmentsFromReq(req, attachments);
    const changeSummary = [];

    if (dispute.subject !== trimmedSubject) {
      dispute.subject = trimmedSubject;
      changeSummary.push('title');
    }

    if ((dispute.description || '') !== trimmedDescription) {
      dispute.description = trimmedDescription;
      changeSummary.push('description');
    }

    const currentIssueType = Array.isArray(dispute.issueType)
      ? dispute.issueType.map((value) => String(value))
      : [];

    if (!areStringArraysEqual(currentIssueType, parsedIssueType)) {
      dispute.issueType = parsedIssueType;
      changeSummary.push('issue type');
    }

    if ((dispute.otherIssueDescription || '') !== normalizedOtherIssueDescription) {
      dispute.otherIssueDescription = normalizedOtherIssueDescription;
      changeSummary.push('other issue description');
    }

    const existingAttachments = Array.isArray(dispute.attachments)
      ? dispute.attachments
      : [];

    if (parsedRemovedAttachmentUrls.length > 0) {
      const removedSet = new Set(parsedRemovedAttachmentUrls);

      const nextAttachments = existingAttachments.filter((attachment) => {
        const urls = getAttachmentUrls(attachment);
        return !urls.some((url) => removedSet.has(url));
      });

      const removedCount = existingAttachments.length - nextAttachments.length;

      if (removedCount > 0) {
        dispute.attachments = nextAttachments;
        changeSummary.push(
          `${removedCount} attachment${removedCount > 1 ? 's' : ''} removed`
        );
      }
    }

    if (uploadedAttachments.length > 0) {
      dispute.attachments = [
        ...(Array.isArray(dispute.attachments) ? dispute.attachments : []),
        ...uploadedAttachments,
      ];

      changeSummary.push(
        `${uploadedAttachments.length} attachment${uploadedAttachments.length > 1 ? 's' : ''} added`
      );
    }

    if (changeSummary.length === 0) {
      return res.status(200).json({
        message: 'No changes detected',
        disputeId: dispute.disputeId,
        status: dispute.status,
        dispute,
      });
    }

    dispute.comments = Array.isArray(dispute.comments) ? dispute.comments : [];
    dispute.comments.push({
      authorRole: 'Brand',
      authorId: trimmedBrandId,
      text: `Dispute updated by Brand. Updated: ${changeSummary.join(', ')}.`,
      attachments: uploadedAttachments,
    });

    await dispute.save();

    try {
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(dispute),
        influencerId: dispute.influencerId,
        type: 'dispute.updated',
        title: `Dispute #${dispute.disputeId} updated`,
        message: `${brand?.name || 'Brand'} updated the dispute "${dispute.subject}".`,
        entityType: 'dispute',
        entityId: dispute.disputeId,
        actionPath: {
          admin: `/admin/disputes/${dispute.disputeId}`,
          influencer: `/influencer/disputes/${dispute.disputeId}`,
        },
      });
    } catch (e) {
      console.warn(
        'In-app notify failed (brandEditDispute):',
        e?.message || e
      );
    }

    return res.status(200).json({
      message: 'Dispute updated successfully',
      disputeId: dispute.disputeId,
      status: dispute.status,
      dispute,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "BRAND_EDIT_DISPUTE_ERROR");
    console.error('Error in brandEditDispute:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
// Brand creates a dispute (multi-image attachments supported)
exports.brandCreateDispute = async (req, res) => {
  try {
    const {
      brandId,
      campaignId,
      influencerId,
      subject,
      description = "",
      attachments = [],
      issueType,
      related,
      otherIssueDescription = "",
    } = req.body || {};

    console.log("brandCreateDispute payload:", {
      brandId,
      campaignId,
      influencerId,
      subject,
      description,
      issueType,
      related,
      otherIssueDescription,
    });

    if (!brandId || !influencerId || !subject) {
      return res.status(400).json({
        message: "brandId, influencerId and subject are required",
      });
    }

    const brand = await Brand.findOne({ _id: String(brandId) }).lean();
    if (!brand) {
      return res.status(404).json({ message: "Brand not found" });
    }

    const influencer = await Influencer.findOne({
      _id: String(influencerId),
    }).lean();
    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    let linkedCampaignId = null;
    let camp = null;

    if (campaignId) {
      camp = await Campaign.findOne({
        _id: campaignId,
        brandId: String(brandId),
      }).lean();

      console.log("Found campaign:", camp);

      if (camp) linkedCampaignId = String(campaignId);
    }

    // Parse issue type from multipart/form-data
    let parsedIssueType = ["other"];
    const rawIssueType = issueType ?? related;

    if (rawIssueType) {
      try {
        if (Array.isArray(rawIssueType)) {
          parsedIssueType = rawIssueType;
        } else if (typeof rawIssueType === "string") {
          const parsed = JSON.parse(rawIssueType);

          if (Array.isArray(parsed)) {
            parsedIssueType = parsed;
          } else if (Array.isArray(parsed?.type)) {
            parsedIssueType = parsed.type;
          } else if (typeof parsed?.type === "string") {
            parsedIssueType = [parsed.type];
          } else if (typeof parsed === "string") {
            parsedIssueType = [parsed];
          }
        }
      } catch (err) {
        if (typeof rawIssueType === "string" && rawIssueType.trim()) {
          parsedIssueType = [rawIssueType.trim()];
        }
      }
    }

    parsedIssueType = [
      ...new Set(
        parsedIssueType
          .map((item) => String(item).trim())
          .filter(Boolean)
      ),
    ];

    if (!parsedIssueType.length) {
      parsedIssueType = ["other"];
    }

    const normalizedOtherIssueDescription = normalizeOtherIssueDescription(
      parsedIssueType,
      otherIssueDescription
    );

    const sanitizedAttachments = await buildAttachmentsFromReq(req, attachments);

    const dispute = new Dispute({
      campaignId: linkedCampaignId,
      brandId: String(brandId),
      influencerId: String(influencerId),
      subject: String(subject).trim(),
      description: String(description || ""),
      issueType: parsedIssueType,
      otherIssueDescription: normalizedOtherIssueDescription,
      createdBy: { id: String(brandId), role: "Brand" },
      attachments: sanitizedAttachments,
    });

    await dispute.save();

    try {
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(dispute),
        influencerId: String(influencerId),
        type: "dispute.created_against_you",
        title: `New dispute raised (Ticket #${dispute.disputeId})`,
        message: `${brand?.name || "A brand"} raised a dispute: "${dispute.subject}".`,
        entityType: "dispute",
        entityId: dispute.disputeId,
        actionPath: { admin: `/admin/disputes/${dispute.disputeId}`, influencer: `/influencer/disputes/${dispute.disputeId}` },
      });
    } catch (e) {
      console.warn("In-app notify failed (brandCreateDispute):", e.message);
    }

    if (brand.email) {
      await handleSendDisputeCreated({
        email: brand.email,
        userName: brand.name,
        ticketId: dispute.disputeId,
        category: dispute.subject,
      });
    }

    if (influencer.email) {
      await handleSendDisputeAgainstYou({
        email: influencer.email,
        userName: influencer.name,
        ticketId: dispute.disputeId,
        category: dispute.subject,
        raisedBy: brand.name,
        raisedByRole: "Brand",
        campaignName: linkedCampaignId ? camp?.campaignTitle || "" : "",
      });
    }

    return res.status(201).json({
      message: "Dispute created",
      disputeId: dispute.disputeId,
      issueType: dispute.issueType,
      otherIssueDescription: dispute.otherIssueDescription,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "BRAND_CREATE_DISPUTE_ERROR");
    console.error("Error in brandCreateDispute:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Brand list disputes for its brandId
exports.brandList = async (req, res) => {
  try {
    const {
      brandId,
      page = 1,
      limit = 10,
      status,
      search,
      appliedBy,
    } = req.body || {};

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required" });
    }

    const brand = await Brand.findOne(buildBrandLookup(brandId)).lean();
    if (!brand) {
      return res.status(404).json({ message: "Brand not found" });
    }

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

    const normalizeSearchValue = (value = "") =>
      String(value).trim().toLowerCase().replace(/^#+/, "");

    const filter = {
      brandId: String(brand._id || brandId),
    };

    const normalizedStatus = normalizeStatusInput(status, { allowZeroAll: true });
    if (normalizedStatus && normalizedStatus !== "__ALL__") {
      filter.status = normalizedStatus;
    }

    if (appliedBy && typeof appliedBy === "string") {
      const role = String(appliedBy).toLowerCase();
      if (role === "brand") filter["createdBy.role"] = "Brand";
      if (role === "influencer") filter["createdBy.role"] = "Influencer";
    }

    const rows = await Dispute.find(filter)
      .select(
        "disputeId subject description issueType otherIssueDescription status campaignId brandId influencerId assignedTo attachments evidence comments createdAt updatedAt createdBy"
      )
      .sort({ createdAt: -1 })
      .lean();

    const enriched = await enrichDisputesForResponse(rows, {
      viewerRole: "Brand",
    });

    const searchTerm = normalizeSearchValue(search);

    const filtered = searchTerm
      ? enriched.filter((r) => {
          const searchableText = [
            r.subject,
            r.description,
            r.otherIssueDescription,
            r.disputeId,
            r.disputeId ? `#${r.disputeId}` : "",
            r.campaignName,
            r.brandName,
            r.influencerName,
            r.influencerHandle,
            r.raisedBy?.name,
            r.raisedBy?.handle,
            r.raisedAgainst?.name,
            r.raisedAgainst?.handle,
            r.status,
            ...(Array.isArray(r.issueType) ? r.issueType : []),
          ]
            .filter(Boolean)
            .map((item) => normalizeSearchValue(item))
            .join(" ");

          return searchableText.includes(searchTerm);
        })
      : enriched;

    const total = filtered.length;
    const totalPages = Math.ceil(total / l) || 1;
    const disputes = filtered.slice((p - 1) * l, p * l);

    return res.status(200).json({
      page: p,
      limit: l,
      total,
      totalPages,
      disputes,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "BRAND_LIST_ERROR");
    console.error("Error in brandList:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.publicGetDisputeById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ message: "Dispute id is required" });
    }

    const dispute = await Dispute.findOne({ disputeId: id }).lean();
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    const enrichedDispute = await enrichDisputeForResponse(dispute);

    return res.status(200).json({ dispute: enrichedDispute });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "PUBLIC_GET_DISPUTE_BY_ID_ERROR");
    console.error("Error in publicGetDisputeById:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.brandGetById = async (req, res) => {
  try {
    const { id } = req.params;
    const brandId =
      (req.query && req.query.brandId) || (req.body && req.body.brandId);

    if (!id) {
      return res.status(400).json({ message: "Dispute id is required" });
    }

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required" });
    }

    const brand = await Brand.findOne(buildBrandLookup(brandId)).lean();
    if (!brand) {
      return res.status(404).json({ message: "Brand not found" });
    }

    const dispute = await Dispute.findOne({ disputeId: id }).lean();
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (String(dispute.brandId) !== String(brand._id || brandId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const enrichedDispute = await enrichDisputeForResponse(dispute, {
      viewerRole: "Brand",
    });

    return res.status(200).json({ dispute: enrichedDispute });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "BRAND_GET_BY_ID_ERROR");
    console.error("Error in brandGetById:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.brandAddComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { text, attachments = [], brandId } = req.body || {};

    if (!id) {
      return res.status(400).json({ message: "Dispute id is required" });
    }

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required" });
    }

    if (!text || !String(text).trim()) {
      return res.status(400).json({ message: "text is required" });
    }

    const brand = await Brand.findOne({ _id: String(brandId) }).lean();
    if (!brand) {
      return res.status(404).json({ message: "Brand not found" });
    }

    const d = await Dispute.findOne({ disputeId: id });
    if (!d) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (d.brandId !== String(brandId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (FINALIZED_STATUSES.has(d.status)) {
      return res.status(400).json({
        message: "Cannot comment on a finalized dispute",
      });
    }

    const sanitized = await buildAttachmentsFromReq(req, attachments);

    d.comments.push({
      authorRole: "Brand",
      authorId: String(brandId),
      text: String(text).trim(),
      attachments: sanitized,
    });

    await d.save();

    try {
      const snippet = String(text).trim().slice(0, 120);
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(d),
        influencerId: d.influencerId,
        type: "dispute.comment_added",
        title: `New comment on Dispute #${d.disputeId}`,
        message: `${brand?.name || "Brand"}: ${snippet}${String(text).trim().length > 120 ? "..." : ""}`,
        entityType: "dispute",
        entityId: d.disputeId,
        actionPath: { admin: `/admin/disputes/${d.disputeId}`, influencer: `/influencer/disputes/${d.disputeId}` },
      });
    } catch (e) {
      console.warn("In-app notify failed (brandAddComment):", e.message);
    }

    return res.status(200).json({ message: "Comment added" });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "BRAND_ADD_COMMENT_ERROR");
    console.error("Error in brandAddComment:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
exports.brandEditComment = async (req, res) => {
  try {
    const { id } = req.params; // commentId
    const { brandId, text, attachments } = req.body || {};

    if (!id) {
      return res.status(400).json({ message: 'commentId is required' });
    }

    if (!brandId) {
      return res.status(400).json({ message: 'brandId is required' });
    }

    const trimmedBrandId = String(brandId).trim();
    const trimmedText = text !== undefined ? String(text).trim() : undefined;

    const brand = await Brand.findOne({ _id: trimmedBrandId }).lean();
    if (!brand) {
      return res.status(404).json({ message: 'Brand not found' });
    }

    const dispute = await Dispute.findOne({
      brandId: trimmedBrandId,
      'comments.commentId': id,
    });

    if (!dispute) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    if (FINALIZED_STATUSES.has(dispute.status)) {
      return res.status(400).json({
        message: `Cannot edit a comment on a dispute that is already ${dispute.status}`,
      });
    }

    const commentIndex = dispute.comments.findIndex(
      (comment) => String(comment.commentId) === String(id)
    );

    if (commentIndex === -1) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    const comment = dispute.comments[commentIndex];

    if (
      comment.authorRole !== 'Brand' ||
      String(comment.authorId) !== trimmedBrandId
    ) {
      return res.status(403).json({
        message: 'You can only edit your own comments',
      });
    }

    let hasChanges = false;

    if (trimmedText !== undefined) {
      if (!trimmedText) {
        return res.status(400).json({ message: 'text is required' });
      }

      if (comment.text !== trimmedText) {
        comment.text = trimmedText;
        hasChanges = true;
      }
    }

    const hasAttachmentPayload =
      req.body?.attachments !== undefined ||
      (Array.isArray(req.files) && req.files.length > 0);

    if (hasAttachmentPayload) {
      const nextAttachments = await buildAttachmentsFromReq(req, attachments || []);
      comment.attachments = nextAttachments;
      hasChanges = true;
    }

    if (!hasChanges) {
      return res.status(200).json({
        message: 'No changes detected',
        commentId: comment.commentId,
      });
    }

    await dispute.save();

    try {
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(dispute),
        influencerId: dispute.influencerId,
        type: 'dispute.comment_edited',
        title: `Comment updated on Dispute #${dispute.disputeId}`,
        message: `${brand?.name || 'Brand'} updated a comment.`,
        entityType: 'dispute',
        entityId: dispute.disputeId,
        actionPath: {
          admin: `/admin/disputes/${dispute.disputeId}`,
          influencer: `/influencer/disputes/${dispute.disputeId}`,
        },
      });
    } catch (e) {
      console.warn('In-app notify failed (brandEditComment):', e?.message || e);
    }

    return res.status(200).json({
      message: 'Comment updated successfully',
      commentId: comment.commentId,
      disputeId: dispute.disputeId,
      comment,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "BRAND_EDIT_COMMENT_ERROR");
    console.error('Error in brandEditComment:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.brandDeleteComment = async (req, res) => {
  try {
    const { id } = req.params; // commentId
    const { brandId } = req.body || {};

    if (!id) {
      return res.status(400).json({ message: 'commentId is required' });
    }

    if (!brandId) {
      return res.status(400).json({ message: 'brandId is required' });
    }

    const trimmedBrandId = String(brandId).trim();

    const brand = await Brand.findOne({ _id: trimmedBrandId }).lean();
    if (!brand) {
      return res.status(404).json({ message: 'Brand not found' });
    }

    const dispute = await Dispute.findOne({
      brandId: trimmedBrandId,
      'comments.commentId': id,
    });

    if (!dispute) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    if (FINALIZED_STATUSES.has(dispute.status)) {
      return res.status(400).json({
        message: `Cannot delete a comment on a dispute that is already ${dispute.status}`,
      });
    }

    const comment = dispute.comments.find(
      (item) => String(item.commentId) === String(id)
    );

    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    if (
      comment.authorRole !== 'Brand' ||
      String(comment.authorId) !== trimmedBrandId
    ) {
      return res.status(403).json({
        message: 'You can only delete your own comments',
      });
    }

    dispute.comments = dispute.comments.filter(
      (item) => String(item.commentId) !== String(id)
    );

    await dispute.save();

    try {
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(dispute),
        influencerId: dispute.influencerId,
        type: 'dispute.comment_deleted',
        title: `Comment removed from Dispute #${dispute.disputeId}`,
        message: `${brand?.name || 'Brand'} deleted a comment.`,
        entityType: 'dispute',
        entityId: dispute.disputeId,
        actionPath: {
          admin: `/admin/disputes/${dispute.disputeId}`,
          influencer: `/influencer/disputes/${dispute.disputeId}`,
        },
      });
    } catch (e) {
      console.warn('In-app notify failed (brandDeleteComment):', e?.message || e);
    }

    return res.status(200).json({
      message: 'Comment deleted successfully',
      commentId: id,
      disputeId: dispute.disputeId,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "BRAND_DELETE_COMMENT_ERROR");
    console.error('Error in brandDeleteComment:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
// ----------------- INFLUENCER ENDPOINTS -----------------
// Influencer revoke dispute
exports.influencerRevokeDispute = async (req, res) => {
  try {
    const { id } = req.params;
    const { influencerId, reason = '' } = req.body || {};

    if (!id) {
      return res.status(400).json({ message: 'Dispute id is required' });
    }

    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }

    const influencer = await Influencer.findOne({
      _id: String(influencerId),
    }).lean();

    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const d = await Dispute.findOne({ disputeId: id });
    if (!d) {
      return res.status(404).json({ message: 'Dispute not found' });
    }

    if (d.influencerId !== String(influencerId)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (
      d.createdBy?.role !== 'Influencer' ||
      String(d.createdBy?.id) !== String(influencerId)
    ) {
      return res.status(403).json({
        message: 'Only the user who raised this dispute can revoke it',
      });
    }

    if (FINALIZED_STATUSES.has(d.status)) {
      return res.status(400).json({
        message: `Cannot revoke a dispute that is already ${d.status}`,
      });
    }

    d.status = 'revoked';

    d.comments.push({
      authorRole: 'Influencer',
      authorId: String(influencerId),
      text: reason && String(reason).trim()
        ? `Dispute revoked by Influencer. Reason: ${String(reason).trim()}`
        : 'Dispute revoked by Influencer.',
      attachments: [],
    });

    await d.save();

    try {
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(d),
        brandId: d.brandId,
        type: 'dispute.revoked',
        title: `Dispute #${d.disputeId} revoked`,
        message: `${influencer?.name || 'Influencer'} revoked the dispute "${d.subject}".`,
        entityType: 'dispute',
        entityId: d.disputeId,
        actionPath: {
          admin: `/admin/disputes/${d.disputeId}`,
          brand: `/brand/disputes/${d.disputeId}`,
        },
      });
    } catch (e) {
      console.warn('In-app notify failed (influencerRevokeDispute):', e.message);
    }

    return res.status(200).json({
      message: 'Dispute revoked successfully',
      disputeId: d.disputeId,
      status: d.status,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INFLUENCER_REVOKE_DISPUTE_ERROR");
    console.error('Error in influencerRevokeDispute:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
// Influencer creates a dispute (multi-image attachments supported)
exports.influencerCreateDispute = async (req, res) => {
  try {
    const {
      influencerId,
      campaignId,
      brandId,
      subject,
      description = '',
      attachments = [],
      issueType,
      related,
      otherIssueDescription = '',
    } = req.body || {};

    if (!influencerId || !brandId || !subject) {
      return res.status(400).json({
        message: 'influencerId, brandId and subject are required',
      });
    }

    const influencer = await Influencer.findOne({
      _id: String(influencerId),
    }).lean();
    if (!influencer) return res.status(404).json({ message: 'Influencer not found' });

    const brand = await Brand.findOne({ _id: String(brandId) }).lean();
    if (!brand) return res.status(404).json({ message: 'Brand not found' });

    let linkedCampaignId = null;
    let camp = null;
    if (campaignId) {
      camp = await Campaign.findOne({
        _id: campaignId,
        brandId: String(brandId),
      }).lean();
      console.log("Found campaign:", camp);
      if (camp) linkedCampaignId = String(campaignId);
    }


    const parsedIssueType = parseIssueTypePayload(issueType ?? related);
    const normalizedOtherIssueDescription = normalizeOtherIssueDescription(
      parsedIssueType,
      otherIssueDescription
    );

    const sanitizedAttachments = await buildAttachmentsFromReq(req, attachments);

    const dispute = new Dispute({
      campaignId: linkedCampaignId,
      brandId: String(brandId),
      influencerId: String(influencerId),
      subject: String(subject).trim(),
      description: String(description || ''),
      issueType: parsedIssueType,
      otherIssueDescription: normalizedOtherIssueDescription,
      createdBy: { id: String(influencerId), role: 'Influencer' },
      attachments: sanitizedAttachments,
    });

    await dispute.save();

    // 🔔 IN-APP NOTIFICATION (Influencer raised dispute -> Brand must see it)
    try {
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(dispute),
        brandId: String(brandId),
        type: 'dispute.created_against_you',
        title: `New dispute raised (Ticket #${dispute.disputeId})`,
        message: `${influencer?.name || 'An influencer'} raised a dispute: "${dispute.subject}".`,
        entityType: 'dispute',
        entityId: dispute.disputeId,
        actionPath: { admin: `/admin/disputes/${dispute.disputeId}`, brand: `/brand/disputes/${dispute.disputeId}` },
      });
    } catch (e) {
      console.warn('In-app notify failed (influencerCreateDispute):', e.message);
    }

    // email notifications (existing)
    if (influencer.email) {
      await handleSendDisputeCreated({
        email: influencer.email,
        userName: influencer.name,
        ticketId: dispute.disputeId,
        category: dispute.subject,
      });
    }

    if (brand.email) {
      await handleSendDisputeAgainstYou({
        email: brand.email,
        userName: brand.name,
        ticketId: dispute.disputeId,
        category: dispute.subject,
        raisedBy: influencer.name,
        raisedByRole: 'Influencer',
        campaignName: linkedCampaignId ? camp?.campaignTitle || '' : '',
      });
    }

    return res
      .status(201)
      .json({
        message: 'Dispute created',
        disputeId: dispute.disputeId,
        issueType: dispute.issueType,
        otherIssueDescription: dispute.otherIssueDescription,
      });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INFLUENCER_CREATE_DISPUTE_ERROR");
    console.error('Error in influencerCreateDispute:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.influencerList = async (req, res) => {
  try {
    const {
      influencerId,
      page = 1,
      limit = 10,
      status,
      search,
      appliedBy,
    } = req.body || {};

    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required" });
    }

    const influencer = await Influencer.findOne(
      buildInfluencerLookupForProfile(influencerId)
    ).lean();

    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

    const normalizeSearchValue = (value = "") =>
      String(value).trim().toLowerCase().replace(/^#+/, "");

    const filter = {
      influencerId: String(influencer._id || influencerId),
    };

    const normalizedStatus = normalizeStatusInput(status, { allowZeroAll: true });
    if (normalizedStatus && normalizedStatus !== "__ALL__") {
      filter.status = normalizedStatus;
    }

    if (appliedBy && typeof appliedBy === "string") {
      const role = String(appliedBy).toLowerCase();
      if (role === "brand") filter["createdBy.role"] = "Brand";
      if (role === "influencer") filter["createdBy.role"] = "Influencer";
    }

    const rows = await Dispute.find(filter)
      .select(
        "disputeId subject description issueType otherIssueDescription status campaignId brandId influencerId assignedTo attachments evidence comments createdAt updatedAt createdBy"
      )
      .sort({ createdAt: -1 })
      .lean();

    const enriched = await enrichDisputesForResponse(rows, {
      viewerRole: "Influencer",
    });

    const searchTerm = normalizeSearchValue(search);

    const filtered = searchTerm
      ? enriched.filter((r) => {
          const searchableText = [
            r.subject,
            r.description,
            r.otherIssueDescription,
            r.disputeId,
            r.disputeId ? `#${r.disputeId}` : "",
            r.campaignName,
            r.brandName,
            r.influencerName,
            r.influencerHandle,
            r.raisedBy?.name,
            r.raisedBy?.handle,
            r.raisedAgainst?.name,
            r.raisedAgainst?.handle,
            r.status,
            ...(Array.isArray(r.issueType) ? r.issueType : []),
          ]
            .filter(Boolean)
            .map((item) => normalizeSearchValue(item))
            .join(" ");

          return searchableText.includes(searchTerm);
        })
      : enriched;

    const total = filtered.length;
    const totalPages = Math.ceil(total / l) || 1;
    const disputes = filtered.slice((p - 1) * l, p * l);

    return res.status(200).json({
      page: p,
      limit: l,
      total,
      totalPages,
      disputes,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INFLUENCER_LIST_ERROR");
    console.error("Error in influencerList:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.influencerGetById = async (req, res) => {
  try {
    const { id } = req.params;
    const influencerId =
      (req.query && req.query.influencerId) ||
      (req.body && req.body.influencerId);

    if (!id) {
      return res.status(400).json({ message: "Dispute id is required" });
    }

    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required" });
    }

    const influencer = await Influencer.findOne(
      buildInfluencerLookupForProfile(influencerId)
    ).lean();

    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const dispute = await Dispute.findOne({ disputeId: id }).lean();
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (String(dispute.influencerId) !== String(influencer._id || influencerId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const enrichedDispute = await enrichDisputeForResponse(dispute, {
      viewerRole: "Influencer",
    });

    return res.status(200).json({ dispute: enrichedDispute });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INFLUENCER_GET_BY_ID_ERROR");
    console.error("Error in influencerGetById:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.influencerAddComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { text, attachments = [], influencerId } = req.body || {};

    if (!id) {
      return res.status(400).json({ message: "Dispute id is required" });
    }

    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required" });
    }

    if (!text || !String(text).trim()) {
      return res.status(400).json({ message: "text is required" });
    }

    const influencer = await Influencer.findOne({ _id: String(influencerId) }).lean();
    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const d = await Dispute.findOne({ disputeId: id });
    if (!d) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (d.influencerId !== String(influencerId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (FINALIZED_STATUSES.has(d.status)) {
      return res.status(400).json({
        message: "Cannot comment on a finalized dispute",
      });
    }

    const sanitized = await buildAttachmentsFromReq(req, attachments);

    d.comments.push({
      authorRole: "Influencer",
      authorId: String(influencerId),
      text: String(text).trim(),
      attachments: sanitized,
    });

    await d.save();

    try {
      const snippet = String(text).trim().slice(0, 120);
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(d),
        brandId: d.brandId,
        type: "dispute.comment_added",
        title: `New comment on Dispute #${d.disputeId}`,
        message: `${influencer?.name || "Influencer"}: ${snippet}${String(text).trim().length > 120 ? "..." : ""}`,
        entityType: "dispute",
        entityId: d.disputeId,
        actionPath: { admin: `/admin/disputes/${d.disputeId}`, brand: `/brand/disputes/${d.disputeId}` },
      });
    } catch (e) {
      console.warn("In-app notify failed (influencerAddComment):", e.message);
    }

    return res.status(200).json({ message: "Comment added" });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INFLUENCER_ADD_COMMENT_ERROR");
    console.error("Error in influencerAddComment:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.influencerRevokeDispute = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = "" } = req.body || {};
    const influencerId = getInfluencerIdFromReq(req);

    if (!id) {
      return res.status(400).json({ message: "Dispute id is required" });
    }

    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required" });
    }

    const influencer = await Influencer.findOne(
      buildInfluencerLookup(influencerId)
    ).lean();

    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const possibleInfluencerIds = getInfluencerPossibleIds(influencer);

    const dispute = await Dispute.findOne({ disputeId: id });
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (!possibleInfluencerIds.includes(String(dispute.influencerId))) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (
      dispute.createdBy?.role !== "Influencer" ||
      !possibleInfluencerIds.includes(String(dispute.createdBy?.id))
    ) {
      return res.status(403).json({
        message: "Only the user who raised this dispute can revoke it",
      });
    }

    if (FINALIZED_STATUSES.has(dispute.status)) {
      return res.status(400).json({
        message: `Cannot revoke a dispute that is already ${dispute.status}`,
      });
    }

    const trimmedReason = String(reason || "").trim();

    dispute.status = "revoked";

    dispute.comments = Array.isArray(dispute.comments) ? dispute.comments : [];
    dispute.comments.push({
      authorRole: "Influencer",
      authorId: String(dispute.influencerId),
      text: trimmedReason
        ? `Dispute revoked by Influencer. Reason: ${trimmedReason}`
        : "Dispute revoked by Influencer.",
      attachments: [],
    });

    await dispute.save();

    try {
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(dispute),
        brandId: dispute.brandId,
        type: "dispute.revoked",
        title: `Dispute #${dispute.disputeId} revoked`,
        message: `${influencer?.name || "Influencer"} revoked the dispute "${dispute.subject}".`,
        entityType: "dispute",
        entityId: dispute.disputeId,
        actionPath: {
          admin: `/admin/disputes/${dispute.disputeId}`,
          brand: `/brand/disputes/${dispute.disputeId}`,
        },
      });
    } catch (notifyErr) {
      console.warn(
        "In-app notify failed (influencerRevokeDispute):",
        notifyErr?.message || notifyErr
      );
    }

    return res.status(200).json({
      message: "Dispute revoked successfully",
      disputeId: dispute.disputeId,
      status: dispute.status,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INFLUENCER_REVOKE_DISPUTE_ERROR");
    console.error("Error in influencerRevokeDispute:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.influencerEditDispute = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      subject,
      description = "",
      issueType,
      otherIssueDescription = "",
      attachments = [],
      removedAttachmentUrls = [],
    } = req.body || {};

    const influencerId = getInfluencerIdFromReq(req);

    const trimmedInfluencerId = String(influencerId || "").trim();
    const trimmedSubject = String(subject || "").trim();
    const trimmedDescription = String(description || "").trim();

    if (!id) {
      return res.status(400).json({ message: "Dispute id is required" });
    }

    if (!trimmedInfluencerId) {
      return res.status(400).json({ message: "influencerId is required" });
    }

    if (!trimmedSubject) {
      return res.status(400).json({ message: "Subject is required" });
    }

    const influencer = await Influencer.findOne(
      buildInfluencerLookup(trimmedInfluencerId)
    ).lean();

    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const possibleInfluencerIds = getInfluencerPossibleIds(influencer);

    const dispute = await Dispute.findOne({ disputeId: id });
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (!possibleInfluencerIds.includes(String(dispute.influencerId))) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (
      dispute.createdBy?.role !== "Influencer" ||
      !possibleInfluencerIds.includes(String(dispute.createdBy?.id))
    ) {
      return res.status(403).json({
        message: "Only the user who raised this dispute can edit it",
      });
    }

    if (FINALIZED_STATUSES.has(dispute.status)) {
      return res.status(400).json({
        message: `Cannot edit a dispute that is already ${dispute.status}`,
      });
    }

    const parsedIssueType = parseIssueTypePayload(issueType);
    const invalidIssueTypes = parsedIssueType.filter(
      (value) => !EDITABLE_ISSUE_TYPES.has(value)
    );

    if (invalidIssueTypes.length > 0) {
      return res.status(400).json({
        message: `Invalid issueType value(s): ${invalidIssueTypes.join(", ")}`,
      });
    }

    const normalizedOtherIssueDescription = normalizeOtherIssueDescription(
      parsedIssueType,
      otherIssueDescription
    );

    const parsedRemovedAttachmentUrls =
      parseRemovedAttachmentUrlsPayload(removedAttachmentUrls);

    const uploadedAttachments = await buildAttachmentsFromReq(
      req,
      attachments
    );

    const changeSummary = [];

    if (dispute.subject !== trimmedSubject) {
      dispute.subject = trimmedSubject;
      changeSummary.push("title");
    }

    if ((dispute.description || "") !== trimmedDescription) {
      dispute.description = trimmedDescription;
      changeSummary.push("description");
    }

    const currentIssueType = Array.isArray(dispute.issueType)
      ? dispute.issueType.map((value) => String(value))
      : [];

    if (!areStringArraysEqual(currentIssueType, parsedIssueType)) {
      dispute.issueType = parsedIssueType;
      changeSummary.push("issue type");
    }

    if ((dispute.otherIssueDescription || "") !== normalizedOtherIssueDescription) {
      dispute.otherIssueDescription = normalizedOtherIssueDescription;
      changeSummary.push("other issue description");
    }

    const existingAttachments = Array.isArray(dispute.attachments)
      ? dispute.attachments
      : [];

    if (parsedRemovedAttachmentUrls.length > 0) {
      const removedSet = new Set(parsedRemovedAttachmentUrls);

      const nextAttachments = existingAttachments.filter((attachment) => {
        const urls = getAttachmentUrls(attachment);
        return !urls.some((url) => removedSet.has(url));
      });

      const removedCount = existingAttachments.length - nextAttachments.length;

      if (removedCount > 0) {
        dispute.attachments = nextAttachments;
        changeSummary.push(
          `${removedCount} attachment${removedCount > 1 ? "s" : ""} removed`
        );
      }
    }

    if (uploadedAttachments.length > 0) {
      dispute.attachments = [
        ...(Array.isArray(dispute.attachments) ? dispute.attachments : []),
        ...uploadedAttachments,
      ];

      changeSummary.push(
        `${uploadedAttachments.length} attachment${
          uploadedAttachments.length > 1 ? "s" : ""
        } added`
      );
    }

    if (changeSummary.length === 0) {
      return res.status(200).json({
        message: "No changes detected",
        disputeId: dispute.disputeId,
        status: dispute.status,
        dispute,
      });
    }

    dispute.comments = Array.isArray(dispute.comments) ? dispute.comments : [];
    dispute.comments.push({
      authorRole: "Influencer",
      authorId: String(dispute.influencerId),
      text: `Dispute updated by Influencer. Updated: ${changeSummary.join(", ")}.`,
      attachments: uploadedAttachments,
    });

    await dispute.save();

    try {
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(dispute),
        brandId: dispute.brandId,
        type: "dispute.updated",
        title: `Dispute #${dispute.disputeId} updated`,
        message: `${influencer?.name || "Influencer"} updated the dispute "${dispute.subject}".`,
        entityType: "dispute",
        entityId: dispute.disputeId,
        actionPath: {
          admin: `/admin/disputes/${dispute.disputeId}`,
          brand: `/brand/disputes/${dispute.disputeId}`,
        },
      });
    } catch (notifyErr) {
      console.warn(
        "In-app notify failed (influencerEditDispute):",
        notifyErr?.message || notifyErr
      );
    }

    return res.status(200).json({
      message: "Dispute updated successfully",
      disputeId: dispute.disputeId,
      status: dispute.status,
      dispute,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INFLUENCER_EDIT_DISPUTE_ERROR");
    console.error("Error in influencerEditDispute:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
// ----------------- ADMIN ENDPOINTS -----------------

// Admin-friendly detail view (relaxed auth, no token required)
// Admin-friendly detail view (relaxed auth, no token required)
exports.adminGetById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ message: "Dispute id is required" });
    }

    const dispute = await Dispute.findOne({ disputeId: id }).lean();

    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    const enrichedDispute = await enrichDisputeForResponse(dispute);

    return res.status(200).json({ dispute: enrichedDispute });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "ADMIN_GET_BY_ID_ERROR");
    console.error("Error in adminGetById:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.adminCreateDisputeEvidence = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      evidenceName,
      notes = "",
      attachments = [],
      adminId,
    } = req.body || {};

    if (!id) {
      return res.status(400).json({ message: "Dispute id is required" });
    }

    const trimmedEvidenceName = String(evidenceName || "").trim();
    const trimmedNotes = String(notes || "").trim();

    if (!trimmedEvidenceName) {
      return res.status(400).json({ message: "Evidence name is required" });
    }

    const dispute = await Dispute.findOne({ disputeId: id });
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (FINALIZED_STATUSES.has(dispute.status)) {
      return res.status(400).json({
        message: `Cannot add evidence to a dispute that is already ${dispute.status}`,
      });
    }

    const admin =
      (await resolveAdminModel(req)) ||
      (adminId
        ? await findAdminByAnyId(adminId)
        : null);

    const uploadedAttachments = await buildAttachmentsFromReq(req, attachments);

    if (!uploadedAttachments.length) {
      return res.status(400).json({
        message: "Please attach at least one evidence file",
      });
    }

    const actorId =
      admin?._id ||
      (adminId ? String(adminId) : null) ||
      req.user?.id ||
      "system";

    const actorName = admin?.name || req.user?.name || "Admin";

    if (!Array.isArray(dispute.evidence)) {
      dispute.evidence = [];
    }

    const previousStatus = dispute.status;

    const evidenceEntry = {
      evidenceId: uuidv4(),
      evidenceName: trimmedEvidenceName,
      notes: trimmedNotes,
      attachments: uploadedAttachments,
      createdBy: {
        role: "Admin",
        id: String(actorId),
        name: actorName,
      },
      createdAt: new Date(),
    };

    dispute.evidence.push(evidenceEntry);

    // if (dispute.status !== "evidence_submitted") {
    //   dispute.status = "evidence_submitted";
    // }

    if (!Array.isArray(dispute.comments)) {
      dispute.comments = [];
    }

    dispute.comments.push({
      authorRole: "Admin",
      authorId: String(actorId),
      text: trimmedNotes
        ? `Evidence added by Admin: ${trimmedEvidenceName}. Notes: ${trimmedNotes}`
        : `Evidence added by Admin: ${trimmedEvidenceName}.`,
      attachments: [],
    });

    if (previousStatus !== dispute.status) {
      dispute.comments.push({
        authorRole: "Admin",
        authorId: String(actorId),
        text: `Status updated by Admin: ${STATUS_LABELS[dispute.status]}.`,
        attachments: [],
      });
    }

    await dispute.save();

    try {
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(dispute),
        brandId: dispute.brandId,
        influencerId: dispute.influencerId,
        type: "dispute.evidence_added",
        title: `Evidence added to Dispute #${dispute.disputeId}`,
        message: `${actorName} added evidence "${trimmedEvidenceName}".`,
        entityType: "dispute",
        entityId: dispute.disputeId,
        actionPath: {
          admin: `/admin/disputes/${dispute.disputeId}`,
          brand: `/brand/disputes/${dispute.disputeId}`,
          influencer: `/influencer/disputes/${dispute.disputeId}`,
        },
      });
    } catch (e) {
      console.warn(
        "In-app notify failed (adminCreateDisputeEvidence):",
        e?.message || e
      );
    }

    return res.status(201).json({
      message: "Evidence added successfully",
      disputeId: dispute.disputeId,
      status: dispute.status,
      evidence: evidenceEntry,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "ADMIN_CREATE_DISPUTE_EVIDENCE_ERROR");
    console.error("Error in adminCreateDisputeEvidence:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
// Admin add comment (multi-image attachments supported, relaxed auth)
exports.adminAddComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { text, attachments = [], adminId, parentCommentId = null } = req.body || {};

    if (!id) {
      return res.status(400).json({ message: "Dispute id is required" });
    }

    if (!text || !String(text).trim()) {
      return res.status(400).json({ message: "text is required" });
    }

    const d = await Dispute.findOne({ disputeId: id });
    if (!d) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (FINALIZED_STATUSES.has(d.status)) {
      return res.status(400).json({
        message: "Cannot comment on a finalized dispute",
      });
    }

    const admin =
      (adminId
        ? await findAdminByAnyId(adminId)
        : null) || (await resolveAdminModel(req));

    const sanitized = await buildAttachmentsFromReq(req, attachments);

    let parentComment = null;
    if (parentCommentId) {
      parentComment = Array.isArray(d.comments)
        ? d.comments.find(
          (comment) => String(comment.commentId) === String(parentCommentId)
        )
        : null;

      if (!parentComment) {
        return res.status(404).json({ message: "Parent comment not found" });
      }

      if (parentComment.authorRole !== "Brand") {
        return res.status(400).json({
          message: "Replies can only be created for brand comments",
        });
      }
    }

    const actorId = admin?._id || adminId || req.user?.id || "system";

    d.comments.push({
      authorRole: "Admin",
      authorId: String(actorId),
      text: String(text).trim(),
      attachments: sanitized,
      parentCommentId: parentComment ? String(parentComment.commentId) : null,
      threadRootCommentId: parentComment
        ? String(parentComment.threadRootCommentId || parentComment.commentId)
        : null,
    });

    await d.save();

    try {
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(d),
        brandId: d.brandId,
        influencerId: d.influencerId,
        type: parentComment ? "dispute.admin_reply" : "dispute.admin_comment",
        title: parentComment
          ? `Admin replied on Dispute #${d.disputeId}`
          : `Admin comment on Dispute #${d.disputeId}`,
        message: parentComment
          ? "Admin replied in the discussion."
          : "Admin added a comment.",
        entityType: "dispute",
        entityId: d.disputeId,
        actionPath: {
          admin: `/admin/disputes/${d.disputeId}`,
          brand: `/brand/disputes/${d.disputeId}`,
          influencer: `/influencer/disputes/${d.disputeId}`,
        },
      });
    } catch (e) {
      console.warn("In-app notify failed (adminAddComment):", e.message);
    }

    return res.status(200).json({
      message: parentComment ? "Reply added" : "Comment added",
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "ADMIN_ADD_COMMENT_ERROR");
    console.error("Error in adminAddComment:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Admin list with filters (status, campaignId, brandId, influencerId, etc.)
exports.adminList = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      campaignId,
      brandId,
      influencerId,
      search,
      appliedBy,
      adminId,
    } = req.body || {};

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

    const normalizeSearchValue = (value = "") =>
      String(value).trim().toLowerCase().replace(/^#+/, "");

    const filter = {};

    const trimmedAdminId = String(adminId || "").trim();

    if (trimmedAdminId) {
      filter.adminNotInterested = { $ne: trimmedAdminId };
    }

    const normalizedStatus = normalizeStatusInput(status, { allowZeroAll: true });
    if (normalizedStatus && normalizedStatus !== "__ALL__") {
      filter.status = normalizedStatus;
    }

    if (campaignId) filter.campaignId = String(campaignId);
    if (brandId) filter.brandId = String(brandId);
    if (influencerId) filter.influencerId = String(influencerId);

    if (appliedBy && typeof appliedBy === "string") {
      const role = String(appliedBy).toLowerCase();
      if (role === "brand") filter["createdBy.role"] = "Brand";
      if (role === "influencer") filter["createdBy.role"] = "Influencer";
    }

    const rows = await Dispute.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    const enriched = await enrichDisputesForResponse(rows);

    const searchTerm = normalizeSearchValue(search);

    const filtered = searchTerm
      ? enriched.filter((r) => {
          const searchableText = [
            r.subject,
            r.description,
            r.otherIssueDescription,
            r.disputeId,
            r.disputeId ? `#${r.disputeId}` : "",
            r.campaignName,
            r.brandName,
            r.influencerName,
            r.influencerHandle,
            r.raisedBy?.name,
            r.raisedBy?.handle,
            r.raisedAgainst?.name,
            r.raisedAgainst?.handle,
            r.status,
            ...(Array.isArray(r.issueType) ? r.issueType : []),
          ]
            .filter(Boolean)
            .map((item) => normalizeSearchValue(item))
            .join(" ");

          return searchableText.includes(searchTerm);
        })
      : enriched;

    const total = filtered.length;
    const disputes = filtered.slice((p - 1) * l, p * l);

    return res.status(200).json({
      page: p,
      limit: l,
      total,
      totalPages: Math.ceil(total / l) || 1,
      disputes,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "ADMIN_LIST_ERROR");
    console.error("Error in adminList:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.adminUpdateStatus = async (req, res) => {
  try {
    const { disputeId, status, resolution, adminId } = req.body || {};

    if (!disputeId || status === undefined || status === null || status === "") {
      return res.status(400).json({
        message: "disputeId and status are required",
      });
    }

    const normalizedStatus = normalizeStatusInput(status, { allowZeroAll: false });
    if (!normalizedStatus) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const d = await Dispute.findOne({ disputeId });
    if (!d) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    const prevStatus = d.status;
    d.status = normalizedStatus;

    let admin = null;
    if (adminId) {
      admin = await findAdminByAnyId(adminId);
    }

    const actorId = admin?._id ? String(admin._id) : adminId || "system";

    if (prevStatus !== normalizedStatus) {
      d.comments.push({
        authorRole: "Admin",
        authorId: actorId,
        text: `Status updated by Admin: ${STATUS_LABELS[normalizedStatus] || normalizedStatus}.`,
        attachments: [],
      });
    }

    if (resolution && String(resolution).trim()) {
      d.comments.push({
        authorRole: "Admin",
        authorId: actorId,
        text: String(resolution).trim(),
        attachments: [],
      });
    }

    await d.save();

    try {
      const adminName = admin?.name || "Admin";
      const resolutionText =
        resolution && String(resolution).trim()
          ? ` Note: ${String(resolution).trim()}`
          : "";

      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(d),
        brandId: d.brandId,
        influencerId: d.influencerId,
        type: "dispute.status_updated",
        title: `Dispute #${d.disputeId} status updated`,
        message: `${adminName} changed status from "${STATUS_LABELS[prevStatus] || prevStatus}" to "${STATUS_LABELS[d.status] || d.status}".${resolutionText}`,
        entityType: "dispute",
        entityId: d.disputeId,
        actionPath: {
          admin: `/admin/disputes/${d.disputeId}`,
          brand: `/brand/disputes/${d.disputeId}`,
          influencer: `/influencer/disputes/${d.disputeId}`,
        },
      });
    } catch (e) {
      console.warn("In-app notify failed (adminUpdateStatus):", e.message);
    }

    if (d.status === "resolved") {
      const [brand, influencer] = await Promise.all([
        Brand.findOne(buildBrandLookup(d.brandId)).lean(),
        Influencer.findOne(buildInfluencerLookupForProfile(d.influencerId)).lean(),
      ]);

      const resolutionSummary =
        resolution || "The dispute has been reviewed and resolved by our team.";

      if (brand && brand.email) {
        await handleSendDisputeResolved({
          email: brand.email,
          userName: brand.name,
          ticketId: d.disputeId,
          resolutionSummary,
        });
      }

      if (influencer && influencer.email) {
        await handleSendDisputeResolved({
          email: influencer.email,
          userName: influencer.name,
          ticketId: d.disputeId,
          resolutionSummary,
        });
      }
    }

    return res.status(200).json({
      message: "Status updated",
      status: d.status,
      statusLabel: STATUS_LABELS[d.status] || d.status,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "ADMIN_UPDATE_STATUS_ERROR");
    console.error("Error in adminUpdateStatus:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
exports.adminMarkNotInterested = async (req, res) => {
  try {
    const { disputeId, adminId } = req.body || {};

    const trimmedDisputeId = String(disputeId || "").trim();
    const trimmedAdminId = String(adminId || "").trim();

    if (!trimmedDisputeId) {
      return res.status(400).json({ message: "disputeId is required" });
    }

    if (!trimmedAdminId) {
      return res.status(400).json({ message: "adminId is required" });
    }

    const dispute = await Dispute.findOne({ disputeId: trimmedDisputeId });

    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    dispute.adminNotInterested = Array.isArray(dispute.adminNotInterested)
      ? dispute.adminNotInterested
      : [];

    if (!dispute.adminNotInterested.includes(trimmedAdminId)) {
      dispute.adminNotInterested.push(trimmedAdminId);
    }

    await dispute.save();

    return res.status(200).json({
      message: "Dispute hidden for this admin",
      disputeId: dispute.disputeId,
      adminId: trimmedAdminId,
      status: dispute.status,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "ADMIN_MARK_NOT_INTERESTED_ERROR");
    console.error("Error in adminMarkNotInterested:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Admin assign dispute
exports.adminAssign = async (req, res) => {
  try {
    const { disputeId, adminId } = req.body || {};
    if (!disputeId) {
      return res.status(400).json({ message: 'disputeId is required' });
    }

    const d = await Dispute.findOne({ disputeId });
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    let targetAdminId = adminId ? String(adminId) : null;
    let name = null;

    if (targetAdminId) {
      try {
        const a = await findAdminByAnyId(targetAdminId);
        if (a) {
          name = a.name || a.email || null;
        }
      } catch {
        // ignore lookup errors, keep name=null
      }
    }

    d.assignedTo = { adminId: targetAdminId || null, name };
    await d.save();
    try {
      await createAndEmit({
        adminIds: await getAdminNotificationRecipientsForDispute(d),
        brandId: d.brandId,
        influencerId: d.influencerId,
        type: 'dispute.assigned',
        title: `Dispute #${d.disputeId} assigned`,
        message: `Your dispute has been assigned to our team.`,
        entityType: 'dispute',
        entityId: d.disputeId,
        actionPath: {
          admin: `/admin/disputes/${d.disputeId}`,
          brand: `/brand/disputes/${d.disputeId}`,
          influencer: `/influencer/disputes/${d.disputeId}`,
        },
      });
    } catch (e) {
      console.warn('In-app notify failed (adminAssign):', e.message);
    }

    return res
      .status(200)
      .json({ message: 'Assigned', assignedTo: d.assignedTo });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "ADMIN_ASSIGN_ERROR");
    console.error('Error in adminAssign:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Influencer campaigns for dispute creation
exports.influencerCampaignsForDispute = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body || {};

  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required' });
  }

  try {
    // Ensure influencer exists (defensive)
    const inf = await Influencer.findOne({
      _id: String(influencerId),
    }).lean();
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    // 1) All campaigns this influencer has applied to
    const applyRecs = await ApplyCampaign.find(
      { 'applicants.influencerId': String(influencerId) },
      'campaignId'
    ).lean();

    let campaignIds = applyRecs
      .map((r) => r.campaignId)
      .filter(Boolean)
      .map(String);

    if (!campaignIds.length) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: Number(page),
          limit: Number(limit),
          totalPages: 0,
        },
        campaigns: [],
      });
    }

    // 2) All contracts this influencer has for those campaigns
    const contracts = await Contract.find(
      {
        influencerId: String(influencerId),
        campaignId: { $in: campaignIds },
      },
      'campaignId contractId status isAccepted isRejected'
    ).lean();

    const contractMap = new Map();
    contracts.forEach((c) => {
      const key = String(c.campaignId);
      contractMap.set(key, {
        contractId: c.contractId || null,
        status: c.status || null,
        isAccepted: c.isAccepted === 1 ? 1 : 0,
        isRejected: c.isRejected === 1 ? 1 : 0,
      });
    });

    // 3) Fetch campaign docs for those ids
    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const filter = {
      _id: { $in: campaignIds.map((id) => new Types.ObjectId(id)) },
    };
    if (typeof search === 'string' && search.trim()) {
      const term = search.trim();
      filter.$or = buildSearchOr(term);
    }

    // Only fetch the minimal fields we need
    const projection = [
      'brandId',
      'brandName',
      'campaignTitle',
      'isActive',
      'applicantCount',
      'hasApplied',
      'isDraft',
      'campaignsId',
      'createdAt',
    ].join(' ');

    const [total, rawCampaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter, projection)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limNum)
        .lean(),
    ]);

    const campaigns = rawCampaigns.map((c) => {
      const key = String(c.campaignsId);
      const contract = contractMap.get(key);

      const isRejected = contract ? contract.isRejected : 0;
      const isContracted = contract && !contract.isRejected ? 1 : 0;
      const isAccepted = contract && contract.isAccepted ? 1 : 0;

      return {
        // campaign identity
        campaignId: c.campaignsId,
        _id: c._id,
        campaignName: c.campaignTitle,

        // brand info
        brandId: c.brandId,
        brandName: c.brandName,

        // campaign state
        isActive: typeof c.isActive === 'number' ? c.isActive : 0,
        applicantCount: c.applicantCount ?? 0,
        hasApplied: 1, // by definition they applied
        isDraft: c.isDraft ?? 0,
        createdAt: c.createdAt,

        // contract state
        isContracted,
        isAccepted,
        isRejected,
        contractId: contract ? contract.contractId : null,
        contractStatus: contract ? contract.status : null,
      };
    });

    return res.status(200).json({
      meta: {
        total,
        page: pageNum,
        limit: limNum,
        totalPages: Math.ceil(total / limNum),
      },
      campaigns,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INFLUENCER_CAMPAIGNS_FOR_DISPUTE_ERROR");
    console.error('Error in influencerCampaignsForDispute:', err);
    return res.status(500).json({
      message:
        'Internal server error while fetching campaigns for dispute.',
    });
  }
};