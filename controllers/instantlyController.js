const instantlyService = require("../services/instantlyService");
const saveErrorLog = require("../services/errorLog.service");

function getErrorPayload(error) {
  return {
    message:
      error?.response?.data?.message ||
      error?.response?.data?.error ||
      error?.message ||
      "Instantly request failed",
    details: error?.response?.data || null,
    statusCode: error?.response?.status || 500,
  };
}

function ok(res, data, extra = {}) {
  return res.status(200).json({
    success: true,
    ...extra,
    data,
  });
}

async function fail(req, res, error, errorCode = "INSTANTLY_CONTROLLER_ERROR") {
  const payload = getErrorPayload(error);
  await saveErrorLog(req, error, payload.statusCode, errorCode);

  return res.status(payload.statusCode).json({
    success: false,
    ...payload,
  });
}

function decodeParam(value) {
  return decodeURIComponent(String(value || "").trim());
}

function createHandler(serviceCall, options = {}) {
  const { errorCode = "INSTANTLY_CONTROLLER_ERROR", ...successOptions } = options;

  return async (req, res) => {
    try {
      const data = await serviceCall(req, res);
      return ok(res, data, successOptions);
    } catch (error) {
      return fail(req, res, error, errorCode);
    }
  };
}

exports.testInstantlyConnection = createHandler(
  async () => instantlyService.listAccounts(),
  { errorCode: "TEST_INSTANTLY_CONNECTION_ERROR", message: "Instantly connected successfully" }
);

/* =========================
   Analytics
========================= */

exports.getWarmupAnalytics = createHandler(async (req) =>
  instantlyService.getWarmupAnalytics(req.body || {})
, { errorCode: "GET_WARMUP_ANALYTICS_ERROR" });

exports.getAccountDailyAnalytics = createHandler(async (req) =>
  instantlyService.getAccountDailyAnalytics(req.query || {})
, { errorCode: "GET_ACCOUNT_DAILY_ANALYTICS_ERROR" });

exports.testAccountVitals = createHandler(async (req) =>
  instantlyService.testAccountVitals(req.body || {})
, { errorCode: "TEST_ACCOUNT_VITALS_ERROR" });

exports.getCampaignAnalytics = createHandler(async (req) =>
  instantlyService.getCampaignAnalytics(req.query || {})
, { errorCode: "GET_CAMPAIGN_ANALYTICS_ERROR" });

exports.getCampaignAnalyticsOverview = createHandler(async (req) =>
  instantlyService.getCampaignAnalyticsOverview(req.query || {})
, { errorCode: "GET_CAMPAIGN_ANALYTICS_OVERVIEW_ERROR" });

exports.getCampaignAnalyticsDaily = createHandler(async (req) =>
  instantlyService.getCampaignAnalyticsDaily(req.query || {})
, { errorCode: "GET_CAMPAIGN_ANALYTICS_DAILY_ERROR" });

exports.getCampaignAnalyticsSteps = createHandler(async (req) =>
  instantlyService.getCampaignAnalyticsSteps(req.query || {})
, { errorCode: "GET_CAMPAIGN_ANALYTICS_STEPS_ERROR" });

/* =========================
   Campaigns
========================= */

exports.createCampaign = createHandler(async (req) =>
  instantlyService.createCampaign(req.body || {})
, { errorCode: "CREATE_CAMPAIGN_ERROR" });

exports.listCampaigns = createHandler(async (req) =>
  instantlyService.listCampaigns(req.query || {})
, { errorCode: "LIST_CAMPAIGNS_ERROR" });

exports.getCampaign = createHandler(async (req) =>
  instantlyService.getCampaign(req.params.id)
, { errorCode: "GET_CAMPAIGN_ERROR" });

exports.updateCampaign = createHandler(async (req) =>
  instantlyService.updateCampaign(req.params.id, req.body || {})
, { errorCode: "UPDATE_CAMPAIGN_ERROR" });

exports.deleteCampaign = createHandler(async (req) =>
  instantlyService.deleteCampaign(req.params.id)
, { errorCode: "DELETE_CAMPAIGN_ERROR" });

exports.activateCampaign = createHandler(
  async (req) => instantlyService.activateCampaign(req.params.id, req.body || {}),
  { errorCode: "ACTIVATE_CAMPAIGN_ERROR", message: "Campaign activated successfully" }
);

exports.pauseCampaign = createHandler(
  async (req) => instantlyService.pauseCampaign(req.params.id, req.body || {}),
  { errorCode: "PAUSE_CAMPAIGN_ERROR", message: "Campaign paused successfully" }
);

exports.searchCampaignsByContact = createHandler(async (req) =>
  instantlyService.searchCampaignsByContact(req.query || {})
, { errorCode: "SEARCH_CAMPAIGNS_BY_CONTACT_ERROR" });

exports.shareCampaign = createHandler(async (req) =>
  instantlyService.shareCampaign(req.params.id, req.body || {})
, { errorCode: "SHARE_CAMPAIGN_ERROR" });

exports.createCampaignFromExport = createHandler(async (req) =>
  instantlyService.createCampaignFromExport(req.params.id, req.body || {})
, { errorCode: "CREATE_CAMPAIGN_FROM_EXPORT_ERROR" });

exports.exportCampaign = createHandler(async (req) =>
  instantlyService.exportCampaign(req.params.id, req.body || {})
, { errorCode: "EXPORT_CAMPAIGN_ERROR" });

exports.duplicateCampaign = createHandler(async (req) =>
  instantlyService.duplicateCampaign(req.params.id, req.body || {})
, { errorCode: "DUPLICATE_CAMPAIGN_ERROR" });

exports.getLaunchedCampaignCount = createHandler(async (req) =>
  instantlyService.getLaunchedCampaignCount(req.query || {})
, { errorCode: "GET_LAUNCHED_CAMPAIGN_COUNT_ERROR" });

exports.addCampaignVariables = createHandler(async (req) =>
  instantlyService.addCampaignVariables(req.params.id, req.body || {})
, { errorCode: "ADD_CAMPAIGN_VARIABLES_ERROR" });

exports.getCampaignSendingStatus = createHandler(async (req) =>
  instantlyService.getCampaignSendingStatus(req.params.id, req.query || {})
, { errorCode: "GET_CAMPAIGN_SENDING_STATUS_ERROR" });

function flattenCsvRow(value, prefix = "", target = {}) {
  if (Array.isArray(value)) {
    if (!value.length) {
      if (prefix) target[prefix] = "";
      return target;
    }

    const arePrimitive = value.every(
      (item) => item == null || ["string", "number", "boolean"].includes(typeof item)
    );

    if (arePrimitive) {
      if (prefix) target[prefix] = value.join(" | ");
      return target;
    }

    value.forEach((item, index) => {
      flattenCsvRow(item, prefix ? `${prefix}.${index}` : String(index), target);
    });

    return target;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, nestedValue]) => {
      flattenCsvRow(nestedValue, prefix ? `${prefix}.${key}` : key, target);
    });
    return target;
  }

  if (prefix) {
    target[prefix] = value == null ? "" : value;
  }

  return target;
}

function toCsv(rows = []) {
  const flatRows = rows.map((row) => flattenCsvRow(row));
  const headers = Array.from(
    flatRows.reduce((acc, row) => {
      Object.keys(row).forEach((key) => acc.add(key));
      return acc;
    }, new Set())
  );

  const escape = (value) => {
    const stringValue = String(value == null ? "" : value);
    if (/[,"]|\n/.test(stringValue)) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  };

  const lines = [headers.join(",")];

  flatRows.forEach((row) => {
    lines.push(headers.map((header) => escape(row[header])).join(","));
  });

  return lines.join("\n");
}

function extractAnalyticsRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return payload ? [payload] : [];
}

exports.downloadCampaignAnalyticsCsv = async (req, res) => {
  try {
    const params = { ...(req.query || {}) };

    if (req.params.id) {
      params.campaign_id = params.campaign_id || req.params.id;
      params.campaignId = params.campaignId || req.params.id;
      params.id = params.id || req.params.id;
    }

    const analytics = await instantlyService.getCampaignAnalyticsDaily(params);
    const rows = extractAnalyticsRows(analytics);
    const csv = toCsv(rows);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="campaign-analytics-${req.params.id}.csv"`
    );

    return res.status(200).send(csv);
  } catch (error) {
    return fail(req, res, error, "DOWNLOAD_CAMPAIGN_ANALYTICS_CSV_ERROR");
  }
};

/* =========================
   Emails
========================= */

exports.sendTestEmail = createHandler(async (req) =>
  instantlyService.sendTestEmail(req.body || {})
, { errorCode: "SEND_TEST_EMAIL_ERROR" });

exports.replyToEmail = createHandler(async (req) =>
  instantlyService.replyToEmail(req.body || {})
, { errorCode: "REPLY_TO_EMAIL_ERROR" });

exports.forwardEmail = createHandler(async (req) =>
  instantlyService.forwardEmail(req.body || {})
, { errorCode: "FORWARD_EMAIL_ERROR" });

exports.listEmails = createHandler(async (req) =>
  instantlyService.listEmails(req.query || {})
, { errorCode: "LIST_EMAILS_ERROR" });

exports.getEmail = createHandler(async (req) =>
  instantlyService.getEmail(req.params.id)
, { errorCode: "GET_EMAIL_ERROR" });

exports.updateEmail = createHandler(async (req) =>
  instantlyService.updateEmail(req.params.id, req.body || {})
, { errorCode: "UPDATE_EMAIL_ERROR" });

exports.deleteEmail = createHandler(async (req) =>
  instantlyService.deleteEmail(req.params.id)
, { errorCode: "DELETE_EMAIL_ERROR" });

exports.getUnreadEmailCount = createHandler(async (req) =>
  instantlyService.getUnreadEmailCount(req.query || {})
, { errorCode: "GET_UNREAD_EMAIL_COUNT_ERROR" });

exports.markThreadAsRead = createHandler(
  async (req) => instantlyService.markThreadAsRead(req.params.threadId),
  { errorCode: "MARK_THREAD_AS_READ_ERROR", message: "Thread marked as read" }
);

/* =========================
   Accounts
========================= */

exports.createInstantlyAccount = createHandler(async (req) =>
  instantlyService.createAccount(req.body || {})
, { errorCode: "CREATE_INSTANTLY_ACCOUNT_ERROR" });

exports.listInstantlyAccounts = createHandler(async (req) =>
  instantlyService.listAccounts(req.query || {})
, { errorCode: "LIST_INSTANTLY_ACCOUNTS_ERROR" });

exports.getInstantlyAccount = createHandler(async (req) =>
  instantlyService.getAccount(decodeParam(req.params.email))
, { errorCode: "GET_INSTANTLY_ACCOUNT_ERROR" });

exports.updateInstantlyAccount = createHandler(async (req) =>
  instantlyService.updateAccount(decodeParam(req.params.email), req.body || {})
, { errorCode: "UPDATE_INSTANTLY_ACCOUNT_ERROR" });

exports.deleteInstantlyAccount = createHandler(async (req) =>
  instantlyService.deleteAccount(decodeParam(req.params.email))
, { errorCode: "DELETE_INSTANTLY_ACCOUNT_ERROR" });

exports.pauseInstantlyAccount = createHandler(
  async (req) => instantlyService.pauseAccount(decodeParam(req.params.email)),
  { errorCode: "PAUSE_INSTANTLY_ACCOUNT_ERROR", message: "Account paused successfully" }
);

exports.resumeInstantlyAccount = createHandler(
  async (req) => instantlyService.resumeAccount(decodeParam(req.params.email)),
  { errorCode: "RESUME_INSTANTLY_ACCOUNT_ERROR", message: "Account resumed successfully" }
);

exports.enableInstantlyWarmup = createHandler(
  async (req) => {
    const email = decodeParam(req.params.email);
    const body = req.body || {};
    const emails = Array.isArray(body.emails) && body.emails.length > 0
      ? body.emails
      : [email];

    return instantlyService.enableWarmup({
      ...body,
      emails,
    });
  },
  { errorCode: "ENABLE_INSTANTLY_WARMUP_ERROR", message: "Warmup enable job started" }
);

exports.disableInstantlyWarmup = createHandler(
  async (req) => {
    const email = decodeParam(req.params.email);
    const body = req.body || {};
    const emails = Array.isArray(body.emails) && body.emails.length > 0
      ? body.emails
      : [email];

    return instantlyService.disableWarmup({
      ...body,
      emails,
    });
  },
  { errorCode: "DISABLE_INSTANTLY_WARMUP_ERROR", message: "Warmup disable job started" }
);

exports.markInstantlyAccountFixed = createHandler(
  async (req) =>
    instantlyService.markAccountFixed(decodeParam(req.params.email), req.body || {}),
  { errorCode: "MARK_INSTANTLY_ACCOUNT_FIXED_ERROR", message: "Account marked as fixed" }
);

exports.getCustomTrackingDomainStatus = createHandler(async (req) =>
  instantlyService.getCustomTrackingDomainStatus(req.query || {})
, { errorCode: "GET_CUSTOM_TRACKING_DOMAIN_STATUS_ERROR" });

exports.moveInstantlyAccounts = createHandler(async (req) =>
  instantlyService.moveAccounts(req.body || {})
, { errorCode: "MOVE_INSTANTLY_ACCOUNTS_ERROR" });

/* =========================
   Leads
========================= */

exports.createLead = createHandler(async (req) =>
  instantlyService.createLead(req.body || {})
, { errorCode: "CREATE_LEAD_ERROR" });

exports.listLeads = createHandler(async (req) =>
  instantlyService.listLeads(req.body || {})
, { errorCode: "LIST_LEADS_ERROR" });

exports.getLead = createHandler(async (req) =>
  instantlyService.getLead(req.params.id)
, { errorCode: "GET_LEAD_ERROR" });

exports.updateLead = createHandler(async (req) =>
  instantlyService.updateLead(req.params.id, req.body || {})
, { errorCode: "UPDATE_LEAD_ERROR" });

exports.deleteLead = createHandler(async (req) =>
  instantlyService.deleteLead(req.params.id)
, { errorCode: "DELETE_LEAD_ERROR" });

exports.bulkDeleteLeads = createHandler(async (req) =>
  instantlyService.bulkDeleteLeads(req.body || {})
, { errorCode: "BULK_DELETE_LEADS_ERROR" });

exports.mergeLeads = createHandler(async (req) =>
  instantlyService.mergeLeads(req.body || {})
, { errorCode: "MERGE_LEADS_ERROR" });

exports.updateLeadInterestStatus = createHandler(async (req) =>
  instantlyService.updateLeadInterestStatus(req.body || {})
, { errorCode: "UPDATE_LEAD_INTEREST_STATUS_ERROR" });

exports.removeLeadFromSubsequence = createHandler(async (req) =>
  instantlyService.removeLeadFromSubsequence(req.body || {})
, { errorCode: "REMOVE_LEAD_FROM_SUBSEQUENCE_ERROR" });

exports.bulkAssignLeads = createHandler(async (req) =>
  instantlyService.bulkAssignLeads(req.body || {})
, { errorCode: "BULK_ASSIGN_LEADS_ERROR" });

exports.moveLeads = createHandler(async (req) =>
  instantlyService.moveLeads(req.body || {})
, { errorCode: "MOVE_LEADS_ERROR" });

exports.moveLeadToSubsequence = createHandler(async (req) =>
  instantlyService.moveLeadToSubsequence(req.body || {})
, { errorCode: "MOVE_LEAD_TO_SUBSEQUENCE_ERROR" });

exports.addLeads = createHandler(async (req) =>
  instantlyService.addLeads(req.body || {})
, { errorCode: "ADD_LEADS_ERROR" });

/* =========================
   Lead Lists
========================= */

exports.createLeadList = createHandler(async (req) =>
  instantlyService.createLeadList(req.body || {})
, { errorCode: "CREATE_LEAD_LIST_ERROR" });

exports.listLeadLists = createHandler(async (req) =>
  instantlyService.listLeadLists(req.query || {})
, { errorCode: "LIST_LEAD_LISTS_ERROR" });

exports.getLeadList = createHandler(async (req) =>
  instantlyService.getLeadList(req.params.id)
, { errorCode: "GET_LEAD_LIST_ERROR" });

exports.updateLeadList = createHandler(async (req) =>
  instantlyService.updateLeadList(req.params.id, req.body || {})
, { errorCode: "UPDATE_LEAD_LIST_ERROR" });

exports.deleteLeadList = createHandler(async (req) =>
  instantlyService.deleteLeadList(req.params.id)
, { errorCode: "DELETE_LEAD_LIST_ERROR" });

exports.getLeadListVerificationStats = createHandler(async (req) =>
  instantlyService.getLeadListVerificationStats(req.params.id, req.query || {})
, { errorCode: "GET_LEAD_LIST_VERIFICATION_STATS_ERROR" });

/* =========================
   Email Verification
========================= */

exports.createEmailVerification = createHandler(async (req) =>
  instantlyService.createEmailVerification(req.body || {})
, { errorCode: "CREATE_EMAIL_VERIFICATION_ERROR" });

exports.getEmailVerification = createHandler(async (req) =>
  instantlyService.getEmailVerification(decodeParam(req.params.email))
, { errorCode: "GET_EMAIL_VERIFICATION_ERROR" });

/* =========================
   Lead Labels
========================= */

exports.createLeadLabel = createHandler(async (req) =>
  instantlyService.createLeadLabel(req.body || {})
, { errorCode: "CREATE_LEAD_LABEL_ERROR" });

exports.listLeadLabels = createHandler(async (req) =>
  instantlyService.listLeadLabels(req.query || {})
, { errorCode: "LIST_LEAD_LABELS_ERROR" });

exports.getLeadLabel = createHandler(async (req) =>
  instantlyService.getLeadLabel(req.params.id)
, { errorCode: "GET_LEAD_LABEL_ERROR" });

exports.updateLeadLabel = createHandler(async (req) =>
  instantlyService.updateLeadLabel(req.params.id, req.body || {})
, { errorCode: "UPDATE_LEAD_LABEL_ERROR" });

exports.deleteLeadLabel = createHandler(async (req) =>
  instantlyService.deleteLeadLabel(req.params.id)
, { errorCode: "DELETE_LEAD_LABEL_ERROR" });

exports.predictAiReplyLabel = createHandler(async (req) =>
  instantlyService.predictAiReplyLabel(req.body || {})
, { errorCode: "PREDICT_AI_REPLY_LABEL_ERROR" });

/* =========================
   Custom Tags
========================= */

exports.createCustomTag = createHandler(async (req) =>
  instantlyService.createCustomTag(req.body || {})
, { errorCode: "CREATE_CUSTOM_TAG_ERROR" });

exports.listCustomTags = createHandler(async (req) =>
  instantlyService.listCustomTags(req.query || {})
, { errorCode: "LIST_CUSTOM_TAGS_ERROR" });

exports.getCustomTag = createHandler(async (req) =>
  instantlyService.getCustomTag(req.params.id)
, { errorCode: "GET_CUSTOM_TAG_ERROR" });

exports.updateCustomTag = createHandler(async (req) =>
  instantlyService.updateCustomTag(req.params.id, req.body || {})
, { errorCode: "UPDATE_CUSTOM_TAG_ERROR" });

exports.deleteCustomTag = createHandler(async (req) =>
  instantlyService.deleteCustomTag(req.params.id)
, { errorCode: "DELETE_CUSTOM_TAG_ERROR" });

exports.toggleCustomTagResource = createHandler(async (req) =>
  instantlyService.toggleCustomTagResource(req.body || {})
, { errorCode: "TOGGLE_CUSTOM_TAG_RESOURCE_ERROR" });

exports.listCustomTagMappings = createHandler(async (req) =>
  instantlyService.listCustomTagMappings(req.query || {})
, { errorCode: "LIST_CUSTOM_TAG_MAPPINGS_ERROR" });

/* =========================
   Block List Entries
========================= */

exports.createBlockListEntry = createHandler(async (req) =>
  instantlyService.createBlockListEntry(req.body || {})
, { errorCode: "CREATE_BLOCK_LIST_ENTRY_ERROR" });

exports.listBlockListEntries = createHandler(async (req) =>
  instantlyService.listBlockListEntries(req.query || {})
, { errorCode: "LIST_BLOCK_LIST_ENTRIES_ERROR" });

exports.getBlockListEntry = createHandler(async (req) =>
  instantlyService.getBlockListEntry(req.params.id)
, { errorCode: "GET_BLOCK_LIST_ENTRY_ERROR" });

exports.updateBlockListEntry = createHandler(async (req) =>
  instantlyService.updateBlockListEntry(req.params.id, req.body || {})
, { errorCode: "UPDATE_BLOCK_LIST_ENTRY_ERROR" });

exports.deleteBlockListEntry = createHandler(async (req) =>
  instantlyService.deleteBlockListEntry(req.params.id)
, { errorCode: "DELETE_BLOCK_LIST_ENTRY_ERROR" });

exports.deleteAllBlockListEntries = createHandler(async (req) =>
  instantlyService.deleteAllBlockListEntries(req.body || {})
, { errorCode: "DELETE_ALL_BLOCK_LIST_ENTRIES_ERROR" });

exports.bulkCreateBlockListEntries = createHandler(async (req) =>
  instantlyService.bulkCreateBlockListEntries(req.body || {})
, { errorCode: "BULK_CREATE_BLOCK_LIST_ENTRIES_ERROR" });

exports.bulkDeleteBlockListEntries = createHandler(async (req) =>
  instantlyService.bulkDeleteBlockListEntries(req.body || {})
, { errorCode: "BULK_DELETE_BLOCK_LIST_ENTRIES_ERROR" });

exports.downloadBlockListEntries = async (req, res) => {
  try {
    const response = await instantlyService.downloadBlockListEntries(req.query || {});
    const contentType =
      response?.headers?.["content-type"] || "text/csv; charset=utf-8";
    const disposition =
      response?.headers?.["content-disposition"] ||
      'attachment; filename="instantly-block-list.csv"';

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", disposition);
    return res.status(200).send(response.data);
  } catch (error) {
    return fail(req, res, error, "DOWNLOAD_BLOCK_LIST_ENTRIES_ERROR");
  }
};

/* =========================
   Inbox Placement Tests
========================= */

exports.createInboxPlacementTest = createHandler(async (req) =>
  instantlyService.createInboxPlacementTest(req.body || {})
, { errorCode: "CREATE_INBOX_PLACEMENT_TEST_ERROR" });

exports.listInboxPlacementTests = createHandler(async (req) =>
  instantlyService.listInboxPlacementTests(req.query || {})
, { errorCode: "LIST_INBOX_PLACEMENT_TESTS_ERROR" });

exports.getInboxPlacementTest = createHandler(async (req) =>
  instantlyService.getInboxPlacementTest(req.params.id)
, { errorCode: "GET_INBOX_PLACEMENT_TEST_ERROR" });

exports.updateInboxPlacementTest = createHandler(async (req) =>
  instantlyService.updateInboxPlacementTest(req.params.id, req.body || {})
, { errorCode: "UPDATE_INBOX_PLACEMENT_TEST_ERROR" });

exports.deleteInboxPlacementTest = createHandler(async (req) =>
  instantlyService.deleteInboxPlacementTest(req.params.id)
, { errorCode: "DELETE_INBOX_PLACEMENT_TEST_ERROR" });

exports.getEmailServiceProviderOptions = createHandler(async (req) =>
  instantlyService.getEmailServiceProviderOptions(req.query || {})
, { errorCode: "GET_EMAIL_SERVICE_PROVIDER_OPTIONS_ERROR" });

/* =========================
   Inbox Placement Analytics
========================= */

exports.listInboxPlacementAnalytics = createHandler(async (req) =>
  instantlyService.listInboxPlacementAnalytics(req.query || {})
, { errorCode: "LIST_INBOX_PLACEMENT_ANALYTICS_ERROR" });

exports.getInboxPlacementAnalytics = createHandler(async (req) =>
  instantlyService.getInboxPlacementAnalytics(req.params.id)
, { errorCode: "GET_INBOX_PLACEMENT_ANALYTICS_ERROR" });

exports.getInboxPlacementStatsByTestId = createHandler(async (req) =>
  instantlyService.getInboxPlacementStatsByTestId(req.body || {})
, { errorCode: "GET_INBOX_PLACEMENT_STATS_BY_TEST_ID_ERROR" });

exports.getInboxPlacementDeliverabilityInsights = createHandler(async (req) =>
  instantlyService.getInboxPlacementDeliverabilityInsights(req.body || {})
, { errorCode: "GET_INBOX_PLACEMENT_DELIVERABILITY_INSIGHTS_ERROR" });

exports.getInboxPlacementStatsByDate = createHandler(async (req) =>
  instantlyService.getInboxPlacementStatsByDate(req.body || {})
, { errorCode: "GET_INBOX_PLACEMENT_STATS_BY_DATE_ERROR" });

/* =========================
   OAuth Compatibility
========================= */

exports.initInstantlyOAuth = async (req, res) => {
  try {
    const provider = String(req.params.provider || "").trim().toLowerCase();

    if (!["google", "microsoft"].includes(provider)) {
      return res.status(400).json({
        success: false,
        message: "provider must be google or microsoft",
      });
    }

    const data =
      provider === "google"
        ? await instantlyService.initGoogleOAuth()
        : await instantlyService.initMicrosoftOAuth();

    return ok(res, data, {
      provider,
      sessionId: data?.session_id || "",
      authUrl: data?.auth_url || "",
      expiresAt: data?.expires_at || "",
    });
  } catch (error) {
    return fail(req, res, error, "INIT_INSTANTLY_OAUTH_ERROR");
  }
};

exports.getInstantlyOAuthSessionStatus = createHandler(async (req) =>
  instantlyService.getOAuthSessionStatus(req.params.sessionId)
, { errorCode: "GET_INSTANTLY_OAUTH_SESSION_STATUS_ERROR" });