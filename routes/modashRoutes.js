// routes/index.js
const express = require("express");
const router = express.Router();
const ModashController = require("../controllers/modashController");
const { verifyBrandOrAdmin } = require("../middlewares/verifyBrandOrAdmin");
const { modashApiLimiter } = require("../middlewares/rateLimit");

router.get("/users", ModashController.frontendUsers);

router.post("/search", ModashController.frontendSearch);
router.post("/search-unified", ModashController.frontendUnifiedSearch);

router.get("/report-preview", ModashController.frontendReportPreview);
router.get("/report", ModashController.frontendReport);

router.post("/resolve-profile", ModashController.resolveProfile);
router.post("/search-legacy", ModashController.search);

router.get("/saved", ModashController.getSavedInfluencers);
router.get("/random", ModashController.getRandomInfluencers);
router.post("/export-csv", ModashController.exportSavedInfluencersCsv);
router.get("/media-kit-link", ModashController.getMediaKitLink);

router.post("/creator", ModashController.upsertCreator);
router.get("/creator/:userId", ModashController.getCreatorByUserId);
router.get("/locations", ModashController.getModashLocations);

router.post(
  "/campaign-recommendation-source",
  ModashController.getCampaignRecommendationSource
);

router.post(
  "/recommended-by-campaign", ModashController.getRecommendedInfluencersForCampaign
);

router.post("/rate-card/suggested", ModashController.getSuggestedRateCard);
module.exports = router;