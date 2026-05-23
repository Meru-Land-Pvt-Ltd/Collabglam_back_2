const express = require("express");
const ctrl = require("../controllers/campaignReviewController");
const { adminAuth } = require("../middlewares/adminAuth");

const router = express.Router();

/* =========================
   QUESTIONNAIRES
========================= */
router.get("/questionnaires", ctrl.getReviewQuestionnaires);
router.get("/admin/questionnaires", adminAuth, ctrl.getReviewQuestionnaires);

/* =========================
   PUBLIC PLATFORM FEEDBACK PAGE
   Standalone page, not token based
========================= */
router.get("/platform-feedback/questionnaire", ctrl.getPublicPlatformFeedbackQuestionnaire);
router.post("/platform-feedback/submit", ctrl.submitPublicPlatformFeedback);

/* =========================
   PUBLIC TOKEN REVIEW
   One-time submit only. No PUT/update route.
========================= */
router.get("/public/:token", ctrl.getReviewByToken);
router.post("/public/:token", ctrl.submitReviewByToken);

/* =========================
   BRAND REVIEWS
   Brand reviews influencer for campaign
   One-time submit only. No PUT/update route.
========================= */
router.post("/brand/submit", ctrl.submitBrandReviewDirect);
router.post("/brand/prompt-state", ctrl.getBrandReviewPromptState);
router.post("/brand/skip", ctrl.skipBrandReviewDirect);

/* =========================
   INFLUENCER REVIEWS
   Influencer reviews brand for campaign
   One-time submit only. No PUT/update route.
========================= */
router.post("/influencer/submit", ctrl.submitInfluencerReviewDirect);
router.post("/influencer/prompt-state", ctrl.getInfluencerReviewPromptState);
router.post("/influencer/skip", ctrl.skipInfluencerReviewDirect);

/* =========================
   PLATFORM REVIEWS
   Brand / Influencer reviews CollabGlam platform
   One-time submit only. No PUT/update route.
========================= */
router.post("/brand/platform/submit", ctrl.submitBrandPlatformReviewDirect);
router.post("/brand/platform/prompt-state", ctrl.getBrandPlatformReviewPromptState);
router.post("/brand/platform/skip", ctrl.skipBrandPlatformReviewDirect);

router.post("/influencer/platform/submit", ctrl.submitInfluencerPlatformReviewDirect);
router.post(
  "/influencer/platform/prompt-state",
  ctrl.getInfluencerPlatformReviewPromptState
);
router.post("/influencer/platform/skip", ctrl.skipInfluencerPlatformReviewDirect);

/* =========================
   ADMIN
========================= */
router.get("/admin/options", adminAuth, ctrl.listAdminReviewOptions);
router.get("/admin/links", adminAuth, ctrl.listAdminReviewLinks);
router.post("/admin/generate-links", adminAuth, ctrl.generateReviewLinks);
router.get("/admin/page", adminAuth, ctrl.getAdminReviewPage);
router.get("/admin", adminAuth, ctrl.listAdminReviews);
router.post("/admin/:id/revoke", adminAuth, ctrl.revokeReviewLink);

/* =========================
   PUBLIC / SHARED SUMMARY
========================= */
router.get("/summary", ctrl.getReviewSummary);

module.exports = router;