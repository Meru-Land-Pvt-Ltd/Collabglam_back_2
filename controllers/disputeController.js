// controllers/disputeController.js
const mongoose = require("mongoose");
const Dispute = require('../models/dispute');
const Campaign = require('../models/campaign');
const Admin = require('../models/admin');
const Brand = require('../models/brand');
const { InfluencerModel: Influencer } = require('../models/influencer');
const ApplyCampaign = require('../models/applyCampaign');
const Modash = require('../models/modash');
const Contract = require('../models/contract');
const { Types } = require('mongoose');
const { createAndEmit } = require('../utils/notifier');
const { v4: uuidv4 } = require("uuid");
// ⬇️ Adjust this path to your GridFS helper file if needed
const { uploadToGridFS } = require('../utils/gridfs');

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

function areStringArraysEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => String(value) === String(b[index]));
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

  const brand = await Brand.findOne({ brandId: String(brandId) }).lean();
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

  const influencer = await Influencer.findOne({
    influencerId: String(influencerId),
  }).lean();

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

  const admin = await Admin.findOne({ adminId: String(adminId) })
    .select('adminId name email')
    .lean();

  return admin || null;
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
        influencerId: dispute.influencerId,
        type: "dispute.revoked",
        title: `Dispute #${dispute.disputeId} revoked`,
        message: `${brand?.name || "Brand"} revoked the dispute "${dispute.subject}".`,
        entityType: "dispute",
        entityId: dispute.disputeId,
        actionPath: {
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
        influencerId: dispute.influencerId,
        type: 'dispute.updated',
        title: `Dispute #${dispute.disputeId} updated`,
        message: `${brand?.name || 'Brand'} updated the dispute "${dispute.subject}".`,
        entityType: 'dispute',
        entityId: dispute.disputeId,
        actionPath: {
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
    } = req.body || {};

    console.log("brandCreateDispute payload:", {
      brandId,
      campaignId,
      influencerId,
      subject,
      description,
      issueType,
      related,
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

    const sanitizedAttachments = await buildAttachmentsFromReq(req, attachments);

    const dispute = new Dispute({
      campaignId: linkedCampaignId,
      brandId: String(brandId),
      influencerId: String(influencerId),
      subject: String(subject).trim(),
      description: String(description || ""),
      issueType: parsedIssueType,
      createdBy: { id: String(brandId), role: "Brand" },
      attachments: sanitizedAttachments,
    });

    await dispute.save();

    try {
      await createAndEmit({
        influencerId: String(influencerId),
        type: "dispute.created_against_you",
        title: `New dispute raised (Ticket #${dispute.disputeId})`,
        message: `${brand?.name || "A brand"} raised a dispute: "${dispute.subject}".`,
        entityType: "dispute",
        entityId: dispute.disputeId,
        actionPath: { influencer: `/influencer/disputes/${dispute.disputeId}` },
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
    });
  } catch (err) {
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
      appliedBy, // "brand" | "influencer" optional
    } = req.body || {};

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required" });
    }

    const brand = await Brand.findOne({ _id: String(brandId) }).lean();
    if (!brand) {
      return res.status(404).json({ message: "Brand not found" });
    }

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

    const normalizeSearchValue = (value = "") =>
      String(value)
        .trim()
        .toLowerCase()
        .replace(/^#+/, "");

    const filter = {
      brandId: String(brandId),
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

    // Fetch all disputes matching base filters first.
    // Search will be applied AFTER enrichment so campaign/influencer fields work too.
    const rows = await Dispute.find(filter)
      .select(
        "disputeId subject description issueType status campaignId brandId influencerId assignedTo attachments comments createdAt updatedAt createdBy"
      )
      .sort({ createdAt: -1 })
      .lean();

    const rowsWithRole = rows.map((r) => ({
      ...r,
      raisedByRole: r.createdBy?.role || null,
      raisedById: r.createdBy?.id || null,
    }));

    try {
      const influencerIds = Array.from(
        new Set(rowsWithRole.map((r) => r.influencerId).filter(Boolean))
      ).map(String);

      const campaignIds = Array.from(
        new Set(rowsWithRole.map((r) => r.campaignId).filter(Boolean))
      ).map(String);

      const [influencers, campaigns, modashProfiles] = await Promise.all([
        influencerIds.length
          ? Influencer.find({ _id: { $in: influencerIds } })
            .select("_id name")
            .lean()
          : [],
        campaignIds.length
          ? Campaign.find({ _id: { $in: campaignIds } })
            .select("_id campaignTitle")
            .lean()
          : [],
        influencerIds.length
          ? Modash.find({
            $or: [
              { influencerId: { $in: influencerIds } },
              { influencer: { $in: influencerIds } },
            ],
          })
            .select("influencerId handle username provider updatedAt")
            .sort({ updatedAt: -1 })
            .lean()
          : [],
      ]);

      const infMap = new Map(
        (influencers || []).map((i) => [String(i._id), i.name || null])
      );

      const cmap = new Map(
        (campaigns || []).map((c) => [String(c._id), c.campaignTitle || null])
      );

      // keep first/latest handle per influencerId
      const modashMap = new Map();
      for (const m of modashProfiles || []) {
        const key = String(m.influencerId || m.influencer);
        if (!key) continue;
        if (!modashMap.has(key)) {
          modashMap.set(key, {
            handle: m.handle || m.username || null,
            provider: m.provider || null,
          });
        }
      }

      const enriched = rowsWithRole.map((r) => {
        const campaignName = r.campaignId
          ? cmap.get(String(r.campaignId)) || null
          : null;

        const influencerName = infMap.get(String(r.influencerId)) || null;
        const modashMeta = modashMap.get(String(r.influencerId)) || {
          handle: null,
          provider: null,
        };

        const role = r.raisedByRole;
        let raisedBy = null;
        let raisedAgainst = null;

        if (role === "Brand") {
          raisedBy = {
            role: "Brand",
            id: r.brandId,
            name: brand.name || null,
          };
          raisedAgainst = {
            role: "Influencer",
            id: r.influencerId,
            name: influencerName,
            handle: modashMeta.handle,
            provider: modashMeta.provider,
          };
        } else if (role === "Influencer") {
          raisedBy = {
            role: "Influencer",
            id: r.influencerId,
            name: influencerName,
            handle: modashMeta.handle,
            provider: modashMeta.provider,
          };
          raisedAgainst = {
            role: "Brand",
            id: r.brandId,
            name: brand.name || null,
          };
        }

        const viewerIsRaiser = role === "Brand";

        return {
          ...r,
          campaignName,
          influencerName,
          influencerHandle: modashMeta.handle,
          influencerProvider: modashMeta.provider,
          raisedBy,
          raisedAgainst,
          viewerIsRaiser,
          issueType: Array.isArray(r.issueType) ? r.issueType : [],
        };
      });

      const searchTerm = normalizeSearchValue(search);

      const filtered = searchTerm
        ? enriched.filter((r) => {
          const searchableText = [
            r.subject,
            r.description,
            r.disputeId,
            r.disputeId ? `#${r.disputeId}` : "",
            r.campaignName,
            r.influencerName,
            r.influencerHandle,
            r.raisedBy?.name,
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
    } catch (e) {
      console.error("Error enriching brandList:", e);

      const searchTerm = normalizeSearchValue(search);

      const fallbackFiltered = searchTerm
        ? rowsWithRole.filter((r) => {
          const searchableText = [
            r.subject,
            r.description,
            r.disputeId,
            r.disputeId ? `#${r.disputeId}` : "",
            ...(Array.isArray(r.issueType) ? r.issueType : []),
          ]
            .filter(Boolean)
            .map((item) => normalizeSearchValue(item))
            .join(" ");

          return searchableText.includes(searchTerm);
        })
        : rowsWithRole;

      const total = fallbackFiltered.length;
      const totalPages = Math.ceil(total / l) || 1;
      const disputes = fallbackFiltered.slice((p - 1) * l, p * l);

      return res.status(200).json({
        page: p,
        limit: l,
        total,
        totalPages,
        disputes,
      });
    }
  } catch (err) {
    console.error("Error in brandList:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
exports.publicGetDisputeById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ message: 'Dispute id is required' });
    }

    const d = await Dispute.findOne({ disputeId: id }).lean();
    if (!d) {
      return res.status(404).json({ message: 'Dispute not found' });
    }

    try {
      const [campaign, brand, influencer, modash] = await Promise.all([
        d.campaignId
          ? Campaign.findOne({ _id: d.campaignId })
            .select('_id campaignTitle')
            .lean()
          : null,

        d.brandId
          ? Brand.findOne({ _id: d.brandId })
            .select('_id name')
            .lean()
          : null,

        d.influencerId
          ? Influencer.findOne({ _id: d.influencerId })
            .select('_id name')
            .lean()
          : null,

        d.influencerId
          ? Modash.findOne({
            $or: [
              { influencerId: String(d.influencerId) },
              { influencer: d.influencerId },
            ],
          })
            .select('influencerId influencer handle username provider updatedAt')
            .sort({ updatedAt: -1 })
            .lean()
          : null,
      ]);

      d.campaignName = campaign?.campaignTitle || null;

      const brandName = brand?.name || null;
      const influencerName = influencer?.name || null;
      const influencerHandle = modash?.handle || modash?.username || null;
      const influencerProvider = modash?.provider || null;
      const raisedByRole = d.createdBy?.role || null;

      d.brandName = brandName;
      d.influencerName = influencerName;
      d.influencerHandle = influencerHandle;
      d.influencerProvider = influencerProvider;

      if (raisedByRole === 'Brand') {
        d.raisedBy = {
          role: 'Brand',
          id: d.brandId,
          name: brandName,
        };
        d.raisedAgainst = {
          role: 'Influencer',
          id: d.influencerId,
          name: influencerName,
          handle: influencerHandle,
          provider: influencerProvider,
        };
      } else if (raisedByRole === 'Influencer') {
        d.raisedBy = {
          role: 'Influencer',
          id: d.influencerId,
          name: influencerName,
          handle: influencerHandle,
          provider: influencerProvider,
        };
        d.raisedAgainst = {
          role: 'Brand',
          id: d.brandId,
          name: brandName,
        };
      } else {
        d.raisedBy = null;
        d.raisedAgainst = null;
      }

      d.raisedByRole = raisedByRole;
      d.raisedById = d.createdBy?.id || null;
      d.viewerIsRaiser = false;
    } catch (e) {
      console.error('Error enriching publicGetDisputeById:', e);
      d.campaignName = d.campaignName || null;
      d.brandName = d.brandName || null;
      d.influencerName = d.influencerName || null;
      d.influencerHandle = d.influencerHandle || null;
      d.influencerProvider = d.influencerProvider || null;
    }

    return res.status(200).json({ dispute: d });
  } catch (err) {
    console.error('Error in publicGetDisputeById:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
exports.brandGetById = async (req, res) => {
  try {
    const { id } = req.params;
    const brandId =
      (req.query && req.query.brandId) || (req.body && req.body.brandId);

    if (!id) return res.status(400).json({ message: 'Dispute id is required' });
    if (!brandId) {
      return res.status(400).json({ message: 'brandId is required' });
    }

    const brand = await Brand.findOne({ _id: String(brandId) }).lean();
    if (!brand) return res.status(404).json({ message: 'Brand not found' });

    const d = await Dispute.findOne({ disputeId: id }).lean();
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    if (d.brandId !== String(brandId)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    try {
      const [campaign, influencer, modash] = await Promise.all([
        d.campaignId
          ? Campaign.findOne({ _id: d.campaignId })
            .select('_id campaignTitle')
            .lean()
          : null,

        d.influencerId
          ? Influencer.findOne({ _id: d.influencerId })
            .select('_id name')
            .lean()
          : null,

        d.influencerId
          ? Modash.findOne({
            $or: [
              { influencerId: String(d.influencerId) },
              { influencer: d.influencerId },
            ],
          })
            .select('influencerId influencer handle username provider updatedAt')
            .sort({ updatedAt: -1 })
            .lean()
          : null,
      ]);

      d.campaignName = campaign?.campaignTitle || null;

      const influencerName = influencer?.name || null;
      const influencerHandle = modash?.handle || modash?.username || null;
      const influencerProvider = modash?.provider || null;
      const raisedByRole = d.createdBy?.role || null;

      d.influencerName = influencerName;
      d.influencerHandle = influencerHandle;
      d.influencerProvider = influencerProvider;

      if (raisedByRole === 'Brand') {
        d.raisedBy = {
          role: 'Brand',
          id: d.brandId,
          name: brand.name || null,
        };
        d.raisedAgainst = {
          role: 'Influencer',
          id: d.influencerId,
          name: influencerName,
          handle: influencerHandle,
          provider: influencerProvider,
        };
      } else if (raisedByRole === 'Influencer') {
        d.raisedBy = {
          role: 'Influencer',
          id: d.influencerId,
          name: influencerName,
          handle: influencerHandle,
          provider: influencerProvider,
        };
        d.raisedAgainst = {
          role: 'Brand',
          id: d.brandId,
          name: brand.name || null,
        };
      } else {
        d.raisedBy = null;
        d.raisedAgainst = null;
      }

      d.raisedByRole = raisedByRole;
      d.raisedById = d.createdBy?.id || null;
      d.viewerIsRaiser = raisedByRole === 'Brand';
    } catch (e) {
      console.error('Error enriching brandGetById:', e);
      d.campaignName = d.campaignName || null;
      d.influencerName = d.influencerName || null;
      d.influencerHandle = d.influencerHandle || null;
      d.influencerProvider = d.influencerProvider || null;
    }

    return res.status(200).json({ dispute: d });
  } catch (err) {
    console.error('Error in brandGetById:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Brand add comment (multi-image attachments supported)
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
        influencerId: d.influencerId,
        type: "dispute.comment_added",
        title: `New comment on Dispute #${d.disputeId}`,
        message: `${brand?.name || "Brand"}: ${snippet}${String(text).trim().length > 120 ? "..." : ""}`,
        entityType: "dispute",
        entityId: d.disputeId,
        actionPath: { influencer: `/influencer/disputes/${d.disputeId}` },
      });
    } catch (e) {
      console.warn("In-app notify failed (brandAddComment):", e.message);
    }

    return res.status(200).json({ message: "Comment added" });
  } catch (err) {
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
        influencerId: dispute.influencerId,
        type: 'dispute.comment_edited',
        title: `Comment updated on Dispute #${dispute.disputeId}`,
        message: `${brand?.name || 'Brand'} updated a comment.`,
        entityType: 'dispute',
        entityId: dispute.disputeId,
        actionPath: {
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
        influencerId: dispute.influencerId,
        type: 'dispute.comment_deleted',
        title: `Comment removed from Dispute #${dispute.disputeId}`,
        message: `${brand?.name || 'Brand'} deleted a comment.`,
        entityType: 'dispute',
        entityId: dispute.disputeId,
        actionPath: {
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
        brandId: d.brandId,
        type: 'dispute.revoked',
        title: `Dispute #${d.disputeId} revoked`,
        message: `${influencer?.name || 'Influencer'} revoked the dispute "${d.subject}".`,
        entityType: 'dispute',
        entityId: d.disputeId,
        actionPath: {
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


    const sanitizedAttachments = await buildAttachmentsFromReq(req, attachments);

    const dispute = new Dispute({
      campaignId: linkedCampaignId,
      brandId: String(brandId),
      influencerId: String(influencerId),
      subject: String(subject).trim(),
      description: String(description || ''),
      createdBy: { id: String(influencerId), role: 'Influencer' },
      attachments: sanitizedAttachments,
    });

    await dispute.save();

    // 🔔 IN-APP NOTIFICATION (Influencer raised dispute -> Brand must see it)
    try {
      await createAndEmit({
        brandId: String(brandId),
        type: 'dispute.created_against_you',
        title: `New dispute raised (Ticket #${dispute.disputeId})`,
        message: `${influencer?.name || 'An influencer'} raised a dispute: "${dispute.subject}".`,
        entityType: 'dispute',
        entityId: dispute.disputeId,
        actionPath: { brand: `/brand/disputes/${dispute.disputeId}` },
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
      .json({ message: 'Dispute created', disputeId: dispute.disputeId });
  } catch (err) {
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
      appliedBy, // "brand" | "influencer" optional
    } = req.body || {};

    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }

    const influencer = await Influencer.findOne({ _id: String(influencerId) }).lean();
    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

    const filter = {
      influencerId: String(influencerId),
    };

    // numeric / string status support (0 = all)
    const normalizedStatus = normalizeStatusInput(status, { allowZeroAll: true });
    if (normalizedStatus && normalizedStatus !== '__ALL__') {
      filter.status = normalizedStatus;
    }

    // backend search: subject / description / disputeId
    const searchTerm = typeof search === 'string' ? search.trim() : '';
    if (searchTerm) {
      const pattern = escapeRegex(searchTerm);
      const re = new RegExp(pattern, 'i');
      filter.$or = [{ subject: re }, { description: re }, { disputeId: re }];
    }

    // who raised it (direction filter)
    if (appliedBy && typeof appliedBy === 'string') {
      const role = String(appliedBy).toLowerCase();
      if (role === 'brand') filter['createdBy.role'] = 'Brand';
      if (role === 'influencer') filter['createdBy.role'] = 'Influencer';
    }

    const total = await Dispute.countDocuments(filter);
    const rows = await Dispute.find(filter)
      .select(
        'disputeId subject description status campaignId brandId influencerId assignedTo attachments comments createdAt updatedAt createdBy'
      )
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean();

    // Add quick "who raised it" info
    const rowsWithRole = rows.map((r) => ({
      ...r,
      raisedByRole: r.createdBy?.role || null,
      raisedById: r.createdBy?.id || null,
    }));

    // Enrich with brand name + campaign name + raisedBy/raisedAgainst
    try {
      const brandIds = Array.from(
        new Set(rowsWithRole.map((r) => r.brandId).filter(Boolean))
      ).map(String);

      const campaignIds = Array.from(
        new Set(rowsWithRole.map((r) => r.campaignId).filter(Boolean))
      ).map(String);

      const [brands, campaigns] = await Promise.all([
        brandIds.length
          ? Brand.find({ _id: { $in: brandIds } })
            .select('_id name')
            .lean()
          : [],
        campaignIds.length
          ? Campaign.find({ _id: { $in: campaignIds } })
            .select('_id campaignTitle')
            .lean()
          : [],
      ]);

      const brandMap = new Map(
        (brands || []).map((b) => [String(b._id), b.name])
      );

      const cmap = new Map(
        (campaigns || []).map((c) => [String(c._id), c.campaignTitle])
      );

      const enriched = rowsWithRole.map((r) => {
        const campaignName = r.campaignId
          ? cmap.get(String(r.campaignId)) || null
          : null;

        const role = r.raisedByRole;
        let raisedBy = null;
        let raisedAgainst = null;

        if (role === 'Influencer') {
          // Influencer (viewer) raised it
          raisedBy = {
            role: 'Influencer',
            id: r.influencerId,
            name: influencer.name || null,
          };
          raisedAgainst = {
            role: 'Brand',
            id: r.brandId,
            name: brandMap.get(String(r.brandId)) || null,
          };
        } else if (role === 'Brand') {
          // Brand raised it against this influencer
          raisedBy = {
            role: 'Brand',
            id: r.brandId,
            name: brandMap.get(String(r.brandId)) || null,
          };
          raisedAgainst = {
            role: 'Influencer',
            id: r.influencerId,
            name: influencer.name || null,
          };
        }

        const viewerIsRaiser = role === 'Influencer';

        return {
          ...r,
          campaignName,
          raisedBy,
          raisedAgainst,
          viewerIsRaiser,
        };
      });

      return res.status(200).json({
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
        disputes: enriched,
      });
    } catch (e) {
      console.error('Error enriching influencerList:', e);
      // Fallback: still return raisedByRole info
      return res.status(200).json({
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
        disputes: rowsWithRole,
      });
    }
  } catch (err) {
    console.error('Error in influencerList:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Influencer get dispute-by-id (must match influencerId)
exports.influencerGetById = async (req, res) => {
  try {
    const { id } = req.params;
    const influencerId =
      (req.query && req.query.influencerId) ||
      (req.body && req.body.influencerId);

    if (!id) return res.status(400).json({ message: 'Dispute id is required' });
    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }

    const influencer = await Influencer.findOne({ _id: String(influencerId) }).lean();
    if (!influencer) return res.status(404).json({ message: 'Influencer not found' });

    const d = await Dispute.findOne({ disputeId: id }).lean();
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    if (d.influencerId !== String(influencerId)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Enrich with campaign name + who raised against whom
    try {
      const [campaign, brand] = await Promise.all([
        d.campaignId
          ? Campaign.findOne({ campaignsId: d.campaignId })
            .select('campaignsId campaignTitle')
            .lean()
          : null,
        d.brandId
          ? Brand.findOne({ _id: d.brandId })
            .select('_id name')
            .lean()
          : null,
      ]);

      d.campaignName = campaign?.campaignTitle || null;

      const brandName = brand?.name || null;
      const raisedByRole = d.createdBy?.role || null;

      if (raisedByRole === 'Influencer') {
        d.raisedBy = {
          role: 'Influencer',
          id: d.influencerId,
          name: influencer.name || null,
        };
        d.raisedAgainst = {
          role: 'Brand',
          id: d.brandId,
          name: brandName,
        };
      } else if (raisedByRole === 'Brand') {
        d.raisedBy = {
          role: 'Brand',
          id: d.brandId,
          name: brandName,
        };
        d.raisedAgainst = {
          role: 'Influencer',
          id: d.influencerId,
          name: influencer.name || null,
        };
      } else {
        d.raisedBy = null;
        d.raisedAgainst = null;
      }

      d.raisedByRole = raisedByRole;
      d.raisedById = d.createdBy?.id || null;
      d.viewerIsRaiser = raisedByRole === 'Influencer';
    } catch (e) {
      console.error('Error enriching influencerGetById:', e);
      d.campaignName = d.campaignName || null;
    }

    return res.status(200).json({ dispute: d });
  } catch (err) {
    console.error('Error in influencerGetById:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Influencer add comment (multi-image attachments supported)
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
        brandId: d.brandId,
        type: "dispute.comment_added",
        title: `New comment on Dispute #${d.disputeId}`,
        message: `${influencer?.name || "Influencer"}: ${snippet}${String(text).trim().length > 120 ? "..." : ""}`,
        entityType: "dispute",
        entityId: d.disputeId,
        actionPath: { brand: `/brand/disputes/${d.disputeId}` },
      });
    } catch (e) {
      console.warn("In-app notify failed (influencerAddComment):", e.message);
    }

    return res.status(200).json({ message: "Comment added" });
  } catch (err) {
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
        brandId: dispute.brandId,
        type: "dispute.revoked",
        title: `Dispute #${dispute.disputeId} revoked`,
        message: `${influencer?.name || "Influencer"} revoked the dispute "${dispute.subject}".`,
        entityType: "dispute",
        entityId: dispute.disputeId,
        actionPath: {
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
        brandId: dispute.brandId,
        type: "dispute.updated",
        title: `Dispute #${dispute.disputeId} updated`,
        message: `${influencer?.name || "Influencer"} updated the dispute "${dispute.subject}".`,
        entityType: "dispute",
        entityId: dispute.disputeId,
        actionPath: {
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

    const d = await Dispute.findOne({ disputeId: id }).lean();

    if (!d) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    try {
      const toObjectIdOrNull = (value) => {
        if (!value) return null;
        const str = String(value);
        return mongoose.Types.ObjectId.isValid(str)
          ? new mongoose.Types.ObjectId(str)
          : null;
      };

      const formatSince = (dateValue) => {
        if (!dateValue) return null;
        const date = new Date(dateValue);
        if (Number.isNaN(date.getTime())) return null;

        return date.toLocaleString("en-US", {
          month: "short",
          year: "numeric",
        });
      };

      const brandObjectId = toObjectIdOrNull(d.brandId);
      const influencerObjectId = toObjectIdOrNull(d.influencerId);
      const campaignObjectId = toObjectIdOrNull(d.campaignId);

      const [b, inf, camp, modash] = await Promise.all([
        brandObjectId
          ? Brand.findOne({ _id: brandObjectId })
            .select("_id name email createdAt logoUrl brandLogoUrl profileImage profilePic image avatar avatarUrl")
            .lean()
          : null,

        influencerObjectId
          ? Influencer.findOne({ _id: influencerObjectId })
            .select("_id name email createdAt")
            .lean()
          : null,

        campaignObjectId
          ? Campaign.findOne({ _id: campaignObjectId })
            .select("_id campaignTitle")
            .lean()
          : null,

        d.influencerId
          ? Modash.findOne({
            $or: [
              { influencerId: String(d.influencerId) },
              { influencer: influencerObjectId || d.influencerId },
            ],
          })
            .select("picture handle username provider updatedAt")
            .sort({ updatedAt: -1 })
            .lean()
          : null,
      ]);

      const brandImage =
        b?.logoUrl ||
        b?.brandLogoUrl ||
        b?.profileImage ||
        b?.profilePic ||
        b?.avatarUrl ||
        b?.avatar ||
        b?.image ||
        null;

      const influencerImage = modash?.picture || null;

      const brandSince = formatSince(b?.createdAt);
      const influencerSince = formatSince(inf?.createdAt);

      d.brandName = b?.name || null;
      d.influencerName = inf?.name || null;
      d.campaignName = camp?.campaignTitle || null;

      d.brandEmail = b?.email || null;
      d.influencerEmail = inf?.email || null;

      d.brandLogoUrl = brandImage;
      d.influencerProfileImage = influencerImage;
      d.influencerHandle = modash?.handle || modash?.username || null;
      d.influencerProvider = modash?.provider || null;

      d.brandSince = brandSince;
      d.influencerSince = influencerSince;

      const raisedByRole = d.createdBy?.role || null;

      if (raisedByRole === "Brand") {
        d.raisedBy = {
          role: "Brand",
          id: d.brandId,
          name: b?.name || null,
          email: b?.email || null,
          logoUrl: brandImage,
          since: brandSince,
        };

        d.raisedAgainst = {
          role: "Influencer",
          id: d.influencerId,
          name: inf?.name || null,
          email: inf?.email || null,
          logoUrl: influencerImage,
          since: influencerSince,
        };
      } else if (raisedByRole === "Influencer") {
        d.raisedBy = {
          role: "Influencer",
          id: d.influencerId,
          name: inf?.name || null,
          email: inf?.email || null,
          logoUrl: influencerImage,
          since: influencerSince,
        };

        d.raisedAgainst = {
          role: "Brand",
          id: d.brandId,
          name: b?.name || null,
          email: b?.email || null,
          logoUrl: brandImage,
          since: brandSince,
        };
      } else {
        d.raisedBy = null;
        d.raisedAgainst = null;
      }

      d.raisedByRole = raisedByRole;
      d.raisedById = d.createdBy?.id || null;
    } catch (e) {
      console.error("Error enriching adminGetById:", e);

      d.brandName = null;
      d.influencerName = null;
      d.campaignName = null;
      d.brandEmail = null;
      d.influencerEmail = null;
      d.brandLogoUrl = null;
      d.influencerProfileImage = null;
      d.influencerHandle = null;
      d.influencerProvider = null;
      d.brandSince = null;
      d.influencerSince = null;
      d.raisedBy = null;
      d.raisedAgainst = null;
      d.raisedByRole = d.createdBy?.role || null;
      d.raisedById = d.createdBy?.id || null;
    }

    return res.status(200).json({ dispute: d });
  } catch (err) {
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
        ? await Admin.findOne({ adminId: String(adminId) })
          .select("adminId name email")
          .lean()
        : null);

    const uploadedAttachments = await buildAttachmentsFromReq(req, attachments);

    if (!uploadedAttachments.length) {
      return res.status(400).json({
        message: "Please attach at least one evidence file",
      });
    }

    const actorId =
      admin?.adminId ||
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
        brandId: dispute.brandId,
        influencerId: dispute.influencerId,
        type: "dispute.evidence_added",
        title: `Evidence added to Dispute #${dispute.disputeId}`,
        message: `${actorName} added evidence "${trimmedEvidenceName}".`,
        entityType: "dispute",
        entityId: dispute.disputeId,
        actionPath: {
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
        ? await Admin.findOne({ adminId: String(adminId) })
          .select("adminId name email")
          .lean()
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

    const actorId = admin?.adminId || adminId || req.user?.id || "system";

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
    } = req.body || {};

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

    const filter = {};

    const normalizedStatus = normalizeStatusInput(status, { allowZeroAll: true });
    if (normalizedStatus && normalizedStatus !== "__ALL__") {
      filter.status = normalizedStatus;
    }

    if (campaignId) filter.campaignId = String(campaignId);
    if (brandId) filter.brandId = String(brandId);
    if (influencerId) filter.influencerId = String(influencerId);

    const searchTerm = typeof search === "string" ? search.trim() : "";
    if (searchTerm) {
      const pattern = escapeRegex(searchTerm);
      const re = new RegExp(pattern, "i");
      filter.$or = [{ subject: re }, { description: re }, { disputeId: re }];
    }

    if (appliedBy && typeof appliedBy === "string") {
      const role = String(appliedBy).toLowerCase();
      if (role === "brand") filter["createdBy.role"] = "Brand";
      if (role === "influencer") filter["createdBy.role"] = "Influencer";
    }

    const total = await Dispute.countDocuments(filter);

    const rows = await Dispute.find(filter)
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean();

    try {
      const uniqueBrandIds = [...new Set(rows.map((r) => r.brandId).filter(Boolean))];
      const uniqueInfluencerIds = [...new Set(rows.map((r) => r.influencerId).filter(Boolean))];
      const uniqueCampaignIds = [...new Set(rows.map((r) => r.campaignId).filter(Boolean))];

      const toObjectIds = (ids = []) =>
        ids
          .map((id) => String(id))
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
          .map((id) => new mongoose.Types.ObjectId(id));

      const brandObjectIds = toObjectIds(uniqueBrandIds);
      const influencerObjectIds = toObjectIds(uniqueInfluencerIds);
      const campaignObjectIds = toObjectIds(uniqueCampaignIds);

      const [brands, influencers, campaigns] = await Promise.all([
        brandObjectIds.length
          ? Brand.find({ _id: { $in: brandObjectIds } })
            .select("_id name brandName companyName")
            .lean()
          : [],
        influencerObjectIds.length
          ? Influencer.find({ _id: { $in: influencerObjectIds } })
            .select("_id name fullName influencerName username")
            .lean()
          : [],
        campaignObjectIds.length
          ? Campaign.find({ _id: { $in: campaignObjectIds } })
            .select("_id campaignTitle title name")
            .lean()
          : [],
      ]);

      const brandMap = new Map(
        (brands || []).map((b) => [
          String(b._id),
          b.name || b.brandName || b.companyName || null,
        ])
      );

      const influencerMap = new Map(
        (influencers || []).map((i) => [
          String(i._id),
          i.name || i.fullName || i.influencerName || i.username || null,
        ])
      );

      const campaignMap = new Map(
        (campaigns || []).map((c) => [
          String(c._id),
          c.campaignTitle || c.title || c.name || null,
        ])
      );

      const enriched = rows.map((r) => {
        const raisedByRole = r.createdBy?.role || null;

        return {
          ...r,
          brandName: brandMap.get(String(r.brandId)) || null,
          influencerName: influencerMap.get(String(r.influencerId)) || null,
          campaignName: r.campaignId
            ? campaignMap.get(String(r.campaignId)) || null
            : null,
          raisedByRole,
          raisedById: r.createdBy?.id || null,
        };
      });

      return res.status(200).json({
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
        disputes: enriched,
      });
    } catch (e) {
      console.error("Error enriching adminList:", e);
      return res.status(200).json({
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
        disputes: rows,
      });
    }
  } catch (err) {
    console.error("Error in adminList:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Admin update status
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
      admin = await Admin.findOne({ adminId: String(adminId) })
        .select("adminId name email")
        .lean();
    }

    const actorId = admin ? admin.adminId : adminId || "system";

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
        brandId: d.brandId,
        influencerId: d.influencerId,
        type: "dispute.status_updated",
        title: `Dispute #${d.disputeId} status updated`,
        message: `${adminName} changed status from "${STATUS_LABELS[prevStatus] || prevStatus}" to "${STATUS_LABELS[d.status] || d.status}".${resolutionText}`,
        entityType: "dispute",
        entityId: d.disputeId,
        actionPath: {
          brand: `/brand/disputes/${d.disputeId}`,
          influencer: `/influencer/disputes/${d.disputeId}`,
        },
      });
    } catch (e) {
      console.warn("In-app notify failed (adminUpdateStatus):", e.message);
    }

    if (d.status === "resolved") {
      const [brand, influencer] = await Promise.all([
        Brand.findOne({ brandId: d.brandId }).lean(),
        Influencer.findOne({ influencerId: d.influencerId }).lean(),
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
    console.error("Error in adminUpdateStatus:", err);
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
        const a = await Admin.findOne({ adminId: targetAdminId })
          .select('email name')
          .lean();
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
        brandId: d.brandId,
        influencerId: d.influencerId,
        type: 'dispute.assigned',
        title: `Dispute #${d.disputeId} assigned`,
        message: `Your dispute has been assigned to our team.`,
        entityType: 'dispute',
        entityId: d.disputeId,
        actionPath: {
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
    console.error('Error in influencerCampaignsForDispute:', err);
    return res.status(500).json({
      message:
        'Internal server error while fetching campaigns for dispute.',
    });
  }
};
