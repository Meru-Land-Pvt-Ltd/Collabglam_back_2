const ProspectBrand = require("../models/prospectBrand");
const OutreachCampaign = require("../models/outreachCampaign");
const ReplyReviewQueue = require("../models/replyReviewQueue");
const { ConversationThread, ConversationMessage } = require("../models/conversationThread");
const { normalizeInstantlyWebhook } = require("../utils/instantlyWebhookNormalizer");
const {
  PROSPECT_STAGE,
  OWNER_ROLE,
  REVIEW_STATUS,
} = require("../constants/outreach");

exports.handleInstantlyWebhook = async (req, res) => {
  try {
    const secret = req.headers["x-webhook-secret"];
    if (!secret || secret !== process.env.INSTANTLY_WEBHOOK_SECRET) {
      return res.status(401).json({ success: false, message: "Invalid webhook secret" });
    }

    const payload = normalizeInstantlyWebhook(req.body);

    // Adjust this condition to your final Instantly webhook event names.
    const isReplyEvent =
      payload.event.includes("reply") ||
      payload.event.includes("replied") ||
      payload.event.includes("email.reply");

    if (!isReplyEvent) {
      return res.status(200).json({ success: true, message: "Ignored event" });
    }

    const prospect = await ProspectBrand.findOne({
      "primaryContact.email": payload.email,
    });

    if (!prospect) {
      return res.status(200).json({
        success: true,
        message: "Prospect not found, event ignored",
      });
    }

    let campaign = null;
    if (prospect.instantly.campaignId) {
      campaign = await OutreachCampaign.findOne({
        "instantly.campaignId": prospect.instantly.campaignId,
      });
    }

    prospect.reply.received = true;
    prospect.reply.firstReplyAt = prospect.reply.firstReplyAt || new Date();
    prospect.reply.lastReplyAt = new Date();
    prospect.reply.snippet = payload.snippet || payload.bodyText || "";
    prospect.reply.subject = payload.subject || "";
    prospect.stage = PROSPECT_STAGE.REPLIED_PENDING_REVIEW;
    prospect.sdrWriteLocked = true;
    prospect.currentOwnerRole = OWNER_ROLE.REVENUE_HEAD;
    prospect.currentOwnerId = prospect.RHId;
    prospect.instantly.threadId = payload.threadId || prospect.instantly.threadId;
    prospect.instantly.lastEmailId = payload.emailId || prospect.instantly.lastEmailId;
    await prospect.save();

    const thread = await ConversationThread.findOneAndUpdate(
      { prospectId: prospect._id },
      {
        $set: {
          campaignId: campaign?._id || null,
          ownerRole: OWNER_ROLE.REVENUE_HEAD,
          ownerId: prospect.RHId,
          instantlyThreadId: payload.threadId || "",
          instantlyCampaignId: prospect.instantly.campaignId || "",
          subject: payload.subject || "",
          brandEmail: prospect.primaryContact.email,
          brandName: prospect.companyName,
          lastMessageAt: new Date(),
          lastInboundAt: new Date(),
          unreadForBme: true,
        },
      },
      { new: true, upsert: true }
    );

    await ConversationMessage.create({
      threadId: thread._id,
      prospectId: prospect._id,
      direction: "inbound",
      provider: "instantly",
      providerMessageId: payload.emailId || "",
      providerThreadId: payload.threadId || "",
      from: prospect.primaryContact.email,
      to: [],
      subject: payload.subject || "",
      bodyText: payload.bodyText || payload.snippet || "",
      receivedAt: new Date(),
    });

    await ReplyReviewQueue.findOneAndUpdate(
      {
        prospectId: prospect._id,
        reviewStatus: REVIEW_STATUS.PENDING,
      },
      {
        $set: {
          campaignId: campaign?._id || null,
          sdrId: prospect.sdrId,
          RHId: prospect.RHId,
          suggestedBmeId: prospect.preAssignedBmeId,
          instantlyThreadId: payload.threadId || "",
          instantlyEmailId: payload.emailId || "",
          latestReplySnippet: payload.snippet || payload.bodyText || "",
          latestReplySubject: payload.subject || "",
          reviewStatus: REVIEW_STATUS.PENDING,
        },
      },
      { new: true, upsert: true }
    );

    if (campaign?._id) {
      await OutreachCampaign.findByIdAndUpdate(campaign._id, {
        $inc: { "stats.totalReplies": 1 },
      });
    }

    return res.status(200).json({ success: true, message: "Reply processed" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};