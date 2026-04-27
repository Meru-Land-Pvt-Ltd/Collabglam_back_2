const instantlyService = require("../services/instantlyService");

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

function fail(res, error) {
  const payload = getErrorPayload(error);
  return res.status(payload.statusCode).json({
    success: false,
    ...payload,
  });
}

function decodeParam(value) {
  return decodeURIComponent(String(value || "").trim());
}

function createHandler(serviceCall, options = {}) {
  return async (req, res) => {
    try {
      const data = await serviceCall(req, res);
      return ok(res, data, options);
    } catch (error) {
      return fail(res, error);
    }
  };
}

exports.testInstantlyConnection = createHandler(
  async () => instantlyService.listAccounts(),
  { message: "Instantly connected successfully" }
);

/* =========================
   Analytics
========================= */

exports.getWarmupAnalytics = createHandler(async (req) =>
  instantlyService.getWarmupAnalytics(req.body || {})
);

exports.getAccountDailyAnalytics = createHandler(async (req) =>
  instantlyService.getAccountDailyAnalytics(req.query || {})
);

exports.testAccountVitals = createHandler(async (req) =>
  instantlyService.testAccountVitals(req.body || {})
);

exports.getCampaignAnalytics = createHandler(async (req) =>
  instantlyService.getCampaignAnalytics(req.query || {})
);

exports.getCampaignAnalyticsOverview = createHandler(async (req) =>
  instantlyService.getCampaignAnalyticsOverview(req.query || {})
);

exports.getCampaignAnalyticsDaily = createHandler(async (req) =>
  instantlyService.getCampaignAnalyticsDaily(req.query || {})
);

exports.getCampaignAnalyticsSteps = createHandler(async (req) =>
  instantlyService.getCampaignAnalyticsSteps(req.query || {})
);

/* =========================
   Campaigns
========================= */

exports.createCampaign = createHandler(async (req) =>
  instantlyService.createCampaign(req.body || {})
);

exports.listCampaigns = createHandler(async (req) =>
  instantlyService.listCampaigns(req.query || {})
);

exports.getCampaign = createHandler(async (req) =>
  instantlyService.getCampaign(req.params.id)
);

exports.updateCampaign = createHandler(async (req) =>
  instantlyService.updateCampaign(req.params.id, req.body || {})
);

exports.deleteCampaign = createHandler(async (req) =>
  instantlyService.deleteCampaign(req.params.id)
);

exports.activateCampaign = createHandler(
  async (req) => instantlyService.activateCampaign(req.params.id, req.body || {}),
  { message: "Campaign activated successfully" }
);

exports.pauseCampaign = createHandler(
  async (req) => instantlyService.pauseCampaign(req.params.id, req.body || {}),
  { message: "Campaign paused successfully" }
);

exports.searchCampaignsByContact = createHandler(async (req) =>
  instantlyService.searchCampaignsByContact(req.query || {})
);

exports.shareCampaign = createHandler(async (req) =>
  instantlyService.shareCampaign(req.params.id, req.body || {})
);

exports.createCampaignFromExport = createHandler(async (req) =>
  instantlyService.createCampaignFromExport(req.params.id, req.body || {})
);

exports.exportCampaign = createHandler(async (req) =>
  instantlyService.exportCampaign(req.params.id, req.body || {})
);

exports.duplicateCampaign = createHandler(async (req) =>
  instantlyService.duplicateCampaign(req.params.id, req.body || {})
);

exports.getLaunchedCampaignCount = createHandler(async (req) =>
  instantlyService.getLaunchedCampaignCount(req.query || {})
);

exports.addCampaignVariables = createHandler(async (req) =>
  instantlyService.addCampaignVariables(req.params.id, req.body || {})
);

exports.getCampaignSendingStatus = createHandler(async (req) =>
  instantlyService.getCampaignSendingStatus(req.params.id, req.query || {})
);

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
    return fail(res, error);
  }
};

/* =========================
   Emails
========================= */

exports.sendTestEmail = createHandler(async (req) =>
  instantlyService.sendTestEmail(req.body || {})
);

exports.replyToEmail = createHandler(async (req) =>
  instantlyService.replyToEmail(req.body || {})
);

exports.forwardEmail = createHandler(async (req) =>
  instantlyService.forwardEmail(req.body || {})
);

exports.listEmails = createHandler(async (req) =>
  instantlyService.listEmails(req.query || {})
);

exports.getEmail = createHandler(async (req) =>
  instantlyService.getEmail(req.params.id)
);

exports.updateEmail = createHandler(async (req) =>
  instantlyService.updateEmail(req.params.id, req.body || {})
);

exports.deleteEmail = createHandler(async (req) =>
  instantlyService.deleteEmail(req.params.id)
);

exports.getUnreadEmailCount = createHandler(async (req) =>
  instantlyService.getUnreadEmailCount(req.query || {})
);

exports.markThreadAsRead = createHandler(
  async (req) => instantlyService.markThreadAsRead(req.params.threadId),
  { message: "Thread marked as read" }
);

/* =========================
   Accounts
========================= */

exports.createInstantlyAccount = createHandler(async (req) =>
  instantlyService.createAccount(req.body || {})
);

exports.listInstantlyAccounts = createHandler(async (req) =>
  instantlyService.listAccounts(req.query || {})
);

exports.getInstantlyAccount = createHandler(async (req) =>
  instantlyService.getAccount(decodeParam(req.params.email))
);

exports.updateInstantlyAccount = createHandler(async (req) =>
  instantlyService.updateAccount(decodeParam(req.params.email), req.body || {})
);

exports.deleteInstantlyAccount = createHandler(async (req) =>
  instantlyService.deleteAccount(decodeParam(req.params.email))
);

exports.pauseInstantlyAccount = createHandler(
  async (req) => instantlyService.pauseAccount(decodeParam(req.params.email)),
  { message: "Account paused successfully" }
);

exports.resumeInstantlyAccount = createHandler(
  async (req) => instantlyService.resumeAccount(decodeParam(req.params.email)),
  { message: "Account resumed successfully" }
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
  { message: "Warmup enable job started" }
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
  { message: "Warmup disable job started" }
);

exports.markInstantlyAccountFixed = createHandler(
  async (req) =>
    instantlyService.markAccountFixed(decodeParam(req.params.email), req.body || {}),
  { message: "Account marked as fixed" }
);

exports.getCustomTrackingDomainStatus = createHandler(async (req) =>
  instantlyService.getCustomTrackingDomainStatus(req.query || {})
);

exports.moveInstantlyAccounts = createHandler(async (req) =>
  instantlyService.moveAccounts(req.body || {})
);

/* =========================
   Leads
========================= */

exports.createLead = createHandler(async (req) =>
  instantlyService.createLead(req.body || {})
);

exports.listLeads = createHandler(async (req) =>
  instantlyService.listLeads(req.body || {})
);

exports.getLead = createHandler(async (req) =>
  instantlyService.getLead(req.params.id)
);

exports.updateLead = createHandler(async (req) =>
  instantlyService.updateLead(req.params.id, req.body || {})
);

exports.deleteLead = createHandler(async (req) =>
  instantlyService.deleteLead(req.params.id)
);

exports.bulkDeleteLeads = createHandler(async (req) =>
  instantlyService.bulkDeleteLeads(req.body || {})
);

exports.mergeLeads = createHandler(async (req) =>
  instantlyService.mergeLeads(req.body || {})
);

exports.updateLeadInterestStatus = createHandler(async (req) =>
  instantlyService.updateLeadInterestStatus(req.body || {})
);

exports.removeLeadFromSubsequence = createHandler(async (req) =>
  instantlyService.removeLeadFromSubsequence(req.body || {})
);

exports.bulkAssignLeads = createHandler(async (req) =>
  instantlyService.bulkAssignLeads(req.body || {})
);

exports.moveLeads = createHandler(async (req) =>
  instantlyService.moveLeads(req.body || {})
);

exports.moveLeadToSubsequence = createHandler(async (req) =>
  instantlyService.moveLeadToSubsequence(req.body || {})
);

exports.addLeads = createHandler(async (req) =>
  instantlyService.addLeads(req.body || {})
);

/* =========================
   Lead Lists
========================= */

exports.createLeadList = createHandler(async (req) =>
  instantlyService.createLeadList(req.body || {})
);

exports.listLeadLists = createHandler(async (req) =>
  instantlyService.listLeadLists(req.query || {})
);

exports.getLeadList = createHandler(async (req) =>
  instantlyService.getLeadList(req.params.id)
);

exports.updateLeadList = createHandler(async (req) =>
  instantlyService.updateLeadList(req.params.id, req.body || {})
);

exports.deleteLeadList = createHandler(async (req) =>
  instantlyService.deleteLeadList(req.params.id)
);

exports.getLeadListVerificationStats = createHandler(async (req) =>
  instantlyService.getLeadListVerificationStats(req.params.id, req.query || {})
);

/* =========================
   Email Verification
========================= */

exports.createEmailVerification = createHandler(async (req) =>
  instantlyService.createEmailVerification(req.body || {})
);

exports.getEmailVerification = createHandler(async (req) =>
  instantlyService.getEmailVerification(decodeParam(req.params.email))
);

/* =========================
   Lead Labels
========================= */

exports.createLeadLabel = createHandler(async (req) =>
  instantlyService.createLeadLabel(req.body || {})
);

exports.listLeadLabels = createHandler(async (req) =>
  instantlyService.listLeadLabels(req.query || {})
);

exports.getLeadLabel = createHandler(async (req) =>
  instantlyService.getLeadLabel(req.params.id)
);

exports.updateLeadLabel = createHandler(async (req) =>
  instantlyService.updateLeadLabel(req.params.id, req.body || {})
);

exports.deleteLeadLabel = createHandler(async (req) =>
  instantlyService.deleteLeadLabel(req.params.id)
);

exports.predictAiReplyLabel = createHandler(async (req) =>
  instantlyService.predictAiReplyLabel(req.body || {})
);

/* =========================
   Custom Tags
========================= */

exports.createCustomTag = createHandler(async (req) =>
  instantlyService.createCustomTag(req.body || {})
);

exports.listCustomTags = createHandler(async (req) =>
  instantlyService.listCustomTags(req.query || {})
);

exports.getCustomTag = createHandler(async (req) =>
  instantlyService.getCustomTag(req.params.id)
);

exports.updateCustomTag = createHandler(async (req) =>
  instantlyService.updateCustomTag(req.params.id, req.body || {})
);

exports.deleteCustomTag = createHandler(async (req) =>
  instantlyService.deleteCustomTag(req.params.id)
);

exports.toggleCustomTagResource = createHandler(async (req) =>
  instantlyService.toggleCustomTagResource(req.body || {})
);

exports.listCustomTagMappings = createHandler(async (req) =>
  instantlyService.listCustomTagMappings(req.query || {})
);

/* =========================
   Block List Entries
========================= */

exports.createBlockListEntry = createHandler(async (req) =>
  instantlyService.createBlockListEntry(req.body || {})
);

exports.listBlockListEntries = createHandler(async (req) =>
  instantlyService.listBlockListEntries(req.query || {})
);

exports.getBlockListEntry = createHandler(async (req) =>
  instantlyService.getBlockListEntry(req.params.id)
);

exports.updateBlockListEntry = createHandler(async (req) =>
  instantlyService.updateBlockListEntry(req.params.id, req.body || {})
);

exports.deleteBlockListEntry = createHandler(async (req) =>
  instantlyService.deleteBlockListEntry(req.params.id)
);

exports.deleteAllBlockListEntries = createHandler(async (req) =>
  instantlyService.deleteAllBlockListEntries(req.body || {})
);

exports.bulkCreateBlockListEntries = createHandler(async (req) =>
  instantlyService.bulkCreateBlockListEntries(req.body || {})
);

exports.bulkDeleteBlockListEntries = createHandler(async (req) =>
  instantlyService.bulkDeleteBlockListEntries(req.body || {})
);

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
    return fail(res, error);
  }
};

/* =========================
   Inbox Placement Tests
========================= */

exports.createInboxPlacementTest = createHandler(async (req) =>
  instantlyService.createInboxPlacementTest(req.body || {})
);

exports.listInboxPlacementTests = createHandler(async (req) =>
  instantlyService.listInboxPlacementTests(req.query || {})
);

exports.getInboxPlacementTest = createHandler(async (req) =>
  instantlyService.getInboxPlacementTest(req.params.id)
);

exports.updateInboxPlacementTest = createHandler(async (req) =>
  instantlyService.updateInboxPlacementTest(req.params.id, req.body || {})
);

exports.deleteInboxPlacementTest = createHandler(async (req) =>
  instantlyService.deleteInboxPlacementTest(req.params.id)
);

exports.getEmailServiceProviderOptions = createHandler(async (req) =>
  instantlyService.getEmailServiceProviderOptions(req.query || {})
);

/* =========================
   Inbox Placement Analytics
========================= */

exports.listInboxPlacementAnalytics = createHandler(async (req) =>
  instantlyService.listInboxPlacementAnalytics(req.query || {})
);

exports.getInboxPlacementAnalytics = createHandler(async (req) =>
  instantlyService.getInboxPlacementAnalytics(req.params.id)
);

exports.getInboxPlacementStatsByTestId = createHandler(async (req) =>
  instantlyService.getInboxPlacementStatsByTestId(req.body || {})
);

exports.getInboxPlacementDeliverabilityInsights = createHandler(async (req) =>
  instantlyService.getInboxPlacementDeliverabilityInsights(req.body || {})
);

exports.getInboxPlacementStatsByDate = createHandler(async (req) =>
  instantlyService.getInboxPlacementStatsByDate(req.body || {})
);

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
    return fail(res, error);
  }
};

exports.getInstantlyOAuthSessionStatus = createHandler(async (req) =>
  instantlyService.getOAuthSessionStatus(req.params.sessionId)
);