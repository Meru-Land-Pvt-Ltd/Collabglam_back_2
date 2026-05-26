const OutreachCampaign = require("../models/outreachCampaign");
const OutreachMailboxAssignment = require("../models/outreachMailboxAssignment");
const { ConversationThread } = require("../models/conversationThread");
const instantlyService = require("../services/instantlyService");
const {
  OWNER_ROLE,
  OUTREACH_CAMPAIGN_STATUS,
} = require("../constants/outreach");
const { ensureRole } = require("../utils/outreachGuards");
const saveErrorLog = require("../services/errorLog.service");

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function getWorkspaceMeta(role) {
  switch (role) {
    case "sdr":
      return {
        workspaceName: "Instantly CRM",
        workspaceSubtitle: "SDR outreach workspace",
        workspaceInitials: "SD",
      };
    case "revenue_head":
      return {
        workspaceName: "Instantly CRM",
        workspaceSubtitle: "Revenue Head workspace",
        workspaceInitials: "RH",
      };
    case "bme":
      return {
        workspaceName: "Instantly CRM",
        workspaceSubtitle: "Brand Manager workspace",
        workspaceInitials: "BM",
      };
    case "ime":
      return {
        workspaceName: "Instantly CRM",
        workspaceSubtitle: "Influencer Management workspace",
        workspaceInitials: "IM",
      };
    case "super_admin":
    default:
      return {
        workspaceName: "Instantly CRM",
        workspaceSubtitle: "CollabGlam outreach workspace",
        workspaceInitials: "IA",
      };
  }
}

function getCampaignFilter(admin) {
  const role = normalizeRole(admin?.role);
  const adminId = admin?.adminId;

  if (role === "sdr") return { sdrId: adminId };
  if (role === "revenue_head") return { RHId: adminId };
  if (role === "ime") return { IMEId: adminId };
  if (role === "super_admin") return {};

  return null;
}

function getMailboxFilter(admin) {
  const role = normalizeRole(admin?.role);
  const adminId = admin?.adminId;

  if (role === "sdr") {
    return {
      adminId,
      role: OWNER_ROLE.SDR,
      isActive: true,
    };
  }

  if (role === "revenue_head") {
    return {
      adminId,
      role: OWNER_ROLE.REVENUE_HEAD,
      isActive: true,
    };
  }

  if (role === "bme") {
    return {
      adminId,
      role: OWNER_ROLE.BME,
      isActive: true,
    };
  }

  if (role === "ime") {
    return {
      adminId,
      role: OWNER_ROLE.IME,
      isActive: true,
    };
  }

  return null;
}

async function getThreadMeta(admin) {
  const role = normalizeRole(admin?.role);
  const adminId = String(admin?.adminId || "");

  if (role === "bme") {
    return {
      filter: { ownerRole: OWNER_ROLE.BME, ownerId: adminId },
      unreadField: "unreadForBme",
    };
  }

  if (role === "ime") {
    return {
      filter: { ownerRole: OWNER_ROLE.IME, ownerId: adminId },
      unreadField: "unreadForIme",
    };
  }

  if (role === "revenue_head") {
    const campaigns = await OutreachCampaign.find({
      $or: [
        { RHId: adminId },
        { flowType: "ime_influencer" },
      ],
    })
      .select("_id")
      .lean();

    return {
      filter: { campaignId: { $in: campaigns.map((item) => item._id) } },
      unreadField: "unreadForRevenueHead",
    };
  }

  if (role === "super_admin") {
    return {
      filter: {},
      unreadField: null,
    };
  }

  return {
    filter: null,
    unreadField: null,
  };
}

function toSenderAccount(doc) {
  return {
    email: doc?.email || "",
    provider: doc?.provider || "unknown",
    isPrimary: Boolean(doc?.isPrimary),
    isActive: Boolean(doc?.isActive),
    assignedAt: doc?.assignedAt || null,
    warmupScore:
      typeof doc?.instantlyMeta?.warmupScore === "number"
        ? doc.instantlyMeta.warmupScore
        : null,
    dailyLimit:
      typeof doc?.instantlyMeta?.dailyLimit === "number"
        ? doc.instantlyMeta.dailyLimit
        : null,
    warmupStatus:
      typeof doc?.instantlyMeta?.warmupStatus === "number"
        ? doc.instantlyMeta.warmupStatus
        : null,
    accountStatus:
      typeof doc?.instantlyMeta?.status === "number"
        ? doc.instantlyMeta.status
        : null,
  };
}

function buildEmptyActiveSender() {
  return {
    email: "",
    provider: "unknown",
    isPrimary: false,
    isActive: false,
    assignedAt: null,
    warmupScore: null,
    dailyLimit: null,
    warmupStatus: null,
    accountStatus: null,
  };
}

function buildWorkflowRule(role, senderCount) {
  if (role === "sdr") {
    return {
      title: "Sender Rule",
      description:
        senderCount > 1
          ? "You have multiple active sender mailboxes. The primary mailbox is used as the default sender, while all active sender emails can be synced into Instantly campaigns."
          : "You can assign multiple sender mailboxes. Mark one mailbox as primary so it is used as the default sender for previews and campaign defaults.",
    };
  }

  if (role === "revenue_head") {
    return {
      title: "Workflow Rule",
      description:
        "Review Queue shows RH review only. Qualified replies move forward from Review Queue for assignment.",
    };
  }

  if (role === "bme") {
    return {
      title: "Workflow Rule",
      description:
        "Replies page shows only conversations assigned to BME. Work from assigned conversations here.",
    };
  }

  if (role === "ime") {
    return {
      title: "Workflow Rule",
      description:
        "IME conversations stay under IME ownership, and the assigned IME mailbox is used as the active reply mailbox.",
    };
  }

  return {
    title: "Workflow Rule",
    description:
      "Manage sender mailboxes, campaigns, and role-based conversations from one outreach workspace.",
  };
}

async function getConnectionState(senderAccounts) {
  try {
    await instantlyService.listAccounts({ limit: 1 });

    if (!senderAccounts.length) {
      return {
        label: "Instantly Connected",
        description: "Provider is reachable, but no mailbox is assigned to this user",
        status: "warning",
      };
    }

    return {
      label: "Instantly Connected",
      description: "Outreach infrastructure reachable",
      status: "connected",
    };
  } catch (error) {
    if (senderAccounts.length) {
      return {
        label: "Instantly Partially Available",
        description: "Using cached mailbox assignments. Live provider check failed",
        status: "warning",
      };
    }

    return {
      label: "Instantly Disconnected",
      description: "Could not reach provider and no mailbox is assigned",
      status: "disconnected",
    };
  }
}

async function getCampaignSummary(filter) {
  if (!filter) {
    return {
      total: 0,
      byStatus: {
        draft: 0,
        ready: 0,
        launched: 0,
        paused: 0,
        completed: 0,
        error: 0,
      },
    };
  }

  const [total, grouped] = await Promise.all([
    OutreachCampaign.countDocuments(filter),
    OutreachCampaign.aggregate([
      { $match: filter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  const byStatus = {
    [OUTREACH_CAMPAIGN_STATUS.DRAFT]: 0,
    [OUTREACH_CAMPAIGN_STATUS.READY]: 0,
    [OUTREACH_CAMPAIGN_STATUS.LAUNCHED]: 0,
    [OUTREACH_CAMPAIGN_STATUS.PAUSED]: 0,
    [OUTREACH_CAMPAIGN_STATUS.COMPLETED]: 0,
    [OUTREACH_CAMPAIGN_STATUS.ERROR]: 0,
  };

  grouped.forEach((item) => {
    if (item?._id) {
      byStatus[item._id] = item.count;
    }
  });

  return {
    total,
    byStatus,
  };
}

async function getConversationSummary(threadMeta) {
  if (!threadMeta?.filter) {
    return {
      total: 0,
      unread: 0,
    };
  }

  const total = await ConversationThread.countDocuments(threadMeta.filter);

  if (!threadMeta.unreadField) {
    return {
      total,
      unread: 0,
    };
  }

  const unread = await ConversationThread.countDocuments({
    ...threadMeta.filter,
    [threadMeta.unreadField]: true,
  });

  return {
    total,
    unread,
  };
}

exports.getSidebarSummary = async (req, res) => {
  try {
    ensureRole(req.admin, ["super_admin", "revenue_head", "sdr", "bme", "ime"]);

    const role = normalizeRole(req.admin.role);
    const workspaceMeta = getWorkspaceMeta(role);
    const campaignFilter = getCampaignFilter(req.admin);
    const mailboxFilter = getMailboxFilter(req.admin);
const threadMeta = await getThreadMeta(req.admin);

    const [mailboxRows, campaignSummary, conversationSummary] = await Promise.all([
      mailboxFilter
        ? OutreachMailboxAssignment.find(mailboxFilter)
            .sort({ isPrimary: -1, assignedAt: 1, createdAt: 1 })
            .lean()
        : [],
      getCampaignSummary(campaignFilter),
      getConversationSummary(threadMeta),
    ]);

    const senderAccounts = mailboxRows.map(toSenderAccount);
    const primarySender =
      senderAccounts.find((item) => item.isPrimary) ||
      senderAccounts[0] ||
      buildEmptyActiveSender();

    const connection = await getConnectionState(senderAccounts);

    return res.status(200).json({
      success: true,
      data: {
        ...workspaceMeta,
        role,
        connection,
        activeSender: primarySender,
        senderAccounts,
        mailboxSummary: {
          total: senderAccounts.length,
          hasMultipleSenders: senderAccounts.length > 1,
          primaryEmail: primarySender?.email || "",
        },
        campaignSummary,
        conversationSummary,
        workflowRule: buildWorkflowRule(role, senderAccounts.length),
      },
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "GET_SIDEBAR_SUMMARY_ERROR"
    );

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to load sidebar summary",
    });
  }
};