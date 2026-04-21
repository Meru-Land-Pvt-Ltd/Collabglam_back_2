const ProspectBrand = require("../models/prospectBrand");
const OutreachCampaign = require("../models/outreachCampaign");
const ReplyReviewQueue = require("../models/replyReviewQueue");
const OutreachMailboxAssignment = require("../models/outreachMailboxAssignment");
const { ConversationThread, ConversationMessage } = require("../models/conversationThread");
const { normalizeInstantlyWebhook } = require("../utils/instantlyWebhookNormalizer");
const {
  PROSPECT_STAGE,
  OWNER_ROLE,
  REVIEW_STATUS,
  THREAD_STATUS,
} = require("../constants/outreach");

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isReplyEventName(eventName = "") {
  const normalized = String(eventName).toLowerCase();
  return (
    normalized.includes("reply") ||
    normalized.includes("replied") ||
    normalized.includes("email.reply")
  );
}

function resolveCampaignSenderEmail(payload, prospect, campaign, thread) {
  return (
    normalizeEmail(payload.accountEmail) ||
    normalizeEmail(thread?.mailboxes?.currentReplyFromEmail) ||
    normalizeEmail(thread?.mailboxes?.campaignSenderEmail) ||
    normalizeEmail(prospect?.instantly?.senderAccountEmail) ||
    normalizeEmail(campaign?.instantly?.senderAccountEmail) ||
    normalizeEmail(campaign?.instantly?.accountEmails?.[0]) ||
    ""
  );
}

function buildThreadUpdate({
  ownerRole,
  ownerId,
  campaign,
  prospect,
  payload,
  existingThread,
  campaignSenderEmail,
  resolvedThreadId,
}) {
  const existingMailboxes = existingThread?.mailboxes || {};

  const nextMailboxes = {
    campaignSenderEmail:
      campaignSenderEmail || existingMailboxes.campaignSenderEmail || "",
    currentReplyFromEmail:
      existingMailboxes.currentReplyFromEmail ||
      campaignSenderEmail ||
      existingMailboxes.campaignSenderEmail ||
      "",
    RHEmail: existingMailboxes.RHEmail || campaign?.teamMailboxes?.RHEmail || "",
    bmeEmail: existingMailboxes.bmeEmail || "",
    imeEmail: existingMailboxes.imeEmail || campaign?.teamMailboxes?.IMEEmail || "",
  };

  if (ownerRole === OWNER_ROLE.REVENUE_HEAD) {
    nextMailboxes.currentReplyFromEmail =
      nextMailboxes.RHEmail ||
      nextMailboxes.currentReplyFromEmail ||
      nextMailboxes.campaignSenderEmail;
  }

  if (ownerRole === OWNER_ROLE.BME) {
    nextMailboxes.currentReplyFromEmail =
      nextMailboxes.bmeEmail ||
      nextMailboxes.currentReplyFromEmail ||
      nextMailboxes.campaignSenderEmail;
  }

  if (ownerRole === OWNER_ROLE.IME) {
    nextMailboxes.currentReplyFromEmail =
      nextMailboxes.imeEmail ||
      nextMailboxes.currentReplyFromEmail ||
      nextMailboxes.campaignSenderEmail;
  }

  return {
    campaignId: campaign?._id || null,
    ownerRole,
    ownerId,
    instantlyThreadId: resolvedThreadId,
    instantlyCampaignId:
      prospect.instantly?.campaignId ||
      campaign?.instantly?.campaignId ||
      existingThread?.instantlyCampaignId ||
      "",
    mailboxes: nextMailboxes,
    subject: payload.subject || existingThread?.subject || "",
    brandEmail: prospect.primaryContact.email,
    brandName: prospect.companyName,
    status: THREAD_STATUS.WAITING_ON_US,
    lastMessageAt: new Date(),
    lastInboundAt: new Date(),
    unreadForRevenueHead: ownerRole === OWNER_ROLE.REVENUE_HEAD,
    unreadForBme: ownerRole === OWNER_ROLE.BME,
    unreadForIme: ownerRole === OWNER_ROLE.IME,
  };
}

exports.handleInstantlyWebhook = async (req, res) => {
  try {
    const payload = normalizeInstantlyWebhook(req.body);

    if (!isReplyEventName(payload.event)) {
      return res.status(200).json({
        success: true,
        message: "Ignored event",
      });
    }

    const prospect = await ProspectBrand.findOne({
      "primaryContact.email": normalizeEmail(payload.email),
    });

    if (!prospect) {
      return res.status(200).json({
        success: true,
        message: "Prospect not found, event ignored",
      });
    }

    const campaignId =
      String(payload.campaignId || "").trim() ||
      String(prospect.instantly?.campaignId || "").trim();

    const campaign = campaignId
      ? await OutreachCampaign.findOne({
          "instantly.campaignId": campaignId,
        })
      : null;

    const existingThread = await ConversationThread.findOne({
      prospectId: prospect._id,
    });

const resolvedThreadId =
  String(payload.threadId || "").trim() ||
  String(existingThread?.instantlyThreadId || "").trim() ||
  String(prospect.instantly?.threadId || "").trim() ||
  "";
    const campaignSenderEmail = resolveCampaignSenderEmail(
      payload,
      prospect,
      campaign,
      existingThread
    );

    const senderMailbox = campaignSenderEmail
      ? await OutreachMailboxAssignment.findOne({
          email: campaignSenderEmail,
          isActive: true,
        }).lean()
      : null;

    const isImeCampaign =
      campaign?.flowType === "ime_influencer" ||
      prospect?.flowType === "ime_influencer";

    let route = "FIRST_STANDARD_REPLY";
    let ownerRole = OWNER_ROLE.REVENUE_HEAD;
    let ownerId = prospect.RHId || null;

    if (
      existingThread?.ownerRole === OWNER_ROLE.IME ||
      senderMailbox?.role === OWNER_ROLE.IME ||
      isImeCampaign
    ) {
      route = "IME_CONTINUATION";
      ownerRole = OWNER_ROLE.IME;
      ownerId =
        existingThread?.ownerId ||
        senderMailbox?.adminId ||
        prospect.assignedImeId ||
        campaign?.IMEId ||
        null;
    } else if (
      existingThread?.ownerRole === OWNER_ROLE.BME ||
      senderMailbox?.role === OWNER_ROLE.BME ||
      prospect.stage === PROSPECT_STAGE.ASSIGNED_TO_BME
    ) {
      route = "BME_CONTINUATION";
      ownerRole = OWNER_ROLE.BME;
      ownerId =
        existingThread?.ownerId ||
        prospect.assignedBmeId ||
        null;
    } else if (
      existingThread?.ownerRole === OWNER_ROLE.REVENUE_HEAD ||
      senderMailbox?.role === OWNER_ROLE.REVENUE_HEAD ||
      prospect.currentOwnerRole === OWNER_ROLE.REVENUE_HEAD
    ) {
      route = "RH_CONTINUATION";
      ownerRole = OWNER_ROLE.REVENUE_HEAD;
      ownerId =
        existingThread?.ownerId ||
        prospect.RHId ||
        null;
    }

    prospect.reply.received = true;
    prospect.reply.firstReplyAt = prospect.reply.firstReplyAt || new Date();
    prospect.reply.lastReplyAt = new Date();
    prospect.reply.snippet = payload.snippet || payload.bodyText || "";
    prospect.reply.subject = payload.subject || "";
    prospect.instantly.threadId = resolvedThreadId || prospect.instantly.threadId;
    prospect.instantly.lastEmailId = payload.emailId || prospect.instantly.lastEmailId;
    prospect.instantly.senderAccountEmail =
      campaignSenderEmail || prospect.instantly.senderAccountEmail;

    if (route === "IME_CONTINUATION") {
      prospect.assignedImeId = ownerId || prospect.assignedImeId;
      prospect.currentOwnerRole = OWNER_ROLE.IME;
      prospect.currentOwnerId = ownerId || prospect.currentOwnerId;
      prospect.stage = PROSPECT_STAGE.ASSIGNED_TO_IME;
      prospect.sdrWriteLocked = true;
    } else if (route === "BME_CONTINUATION") {
      prospect.assignedBmeId = ownerId || prospect.assignedBmeId;
      prospect.currentOwnerRole = OWNER_ROLE.BME;
      prospect.currentOwnerId = ownerId || prospect.currentOwnerId;
      prospect.stage = PROSPECT_STAGE.ASSIGNED_TO_BME;
      prospect.sdrWriteLocked = true;
    } else {
      prospect.currentOwnerRole = OWNER_ROLE.REVENUE_HEAD;
      prospect.currentOwnerId = ownerId || prospect.currentOwnerId;
      prospect.stage = PROSPECT_STAGE.REPLIED_PENDING_REVIEW;
      prospect.sdrWriteLocked = true;
    }

    await prospect.save();

    const threadUpdate = buildThreadUpdate({
      ownerRole,
      ownerId,
      campaign,
      prospect,
      payload,
      existingThread,
      campaignSenderEmail,
      resolvedThreadId,
    });

    const thread = await ConversationThread.findOneAndUpdate(
      { prospectId: prospect._id },
      { $set: threadUpdate },
      { new: true, upsert: true }
    );

    await ConversationMessage.create({
      threadId: thread._id,
      prospectId: prospect._id,
      direction: "inbound",
      provider: "instantly",
      providerMessageId: payload.emailId || "",
      providerThreadId: resolvedThreadId,
      from: prospect.primaryContact.email,
      to: campaignSenderEmail ? [campaignSenderEmail] : [],
      subject: payload.subject || "",
      bodyText: payload.bodyText || payload.snippet || "",
      receivedAt: new Date(),
    });

    if (route === "FIRST_STANDARD_REPLY") {
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
            assignedBmeId: null,
            instantlyThreadId: resolvedThreadId,
            instantlyEmailId: payload.emailId || "",
            latestReplySnippet: payload.snippet || payload.bodyText || "",
            latestReplySubject: payload.subject || "",
            reviewStatus: REVIEW_STATUS.PENDING,
          },
        },
        { new: true, upsert: true }
      );
    }

    if (campaign?._id) {
      await OutreachCampaign.findByIdAndUpdate(campaign._id, {
        $inc: { "stats.totalReplies": 1 },
      });
    }

    return res.status(200).json({
      success: true,
      message:
        route === "IME_CONTINUATION"
          ? "Reply assigned to IME"
          : route === "BME_CONTINUATION"
            ? "Reply assigned to BME"
            : route === "RH_CONTINUATION"
              ? "Reply assigned to Revenue Head"
              : "Reply queued for Revenue Head review",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};