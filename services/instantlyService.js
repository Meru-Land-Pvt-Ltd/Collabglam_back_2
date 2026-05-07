const axios = require("axios");

const BASE_URL =
  process.env.INSTANTLY_BASE_URL || "https://api.instantly.ai/api/v2";

const API_KEY = process.env.INSTANTLY_API_KEY;

if (!API_KEY) {
  throw new Error("INSTANTLY_API_KEY is missing in env");
}

const instantlyClient = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  },
});

function unwrap(res) {
  return res?.data ?? null;
}

function normalizeString(value) {
  return String(value || "").trim();
}

function encodeEmail(email) {
  return encodeURIComponent(normalizeString(email).toLowerCase());
}

function encodeId(value) {
  return encodeURIComponent(normalizeString(value));
}

function serializeParams(params = {}) {
  const searchParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;

    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== undefined && item !== null && item !== "") {
          searchParams.append(key, String(item));
        }
      });
      return;
    }

    searchParams.append(key, String(value));
  });

  return searchParams.toString();
}

async function request(method, url, { params, data, headers, responseType } = {}) {
  const res = await instantlyClient.request({
    method,
    url,
    params,
    paramsSerializer: serializeParams,
    data,
    headers,
    responseType,
  });

  return unwrap(res);
}

async function requestRaw(method, url, { params, data, headers, responseType } = {}) {
  return instantlyClient.request({
    method,
    url,
    params,
    paramsSerializer: serializeParams,
    data,
    headers,
    responseType,
  });
}

/* =========================
   Analytics
========================= */

async function getWarmupAnalytics(payload = {}) {
  return request("post", "/accounts/warmup-analytics", { data: payload });
}

async function getAccountDailyAnalytics(params = {}) {
  const normalizedParams = { ...params };

  if (normalizedParams.email && !normalizedParams.emails) {
    normalizedParams.emails = [normalizeString(normalizedParams.email).toLowerCase()];
    delete normalizedParams.email;
  }

  return request("get", "/accounts/analytics/daily", {
    params: normalizedParams,
  });
}

async function testAccountVitals(payload = {}) {
  return request("post", "/accounts/test/vitals", { data: payload });
}

async function getCampaignAnalytics(params = {}) {
  return request("get", "/campaigns/analytics", { params });
}

async function getCampaignAnalyticsOverview(params = {}) {
  return request("get", "/campaigns/analytics/overview", { params });
}

async function getCampaignAnalyticsDaily(params = {}) {
  return request("get", "/campaigns/analytics/daily", { params });
}

async function getCampaignAnalyticsSteps(params = {}) {
  return request("get", "/campaigns/analytics/steps", { params });
}

/* =========================
   Campaigns
========================= */

async function createCampaign(payload = {}) {
  return request("post", "/campaigns", { data: payload });
}

async function listCampaigns(params = {}) {
  return request("get", "/campaigns", { params });
}

async function getCampaign(id) {
  return request("get", `/campaigns/${encodeId(id)}`);
}

async function updateCampaign(id, payload = {}) {
  return request("patch", `/campaigns/${encodeId(id)}`, { data: payload });
}

async function deleteCampaign(campaignId) {
  if (!campaignId) {
    throw new Error("Instantly campaign id is required");
  }

  const res = await instantlyClient.request({
    method: "delete",
    url: `/campaigns/${encodeId(campaignId)}`,
    data: null,
    transformRequest: [
      (data, headers) => {
        if (headers) {
          if (typeof headers.delete === "function") {
            headers.delete("Content-Type");
            headers.delete("content-type");
          } else {
            delete headers["Content-Type"];
            delete headers["content-type"];
          }
        }

        return data;
      },
    ],
  });

  return unwrap(res);
}

async function activateCampaign(id, payload = {}) {
  return request("post", `/campaigns/${encodeId(id)}/activate`, {
    data: payload,
  });
}

async function pauseCampaign(id, payload = {}) {
  return request("post", `/campaigns/${encodeId(id)}/pause`, {
    data: payload,
  });
}

async function searchCampaignsByContact(params = {}) {
  return request("get", "/campaigns/search-by-contact", { params });
}

async function shareCampaign(id, payload = {}) {
  return request("post", `/campaigns/${encodeId(id)}/share`, {
    data: payload,
  });
}

async function createCampaignFromExport(id, payload = {}) {
  return request("post", `/campaigns/${encodeId(id)}/from-export`, {
    data: payload,
  });
}

async function exportCampaign(id, payload = {}) {
  return request("post", `/campaigns/${encodeId(id)}/export`, {
    data: payload,
  });
}

async function duplicateCampaign(id, payload = {}) {
  return request("post", `/campaigns/${encodeId(id)}/duplicate`, {
    data: payload,
  });
}

async function getLaunchedCampaignCount(params = {}) {
  return request("get", "/campaigns/count-launched", { params });
}

async function addCampaignVariables(id, payload = {}) {
  return request("post", `/campaigns/${encodeId(id)}/variables`, {
    data: payload,
  });
}

async function getCampaignSendingStatus(id, params = {}) {
  return request("get", `/campaigns/${encodeId(id)}/sendingstatus`, {
    params,
  });
}

/* =========================
   Emails
========================= */

async function sendTestEmail(payload = {}) {
  const eaccount = String(
    payload.eaccount ||
    payload.account_email ||
    payload.accountEmail ||
    ""
  ).trim();

  const to_address_email_list = String(
    payload.to_address_email_list ||
    payload.to_email ||
    payload.toEmail ||
    ""
  ).trim();

  const subject = String(payload.subject || "").trim();

  const html =
    payload?.body?.html ||
    payload?.bodyHtml ||
    payload?.bodyText ||
    payload?.body ||
    "";

  return request("post", "/emails/test", {
    data: {
      eaccount,
      to_address_email_list,
      subject,
      body: {
        html: String(html || ""),
      },
    },
  });
}

async function replyToEmail(payload = {}) {
  return request("post", "/emails/reply", { data: payload });
}

async function forwardEmail(payload = {}) {
  return request("post", "/emails/forward", { data: payload });
}

async function listEmails(params = {}) {
  return request("get", "/emails", { params });
}

async function getEmail(id) {
  return request("get", `/emails/${encodeId(id)}`);
}

async function updateEmail(id, payload = {}) {
  return request("patch", `/emails/${encodeId(id)}`, { data: payload });
}

async function deleteEmail(id) {
  return request("delete", `/emails/${encodeId(id)}`);
}

async function getUnreadEmailCount(params = {}) {
  return request("get", "/emails/unread/count", { params });
}

async function markThreadAsRead(threadId) {
  return request("post", `/emails/threads/${encodeId(threadId)}/mark-as-read`);
}

/* =========================
   Accounts
========================= */

async function createAccount(payload = {}) {
  return request("post", "/accounts", { data: payload });
}

async function listAccounts(params = {}) {
  return request("get", "/accounts", { params });
}

async function getAccount(email) {
  return request("get", `/accounts/${encodeEmail(email)}`);
}

async function updateAccount(email, payload = {}) {
  return request("patch", `/accounts/${encodeEmail(email)}`, {
    data: payload,
  });
}

async function deleteAccount(email) {
  if (!email) {
    throw new Error("Instantly account email is required");
  }

  const res = await instantlyClient.request({
    method: "delete",
    url: `/accounts/${encodeEmail(email)}`,
    data: null,
    transformRequest: [
      (data, headers) => {
        if (headers) {
          if (typeof headers.delete === "function") {
            headers.delete("Content-Type");
            headers.delete("content-type");
          } else {
            delete headers["Content-Type"];
            delete headers["content-type"];
          }
        }

        return data;
      },
    ],
  });

  return unwrap(res);
}

async function enableWarmup(payload = {}) {
  return request("post", "/accounts/warmup/enable", { data: payload });
}

async function disableWarmup(payload = {}) {
  return request("post", "/accounts/warmup/disable", { data: payload });
}

async function pauseAccount(email) {
  return request("post", `/accounts/${encodeEmail(email)}/pause`);
}

async function resumeAccount(email) {
  return request("post", `/accounts/${encodeEmail(email)}/resume`);
}

async function markAccountFixed(email, payload = {}) {
  return request("post", `/accounts/${encodeEmail(email)}/markfixed`, {
    data: payload,
  });
}

async function getCustomTrackingDomainStatus(params = {}) {
  return request("get", "/accounts/ctd/status", { params });
}

async function moveAccounts(payload = {}) {
  return request("post", "/accounts/move", { data: payload });
}

/* =========================
   Leads
========================= */

async function createLead(payload = {}) {
  return request("post", "/leads", { data: payload });
}

async function listLeads(payload = {}) {
  return request("post", "/leads/list", { data: payload });
}

async function getLead(id) {
  return request("get", `/leads/${encodeId(id)}`);
}

async function updateLead(id, payload = {}) {
  return request("patch", `/leads/${encodeId(id)}`, { data: payload });
}

async function deleteLead(id) {
  return request("delete", `/leads/${encodeId(id)}`);
}

async function bulkDeleteLeads(payload = {}) {
  return request("delete", "/leads", { data: payload });
}

async function mergeLeads(payload = {}) {
  return request("post", "/leads/merge", { data: payload });
}

async function updateLeadInterestStatus(payload = {}) {
  return request("post", "/leads/update-intereststatus", { data: payload });
}

async function removeLeadFromSubsequence(payload = {}) {
  return request("post", "/leads/subsequence/remove", { data: payload });
}

async function bulkAssignLeads(payload = {}) {
  return request("post", "/leads/bulk-assign", { data: payload });
}

async function moveLeads(payload = {}) {
  return request("post", "/leads/move", { data: payload });
}

async function moveLeadToSubsequence(payload = {}) {
  return request("post", "/leads/subsequence/move", { data: payload });
}

async function moveLeadsToSubsequence(payload = {}) {
  return request("post", "/leads/subsequence/move", { data: payload });
}

async function addLeads(payload = {}) {
  return request("post", "/leads/add", { data: payload });
}

/* =========================
   Lead Lists
========================= */

async function createLeadList(payload = {}) {
  return request("post", "/lead-lists", { data: payload });
}

async function listLeadLists(params = {}) {
  return request("get", "/lead-lists", { params });
}

async function getLeadList(id) {
  return request("get", `/lead-lists/${encodeId(id)}`);
}

async function updateLeadList(id, payload = {}) {
  return request("patch", `/lead-lists/${encodeId(id)}`, { data: payload });
}

async function deleteLeadList(id) {
  return request("delete", `/lead-lists/${encodeId(id)}`);
}

async function getLeadListVerificationStats(id, params = {}) {
  return request("get", `/lead-lists/${encodeId(id)}/verificationstats`, {
    params,
  });
}

/* =========================
   Email Verification
========================= */

async function createEmailVerification(payload = {}) {
  return request("post", "/email-verification", { data: payload });
}

async function getEmailVerification(email) {
  return request("get", `/email-verification/${encodeEmail(email)}`);
}

/* =========================
   Lead Labels
========================= */

async function createLeadLabel(payload = {}) {
  return request("post", "/lead-labels", { data: payload });
}

async function listLeadLabels(params = {}) {
  return request("get", "/lead-labels", { params });
}

async function getLeadLabel(id) {
  return request("get", `/lead-labels/${encodeId(id)}`);
}

async function updateLeadLabel(id, payload = {}) {
  return request("patch", `/lead-labels/${encodeId(id)}`, { data: payload });
}

async function deleteLeadLabel(id) {
  return request("delete", `/lead-labels/${encodeId(id)}`);
}

async function predictAiReplyLabel(payload = {}) {
  return request("post", "/lead-labels/ai-reply-label", { data: payload });
}

/* =========================
   Custom Tags
========================= */

async function createCustomTag(payload = {}) {
  return request("post", "/custom-tags", { data: payload });
}

async function listCustomTags(params = {}) {
  return request("get", "/custom-tags", { params });
}

async function getCustomTag(id) {
  return request("get", `/custom-tags/${encodeId(id)}`);
}

async function updateCustomTag(id, payload = {}) {
  return request("patch", `/custom-tags/${encodeId(id)}`, { data: payload });
}

async function deleteCustomTag(id) {
  return request("delete", `/custom-tags/${encodeId(id)}`);
}

async function toggleCustomTagResource(payload = {}) {
  return request("post", "/custom-tags/toggle-resource", { data: payload });
}

async function listCustomTagMappings(params = {}) {
  return request("get", "/custom-tag-mappings", { params });
}

/* =========================
   Block List Entries
========================= */

async function createBlockListEntry(payload = {}) {
  return request("post", "/block-lists-entries", { data: payload });
}

async function listBlockListEntries(params = {}) {
  return request("get", "/block-lists-entries", { params });
}

async function getBlockListEntry(id) {
  return request("get", `/block-lists-entries/${encodeId(id)}`);
}

async function updateBlockListEntry(id, payload = {}) {
  return request("patch", `/block-lists-entries/${encodeId(id)}`, {
    data: payload,
  });
}

async function deleteBlockListEntry(id) {
  return request("delete", `/block-lists-entries/${encodeId(id)}`);
}

async function deleteAllBlockListEntries(payload = {}) {
  return request("delete", "/block-lists-entries", { data: payload });
}

async function bulkCreateBlockListEntries(payload = {}) {
  return request("post", "/block-lists-entries/bulkcreate", {
    data: payload,
  });
}

async function bulkDeleteBlockListEntries(payload = {}) {
  return request("post", "/block-lists-entries/bulkdelete", {
    data: payload,
  });
}

async function downloadBlockListEntries(params = {}) {
  return requestRaw("get", "/block-lists-entries/download", {
    params,
    responseType: "arraybuffer",
    headers: {
      Accept: "text/csv,application/octet-stream",
    },
  });
}

/* =========================
   Inbox Placement Tests
========================= */

async function createInboxPlacementTest(payload = {}) {
  return request("post", "/inbox-placement-tests", { data: payload });
}

async function listInboxPlacementTests(params = {}) {
  return request("get", "/inbox-placement-tests", { params });
}

async function getInboxPlacementTest(id) {
  return request("get", `/inbox-placement-tests/${encodeId(id)}`);
}

async function updateInboxPlacementTest(id, payload = {}) {
  return request("patch", `/inbox-placement-tests/${encodeId(id)}`, {
    data: payload,
  });
}

async function deleteInboxPlacementTest(id) {
  return request("delete", `/inbox-placement-tests/${encodeId(id)}`);
}

async function getEmailServiceProviderOptions(params = {}) {
  return request("get", "/inbox-placement-tests/email-serviceprovider-options", {
    params,
  });
}

/* =========================
   Inbox Placement Analytics
========================= */

async function listInboxPlacementAnalytics(params = {}) {
  return request("get", "/inbox-placement-analytics", { params });
}

async function getInboxPlacementAnalytics(id) {
  return request("get", `/inbox-placement-analytics/${encodeId(id)}`);
}

async function getInboxPlacementStatsByTestId(payload = {}) {
  return request("post", "/inbox-placement-analytics/statsby-test-id", {
    data: payload,
  });
}

async function getInboxPlacementDeliverabilityInsights(payload = {}) {
  return request("post", "/inbox-placementanalytics/deliverability-insights", {
    data: payload,
  });
}

async function getInboxPlacementStatsByDate(payload = {}) {
  return request("post", "/inbox-placement-analytics/statsby-date", {
    data: payload,
  });
}

/* =========================
   OAuth Compatibility
========================= */

async function initGoogleOAuth() {
  return request("post", "/oauth/google/init", { data: {} });
}

async function initMicrosoftOAuth() {
  return request("post", "/oauth/microsoft/init", { data: {} });
}

async function getOAuthSessionStatus(sessionId) {
  return request("get", `/oauth/session/status/${encodeId(sessionId)}`);
}

module.exports = {
  instantlyClient,

  getWarmupAnalytics,
  getAccountDailyAnalytics,
  testAccountVitals,
  getCampaignAnalytics,
  getCampaignAnalyticsOverview,
  getCampaignAnalyticsDaily,
  getCampaignAnalyticsSteps,

  createCampaign,
  listCampaigns,
  getCampaign,
  updateCampaign,
  deleteCampaign,
  activateCampaign,
  pauseCampaign,
  searchCampaignsByContact,
  shareCampaign,
  createCampaignFromExport,
  exportCampaign,
  duplicateCampaign,
  getLaunchedCampaignCount,
  addCampaignVariables,
  getCampaignSendingStatus,

  sendTestEmail,
  replyToEmail,
  forwardEmail,
  listEmails,
  getEmail,
  updateEmail,
  deleteEmail,
  getUnreadEmailCount,
  markThreadAsRead,

  createAccount,
  listAccounts,
  getAccount,
  updateAccount,
  deleteAccount,
  enableWarmup,
  disableWarmup,
  pauseAccount,
  resumeAccount,
  markAccountFixed,
  getCustomTrackingDomainStatus,
  moveAccounts,

  createLead,
  listLeads,
  getLead,
  updateLead,
  deleteLead,
  bulkDeleteLeads,
  mergeLeads,
  updateLeadInterestStatus,
  removeLeadFromSubsequence,
  bulkAssignLeads,
  moveLeads,
  moveLeadToSubsequence,
  moveLeadsToSubsequence,
  addLeads,

  createLeadList,
  listLeadLists,
  getLeadList,
  updateLeadList,
  deleteLeadList,
  getLeadListVerificationStats,

  createEmailVerification,
  getEmailVerification,

  createLeadLabel,
  listLeadLabels,
  getLeadLabel,
  updateLeadLabel,
  deleteLeadLabel,
  predictAiReplyLabel,

  createCustomTag,
  listCustomTags,
  getCustomTag,
  updateCustomTag,
  deleteCustomTag,
  toggleCustomTagResource,
  listCustomTagMappings,

  createBlockListEntry,
  listBlockListEntries,
  getBlockListEntry,
  updateBlockListEntry,
  deleteBlockListEntry,
  deleteAllBlockListEntries,
  bulkCreateBlockListEntries,
  bulkDeleteBlockListEntries,
  downloadBlockListEntries,

  createInboxPlacementTest,
  listInboxPlacementTests,
  getInboxPlacementTest,
  updateInboxPlacementTest,
  deleteInboxPlacementTest,
  getEmailServiceProviderOptions,

  listInboxPlacementAnalytics,
  getInboxPlacementAnalytics,
  getInboxPlacementStatsByTestId,
  getInboxPlacementDeliverabilityInsights,
  getInboxPlacementStatsByDate,

  initGoogleOAuth,
  initMicrosoftOAuth,
  getOAuthSessionStatus,
};