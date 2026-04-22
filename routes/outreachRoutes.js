const router = require("express").Router();
const multer = require("multer");

const outreachController = require("../controllers/outreachController");
const replyReviewController = require("../controllers/replyReviewController");
const threadController = require("../controllers/threadController");
const outreachMailboxController = require("../controllers/outreachMailboxController");
const { adminAuth } = require("../middlewares/adminAuth");

const upload = multer({ storage: multer.memoryStorage() });

/* =========================
   Mailboxes
========================= */

router.get("/mailboxes", adminAuth, outreachMailboxController.listMailboxAssignments);
router.post("/mailboxes/assign", adminAuth, outreachMailboxController.assignMailbox);
router.post("/mailboxes/:email/unassign", adminAuth, outreachMailboxController.unassignMailbox);

/* =========================
   Campaigns
========================= */

router.post("/campaigns", adminAuth, outreachController.createOutreachCampaign);
router.get("/campaigns", adminAuth, outreachController.listOutreachCampaigns);
router.get("/campaigns/:id", adminAuth, outreachController.getOutreachCampaignById);

/* list page actions */
router.patch("/campaigns/:id", adminAuth, outreachController.updateOutreachCampaign);
router.delete("/campaigns/:id", adminAuth, outreachController.deleteOutreachCampaign);
router.post("/campaigns/:id/activate", adminAuth, outreachController.launchOutreachCampaign);
router.post("/campaigns/:id/launch", adminAuth, outreachController.launchOutreachCampaign);
router.post("/campaigns/:id/pause", adminAuth, outreachController.pauseOutreachCampaign);
router.post("/campaigns/:id/duplicate", adminAuth, outreachController.duplicateOutreachCampaign);
router.post("/campaigns/:id/share", adminAuth, outreachController.shareOutreachCampaign);
router.get("/campaigns/:id/analytics.csv", adminAuth, outreachController.downloadOutreachCampaignAnalyticsCsv);

/* analytics / status */
router.get("/campaigns/:id/analytics/overview", adminAuth, outreachController.getOutreachCampaignAnalyticsOverview);
router.get("/campaigns/:id/analytics/daily", adminAuth, outreachController.getOutreachCampaignAnalyticsDaily);
router.get("/campaigns/:id/analytics/steps", adminAuth, outreachController.getOutreachCampaignAnalyticsSteps);
router.get("/campaigns/:id/sending-status", adminAuth, outreachController.getOutreachCampaignSendingStatus);
router.post("/campaigns/:id/diagnose", adminAuth, outreachController.diagnoseOutreachCampaign);

/* configuration */
router.get("/campaigns/:id/configuration", adminAuth, outreachController.getOutreachCampaignConfiguration);
router.patch("/campaigns/:id/configuration", adminAuth, outreachController.updateOutreachCampaignConfiguration);
router.post("/campaigns/:id/sync", adminAuth, outreachController.syncOutreachCampaignConfiguration);

/* template variables */
router.get("/campaigns/:id/template-variables", adminAuth, outreachController.getCampaignTemplateVariables);

/* testing */
router.post("/campaigns/:id/test-email", adminAuth, outreachController.sendCampaignTestEmail);

/* contacts */
router.get("/campaigns/:id/contacts", adminAuth, outreachController.listCampaignContacts);
router.post("/campaigns/:id/contacts", adminAuth, outreachController.addProspectsToCampaign);

router.post(
  "/campaigns/:id/contacts/csv/preview",
  adminAuth,
  upload.single("file"),
  outreachController.previewCampaignContactsCsv
);

router.post(
  "/campaigns/:id/contacts/csv",
  adminAuth,
  upload.single("file"),
  outreachController.uploadCampaignContactsCsv
);

router.post("/campaigns/:id/contacts/manual", adminAuth, outreachController.addCampaignContactsManual);
router.post("/campaigns/:id/contacts/google-sheet", adminAuth, outreachController.importCampaignContactsFromGoogleSheet);

router.patch(
  "/campaigns/:id/contacts/:prospectId/stage",
  adminAuth,
  outreachController.updateCampaignContactStage
);

router.delete(
  "/campaigns/:id/contacts/:prospectId",
  adminAuth,
  outreachController.removeCampaignContact
);

/* =========================
   Reply Review
========================= */

router.get("/replies/pending", adminAuth, replyReviewController.listPendingReplies);
router.post("/replies/:reviewId/reject", adminAuth, replyReviewController.rejectReply);
router.post("/replies/:reviewId/assign-bme", adminAuth, replyReviewController.assignReplyToBme);

/* =========================
   Threads
========================= */

router.get("/threads", adminAuth, threadController.listBmeThreads);
router.get("/threads/:threadId", adminAuth, threadController.getThreadMessages);
router.post("/threads/:threadId/reply", adminAuth, threadController.replyToThread);

module.exports = router;