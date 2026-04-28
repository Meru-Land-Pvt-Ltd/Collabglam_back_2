const router = require("express").Router();
const instantlyController = require("../controllers/instantlyController");

/* =========================
   Health
========================= */

router.get("/test-connection", instantlyController.testInstantlyConnection);

/* =========================
   Analytics
========================= */

router.post("/analytics/accounts/warmup", instantlyController.getWarmupAnalytics);
router.get("/analytics/accounts/daily", instantlyController.getAccountDailyAnalytics);
router.post("/analytics/accounts/test-vitals", instantlyController.testAccountVitals);

router.get("/analytics/campaigns", instantlyController.getCampaignAnalytics);
router.get(
  "/analytics/campaigns/overview",
  instantlyController.getCampaignAnalyticsOverview
);
router.get("/analytics/campaigns/daily", instantlyController.getCampaignAnalyticsDaily);
router.get("/analytics/campaigns/steps", instantlyController.getCampaignAnalyticsSteps);

/* =========================
   Campaigns
========================= */

router.post("/campaigns", instantlyController.createCampaign);
router.get("/campaigns/search-by-contact", instantlyController.searchCampaignsByContact);
router.get("/campaigns/count-launched", instantlyController.getLaunchedCampaignCount);
router.get("/campaigns", instantlyController.listCampaigns);
router.get("/campaigns/:id/sendingstatus", instantlyController.getCampaignSendingStatus);
router.post("/campaigns/:id/activate", instantlyController.activateCampaign);
router.post("/campaigns/:id/pause", instantlyController.pauseCampaign);
router.post("/campaigns/:id/share", instantlyController.shareCampaign);
router.post("/campaigns/:id/from-export", instantlyController.createCampaignFromExport);
router.post("/campaigns/:id/export", instantlyController.exportCampaign);
router.post("/campaigns/:id/duplicate", instantlyController.duplicateCampaign);
router.post("/campaigns/:id/variables", instantlyController.addCampaignVariables);
router.get("/campaigns/:id", instantlyController.getCampaign);
router.patch("/campaigns/:id", instantlyController.updateCampaign);
router.delete("/campaigns/:id", instantlyController.deleteCampaign);

/* =========================
   Emails
========================= */

router.post("/emails/test", instantlyController.sendTestEmail);
router.post("/emails/reply", instantlyController.replyToEmail);
router.post("/emails/forward", instantlyController.forwardEmail);
router.get("/emails/unread/count", instantlyController.getUnreadEmailCount);
router.post("/emails/threads/:threadId/mark-as-read", instantlyController.markThreadAsRead);
router.get("/emails", instantlyController.listEmails);
router.get("/emails/:id", instantlyController.getEmail);
router.patch("/emails/:id", instantlyController.updateEmail);
router.delete("/emails/:id", instantlyController.deleteEmail);

/* =========================
   Accounts
========================= */

router.post("/accounts", instantlyController.createInstantlyAccount);
router.get("/accounts/ctd/status", instantlyController.getCustomTrackingDomainStatus);
router.post("/accounts/move", instantlyController.moveInstantlyAccounts);
router.get("/accounts", instantlyController.listInstantlyAccounts);

router.post("/accounts/:email/warmup/enable", instantlyController.enableInstantlyWarmup);
router.post("/accounts/:email/warmup/disable", instantlyController.disableInstantlyWarmup);
router.post("/accounts/:email/pause", instantlyController.pauseInstantlyAccount);
router.post("/accounts/:email/resume", instantlyController.resumeInstantlyAccount);
router.post("/accounts/:email/markfixed", instantlyController.markInstantlyAccountFixed);
router.get("/accounts/:email", instantlyController.getInstantlyAccount);
router.patch("/accounts/:email", instantlyController.updateInstantlyAccount);
router.delete("/accounts/:email", instantlyController.deleteInstantlyAccount);

/* =========================
   Leads
========================= */

router.post("/leads", instantlyController.createLead);
router.post("/leads/list", instantlyController.listLeads);
router.delete("/leads", instantlyController.bulkDeleteLeads);
router.post("/leads/merge", instantlyController.mergeLeads);
router.post("/leads/update-intereststatus", instantlyController.updateLeadInterestStatus);
router.post("/leads/subsequence/remove", instantlyController.removeLeadFromSubsequence);
router.post("/leads/bulk-assign", instantlyController.bulkAssignLeads);
router.post("/leads/move", instantlyController.moveLeads);
router.post("/leads/subsequence/move", instantlyController.moveLeadToSubsequence);
router.post("/leads/add", instantlyController.addLeads);
router.get("/leads/:id", instantlyController.getLead);
router.patch("/leads/:id", instantlyController.updateLead);
router.delete("/leads/:id", instantlyController.deleteLead);

/* =========================
   Lead Lists
========================= */

router.post("/lead-lists", instantlyController.createLeadList);
router.get("/lead-lists", instantlyController.listLeadLists);
router.get(
  "/lead-lists/:id/verificationstats",
  instantlyController.getLeadListVerificationStats
);
router.get("/lead-lists/:id", instantlyController.getLeadList);
router.patch("/lead-lists/:id", instantlyController.updateLeadList);
router.delete("/lead-lists/:id", instantlyController.deleteLeadList);

/* =========================
   Email Verification
========================= */

router.post("/email-verification", instantlyController.createEmailVerification);
router.get("/email-verification/:email", instantlyController.getEmailVerification);

/* =========================
   Lead Labels
========================= */

router.post("/lead-labels", instantlyController.createLeadLabel);
router.get("/lead-labels", instantlyController.listLeadLabels);
router.post("/lead-labels/ai-reply-label", instantlyController.predictAiReplyLabel);
router.get("/lead-labels/:id", instantlyController.getLeadLabel);
router.patch("/lead-labels/:id", instantlyController.updateLeadLabel);
router.delete("/lead-labels/:id", instantlyController.deleteLeadLabel);

/* =========================
   Custom Tags
========================= */

router.post("/custom-tags", instantlyController.createCustomTag);
router.get("/custom-tags", instantlyController.listCustomTags);
router.post("/custom-tags/toggle-resource", instantlyController.toggleCustomTagResource);
router.get("/custom-tags/:id", instantlyController.getCustomTag);
router.patch("/custom-tags/:id", instantlyController.updateCustomTag);
router.delete("/custom-tags/:id", instantlyController.deleteCustomTag);

router.get("/custom-tag-mappings", instantlyController.listCustomTagMappings);

/* =========================
   Block List Entries
========================= */

router.post("/block-lists-entries", instantlyController.createBlockListEntry);
router.get("/block-lists-entries/download", instantlyController.downloadBlockListEntries);
router.get("/block-lists-entries", instantlyController.listBlockListEntries);
router.delete("/block-lists-entries", instantlyController.deleteAllBlockListEntries);
router.post(
  "/block-lists-entries/bulkcreate",
  instantlyController.bulkCreateBlockListEntries
);
router.post(
  "/block-lists-entries/bulkdelete",
  instantlyController.bulkDeleteBlockListEntries
);
router.get("/block-lists-entries/:id", instantlyController.getBlockListEntry);
router.patch("/block-lists-entries/:id", instantlyController.updateBlockListEntry);
router.delete("/block-lists-entries/:id", instantlyController.deleteBlockListEntry);

/* =========================
   Inbox Placement Tests
========================= */

router.post("/inbox-placement-tests", instantlyController.createInboxPlacementTest);
router.get(
  "/inbox-placement-tests/email-serviceprovider-options",
  instantlyController.getEmailServiceProviderOptions
);
router.get("/inbox-placement-tests", instantlyController.listInboxPlacementTests);
router.get("/inbox-placement-tests/:id", instantlyController.getInboxPlacementTest);
router.patch("/inbox-placement-tests/:id", instantlyController.updateInboxPlacementTest);
router.delete("/inbox-placement-tests/:id", instantlyController.deleteInboxPlacementTest);

/* =========================
   Inbox Placement Analytics
========================= */

router.get(
  "/inbox-placement-analytics",
  instantlyController.listInboxPlacementAnalytics
);
router.post(
  "/inbox-placement-analytics/statsby-test-id",
  instantlyController.getInboxPlacementStatsByTestId
);
router.post(
  "/inbox-placementanalytics/deliverability-insights",
  instantlyController.getInboxPlacementDeliverabilityInsights
);
router.post(
  "/inbox-placement-analytics/statsby-date",
  instantlyController.getInboxPlacementStatsByDate
);
router.get(
  "/inbox-placement-analytics/:id",
  instantlyController.getInboxPlacementAnalytics
);

/* =========================
   OAuth Compatibility
========================= */

router.post("/oauth/:provider/init", instantlyController.initInstantlyOAuth);
router.get(
  "/oauth/session-status/:sessionId",
  instantlyController.getInstantlyOAuthSessionStatus
);

module.exports = router;