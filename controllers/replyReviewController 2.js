const ProspectBrand = require("../models/prospectBrand");
const ReplyReviewQueue = require("../models/replyReviewQueue");
const OutreachCampaign = require("../models/outreachCampaign");
const { ConversationThread } = require("../models/conversationThread");
const {
  PROSPECT_STAGE,
  OWNER_ROLE,
  REVIEW_STATUS,
} = require("../constants/outreach");
const { validateOutreachTeam, ensureRole } = require("../utils/outreachGuards");

exports.listPendingReplies = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "super_admin"]);

    const filter =
      req.admin.role === "revenue_head"
        ? { RHId: req.admin.adminId, reviewStatus: REVIEW_STATUS.PENDING }
        : { reviewStatus: REVIEW_STATUS.PENDING };

    const rows = await ReplyReviewQueue.find(filter)
      .populate("prospectId", "companyName primaryContact reply stage")
      .populate("sdrId", "name email")
      .populate("suggestedBmeId", "name email")
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};

exports.rejectReply = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "super_admin"]);

    const { reviewId } = req.params;
    const { disposition = "not_relevant", reviewerNotes = "" } = req.body;

    const review = await ReplyReviewQueue.findById(reviewId);
    if (!review) {
      return res.status(404).json({ success: false, message: "Review item not found" });
    }

    if (
      req.admin.role === "revenue_head" &&
      String(review.RHId) !== String(req.admin.adminId)
    ) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    await ProspectBrand.findByIdAndUpdate(review.prospectId, {
      $set: {
        stage: PROSPECT_STAGE.UNQUALIFIED,
        currentOwnerRole: OWNER_ROLE.REVENUE_HEAD,
        currentOwnerId: review.RHId,
      },
    });

    review.reviewStatus = REVIEW_STATUS.UNQUALIFIED;
    review.disposition = disposition;
    review.reviewerNotes = reviewerNotes;
    review.reviewedBy = req.admin.adminId;
    review.reviewedAt = new Date();
    await review.save();

    return res.status(200).json({ success: true, message: "Reply marked unqualified" });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};

exports.assignReplyToBme = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "super_admin"]);

    const { reviewId } = req.params;
    const { assignedBmeId, reviewerNotes = "" } = req.body;

    const review = await ReplyReviewQueue.findById(reviewId);
    if (!review) {
      return res.status(404).json({ success: false, message: "Review item not found" });
    }

    if (
      req.admin.role === "revenue_head" &&
      String(review.RHId) !== String(req.admin.adminId)
    ) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const prospect = await ProspectBrand.findById(review.prospectId);
    if (!prospect) {
      return res.status(404).json({ success: false, message: "Prospect not found" });
    }

    await validateOutreachTeam({
      sdrId: prospect.sdrId,
      RHId: prospect.RHId,
      bmeId: assignedBmeId,
    });

    prospect.assignedBmeId = assignedBmeId;
    prospect.currentOwnerRole = OWNER_ROLE.BME;
    prospect.currentOwnerId = assignedBmeId;
    prospect.stage = PROSPECT_STAGE.ASSIGNED_TO_BME;
    prospect.qualifiedAt = new Date();
    prospect.handedOffAt = new Date();
    prospect.sdrWriteLocked = true;
    await prospect.save();

    await ConversationThread.findOneAndUpdate(
      { prospectId: prospect._id },
      {
        $set: {
          ownerRole: OWNER_ROLE.BME,
          ownerId: assignedBmeId,
          handoffAt: new Date(),
          unreadForBme: true,
        },
      },
      { upsert: true }
    );

    review.reviewStatus = REVIEW_STATUS.ASSIGNED;
    review.disposition = "qualified";
    review.reviewerNotes = reviewerNotes;
    review.assignedBmeId = assignedBmeId;
    review.reviewedBy = req.admin.adminId;
    review.reviewedAt = new Date();
    review.assignedAt = new Date();
    await review.save();

    await OutreachCampaign.findByIdAndUpdate(review.campaignId, {
      $inc: {
        "stats.totalQualified": 1,
        "stats.totalAssigned": 1,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Reply assigned to BME successfully",
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};