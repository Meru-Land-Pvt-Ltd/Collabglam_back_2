const OutreachMailboxAssignment = require("../models/outreachMailboxAssignment");
const OutreachCampaign = require("../models/outreachCampaign");
const instantlyService = require("../services/instantlyService");
const { OWNER_ROLE } = require("../constants/outreach");
const { ensureRole } = require("../utils/outreachGuards");
const { createAndEmit } = require("../utils/notifier");
const saveErrorLog = require("../services/errorLog.service");


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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function getInstantlyItems(payload) {
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function inferProvider(account) {
  const providerCode = Number(account?.provider_code);

  if (providerCode === 1) return "google";
  if (providerCode === 2) return "microsoft";

  return "unknown";
}

function roleAllowsMultipleMailboxes(role) {
  return [OWNER_ROLE.SDR, OWNER_ROLE.IME].includes(role);
}

function roleCanSelectPrimary(role) {
  return [OWNER_ROLE.SDR, OWNER_ROLE.IME].includes(role);
}

function roleUsesSingleMailbox(role) {
  return [OWNER_ROLE.REVENUE_HEAD, OWNER_ROLE.BME].includes(role);
}

function getArrayPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  return [];
}

function toSafeNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toSafeNullableNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getWarmupEnabled(account, assignment) {
  const raw =
    account?.warmup_enabled ??
    account?.warmup_status ??
    assignment?.instantlyMeta?.warmupStatus;

  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw > 0;

  return false;
}

function normalizeDailyAnalyticsRows(payload) {
  const rows = getArrayPayload(payload);

  return rows.map((item) => ({
    date:
      item?.date ||
      item?.day ||
      item?.label ||
      item?.created_at ||
      "",
    emailAccount: normalizeEmail(
      item?.email_account ||
      item?.emailAccount ||
      item?.email ||
      item?.account_email ||
      item?.accountEmail
    ),
    sent: toSafeNumber(
      item?.sent,
      item?.emails_sent,
      item?.total_sent
    ),
    received: toSafeNumber(
      item?.received,
      item?.emails_received,
      item?.warmup_emails_received,
      item?.total_received
    ),
    savedFromSpam: toSafeNumber(
      item?.saved_from_spam,
      item?.savedFromSpam,
      item?.saved
    ),
  }));
}

function normalizeWarmupAnalyticsRows(payload, email = "") {
  const normalizedEmail = normalizeEmail(email);
  const emailDateData = payload?.email_date_data || payload?.data?.email_date_data || {};
  const accountDateData = emailDateData[normalizedEmail] || emailDateData[email] || {};

  return Object.entries(accountDateData).map(([date, item]) => ({
    date,
    emailAccount: normalizedEmail,
    sent: toSafeNumber(item?.sent),
    received: toSafeNumber(item?.received),
    savedFromSpam: toSafeNumber(item?.landed_inbox, item?.saved_from_spam),
    landedInbox: toSafeNumber(item?.landed_inbox),
    landedSpam: toSafeNumber(item?.landed_spam),
  }));
}

function mergeDailyAndWarmupRows(dailyRows = [], warmupRows = []) {
  const map = new Map();

  dailyRows.forEach((row) => {
    if (!row?.date) return;
    map.set(row.date, { ...row });
  });

  warmupRows.forEach((row) => {
    if (!row?.date) return;

    const existing = map.get(row.date) || {
      date: row.date,
      emailAccount: row.emailAccount || "",
      sent: 0,
      received: 0,
      savedFromSpam: 0,
    };

    map.set(row.date, {
      ...existing,
      sent: toSafeNumber(row.sent, existing.sent),
      received: toSafeNumber(row.received, existing.received),
      savedFromSpam: toSafeNumber(row.savedFromSpam, row.landedInbox, existing.savedFromSpam),
    });
  });

  return Array.from(map.values()).sort(
    (a, b) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
  );
}

function filterDailyRowsByEmail(dailyRows = [], email = "") {
  const normalizedEmail = normalizeEmail(email);

  return dailyRows.filter((item) => {
    if (!item?.emailAccount) return true;
    return item.emailAccount === normalizedEmail;
  });
}

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function getDateNDaysAgoString(days = 30) {
  const date = new Date();
  date.setDate(date.getDate() - Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function getDailyRowForDate(dailyRows = [], targetDate = getTodayDateString()) {
  const normalizedTargetDate = normalizeDailyDate(targetDate);

  return (
    dailyRows.find(
      (item) => normalizeDailyDate(item?.date) === normalizedTargetDate
    ) || null
  );
}

function normalizeDailyDate(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function getEmailsSentSinceAssignment(assignment, dailyRows = []) {
  const today = getTodayDateString();
  const todayRow = getDailyRowForDate(dailyRows, today);

  if (!todayRow) return 0;

  const currentSent = toSafeNumber(todayRow?.sent);

  const baselineDate = normalizeDailyDate(
    assignment?.instantlyMeta?.sentBaselineDate
  );

  const hasBaseline =
    assignment?.instantlyMeta &&
    Object.prototype.hasOwnProperty.call(
      assignment.instantlyMeta,
      "sentBaselineToday"
    );

  const baselineSent = toSafeNumber(
    assignment?.instantlyMeta?.sentBaselineToday
  );

  if (hasBaseline && baselineDate === today) {
    return Math.max(0, currentSent - baselineSent);
  }

  return currentSent;
}

async function findInstantlyAccountByEmail(email) {
  try {
    const account = await instantlyService.getAccount(email);
    if (account) return account;
  } catch (error) { }

  const listPayload = await instantlyService.listAccounts({});
  const items = getInstantlyItems(listPayload);

  return (
    items.find((item) => normalizeEmail(item.email) === normalizeEmail(email)) || null
  );
}

function serializeAssignment(row, liveAccount = null, dailyRows = []) {
  return {
    _id: row?._id || null,
    email: row?.email || "",
    role: row?.role || "",
    provider: liveAccount?.provider
      ? inferProvider(liveAccount)
      : row?.provider || "unknown",
    isActive: Boolean(row?.isActive),
    isPrimary: Boolean(row?.isPrimary),
    assignedAt: row?.assignedAt || null,
    unassignedAt: row?.unassignedAt || null,
    adminId: row?.adminId || null,
    emailsSentToday: getEmailsSentSinceAssignment(row, dailyRows),
    instantlyMeta: {
      status:
        toSafeNullableNumber(liveAccount?.status, row?.instantlyMeta?.status),
      warmupStatus:
        toSafeNullableNumber(
          liveAccount?.warmup_status,
          row?.instantlyMeta?.warmupStatus
        ),
      dailyLimit:
        toSafeNullableNumber(
          liveAccount?.daily_limit,
          row?.instantlyMeta?.dailyLimit
        ),
      warmupScore:
        toSafeNullableNumber(
          liveAccount?.stat_warmup_score,
          row?.instantlyMeta?.warmupScore
        ),
    },
  };
}

function getAssignmentStatusLabel(account, assignment) {
  const status = toSafeNullableNumber(account?.status, assignment?.instantlyMeta?.status);

  if (status === null) return "Unknown";
  if (status === 1) return "Active";
  if (status === 0) return "Paused";

  return "Unknown";
}

function getCampaignStatusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return "Draft";

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

async function ensureFallbackPrimary(adminId, role) {
  if (!roleCanSelectPrimary(role)) return;

  const existingPrimary = await OutreachMailboxAssignment.findOne({
    adminId,
    role,
    isActive: true,
    isPrimary: true,
  }).lean();

  if (existingPrimary) return;

  const fallback = await OutreachMailboxAssignment.findOne({
    adminId,
    role,
    isActive: true,
  })
    .sort({ assignedAt: 1, createdAt: 1 })
    .lean();

  if (!fallback?._id) return;

  await OutreachMailboxAssignment.updateOne(
    { _id: fallback._id },
    {
      $set: {
        isPrimary: true,
      },
    }
  );
}

async function getOwnedMailbox(req, email) {
  const role = normalizeRole(req.admin.role);

  const row = await OutreachMailboxAssignment.findOne({
    adminId: req.admin.adminId,
    role,
    email: normalizeEmail(email),
    isActive: true,
  }).lean();

  if (!row) {
    const error = new Error("Mailbox not found for this user");
    error.statusCode = 404;
    throw error;
  }

  return row;
}

async function getCampaignsForMailbox(role, adminId, email) {
  const normalizedEmail = normalizeEmail(email);

  if (role === OWNER_ROLE.SDR) {
    return OutreachCampaign.find({
      sdrId: adminId,
      $or: [
        { "instantly.senderAccountEmail": normalizedEmail },
        { "instantly.accountEmails": normalizedEmail },
      ],
    })
      .select("name status flowType instantly createdAt launchedAt")
      .sort({ createdAt: -1 })
      .lean();
  }

  if (role === OWNER_ROLE.REVENUE_HEAD) {
    return OutreachCampaign.find({
      RHId: adminId,
      "teamMailboxes.RHEmail": normalizedEmail,
    })
      .select("name status flowType instantly createdAt launchedAt")
      .sort({ createdAt: -1 })
      .lean();
  }

  if (role === OWNER_ROLE.IME) {
    return OutreachCampaign.find({
      IMEId: adminId,
      $or: [
        { "teamMailboxes.IMEEmail": normalizedEmail },
        { "instantly.senderAccountEmail": normalizedEmail },
        { "instantly.accountEmails": normalizedEmail },
      ],
    })
      .select("name status flowType instantly createdAt launchedAt")
      .sort({ createdAt: -1 })
      .lean();
  }

  return [];
}

function buildAccountPatchPayload(body = {}) {
  return {
    first_name: String(body?.firstName || "").trim(),
    last_name: String(body?.lastName || "").trim(),
    signature: String(body?.signature || ""),
    tags: Array.isArray(body?.tags)
      ? body.tags
      : String(body?.tags || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    daily_limit: toSafeNumber(body?.dailyLimit),
    minimum_wait_time: toSafeNumber(body?.minimumWaitTime),
    campaign_slow_ramp: Boolean(body?.campaignSlowRamp),
    reply_to_address: String(body?.replyToAddress || "").trim(),
    daily_inbox_placement_test_limit: toSafeNumber(body?.dailyInboxPlacementTestLimit),
    custom_tracking_domain: String(body?.customTrackingDomain || "").trim(),
    enable_custom_tracking_domain: Boolean(body?.enableCustomTrackingDomain),
    warmup_filter_tag: String(body?.warmupFilterTag || "").trim(),
    increase_per_day: toSafeNumber(body?.increasePerDay),
    daily_warmup_limit: toSafeNumber(body?.dailyWarmupLimit),
    disable_slow_warmup: Boolean(body?.disableSlowWarmup),
    reply_rate: toSafeNumber(body?.replyRate),
  };
}

exports.listMailboxAssignments = async (req, res) => {
  try {
    ensureRole(req.admin, ["super_admin", "revenue_head", "sdr", "bme", "ime"]);

    const filter = {};

    if (req.query.role) {
      filter.role = normalizeRole(req.query.role);
    }

    if (req.query.adminId) {
      filter.adminId = req.query.adminId;
    }

    if (req.query.activeOnly === "true") {
      filter.isActive = true;
    }

    const rows = await OutreachMailboxAssignment.find(filter)
      .populate("adminId", "name email role")
      .populate("assignedBy", "name email")
      .sort({ updatedAt: -1 });

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "LIST_MAILBOX_ASSIGNMENTS_ERROR");
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};

exports.assignMailbox = async (req, res) => {
  try {
    ensureRole(req.admin, ["super_admin", "revenue_head"]);

    const email = normalizeEmail(req.body.email);
    const role = normalizeRole(req.body.role);
    const adminId = String(req.body.adminId || "").trim();
    const requestedPrimary = Boolean(req.body.isPrimary);

    if (!email || !role || !adminId) {
      return res.status(400).json({
        success: false,
        message: "email, role and adminId are required",
      });
    }

    if (!Object.values(OWNER_ROLE).includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role",
      });
    }

    const instantlyAccount = await findInstantlyAccountByEmail(email);
    if (!instantlyAccount) {
      return res.status(404).json({
        success: false,
        message: "Instantly account not found for this email",
      });
    }

    if (roleUsesSingleMailbox(role)) {
      await OutreachMailboxAssignment.updateMany(
        { adminId, role, isActive: true },
        {
          $set: {
            isActive: false,
            isPrimary: false,
            unassignedAt: new Date(),
          },
        }
      );
    }

    if (roleCanSelectPrimary(role) && requestedPrimary) {
      await OutreachMailboxAssignment.updateMany(
        {
          adminId,
          role,
          isActive: true,
          isPrimary: true,
          email: { $ne: email },
        },
        { $set: { isPrimary: false } }
      );
    }

    const existingActiveCount = await OutreachMailboxAssignment.countDocuments({
      adminId,
      role,
      isActive: true,
      email: { $ne: email },
    });

    const shouldBePrimary = roleUsesSingleMailbox(role)
      ? true
      : requestedPrimary || existingActiveCount === 0;

    const dailyPayload = await instantlyService
      .getAccountDailyAnalytics({ email })
      .catch(() => null);

    const dailyRows = normalizeDailyAnalyticsRows(dailyPayload);
    const latestDaily = getDailyRowForDate(dailyRows);

    const doc = await OutreachMailboxAssignment.findOneAndUpdate(
      { email },
      {
        $set: {
          email,
          role,
          adminId,
          provider: inferProvider(instantlyAccount),
          isActive: true,
          isPrimary: shouldBePrimary,
          unassignedAt: null,
          assignedAt: new Date(),
          assignedBy: req.admin.adminId,
          instantlyMeta: {
            status:
              typeof instantlyAccount?.status === "number"
                ? instantlyAccount.status
                : null,
            warmupStatus:
              typeof instantlyAccount?.warmup_status === "number"
                ? instantlyAccount.warmup_status
                : null,
            dailyLimit:
              typeof instantlyAccount?.daily_limit === "number"
                ? instantlyAccount.daily_limit
                : null,
            warmupScore:
              typeof instantlyAccount?.stat_warmup_score === "number"
                ? instantlyAccount.stat_warmup_score
                : null,

            sentBaselineToday: toSafeNumber(latestDaily?.sent),
            sentBaselineDate: getTodayDateString(),
          },
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
    )
      .populate("adminId", "name email role")
      .populate("assignedBy", "name email");

    await ensureFallbackPrimary(adminId, role);

    await notifySafely("assignMailbox", req, {
      adminId,
      type: "outreach.mailbox_assigned",
      title: "Mailbox assigned",
      message: `${email} was assigned to your ${role.replace(/_/g, " ")} mailbox list.`,
      entityType: "outreach_mailbox",
      entityId: String(doc._id),
      actionPath: {
        admin: "/admin/crm/my-accounts",
      },
    });

    return res.status(200).json({
      success: true,
      message: "Mailbox assigned successfully",
      data: doc,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "ASSIGN_MAILBOX_ERROR");
    return res.status(error.statusCode || 500).json({
      success: false,
      message:
        error.code === 11000
          ? "This mailbox or role assignment already exists"
          : error.message || "Internal error",
    });
  }
};

exports.unassignMailbox = async (req, res) => {
  try {
    ensureRole(req.admin, ["super_admin", "revenue_head"]);

    const email = normalizeEmail(req.params.email);

    const row = await OutreachMailboxAssignment.findOneAndUpdate(
      { email, isActive: true },
      {
        $set: {
          isActive: false,
          isPrimary: false,
          unassignedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Active mailbox assignment not found",
      });
    }

    await ensureFallbackPrimary(row.adminId, row.role);

    await notifySafely("unassignMailbox", req, {
      adminId: String(row.adminId),
      type: "outreach.mailbox_unassigned",
      title: "Mailbox unassigned",
      message: `${row.email} was unassigned from your ${row.role.replace(/_/g, " ")} mailbox list.`,
      entityType: "outreach_mailbox",
      entityId: String(row._id),
      actionPath: {
        admin: "/admin/crm/my-accounts",
      },
    });

    return res.status(200).json({
      success: true,
      message: "Mailbox unassigned successfully",
      data: row,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "UNASSIGN_MAILBOX_ERROR");
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};

exports.listMyMailboxAccounts = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "bme", "revenue_head", "ime"]);

    const role = normalizeRole(req.admin.role);

    const rows = await OutreachMailboxAssignment.find({
      adminId: req.admin.adminId,
      role,
      isActive: true,
    })
      .sort({ isPrimary: -1, assignedAt: 1, createdAt: 1 })
      .lean();

    const enriched = await Promise.all(
      rows.map(async (row) => {
        const [liveAccount, dailyPayload] = await Promise.all([
          instantlyService.getAccount(row.email).catch(() => null),
          instantlyService
            .getAccountDailyAnalytics({
              emails: [row.email],
              start_date: getTodayDateString(),
              end_date: getTodayDateString(),
            })
            .catch(() => null),
        ]);

        return serializeAssignment(
          row,
          liveAccount,
          filterDailyRowsByEmail(
            normalizeDailyAnalyticsRows(dailyPayload),
            row.email
          )
        );
      })
    );

    const primary =
      enriched.find((item) => item.isPrimary) ||
      enriched[0] ||
      null;

    return res.status(200).json({
      success: true,
      data: {
        role,
        canSelectPrimary: roleCanSelectPrimary(role),
        allowsMultiple: roleAllowsMultipleMailboxes(role),
        totalAccounts: enriched.length,
        primaryEmail: primary?.email || "",
        accounts: enriched,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "LIST_MY_MAILBOX_ACCOUNTS_ERROR");
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to load accounts",
    });
  }
};

exports.setMyMailboxPrimary = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime"]);

    const role = normalizeRole(req.admin.role);
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "email is required",
      });
    }

    const target = await OutreachMailboxAssignment.findOne({
      adminId: req.admin.adminId,
      role,
      email,
      isActive: true,
    });

    if (!target) {
      return res.status(404).json({
        success: false,
        message: "Mailbox not found for this user",
      });
    }

    await OutreachMailboxAssignment.updateMany(
      {
        adminId: req.admin.adminId,
        role,
        isActive: true,
        _id: { $ne: target._id },
      },
      { $set: { isPrimary: false } }
    );

    target.isPrimary = true;
    await target.save();

    return res.status(200).json({
      success: true,
      message: "Primary mailbox updated successfully",
      data: {
        email,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "SET_MY_MAILBOX_PRIMARY_ERROR");
    return res.status(error.statusCode || 500).json({
      success: false,
      message:
        error.code === 11000
          ? "Another primary mailbox already exists"
          : error.message || "Failed to update primary mailbox",
    });
  }
};

exports.getMyMailboxAccountDetails = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "bme", "revenue_head", "ime"]);

    const role = normalizeRole(req.admin.role);
    const email = normalizeEmail(req.params.email);
    const assignment = await getOwnedMailbox(req, email);

    const [liveAccount, dailyPayload, warmupPayload, campaigns] = await Promise.all([
      instantlyService.getAccount(email).catch(() => null),
      instantlyService
        .getAccountDailyAnalytics({
          emails: [email],
          start_date: getDateNDaysAgoString(30),
          end_date: getTodayDateString(),
        })
        .catch(() => null),
      instantlyService
        .getWarmupAnalytics({
          emails: [email],
        })
        .catch(() => null),
      getCampaignsForMailbox(role, req.admin.adminId, email),
    ]);

    const dailyRows = mergeDailyAndWarmupRows(
      filterDailyRowsByEmail(normalizeDailyAnalyticsRows(dailyPayload), email),
      normalizeWarmupAnalyticsRows(warmupPayload, email)
    ).slice(-30);
    const warmupSummary = dailyRows.reduce(
      (acc, item) => {
        acc.sent += item.sent;
        acc.received += item.received;
        acc.savedFromSpam += item.savedFromSpam;
        return acc;
      },
      {
        sent: 0,
        received: 0,
        savedFromSpam: 0,
      }
    );

    return res.status(200).json({
      success: true,
      data: {
        role,
        canSelectPrimary: roleCanSelectPrimary(role),
        account: {
          email,
          provider: assignment?.provider || inferProvider(liveAccount),
          isActive: Boolean(assignment?.isActive),
          isPrimary: Boolean(assignment?.isPrimary),
          isPaused: toSafeNumber(liveAccount?.status) === 0,
          statusLabel: getAssignmentStatusLabel(liveAccount, assignment),
          assignedAt: assignment?.assignedAt || null,
          emailsSentToday: getEmailsSentSinceAssignment(assignment, dailyRows),
          instantlyMeta: {
            status: toSafeNullableNumber(liveAccount?.status, assignment?.instantlyMeta?.status),
            warmupStatus: toSafeNullableNumber(
              liveAccount?.warmup_status,
              assignment?.instantlyMeta?.warmupStatus
            ),
            dailyLimit: toSafeNullableNumber(
              liveAccount?.daily_limit,
              assignment?.instantlyMeta?.dailyLimit
            ),
            warmupScore: toSafeNullableNumber(
              liveAccount?.stat_warmup_score,
              assignment?.instantlyMeta?.warmupScore
            ),
          },
        },
        warmup: {
          enabled: getWarmupEnabled(liveAccount, assignment),
          startedOn:
            liveAccount?.warmup_started_at ||
            liveAccount?.warmup_start_date ||
            assignment?.assignedAt ||
            null,
          summary: warmupSummary,
          chart: dailyRows.map((item) => ({
            label: item.date || "",
            sent: item.sent,
            received: item.received,
            savedFromSpam: item.savedFromSpam,
          })),
        },
        settings: {
          firstName: liveAccount?.first_name || "",
          lastName: liveAccount?.last_name || "",
          signature: liveAccount?.signature || "",
          tags: Array.isArray(liveAccount?.tags) ? liveAccount.tags : [],
          dailyLimit: toSafeNumber(
            liveAccount?.daily_limit,
            assignment?.instantlyMeta?.dailyLimit
          ),
          minimumWaitTime: toSafeNumber(
            liveAccount?.minimum_wait_time,
            liveAccount?.min_wait_time,
            1
          ),
          campaignSlowRamp: Boolean(
            liveAccount?.campaign_slow_ramp ??
            liveAccount?.campaign_slow_ramp_enabled
          ),
          replyToAddress:
            liveAccount?.reply_to_address ||
            liveAccount?.reply_to ||
            "",
          dailyInboxPlacementTestLimit: toSafeNumber(
            liveAccount?.daily_inbox_placement_test_limit,
            liveAccount?.inbox_placement_test_limit,
            10
          ),
          customTrackingDomain:
            liveAccount?.custom_tracking_domain ||
            "",
          enableCustomTrackingDomain: Boolean(
            liveAccount?.enable_custom_tracking_domain ||
            liveAccount?.custom_tracking_domain_enabled
          ),
          warmupFilterTag:
            liveAccount?.warmup_filter_tag ||
            "",
          increasePerDay: toSafeNumber(
            liveAccount?.increase_per_day,
            1
          ),
          dailyWarmupLimit: toSafeNumber(
            liveAccount?.daily_warmup_limit,
            10
          ),
          disableSlowWarmup: Boolean(liveAccount?.disable_slow_warmup),
          replyRate: toSafeNumber(liveAccount?.reply_rate, 30),
        },
        campaigns: campaigns.map((item) => ({
          _id: item?._id || "",
          name: item?.name || "",
          status: item?.status || "draft",
          statusLabel: getCampaignStatusLabel(item?.status),
          flowType: item?.flowType || "standard_brand",
          senderAccountEmail: item?.instantly?.senderAccountEmail || "",
          createdAt: item?.createdAt || "",
          launchedAt: item?.launchedAt || "",
        })),
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "GET_MY_MAILBOX_ACCOUNT_DETAILS_ERROR");
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to load account details",
    });
  }
};

exports.updateMyMailboxSettings = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "bme", "revenue_head", "ime"]);

    const email = normalizeEmail(req.params.email);
    await getOwnedMailbox(req, email);

    const payload = buildAccountPatchPayload(req.body || {});
    const result = await instantlyService.updateAccount(email, payload);

    return res.status(200).json({
      success: true,
      message: "Mailbox settings updated successfully",
      data: result,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "UPDATE_MY_MAILBOX_SETTINGS_ERROR");
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to update mailbox settings",
    });
  }
};

exports.pauseMyMailbox = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "bme", "revenue_head", "ime"]);

    const email = normalizeEmail(req.params.email);
    await getOwnedMailbox(req, email);

    const result = await instantlyService.pauseAccount(email);

    return res.status(200).json({
      success: true,
      message: "Mailbox paused successfully",
      data: result,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "PAUSE_MY_MAILBOX_ERROR");
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to pause mailbox",
    });
  }
};

exports.resumeMyMailbox = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "bme", "revenue_head", "ime"]);

    const email = normalizeEmail(req.params.email);
    await getOwnedMailbox(req, email);

    const result = await instantlyService.resumeAccount(email);

    return res.status(200).json({
      success: true,
      message: "Mailbox resumed successfully",
      data: result,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "RESUME_MY_MAILBOX_ERROR");
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to resume mailbox",
    });
  }
};

exports.enableMyMailboxWarmup = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "bme", "revenue_head", "ime"]);

    const email = normalizeEmail(req.params.email);
    await getOwnedMailbox(req, email);

    const result = await instantlyService.enableWarmup({
      emails: [email],
    });

    return res.status(200).json({
      success: true,
      message: "Warmup enabled successfully",
      data: result,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "ENABLE_MY_MAILBOX_WARMUP_ERROR");
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to enable warmup",
    });
  }
};

exports.disableMyMailboxWarmup = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "bme", "revenue_head", "ime"]);

    const email = normalizeEmail(req.params.email);
    await getOwnedMailbox(req, email);

    const result = await instantlyService.disableWarmup({
      emails: [email],
    });

    return res.status(200).json({
      success: true,
      message: "Warmup disabled successfully",
      data: result,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "DISABLE_MY_MAILBOX_WARMUP_ERROR");
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to disable warmup",
    });
  }
};