// routes/campaignReviewRoutes.js
const express = require("express");
const ctrl = require("../controllers/campaignReviewController");
const { adminAuth } = require("../middlewares/adminAuth");

const router = express.Router();

router.get("/questionnaires", ctrl.getReviewQuestionnaires);

router.get("/public/:token", ctrl.getReviewByToken);
router.post("/public/:token", ctrl.submitReviewByToken);
router.put("/public/:token", ctrl.submitReviewByToken);

router.post("/brand/submit", ctrl.submitBrandReviewDirect);
router.put("/brand/submit", ctrl.submitBrandReviewDirect);

router.post("/brand/prompt-state", ctrl.getBrandReviewPromptState);
router.post("/brand/skip", ctrl.skipBrandReviewDirect);

router.post("/influencer/submit", ctrl.submitInfluencerReviewDirect);
router.put("/influencer/submit", ctrl.submitInfluencerReviewDirect);

router.post("/influencer/prompt-state", ctrl.getInfluencerReviewPromptState);
router.post("/influencer/skip", ctrl.skipInfluencerReviewDirect);

router.get("/admin/questionnaires", adminAuth, ctrl.getReviewQuestionnaires);
router.get("/admin/options", adminAuth, ctrl.listAdminReviewOptions);
router.post("/admin/generate-links", adminAuth, ctrl.generateReviewLinks);
router.get("/admin", adminAuth, ctrl.listAdminReviews);
router.post("/admin/:id/revoke", adminAuth, ctrl.revokeReviewLink);

router.get("/summary", ctrl.getReviewSummary);

module.exports = router;