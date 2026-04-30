const ProspectBrand = require("../models/prospectBrand");
const OutreachCampaign = require("../models/outreachCampaign");
const { ConversationThread, ConversationMessage } = require("../models/conversationThread");
const instantlyService = require("../services/instantlyService");
const { OWNER_ROLE, THREAD_STATUS } = require("../constants/outreach");

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

async function buildThreadScope(admin) {
  const role = normalizeRole(admin?.role);
  const adminId = String(admin?.adminId || "");

  if (role === "super_admin") {
    return {};
  }

  if (role === OWNER_ROLE.BME) {
    return { ownerRole: OWNER_ROLE.BME, ownerId: adminId };
  }

  if (role === OWNER_ROLE.IME) {
    return { ownerRole: OWNER_ROLE.IME, ownerId: adminId };
  }

  if (isRevenueHeadRole(role)) {
    const campaigns = await OutreachCampaign.find({
      $or: [
        { RHId: adminId },
        { flowType: "ime_influencer" },
      ],
    })
      .select("_id")
      .lean();

    return {
      campaignId: { $in: campaigns.map((item) => item._id) },
    };
  }

  const error = new Error("Forbidden");
  error.statusCode = 403;
  throw error;
}

async function attachFallbackCampaignData(threadDoc) {
  if (!threadDoc) return threadDoc;

  const hasCampaign = Boolean(threadDoc?.campaignId?._id || threadDoc?.campaignId);
  if (hasCampaign) return threadDoc;

  const instantlyCampaignId = String(
    threadDoc?.instantlyCampaignId ||
    threadDoc?.prospectId?.instantly?.campaignId ||
    ""
  ).trim();

  if (!instantlyCampaignId) return threadDoc;

  const fallbackCampaign = await OutreachCampaign.findOne({
    "instantly.campaignId": instantlyCampaignId,
  })
    .select("name sdrId RHId IMEId flowType")
    .populate([
      { path: "sdrId", select: "name email role" },
      { path: "RHId", select: "name email role" },
      { path: "IMEId", select: "name email role" },
    ]);

  if (fallbackCampaign) {
    threadDoc.campaignId = fallbackCampaign;
  }

  return threadDoc;
}

function shouldHideBrandEmail(admin) {
  return normalizeRole(admin?.role) !== "super_admin";
}

function getBrandDisplayNameFromThread(threadDoc) {
  return (
    threadDoc?.prospectId?.companyName ||
    threadDoc?.brandName ||
    threadDoc?.prospectId?.primaryContact?.name ||
    "Lead"
  );
}

function getTeamDisplayNameFromThread(threadDoc) {
  const ownerRole = normalizeRole(threadDoc?.ownerRole);

  if (ownerRole === OWNER_ROLE.BME) {
    return (
      threadDoc?.prospectId?.assignedBmeId?.name ||
      threadDoc?.campaignId?.assignedBmeId?.name ||
      "BME"
    );
  }

  if (ownerRole === OWNER_ROLE.IME) {
    return (
      threadDoc?.prospectId?.assignedImeId?.name ||
      threadDoc?.campaignId?.IMEId?.name ||
      "IME"
    );
  }

  if (ownerRole === OWNER_ROLE.REVENUE_HEAD) {
    return threadDoc?.campaignId?.RHId?.name || "Revenue Head";
  }

  return threadDoc?.campaignId?.sdrId?.name || "SDR";
}

function serializeThread(threadDoc, admin = {}) {
  if (!threadDoc) return null;

  const campaign = threadDoc.campaignId;
  const prospect = threadDoc.prospectId;

  const hideEmail = shouldHideBrandEmail(admin);
  const brandDisplayName = getBrandDisplayNameFromThread(threadDoc);
  const teamDisplayName = getTeamDisplayNameFromThread(threadDoc);

  return {
    _id: threadDoc._id,
    prospectId: prospect
      ? {
        _id: prospect?._id,
        companyName: prospect?.companyName || "",
        primaryContact: {
          ...(prospect?.primaryContact || {}),
          email: hideEmail ? "" : prospect?.primaryContact?.email || "",
        },
        stage: prospect?.stage || "",
      }
      : null,
    campaignId: campaign
      ? {
        _id: campaign?._id,
        name: campaign?.name || "",
      }
      : null,
    sdrId: campaign?.sdrId || null,
    RHId: campaign?.RHId || null,
    IMEId: campaign?.IMEId || null,
    assignedBmeId: prospect?.assignedBmeId || null,
    assignedImeId: prospect?.assignedImeId || campaign?.IMEId || null,
    ownerRole: threadDoc.ownerRole || "",
    ownerId: threadDoc.ownerId || "",
    instantlyThreadId: threadDoc.instantlyThreadId || "",
    instantlyCampaignId: threadDoc.instantlyCampaignId || "",
    mailboxes: threadDoc.mailboxes || {},
    subject: threadDoc.subject || "",
    brandEmail: hideEmail ? "" : threadDoc.brandEmail || "",
    brandName: threadDoc.brandName || brandDisplayName,
    brandDisplayName,
    teamDisplayName,
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

function serializeMessage(messageDoc, threadDoc = null, admin = {}) {
  const hideEmail = shouldHideBrandEmail(admin);
  const isInbound = String(messageDoc.direction || "").toLowerCase() === "inbound";

  const brandDisplayName = getBrandDisplayNameFromThread(threadDoc);
  const teamDisplayName = getTeamDisplayNameFromThread(threadDoc);

  return {
    _id: messageDoc._id,
    threadId: messageDoc.threadId,
    prospectId: messageDoc.prospectId,
    direction: messageDoc.direction,
    provider: messageDoc.provider || "",
    providerMessageId: messageDoc.providerMessageId || "",
    providerThreadId: messageDoc.providerThreadId || "",

    from: hideEmail && isInbound ? brandDisplayName : messageDoc.from || "",
    to:
      hideEmail && isInbound
        ? [teamDisplayName]
        : hideEmail && !isInbound
          ? [brandDisplayName]
          : Array.isArray(messageDoc.to)
            ? messageDoc.to
            : [],

    fromDisplayName: isInbound ? brandDisplayName : teamDisplayName,
    toDisplayNames: isInbound ? [teamDisplayName] : [brandDisplayName],

    cc: hideEmail ? [] : Array.isArray(messageDoc.cc) ? messageDoc.cc : [],
    bcc: hideEmail ? [] : Array.isArray(messageDoc.bcc) ? messageDoc.bcc : [],
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

async function getScopedThread(admin, threadId) {
  const scope = await buildThreadScope(admin);

  let thread = await ConversationThread.findOne({ _id: threadId, ...scope })
    .populate({
      path: "campaignId",
      select: "name sdrId RHId IMEId flowType",
      populate: [
        { path: "sdrId", select: "name email role" },
        { path: "RHId", select: "name email role" },
        { path: "IMEId", select: "name email role" },
      ],
    })
    .populate({
      path: "prospectId",
      select: "companyName primaryContact stage assignedBmeId assignedImeId instantly",
      populate: [
        { path: "assignedBmeId", select: "name email role" },
        { path: "assignedImeId", select: "name email role" },
      ],
    });

  if (!thread) {
    const error = new Error("Thread not found");
    error.statusCode = 404;
    throw error;
  }

  thread = await attachFallbackCampaignData(thread);
  return thread;
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

    const scope = await buildThreadScope(req.admin);
    const query = { ...scope };

    if (String(req.query?.campaignId || "").trim()) {
      query.campaignId = String(req.query.campaignId).trim();
    }

    let threads = await ConversationThread.find(query)
      .populate({
        path: "campaignId",
        select: "name sdrId RHId IMEId flowType",
        populate: [
          { path: "sdrId", select: "name email role" },
          { path: "RHId", select: "name email role" },
          { path: "IMEId", select: "name email role" },
        ],
      })
      .populate({
        path: "prospectId",
        select: "companyName primaryContact stage assignedBmeId assignedImeId instantly",
        populate: [
          { path: "assignedBmeId", select: "name email role" },
          { path: "assignedImeId", select: "name email role" },
        ],
      })
      .sort({ lastMessageAt: -1, updatedAt: -1 });

    threads = await Promise.all(threads.map((thread) => attachFallbackCampaignData(thread)));

    const filtered = threads.filter((thread) => {
      const campaign = thread.campaignId;
      const prospect = thread.prospectId;

      if (normalizeRole(req.admin?.role) === "super_admin" && String(req.query?.RHId || "").trim()) {
        if (String(campaign?.RHId?._id || campaign?.RHId || "") !== String(req.query.RHId).trim()) {
          return false;
        }
      }

      if (String(req.query?.sdrId || "").trim()) {
        if (String(campaign?.sdrId?._id || campaign?.sdrId || "") !== String(req.query.sdrId).trim()) {
          return false;
        }
      }

      if (String(req.query?.assignedBmeId || "").trim()) {
        if (
          String(prospect?.assignedBmeId?._id || prospect?.assignedBmeId || "") !==
          String(req.query.assignedBmeId).trim()
        ) {
          return false;
        }
      }

      if (String(req.query?.assignedImeId || "").trim()) {
        if (
          String(prospect?.assignedImeId?._id || prospect?.assignedImeId || "") !==
          String(req.query.assignedImeId).trim()
        ) {
          return false;
        }
      }

      const search = String(req.query?.search || "").trim().toLowerCase();
      if (!search) return true;

      const haystack = [
        thread.subject,
        thread.brandName,
        thread.brandEmail,
        campaign?.name,
        prospect?.companyName,
        prospect?.primaryContact?.name,
        prospect?.primaryContact?.email,
        thread.ownerRole,
        thread.status,
        campaign?.sdrId?.name,
        campaign?.sdrId?.email,
        campaign?.RHId?.name,
        campaign?.RHId?.email,
        campaign?.IMEId?.name,
        campaign?.IMEId?.email,
        prospect?.assignedBmeId?.name,
        prospect?.assignedBmeId?.email,
        prospect?.assignedImeId?.name,
        prospect?.assignedImeId?.email,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(search);
    });

    return res.status(200).json({
      success: true,
      count: filtered.length,
      data: filtered.map((thread) => serializeThread(thread, req.admin)),
    });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to load threads",
    });
  }
};

exports.getThreadMessages = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "bme", "ime", "super_admin"]);

    const thread = await getScopedThread(req.admin, req.params.threadId);
    const messages = await ConversationMessage.find({ threadId: thread._id }).sort({ createdAt: 1 });

    return res.status(200).json({
      success: true,
      thread: serializeThread(thread, req.admin),
      messages: messages.map((message) => serializeMessage(message, thread, req.admin)),
      messages: messages.map(serializeMessage),
    });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to load thread",
    });
  }
};

exports.replyToThread = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "bme", "ime", "super_admin"]);

    const thread = await getScopedThread(req.admin, req.params.threadId);
    const bodyText = String(req.body?.bodyText || "").trim();
    const subject = String(req.body?.subject || thread.subject || "").trim();

    if (!bodyText) {
      return res.status(400).json({
        success: false,
        message: "Reply body is required",
      });
    }

    const toEmail = thread?.prospectId?.primaryContact?.email || thread?.brandEmail || "";
    if (!toEmail) {
      return res.status(400).json({
        success: false,
        message: "Thread recipient email is missing",
      });
    }

    const fromEmail =
      thread?.mailboxes?.currentReplyFromEmail ||
      thread?.mailboxes?.campaignSenderEmail ||
      "";
    if (!fromEmail) {
      return res.status(400).json({
        success: false,
        message: "Reply mailbox is missing for this thread",
      });
    }

    const replyToId = await resolveReplyTargetForThread(thread);

    const replyTargetUuid = await resolveReplyTargetForThread(thread);

    if (!replyTargetUuid) {
      return res.status(400).json({
        success: false,
        message: "Reply target email id is missing for this conversation",
      });
    }

    const htmlBody = bodyText
      .split("\n")
      .map((line) => (line.trim() ? `<p>${line}</p>` : "<br/>"))
      .join("");

    const response = await instantlyService.replyToEmail({
      reply_to_uuid: replyTargetUuid,
      eaccount: fromEmail,
      subject: subject || thread.subject || "",
      body: {
        text: bodyText,
        html: htmlBody,
      },
    });

    const providerMessageId = String(
      response?.id || response?.data?.id || response?.message_id || ""
    ).trim();

    const message = await ConversationMessage.create({
      threadId: thread._id,
      prospectId: thread.prospectId?._id || thread.prospectId || null,
      direction: "outbound",
      provider: "instantly",
      providerMessageId,
      providerThreadId: thread.instantlyThreadId || "",
      from: fromEmail,
      to: [toEmail],
      subject,
      bodyText,
      repliedByAdminId: req.admin.adminId,
      sentAt: new Date(),
    });

    thread.subject = subject || thread.subject || "";
    thread.status = THREAD_STATUS.WAITING_ON_BRAND;
    thread.lastMessageAt = new Date();
    thread.lastOutboundAt = new Date();
    thread.unreadForRevenueHead = false;
    thread.unreadForBme = false;
    thread.unreadForIme = false;
    await thread.save();

    return res.status(200).json({
      success: true,
      message: "Reply sent successfully",
      data: {
        thread: serializeThread(thread),
        message: serializeMessage(message),
      },
    });
  } catch (error) {
    console.error("replyToThread error:", {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });

    return res.status(error?.response?.status || error?.statusCode || 500).json({
      success: false,
      message:
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        "Failed to send reply",
      details: error?.response?.data || null,
    });
  }
};