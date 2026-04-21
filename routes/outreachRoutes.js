const router = require("express").Router();
const multer = require("multer");

const outreachController = require("../controllers/outreachController");
const replyReviewController = require("../controllers/replyReviewController");
const threadController = require("../controllers/threadController");
const outreachMailboxController = require("../controllers/outreachMailboxController");
const { adminAuth } = require("../middlewares/adminAuth");

const upload = multer({ storage: multer.memoryStorage() });

router.get("/mailboxes", adminAuth, outreachMailboxController.listMailboxAssignments);
router.post("/mailboxes/assign", adminAuth, outreachMailboxController.assignMailbox);
router.post("/mailboxes/:email/unassign", adminAuth, outreachMailboxController.unassignMailbox);

router.post("/campaigns", adminAuth, outreachController.createOutreachCampaign);
router.get("/campaigns", adminAuth, outreachController.listOutreachCampaigns);
router.get("/campaigns/:id", adminAuth, outreachController.getOutreachCampaignById);
router.get(
  "/campaigns/:id/configuration",
  adminAuth,
  outreachController.getOutreachCampaignConfiguration
);
router.patch(
  "/campaigns/:id/configuration",
  adminAuth,
  outreachController.updateOutreachCampaignConfiguration
);
router.post("/campaigns/:id/sync", adminAuth, outreachController.syncOutreachCampaignConfiguration);
router.post("/campaigns/:id/test-email", adminAuth, outreachController.sendCampaignTestEmail);

router.get("/campaigns/:id/contacts", adminAuth, outreachController.listCampaignContacts);
router.post("/campaigns/:id/contacts", adminAuth, outreachController.addProspectsToCampaign);

router.post(
  "/campaigns/:id/contacts/csv",
  adminAuth,
  upload.single("file"),
  outreachController.uploadCampaignContactsCsv
);
router.post(
  "/campaigns/:id/contacts/manual",
  adminAuth,
  outreachController.addCampaignContactsManual
);
router.post(
  "/campaigns/:id/contacts/google-sheet",
  adminAuth,
  outreachController.importCampaignContactsFromGoogleSheet
);

router.post("/campaigns/:id/launch", adminAuth, outreachController.launchOutreachCampaign);
router.post("/campaigns/:id/pause", adminAuth, outreachController.pauseOutreachCampaign);

router.get("/replies/pending", adminAuth, replyReviewController.listPendingReplies);
router.post("/replies/:reviewId/reject", adminAuth, replyReviewController.rejectReply);
router.post("/replies/:reviewId/assign-bme", adminAuth, replyReviewController.assignReplyToBme);

router.get("/threads", adminAuth, threadController.listBmeThreads);
router.get("/threads/:threadId", adminAuth, threadController.getThreadMessages);
router.post("/threads/:threadId/reply", adminAuth, threadController.replyToThread);

module.exports = router;