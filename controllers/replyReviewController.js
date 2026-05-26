const { Types } = require("mongoose");
const ReplyReviewQueue = require("../models/replyReviewQueue");
const ProspectBrand = require("../models/prospectBrand");
const { ConversationThread } = require("../models/conversationThread");
const { AdminModel, ROLES } = require("../models/master");
const { PROSPECT_STAGE, REVIEW_STATUS, OWNER_ROLE } = require("../constants/outreach");
const { createAndEmit } = require("../utils/notifier");
const saveErrorLog = require("../services/errorLog.service");

const BME_ROLE = ROLES?.BME || "bme";

function uniqueNotificationIds(values = []) {
  return [
    ...new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    ),
  ];
}

function buildCrmRepliesAdminPath() {
  return "/admin/crm/review-queue";
}

function getActorPayloadFromReq(req = {}) {
  const admin = req?.admin || req?.user || {};
  const actorAdminId = String(admin.adminId || admin._id || "").trim();

  return {
    actorAdminId: actorAdminId || null,
    actorName: String(admin.name || "").trim(),
    actorEmail: String(admin.email || "").trim().toLowerCase(),
    actorRole: String(admin.role || "").trim().toLowerCase(),
  };
}

async function notifySafely(context, req, payload) {
  try {
    return await createAndEmit({
      ...getActorPayloadFromReq(req),
      ...(payload || {}),
    });
  } catch (error) {
    console.warn(`${context} notification failed:`, error?.message || error);
    return null;
  }
}


function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
}

function isRevenueHeadRole(role) {
  const value = normalizeRole(role);
  return value === "revenue_head" || value === "rh";
}

function ensureRole(admin, allowed = []) {
  const role = normalizeRole(admin?.role);
  const normalizedAllowed = allowed.map((item) => normalizeRole(item));

  const isAllowed = normalizedAllowed.some((item) => {
    if (item === "revenue_head" || item === "rh") {
      return isRevenueHeadRole(role);
    }
    return item === role;
  });

  if (!admin?.adminId || !isAllowed) {
    const error = new Error("Forbidden");
    error.statusCode = 403;
    throw error;
  }
}

function buildReviewScope(admin) {
  const role = normalizeRole(admin?.role);
  const adminId = String(admin?.adminId || "");

  if (role === "super_admin") return {};
  if (isRevenueHeadRole(role)) return { RHId: adminId };

  const error = new Error("Forbidden");
  error.statusCode = 403;
  throw error;
}

async function getScopedReview(admin, reviewId) {
  const scope = buildReviewScope(admin);

  const review = await ReplyReviewQueue.findOne({
    _id: reviewId,
    ...scope,
  });

  if (!review) {
    const error = new Error("Review not found");
    error.statusCode = 404;
    throw error;
  }

  return review;
}

exports.listPendingReplies = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "super_admin"]);

    const scope = buildReviewScope(req.admin);
    const filter = {
      ...scope,
      reviewStatus: REVIEW_STATUS.PENDING,
    };

    if (String(req.query?.campaignId || "").trim()) {
      filter.campaignId = String(req.query.campaignId).trim();
    }

    if (
      normalizeRole(req.admin?.role) === "super_admin" &&
      String(req.query?.RHId || "").trim()
    ) {
      filter.RHId = String(req.query.RHId).trim();
    }

    if (String(req.query?.sdrId || "").trim()) {
      filter.sdrId = String(req.query.sdrId).trim();
    }

    if (String(req.query?.assignedBmeId || "").trim()) {
      filter.assignedBmeId = String(req.query.assignedBmeId).trim();
    }

    const rows = await ReplyReviewQueue.find(filter)
      .populate("campaignId", "name")
      .populate("prospectId", "companyName primaryContact reply stage")
      .populate("sdrId", "name email role")
      .populate("RHId", "name email role")
      .populate("assignedBmeId", "name email role")
      .sort({ createdAt: -1 })
      .lean();

    const rowsWithFallbackCampaign = await Promise.all(
      rows.map(async (item) => {
        if (item?.campaignId?._id || !item?.prospectId?._id) {
          return item;
        }

        const thread = await ConversationThread.findOne({
          prospectId: item.prospectId._id,
        })
          .populate("campaignId", "name")
          .lean();

        if (thread?.campaignId?._id) {
          item.campaignId = {
            _id: thread.campaignId._id,
            name: thread.campaignId.name || "Unnamed Campaign",
          };
        }

        return item;
      })
    );

    const shouldHideBrandEmail = normalizeRole(req.admin?.role) !== "super_admin";

    const sanitizedRows = rowsWithFallbackCampaign.map((item) => {
      const primaryContact = item?.prospectId?.primaryContact || {};

      return {
        ...item,
        prospectId: item.prospectId
          ? {
              ...item.prospectId,
              primaryContact: {
                ...primaryContact,
                email: shouldHideBrandEmail ? "" : primaryContact.email || "",
              },
            }
          : null,
      };
    });

    const search = String(req.query?.search || "").trim().toLowerCase();

    const data = search
      ? sanitizedRows.filter((item) => {
          const haystack = [
            item?.campaignId?.name,
            item?.prospectId?.companyName,
            item?.prospectId?.primaryContact?.name,
            shouldHideBrandEmail ? "" : item?.prospectId?.primaryContact?.email,
            item?.latestReplySubject,
            item?.latestReplySnippet,
            item?.prospectId?.stage,
            item?.sdrId?.name,
            item?.sdrId?.email,
            item?.RHId?.name,
            item?.RHId?.email,
            item?.assignedBmeId?.name,
            item?.assignedBmeId?.email,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          return haystack.includes(search);
        })
      : sanitizedRows;

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "LIST_PENDING_REPLIES_ERROR"
    );

    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to load pending replies",
    });
  }
};

exports.assignReplyToBme = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "super_admin"]);

    const review = await getScopedReview(req.admin, req.params.reviewId);
    const assignedBmeId = String(req.body?.assignedBmeId || "").trim();
    const reviewerNotes = String(req.body?.reviewerNotes || "").trim();

    if (!assignedBmeId) {
      return res.status(400).json({
        success: false,
        message: "assignedBmeId is required",
      });
    }

    if (!Types.ObjectId.isValid(assignedBmeId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid assignedBmeId",
      });
    }

    const bme = await AdminModel.findOne({
      _id: new Types.ObjectId(assignedBmeId),
      role: BME_ROLE,
      status: "active",
    }).select("_id name email role");

    if (!bme) {
      return res.status(404).json({
        success: false,
        message: "Selected BME not found or inactive",
      });
    }

    review.assignedBmeId = bme._id;
    review.reviewStatus = REVIEW_STATUS.ASSIGNED;
    review.reviewerNotes = reviewerNotes;
    review.reviewedBy = req.admin.adminId;
    review.reviewedAt = new Date();
    review.assignedAt = new Date();
    await review.save();

    if (review.prospectId) {
      await ProspectBrand.findByIdAndUpdate(review.prospectId, {
        $set: {
          assignedBmeId: bme._id,
          currentOwnerRole: OWNER_ROLE.BME,
          currentOwnerId: bme._id,
          stage: PROSPECT_STAGE.ASSIGNED_TO_BME,
          handedOffAt: new Date(),
          sdrWriteLocked: true,
        },
      });
    }

    const updatedThread = await ConversationThread.findOneAndUpdate(
      { prospectId: review.prospectId },
      {
        $set: {
          ownerRole: OWNER_ROLE.BME,
          ownerId: bme._id,
          status: "waiting_on_us",
          unreadForRevenueHead: false,
          unreadForBme: true,
        },
      },
      { new: true }
    );

    await notifySafely("assignReplyToBme", req, {
      adminIds: uniqueNotificationIds([bme._id]),
      type: "outreach.reply_assigned_to_bme",
      title: "Reply assigned to BME",
      message: `A pending reply was assigned to ${bme.name || bme.email || "BME"}.`,
      entityType: "outreach_reply",
      entityId: String(review._id),
      actionPath: {
        admin: buildCrmRepliesAdminPath({
          threadId: updatedThread?._id,
          prospectId: review.prospectId,
        }),
      },
    });

    return res.status(200).json({
      success: true,
      message: "Reply assigned to BME successfully",
      data: review,
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "ASSIGN_REPLY_TO_BME_ERROR"
    );

    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to assign reply to BME",
    });
  }
};

exports.rejectReply = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "super_admin"]);

    const review = await getScopedReview(req.admin, req.params.reviewId);
    const reviewerNotes = String(req.body?.reviewerNotes || "").trim();
    const disposition = String(req.body?.disposition || "not_relevant").trim().toLowerCase();

    review.reviewStatus = REVIEW_STATUS.UNQUALIFIED;
    review.disposition = disposition;
    review.reviewerNotes = reviewerNotes;
    review.reviewedBy = req.admin.adminId;
    review.reviewedAt = new Date();
    await review.save();

    if (review.prospectId) {
      await ProspectBrand.findByIdAndUpdate(review.prospectId, {
        $set: {
          stage: PROSPECT_STAGE.UNQUALIFIED,
          currentOwnerRole: OWNER_ROLE.REVENUE_HEAD,
          currentOwnerId: review.RHId || null,
          closedAt: new Date(),
          sdrWriteLocked: true,
        },
      });
    }

    const updatedThread = await ConversationThread.findOneAndUpdate(
      { prospectId: review.prospectId },
      {
        $set: {
          status: "closed",
          unreadForRevenueHead: false,
          unreadForBme: false,
          unreadForIme: false,
        },
      },
      { new: true }
    );

    await notifySafely("rejectReply", req, {
      adminIds: uniqueNotificationIds([review.RHId, review.reviewedBy]),
      type: "outreach.reply_rejected",
      title: "Reply marked unqualified",
      message: "A pending reply was marked unqualified.",
      entityType: "outreach_reply",
      entityId: String(review._id),
      actionPath: {
        admin: buildCrmRepliesAdminPath({
          threadId: updatedThread?._id,
          prospectId: review.prospectId,
        }),
      },
    });

    return res.status(200).json({
      success: true,
      message: "Reply marked unqualified",
      data: review,
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "REJECT_REPLY_ERROR"
    );

    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to reject reply",
    });
  }
};