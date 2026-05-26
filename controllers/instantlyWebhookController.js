const ProspectBrand = require("../models/prospectBrand");
const OutreachCampaign = require("../models/outreachCampaign");
const ReplyReviewQueue = require("../models/replyReviewQueue");
const OutreachMailboxAssignment = require("../models/outreachMailboxAssignment");
const {
  ConversationThread,
  ConversationMessage,
} = require("../models/conversationThread");
const { normalizeInstantlyWebhook } = require("../utils/instantlyWebhookNormalizer");
const {
  PROSPECT_STAGE,
  OWNER_ROLE,
  REVIEW_STATUS,
  THREAD_STATUS,
} = require("../constants/outreach");
const { cleanName, getMailboxDisplayName } = require("../utils/mailboxDisplayName");
const { createAndEmit } = require("../utils/notifier");
const saveErrorLog = require("../services/errorLog.service");


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
  return "/admin/crm/replies";
}

async function notifyWebhookSafely(context, payload) {
  try {
    return await createAndEmit(payload || {});
  } catch (error) {
    console.warn(`${context} notification failed:`, error?.message || error);
    return null;
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeId(value) {
  return String(value || "").trim();
}

function isReplyEventName(eventName = "") {
  const normalized = String(eventName || "").toLowerCase();

  return (
    normalized.includes("reply") ||
    normalized.includes("replied") ||
    normalized.includes("email.reply") ||
    normalized.includes("email_replied") ||
    normalized.includes("lead_replied")
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

function resolveCampaignId(payload, prospect) {
  return (
    normalizeId(payload.campaignId) ||
    normalizeId(prospect?.instantly?.campaignId) ||
    ""
  );
}

function resolveThreadId(payload, prospect, existingThread) {
  return (
    normalizeId(payload.threadId) ||
    normalizeId(existingThread?.instantlyThreadId) ||
    normalizeId(prospect?.instantly?.threadId) ||
    ""
  );
}

function isClosedOrAssignedAway(stage) {
  return [
    PROSPECT_STAGE.ASSIGNED_TO_BME,
    PROSPECT_STAGE.ASSIGNED_TO_IME,
    PROSPECT_STAGE.UNQUALIFIED,
    PROSPECT_STAGE.BLOCKED,
    PROSPECT_STAGE.CLOSED,
  ].includes(String(stage || ""));
}

function resolveRevenueHeadId({ prospect, campaign, existingThread, ownerId }) {
  return (
    prospect?.RHId ||
    campaign?.RHId ||
    (existingThread?.ownerRole === OWNER_ROLE.REVENUE_HEAD
      ? existingThread.ownerId
      : null) ||
    ownerId ||
    null
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
    RHEmail:
      existingMailboxes.RHEmail ||
      campaign?.teamMailboxes?.RHEmail ||
      "",
    bmeEmail: existingMailboxes.bmeEmail || "",
    imeEmail:
      existingMailboxes.imeEmail ||
      campaign?.teamMailboxes?.IMEEmail ||
      "",
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
    brandEmail: prospect.primaryContact?.email || payload.email || "",
    brandName: prospect.companyName || "",
    status: THREAD_STATUS.WAITING_ON_US,
    lastMessageAt: new Date(),
    lastInboundAt: new Date(),
    unreadForRevenueHead: ownerRole === OWNER_ROLE.REVENUE_HEAD,
    unreadForBme: ownerRole === OWNER_ROLE.BME,
    unreadForIme: ownerRole === OWNER_ROLE.IME,
  };
}

async function upsertRevenueHeadReviewQueue({
  prospect,
  campaign,
  existingThread,
  payload,
  resolvedThreadId,
  ownerRole,
  ownerId,
}) {
  const resolvedRHId = resolveRevenueHeadId({
    prospect,
    campaign,
    existingThread,
    ownerId,
  });

  const shouldQueueForRevenueHeadReview =
    ownerRole === OWNER_ROLE.REVENUE_HEAD &&
    resolvedRHId &&
    !isClosedOrAssignedAway(prospect.stage);

  console.log("reply queue debug", {
    prospectId: String(prospect._id),
    ownerRole,
    ownerId: String(ownerId || ""),
    resolvedRHId: String(resolvedRHId || ""),
    stage: prospect.stage,
    shouldQueueForRevenueHeadReview,
    from: prospect.primaryContact?.email || payload.email,
    subject: payload.subject,
  });

  if (!shouldQueueForRevenueHeadReview) {
    return null;
  }

  return ReplyReviewQueue.findOneAndUpdate(
    {
      prospectId: prospect._id,
      reviewStatus: REVIEW_STATUS.PENDING,
    },
    {
      $set: {
        campaignId:
          campaign?._id ||
          existingThread?.campaignId ||
          null,
        prospectId: prospect._id,
        sdrId:
          prospect.sdrId ||
          campaign?.sdrId ||
          existingThread?.sdrId ||
          null,
        RHId:
          resolvedRHId ||
          campaign?.RHId ||
          existingThread?.RHId ||
          null,
        assignedBmeId: null,
        instantlyThreadId: resolvedThreadId,
        instantlyEmailId: payload.emailId || "",
        latestReplySnippet: payload.snippet || payload.bodyText || "",
        latestReplySubject: payload.subject || "",
        reviewStatus: REVIEW_STATUS.PENDING,
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );
}

exports.handleInstantlyWebhook = async (req, res) => {
  try {
    const payload = normalizeInstantlyWebhook(req.body);

    console.log("instantly webhook received", {
      event: payload.event,
      email: payload.email,
      campaignId: payload.campaignId,
      threadId: payload.threadId,
      subject: payload.subject,
    });

    if (!isReplyEventName(payload.event)) {
      return res.status(200).json({
        success: true,
        message: "Ignored event",
      });
    }

    if (!payload.email) {
      return res.status(200).json({
        success: true,
        message: "Reply event ignored because email is missing",
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

    const campaignId = resolveCampaignId(payload, prospect);

    const campaign = campaignId
      ? await OutreachCampaign.findOne({
        "instantly.campaignId": campaignId,
      })
      : null;

    const existingThread = await ConversationThread.findOne({
      prospectId: prospect._id,
    });

    const resolvedThreadId = resolveThreadId(payload, prospect, existingThread);

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
    let ownerId = prospect.RHId || campaign?.RHId || null;

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
        campaign?.RHId ||
        null;
    }

    const resolvedRHId = resolveRevenueHeadId({
      prospect,
      campaign,
      existingThread,
      ownerId,
    });

    prospect.reply = prospect.reply || {};
    prospect.instantly = prospect.instantly || {};

    prospect.reply.received = true;
    prospect.reply.firstReplyAt = prospect.reply.firstReplyAt || new Date();
    prospect.reply.lastReplyAt = new Date();
    prospect.reply.snippet = payload.snippet || payload.bodyText || "";
    prospect.reply.subject = payload.subject || "";

    prospect.instantly.threadId =
      resolvedThreadId || prospect.instantly.threadId || "";
    prospect.instantly.lastEmailId =
      payload.emailId || prospect.instantly.lastEmailId || "";
    prospect.instantly.senderAccountEmail =
      campaignSenderEmail || prospect.instantly.senderAccountEmail || "";

    if (campaign?.instantly?.campaignId && !prospect.instantly.campaignId) {
      prospect.instantly.campaignId = campaign.instantly.campaignId;
    }

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
      ownerRole = OWNER_ROLE.REVENUE_HEAD;
      ownerId = resolvedRHId || ownerId;

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

    const brandDisplayName =
      cleanName(prospect.companyName) ||
      cleanName(prospect.primaryContact?.name) ||
      "Lead";

    const mailboxDisplayName = await getMailboxDisplayName(campaignSenderEmail);

    await ConversationMessage.create({
      threadId: thread._id,
      prospectId: prospect._id,
      direction: "inbound",
      provider: "instantly",
      providerMessageId: payload.emailId || "",
      providerThreadId: resolvedThreadId,

      from: prospect.primaryContact?.email || payload.email || "",
      fromName: brandDisplayName,

      to: campaignSenderEmail ? [campaignSenderEmail] : [],
      toNames: mailboxDisplayName ? [mailboxDisplayName] : [],

      subject: payload.subject || "",
      bodyText: payload.bodyText || payload.snippet || "",
      bodyHtml: "",
      receivedAt: new Date(),
    });

    const reviewRow = await upsertRevenueHeadReviewQueue({
      prospect,
      campaign,
      existingThread,
      payload,
      resolvedThreadId,
      ownerRole,
      ownerId,
    });

    if (campaign?._id) {
      await OutreachCampaign.findByIdAndUpdate(campaign._id, {
        $inc: { "stats.totalReplies": 1 },
      });
    }

    const notificationAdminIds = uniqueNotificationIds([
      ownerId,
      resolvedRHId,
      reviewRow?.RHId,
    ]);

    if (notificationAdminIds.length) {
      await notifyWebhookSafely("handleInstantlyWebhook", {
        adminIds: notificationAdminIds,
        type: "outreach.reply_received",
        title: "New reply received",
        message: `${brandDisplayName} replied${campaign?.name ? ` to ${campaign.name}` : ""}.`,
        entityType: "outreach_thread",
        entityId: String(thread._id),
        actionPath: {
          admin: buildCrmRepliesAdminPath({
            threadId: thread._id,
            prospectId: prospect._id,
          }),
        },
      });
    }

    return res.status(200).json({
      success: true,
      message:
        route === "IME_CONTINUATION"
          ? "Reply assigned to IME"
          : route === "BME_CONTINUATION"
            ? "Reply assigned to BME"
            : reviewRow
              ? "Reply queued for Revenue Head review"
              : "Reply assigned to Revenue Head",
      debug: {
        route,
        ownerRole,
        ownerId: String(ownerId || ""),
        reviewQueued: Boolean(reviewRow),
        reviewId: reviewRow?._id || null,
      },
    });
  } catch (error) {
    console.error("Instantly webhook error", error);
    await saveErrorLog(
      req,
      error,
      error?.statusCode || error?.status || 500,
      "HANDLE_INSTANTLY_WEBHOOK_ERROR"
    );

    return res.status(500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};