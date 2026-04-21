const ProspectBrand = require("../models/prospectBrand");
const { ConversationThread, ConversationMessage } = require("../models/conversationThread");
const instantlyService = require("../services/instantlyService");
const {
  OWNER_ROLE,
  THREAD_STATUS,
} = require("../constants/outreach");

function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
}

function isSuperAdmin(admin) {
  return normalizeRole(admin?.role) === "super_admin";
}

function ensureRole(admin, allowed = []) {
  const role = normalizeRole(admin?.role);

  if (!admin?.adminId || !allowed.includes(role)) {
    const error = new Error("Forbidden");
    error.statusCode = 403;
    throw error;
  }
}

function buildThreadQuery(admin) {
  const role = normalizeRole(admin?.role);
  const adminId = String(admin?.adminId || "");

  if (role === "super_admin") {
    return {};
  }

  if (
    role === OWNER_ROLE.REVENUE_HEAD ||
    role === OWNER_ROLE.BME ||
    role === OWNER_ROLE.IME
  ) {
    return {
      ownerRole: role,
      ownerId: adminId,
    };
  }

  const error = new Error("Forbidden");
  error.statusCode = 403;
  throw error;
}

function serializeThread(threadDoc) {
  if (!threadDoc) return null;

  return {
    _id: threadDoc._id,
    prospectId: threadDoc.prospectId
      ? {
          _id: threadDoc.prospectId?._id,
          companyName: threadDoc.prospectId?.companyName || "",
          primaryContact: threadDoc.prospectId?.primaryContact || {},
          stage: threadDoc.prospectId?.stage || "",
        }
      : null,
    campaignId: threadDoc.campaignId || null,
    brandId: threadDoc.brandId || null,
    ownerRole: threadDoc.ownerRole || "",
    ownerId: threadDoc.ownerId || "",
    instantlyThreadId: threadDoc.instantlyThreadId || "",
    instantlyCampaignId: threadDoc.instantlyCampaignId || "",
    mailboxes: threadDoc.mailboxes || {},
    subject: threadDoc.subject || "",
    brandEmail: threadDoc.brandEmail || "",
    brandName: threadDoc.brandName || "",
    status: threadDoc.status || "",
    handoffAt: threadDoc.handoffAt || null,
    lastMessageAt: threadDoc.lastMessageAt || null,
    lastInboundAt: threadDoc.lastInboundAt || null,
    lastOutboundAt: threadDoc.lastOutboundAt || null,
    unreadForRevenueHead: Boolean(threadDoc.unreadForRevenueHead),
    unreadForBme: Boolean(threadDoc.unreadForBme),
    unreadForIme: Boolean(threadDoc.unreadForIme),
    createdAt: threadDoc.createdAt || null,
    updatedAt: threadDoc.updatedAt || null,
  };
}

function serializeMessage(messageDoc) {
  return {
    _id: messageDoc._id,
    threadId: messageDoc.threadId,
    prospectId: messageDoc.prospectId,
    direction: messageDoc.direction,
    provider: messageDoc.provider || "",
    providerMessageId: messageDoc.providerMessageId || "",
    providerThreadId: messageDoc.providerThreadId || "",
    from: messageDoc.from || "",
    to: Array.isArray(messageDoc.to) ? messageDoc.to : [],
    cc: Array.isArray(messageDoc.cc) ? messageDoc.cc : [],
    bcc: Array.isArray(messageDoc.bcc) ? messageDoc.bcc : [],
    subject: messageDoc.subject || "",
    bodyText: messageDoc.bodyText || "",
    bodyHtml: messageDoc.bodyHtml || "",
    repliedByAdminId: messageDoc.repliedByAdminId || null,
    sentAt: messageDoc.sentAt || null,
    receivedAt: messageDoc.receivedAt || null,
    createdAt: messageDoc.createdAt || null,
    updatedAt: messageDoc.updatedAt || null,
  };
}

async function resolveReplyTargetForThread(thread) {
  const latestInbound = await ConversationMessage.findOne({
    threadId: thread?._id,
    direction: "inbound",
    providerMessageId: { $nin: ["", null] },
  })
    .sort({ createdAt: -1 })
    .select("providerMessageId")
    .lean();

  if (String(latestInbound?.providerMessageId || "").trim()) {
    return String(latestInbound.providerMessageId).trim();
  }

  const latestAny = await ConversationMessage.findOne({
    threadId: thread?._id,
    providerMessageId: { $nin: ["", null] },
  })
    .sort({ createdAt: -1 })
    .select("providerMessageId")
    .lean();

  if (String(latestAny?.providerMessageId || "").trim()) {
    return String(latestAny.providerMessageId).trim();
  }

  return String(thread?.prospectId?.instantly?.lastEmailId || "").trim();
}

exports.listBmeThreads = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "bme", "ime", "super_admin"]);

    const query = buildThreadQuery(req.admin);

    const threads = await ConversationThread.find(query)
      .populate("prospectId", "companyName primaryContact stage")
      .sort({ lastMessageAt: -1, updatedAt: -1 });

    return res.status(200).json({
      success: true,
      count: threads.length,
      data: threads.map(serializeThread),
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};

exports.getThreadMessages = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "bme", "ime", "super_admin"]);

    const thread = await ConversationThread.findById(req.params.threadId)
      .populate("prospectId", "companyName primaryContact stage instantly");

    if (!thread) {
      return res.status(404).json({
        success: false,
        message: "Thread not found",
      });
    }

    if (
      !isSuperAdmin(req.admin) &&
      (
        String(thread.ownerId) !== String(req.admin.adminId) ||
        normalizeRole(thread.ownerRole) !== normalizeRole(req.admin.role)
      )
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden",
      });
    }

    const messages = await ConversationMessage.find({ threadId: thread._id })
      .sort({ createdAt: 1 });

    return res.status(200).json({
      success: true,
      thread: serializeThread(thread),
      messages: messages.map(serializeMessage),
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};

exports.replyToThread = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "bme", "ime", "super_admin"]);

    const { threadId } = req.params;
    const subject = String(req.body?.subject || "").trim();
    const bodyText = String(req.body?.bodyText || "").trim();

    if (!bodyText) {
      return res.status(400).json({
        success: false,
        message: "bodyText is required",
      });
    }

    const thread = await ConversationThread.findById(threadId).populate("prospectId");
    if (!thread) {
      return res.status(404).json({
        success: false,
        message: "Thread not found",
      });
    }

    if (
      !isSuperAdmin(req.admin) &&
      (
        String(thread.ownerId) !== String(req.admin.adminId) ||
        normalizeRole(thread.ownerRole) !== normalizeRole(req.admin.role)
      )
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden",
      });
    }

    const role = normalizeRole(req.admin.role);

    const isRevenueHeadReply =
      role === OWNER_ROLE.REVENUE_HEAD ||
      (isSuperAdmin(req.admin) && normalizeRole(thread.ownerRole) === OWNER_ROLE.REVENUE_HEAD);

    const isImeReply =
      role === OWNER_ROLE.IME ||
      (isSuperAdmin(req.admin) && normalizeRole(thread.ownerRole) === OWNER_ROLE.IME);

    const replyFromEmail = isRevenueHeadReply
      ? thread.mailboxes?.RHEmail ||
        thread.mailboxes?.currentReplyFromEmail ||
        thread.mailboxes?.campaignSenderEmail ||
        ""
      : isImeReply
        ? thread.mailboxes?.imeEmail ||
          thread.mailboxes?.currentReplyFromEmail ||
          thread.mailboxes?.campaignSenderEmail ||
          ""
        : thread.mailboxes?.bmeEmail ||
          thread.mailboxes?.currentReplyFromEmail ||
          thread.mailboxes?.campaignSenderEmail ||
          "";

    if (!replyFromEmail) {
      return res.status(400).json({
        success: false,
        message: "No reply mailbox is mapped for this thread",
      });
    }

    const replyTargetUuid = await resolveReplyTargetForThread(thread);

    if (!replyTargetUuid) {
      return res.status(400).json({
        success: false,
        message: "Reply target email id is missing for this conversation",
      });
    }

    const replyPayload = {
      reply_to_uuid: replyTargetUuid,
      eaccount: replyFromEmail,
      subject: subject || thread.subject || "",
      body: {
        text: bodyText,
        html: bodyText,
      },
    };

    const replyResponse = await instantlyService.replyToEmail(replyPayload);

    await ConversationMessage.create({
      threadId: thread._id,
      prospectId: thread.prospectId?._id,
      direction: "outbound",
      provider: "instantly",
      providerMessageId: String(replyResponse?.id || replyResponse?.message_id || ""),
      providerThreadId: String(thread.instantlyThreadId || "").trim(),
      from: replyFromEmail,
      to: [thread.brandEmail],
      subject: subject || thread.subject || "",
      bodyText,
      repliedByAdminId: req.admin.adminId,
      sentAt: new Date(),
    });

    thread.lastMessageAt = new Date();
    thread.lastOutboundAt = new Date();
    thread.status = THREAD_STATUS.WAITING_ON_BRAND;
    thread.unreadForRevenueHead = false;
    thread.unreadForBme = false;
    thread.unreadForIme = false;
    thread.mailboxes = {
      ...(thread.mailboxes || {}),
      currentReplyFromEmail: replyFromEmail,
    };

    await thread.save();

    await ProspectBrand.findByIdAndUpdate(thread.prospectId?._id, {
      $set: {
        currentOwnerRole: isRevenueHeadReply
          ? OWNER_ROLE.REVENUE_HEAD
          : isImeReply
            ? OWNER_ROLE.IME
            : OWNER_ROLE.BME,
        currentOwnerId: isSuperAdmin(req.admin)
          ? thread.ownerId
          : req.admin.adminId,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Reply sent successfully",
      data: replyResponse,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};