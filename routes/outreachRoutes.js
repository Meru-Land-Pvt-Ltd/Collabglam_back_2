const router = require("express").Router();
const outreachController = require("../controllers/outreachController");
const replyReviewController = require("../controllers/replyReviewController");
const threadController = require("../controllers/threadController");
const { verifyAdminToken } = require("../controllers/adminController"); // or your existing auth middleware

router.post("/prospects", verifyAdminToken, outreachController.createProspect);
router.post("/campaigns", verifyAdminToken, outreachController.createOutreachCampaign);
router.post("/campaigns/:id/launch", verifyAdminToken, outreachController.launchOutreachCampaign);
router.post("/campaigns/:id/pause", verifyAdminToken, outreachController.pauseOutreachCampaign);

router.get("/replies/pending", verifyAdminToken, replyReviewController.listPendingReplies);
router.post("/replies/:reviewId/reject", verifyAdminToken, replyReviewController.rejectReply);
router.post("/replies/:reviewId/assign-bme", verifyAdminToken, replyReviewController.assignReplyToBme);

router.get("/threads", verifyAdminToken, threadController.listBmeThreads);
router.get("/threads/:threadId", verifyAdminToken, threadController.getThreadMessages);
router.post("/threads/:threadId/reply", verifyAdminToken, threadController.replyAsBme);

module.exports = router;