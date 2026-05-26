const { createAndEmit } = require("../utils/notifier");
const ProspectBrand = require("../models/prospectBrand");
const OutreachCampaign = require("../models/outreachCampaign");
const {
  ConversationThread,
  ConversationMessage,
} = require("../models/conversationThread");
const instantlyService = require("../services/instantlyService");
const {
  OWNER_ROLE,
  THREAD_STATUS,
  MESSAGE_DIRECTION,
} = require("../constants/outreach");
const {
  cleanName,
  getMailboxDisplayName,
  nameFromEmail,
} = require("../utils/mailboxDisplayName");
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

function normalizeEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}

function isRevenueHeadRole(role) {
  const value = normalizeRole(role);
  return value === "revenue_head" || value === "rh";
}

function isSuperAdmin(admin = {}) {
  return normalizeRole(admin?.role) === "super_admin";
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

function shouldHideBrandEmail(admin) {
  return !isSuperAdmin(admin);
}

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtmlToPlainText(value = "") {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|tr|h1|h2|h3|h4|h5|h6)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function textToEmailHtml(value = "") {
  return String(value || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => {
      return `<p>${escapeHtml(paragraph).replace(/\n/g, "<br/>")}</p>`;
    })
    .join("");
}

function sanitizeOutgoingEmailHtml(value = "") {
  return String(value || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?>[\s\S]*?<\/embed>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(['"]).*?\1/gi, "")
    .replace(/\s+href\s*=\s*(['"])\s*javascript:[\s\S]*?\1/gi, "")
    .replace(/(<br\s*\/?>\s*){3,}/gi, "<br><br>")
    .trim();
}

function normalizeReplyBody(bodyTextInput = "", bodyHtmlInput = "") {
  const bodyTextRaw = String(bodyTextInput || "").trim();
  const bodyHtmlRaw = String(bodyHtmlInput || "").trim();

  const bodyHtml = bodyHtmlRaw
    ? sanitizeOutgoingEmailHtml(bodyHtmlRaw)
    : textToEmailHtml(bodyTextRaw);

  const bodyText = bodyTextRaw
    ? stripHtmlToPlainText(bodyTextRaw)
    : stripHtmlToPlainText(bodyHtml);

  const finalBodyText = bodyText || stripHtmlToPlainText(bodyHtml);
  const finalBodyHtml = bodyHtml || textToEmailHtml(finalBodyText);

  return {
    bodyText: finalBodyText,
    bodyHtml: finalBodyHtml,
  };
}

function firstUsefulName(...values) {
  for (const value of values) {
    const cleaned = cleanName(value || "");

    if (cleaned) return cleaned;
  }

  return "";
}

function getBrandDisplayNameFromThread(threadDoc) {
  return (
    firstUsefulName(
      threadDoc?.prospectId?.companyName,
      threadDoc?.brandName,
      threadDoc?.prospectId?.primaryContact?.name
    ) || "Lead"
  );
}

function getMailboxNameFromThread(threadDoc) {
  const mailboxes = threadDoc?.mailboxes || {};
  const ownerRole = normalizeRole(threadDoc?.ownerRole);

  if (ownerRole === OWNER_ROLE.BME) {
    return (
      firstUsefulName(
        mailboxes.currentReplyFromName,
        mailboxes.bmeName,
        mailboxes.campaignSenderName,
        nameFromEmail(mailboxes.currentReplyFromEmail),
        nameFromEmail(mailboxes.bmeEmail),
        nameFromEmail(mailboxes.campaignSenderEmail)
      ) || "Team Member"
    );
  }

  if (ownerRole === OWNER_ROLE.IME) {
    return (
      firstUsefulName(
        mailboxes.currentReplyFromName,
        mailboxes.imeName,
        mailboxes.campaignSenderName,
        nameFromEmail(mailboxes.currentReplyFromEmail),
        nameFromEmail(mailboxes.imeEmail),
        nameFromEmail(mailboxes.campaignSenderEmail)
      ) || "Team Member"
    );
  }

  if (ownerRole === OWNER_ROLE.REVENUE_HEAD || ownerRole === "rh") {
    return (
      firstUsefulName(
        mailboxes.currentReplyFromName,
        mailboxes.RHName,
        mailboxes.campaignSenderName,
        nameFromEmail(mailboxes.currentReplyFromEmail),
        nameFromEmail(mailboxes.RHEmail),
        nameFromEmail(mailboxes.campaignSenderEmail)
      ) || "Team Member"
    );
  }

  return (
    firstUsefulName(
      mailboxes.currentReplyFromName,
      mailboxes.campaignSenderName,
      nameFromEmail(mailboxes.currentReplyFromEmail),
      nameFromEmail(mailboxes.campaignSenderEmail)
    ) || "Team Member"
  );
}

async function resolveMailboxDisplayName(email = "", fallback = "") {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return firstUsefulName(fallback) || "";
  }

  const fromAssignment = await getMailboxDisplayName(normalizedEmail, fallback);

  return (
    firstUsefulName(
      fromAssignment,
      fallback,
      nameFromEmail(normalizedEmail)
    ) || ""
  );
}

async function buildThreadScope(admin) {
  const role = normalizeRole(admin?.role);
  const adminId = String(admin?.adminId || "");

  if (role === "super_admin") {
    return {};
  }

  if (role === OWNER_ROLE.BME) {
    return {
      ownerRole: OWNER_ROLE.BME,
      ownerId: adminId,
    };
  }

  if (role === OWNER_ROLE.IME) {
    return {
      ownerRole: OWNER_ROLE.IME,
      ownerId: adminId,
    };
  }

  if (isRevenueHeadRole(role)) {
    const campaigns = await OutreachCampaign.find({
      RHId: adminId,
    })
      .select("_id")
      .lean();

    return {
      $or: [
        {
          ownerRole: OWNER_ROLE.REVENUE_HEAD,
          ownerId: adminId,
        },
        {
          campaignId: {
            $in: campaigns.map((item) => item._id),
          },
        },
      ],
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
    .select("name sdrId RHId IMEId flowType teamMailboxes")
    .populate([
      {
        path: "sdrId",
        select: "name email role",
      },
      {
        path: "RHId",
        select: "name email role",
      },
      {
        path: "IMEId",
        select: "name email role",
      },
    ]);

  if (fallbackCampaign) {
    threadDoc.campaignId = fallbackCampaign;
  }

  return threadDoc;
}

function getThreadCampaignObject(threadDoc) {
  const campaign = threadDoc?.campaignId;

  if (!campaign) return null;

  return campaign;
}

function serializeThread(threadDoc, admin = {}) {
  if (!threadDoc) return null;

  const campaign = getThreadCampaignObject(threadDoc);
  const prospect = threadDoc.prospectId;
  const hideEmail = shouldHideBrandEmail(admin);

  const brandDisplayName = getBrandDisplayNameFromThread(threadDoc);
  const teamDisplayName = getMailboxNameFromThread(threadDoc);

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

    isUnread: isThreadUnreadForAdmin(threadDoc, admin),
    hasUnreadReply: isThreadUnreadForAdmin(threadDoc, admin) && Boolean(threadDoc.lastInboundAt),

    createdAt: threadDoc.createdAt || null,
    updatedAt: threadDoc.updatedAt || null,
  };
}

function serializeMessage(messageDoc, threadDoc = null, admin = {}) {
  if (!messageDoc) return null;

  const hideEmail = shouldHideBrandEmail(admin);
  const isInbound =
    String(messageDoc.direction || "").toLowerCase() === MESSAGE_DIRECTION.INBOUND;

  const brandDisplayName = getBrandDisplayNameFromThread(threadDoc);
  const mailboxDisplayName = getMailboxNameFromThread(threadDoc);

  const storedFromName = firstUsefulName(messageDoc.fromName);
  const storedToNames = Array.isArray(messageDoc.toNames)
    ? messageDoc.toNames.map((item) => firstUsefulName(item)).filter(Boolean)
    : [];

  const fallbackFromName = isInbound
    ? brandDisplayName
    : firstUsefulName(nameFromEmail(messageDoc.from), mailboxDisplayName);

  const fallbackToNames = isInbound
    ? [mailboxDisplayName]
    : [brandDisplayName];

  const fromDisplayName = storedFromName || fallbackFromName;
  const toDisplayNames = storedToNames.length ? storedToNames : fallbackToNames;

  return {
    _id: messageDoc._id,
    threadId: messageDoc.threadId,
    prospectId: messageDoc.prospectId,

    direction: messageDoc.direction,
    provider: messageDoc.provider || "",
    providerMessageId: messageDoc.providerMessageId || "",
    providerThreadId: messageDoc.providerThreadId || "",

    from:
      hideEmail && isInbound
        ? brandDisplayName
        : hideEmail && !isInbound
          ? fromDisplayName
          : messageDoc.from || "",

    fromName: fromDisplayName,
    fromDisplayName,

    to:
      hideEmail
        ? toDisplayNames
        : Array.isArray(messageDoc.to)
          ? messageDoc.to
          : [],

    toNames: toDisplayNames,
    toDisplayNames,

    cc: hideEmail ? [] : Array.isArray(messageDoc.cc) ? messageDoc.cc : [],
    ccNames: hideEmail ? [] : Array.isArray(messageDoc.ccNames) ? messageDoc.ccNames : [],

    bcc: hideEmail ? [] : Array.isArray(messageDoc.bcc) ? messageDoc.bcc : [],
    bccNames: hideEmail ? [] : Array.isArray(messageDoc.bccNames) ? messageDoc.bccNames : [],

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

  let thread = await ConversationThread.findOne({
    _id: threadId,
    ...scope,
  })
    .populate({
      path: "campaignId",
      select: "name sdrId RHId IMEId flowType teamMailboxes",
      populate: [
        {
          path: "sdrId",
          select: "name email role",
        },
        {
          path: "RHId",
          select: "name email role",
        },
        {
          path: "IMEId",
          select: "name email role",
        },
      ],
    })
    .populate({
      path: "prospectId",
      select: "companyName primaryContact stage assignedBmeId assignedImeId instantly",
      populate: [
        {
          path: "assignedBmeId",
          select: "name email role",
        },
        {
          path: "assignedImeId",
          select: "name email role",
        },
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
    direction: MESSAGE_DIRECTION.INBOUND,
    providerMessageId: {
      $nin: ["", null],
    },
  })
    .sort({
      createdAt: -1,
    })
    .select("providerMessageId")
    .lean();

  if (String(latestInbound?.providerMessageId || "").trim()) {
    return String(latestInbound.providerMessageId).trim();
  }

  const latestAny = await ConversationMessage.findOne({
    threadId: thread?._id,
    providerMessageId: {
      $nin: ["", null],
    },
  })
    .sort({
      createdAt: -1,
    })
    .select("providerMessageId")
    .lean();

  if (String(latestAny?.providerMessageId || "").trim()) {
    return String(latestAny.providerMessageId).trim();
  }

  return String(thread?.prospectId?.instantly?.lastEmailId || "").trim();
}

function buildThreadQueryWithFilters(baseScope = {}, queryParams = {}) {
  const query = {
    ...baseScope,
  };

  if (String(queryParams?.campaignId || "").trim()) {
    query.campaignId = String(queryParams.campaignId).trim();
  }

  return query;
}

function getUnreadFlagForAdmin(admin = {}) {
  const role = normalizeRole(admin?.role);

  if (role === OWNER_ROLE.BME) return "unreadForBme";
  if (role === OWNER_ROLE.IME) return "unreadForIme";
  if (role === OWNER_ROLE.REVENUE_HEAD || role === "rh" || role === "revenue_head") {
    return "unreadForRevenueHead";
  }

  return "";
}

function isThreadUnreadForAdmin(threadDoc, admin = {}) {
  if (!threadDoc) return false;

  const role = normalizeRole(admin?.role);

  if (role === "super_admin") {
    return Boolean(
      threadDoc.unreadForRevenueHead ||
      threadDoc.unreadForBme ||
      threadDoc.unreadForIme
    );
  }

  const flag = getUnreadFlagForAdmin(admin);
  return flag ? Boolean(threadDoc?.[flag]) : false;
}

function getThreadSortTime(threadDoc) {
  const values = [
    threadDoc?.lastMessageAt,
    threadDoc?.lastInboundAt,
    threadDoc?.updatedAt,
    threadDoc?.createdAt,
  ];

  for (const value of values) {
    const time = new Date(value || "").getTime();
    if (Number.isFinite(time)) return time;
  }

  return 0;
}

function sortThreadsForAdminInbox(threads = [], admin = {}) {
  return [...threads].sort((a, b) => {
    const unreadDiff =
      Number(isThreadUnreadForAdmin(b, admin)) -
      Number(isThreadUnreadForAdmin(a, admin));

    if (unreadDiff) return unreadDiff;

    return getThreadSortTime(b) - getThreadSortTime(a);
  });
}

exports.listBmeThreads = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "bme", "ime", "super_admin"]);

    const scope = await buildThreadScope(req.admin);
    const query = buildThreadQueryWithFilters(scope, req.query);

    let threads = await ConversationThread.find(query)
      .populate({
        path: "campaignId",
        select: "name sdrId RHId IMEId flowType teamMailboxes",
        populate: [
          {
            path: "sdrId",
            select: "name email role",
          },
          {
            path: "RHId",
            select: "name email role",
          },
          {
            path: "IMEId",
            select: "name email role",
          },
        ],
      })
      .populate({
        path: "prospectId",
        select: "companyName primaryContact stage assignedBmeId assignedImeId instantly",
        populate: [
          {
            path: "assignedBmeId",
            select: "name email role",
          },
          {
            path: "assignedImeId",
            select: "name email role",
          },
        ],
      })
      .sort({
        lastMessageAt: -1,
        updatedAt: -1,
      });

    threads = await Promise.all(
      threads.map((thread) => attachFallbackCampaignData(thread))
    );

    const hideEmail = shouldHideBrandEmail(req.admin);

    const filtered = threads.filter((thread) => {
      const campaign = getThreadCampaignObject(thread);
      const prospect = thread.prospectId;

      if (
        normalizeRole(req.admin?.role) === "super_admin" &&
        String(req.query?.RHId || "").trim()
      ) {
        if (
          String(campaign?.RHId?._id || campaign?.RHId || "") !==
          String(req.query.RHId).trim()
        ) {
          return false;
        }
      }

      if (String(req.query?.sdrId || "").trim()) {
        if (
          String(campaign?.sdrId?._id || campaign?.sdrId || "") !==
          String(req.query.sdrId).trim()
        ) {
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

      const brandDisplayName = getBrandDisplayNameFromThread(thread);
      const mailboxDisplayName = getMailboxNameFromThread(thread);

      const haystack = [
        thread.subject,
        thread.brandName,
        hideEmail ? "" : thread.brandEmail,
        campaign?.name,
        prospect?.companyName,
        prospect?.primaryContact?.name,
        hideEmail ? "" : prospect?.primaryContact?.email,
        thread.ownerRole,
        thread.status,
        mailboxDisplayName,
        brandDisplayName,
        campaign?.sdrId?.name,
        campaign?.RHId?.name,
        campaign?.IMEId?.name,
        prospect?.assignedBmeId?.name,
        prospect?.assignedImeId?.name,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(search);
    });

    const sorted = sortThreadsForAdminInbox(filtered, req.admin);

    return res.status(200).json({
      success: true,
      count: sorted.length,
      data: sorted.map((thread) => serializeThread(thread, req.admin)),
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "LIST_BME_THREADS_ERROR");
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to load threads",
    });
  }
};

exports.markThreadAsRead = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "bme", "ime", "super_admin"]);

    const thread = await getScopedThread(req.admin, req.params.threadId);

    thread.unreadForRevenueHead = false;
    thread.unreadForBme = false;
    thread.unreadForIme = false;

    await thread.save();

    return res.status(200).json({
      success: true,
      message: "Thread marked as read",
      thread: serializeThread(thread, req.admin),
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "MARK_THREAD_AS_READ_ERROR");
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to mark thread as read",
    });
  }
};

exports.getThreadMessages = async (req, res) => {
  try {
    ensureRole(req.admin, ["revenue_head", "bme", "ime", "super_admin"]);

    const thread = await getScopedThread(req.admin, req.params.threadId);

    const messages = await ConversationMessage.find({
      threadId: thread._id,
    }).sort({
      createdAt: 1,
    });

    return res.status(200).json({
      success: true,
      thread: serializeThread(thread, req.admin),
      messages: messages.map((message) =>
        serializeMessage(message, thread, req.admin)
      ),
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "GET_THREAD_MESSAGES_ERROR");
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

    const subject = String(req.body?.subject || thread.subject || "").trim();

    const { bodyText, bodyHtml } = normalizeReplyBody(
      req.body?.bodyText,
      req.body?.bodyHtml
    );

    if (!bodyText || !bodyHtml) {
      return res.status(400).json({
        success: false,
        message: "Reply body is required",
      });
    }

    const toEmail = normalizeEmail(
      thread?.prospectId?.primaryContact?.email || thread?.brandEmail || ""
    );

    if (!toEmail) {
      return res.status(400).json({
        success: false,
        message: "Thread recipient email is missing",
      });
    }

    const fromEmail = normalizeEmail(
      thread?.mailboxes?.currentReplyFromEmail ||
      thread?.mailboxes?.campaignSenderEmail ||
      ""
    );

    if (!fromEmail) {
      return res.status(400).json({
        success: false,
        message: "Reply mailbox is missing for this thread",
      });
    }

    const replyTargetUuid = await resolveReplyTargetForThread(thread);

    if (!replyTargetUuid) {
      return res.status(400).json({
        success: false,
        message: "Reply target email id is missing for this conversation",
      });
    }

    const fromDisplayName = await resolveMailboxDisplayName(
      fromEmail,
      thread?.mailboxes?.currentReplyFromName ||
      thread?.mailboxes?.campaignSenderName ||
      nameFromEmail(fromEmail)
    );

    const brandDisplayName = getBrandDisplayNameFromThread(thread);

    const response = await instantlyService.replyToEmail({
      reply_to_uuid: replyTargetUuid,
      eaccount: fromEmail,
      subject: subject || thread.subject || "",
      body: {
        html: bodyHtml,
      },
    });

    const providerMessageId = String(
      response?.id ||
      response?.data?.id ||
      response?.message_id ||
      response?.data?.message_id ||
      ""
    ).trim();

    const message = await ConversationMessage.create({
      threadId: thread._id,
      prospectId: thread.prospectId?._id || thread.prospectId || null,

      direction: MESSAGE_DIRECTION.OUTBOUND,
      provider: "instantly",
      providerMessageId,
      providerThreadId: thread.instantlyThreadId || "",

      from: fromEmail,
      fromName: fromDisplayName || nameFromEmail(fromEmail),

      to: [toEmail],
      toNames: [brandDisplayName],

      subject,
      bodyText,
      bodyHtml,

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

    thread.mailboxes = {
      ...(thread.mailboxes || {}),
      currentReplyFromEmail: fromEmail,
      currentReplyFromName: fromDisplayName || nameFromEmail(fromEmail),
    };

    await thread.save();

    const notifyAdminIds = uniqueNotificationIds([thread.ownerId]).filter(
      (id) => id !== String(req.admin.adminId || "")
    );

    if (notifyAdminIds.length) {
      await notifySafely("replyToThread", req, {
        adminIds: notifyAdminIds,
        type: "outreach.reply_sent",
        title: "Reply sent in conversation",
        message: `${getMailboxNameFromThread(thread)} replied to ${brandDisplayName}.`,
        entityType: "outreach_thread",
        entityId: String(thread._id),
        actionPath: {
          admin: buildCrmRepliesAdminPath({
            threadId: thread._id,
            prospectId: thread.prospectId?._id || thread.prospectId,
          }),
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Reply sent successfully",
      data: {
        thread: serializeThread(thread, req.admin),
        message: serializeMessage(message, thread, req.admin),
      },
    });
  } catch (error) {
    console.error("replyToThread error:", {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });

    
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "REPLY_TO_THREAD_ERROR");return res.status(error?.response?.status || error?.statusCode || 500).json({
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