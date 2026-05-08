const express = require("express");
const router = express.Router();

const uploadImages = require("../middlewares/uploadImages");
const campaignController = require("../controllers/campaignsController");
const { verifyBrandOrAdmin } = require("../middlewares/verifyBrandOrAdmin");
const { ApiLimiter } = require("../middlewares/rateLimit");
const { brandAuth } = require("../auth/brandAuth");
const { influencerAuth } = require("../auth/influencerAuth");
const brandOrInfluencerAuth = require("../auth/brandOrInfluencerAuth");

// 1. Create a new campaign
router.post("/create", verifyBrandOrAdmin, campaignController.createCampaign);
router.post("/create-ai", campaignController.prefillCampaignWithAI);

// 2. Edit manual campaign
router.put("/update-manual", brandAuth, campaignController.updateManualCampaign);

// optional alias if frontend/client cannot send PUT
router.post("/update-manual", brandAuth, campaignController.updateManualCampaign);

// 3. Get all campaigns
router.get("/getAll", brandAuth, campaignController.getAllCampaigns);
router.get("/getNonFullManagedCampaigns", brandAuth, campaignController.getNonFullManagedCampaigns);
// 4. Get one campaign by its campaignId
router.get("/get-by-id/:campaignId", verifyBrandOrAdmin, campaignController.getCampaignById);
// 5. Delete a campaign
router.post("/delete", brandAuth, campaignController.deleteCampaignByCampaignId);

// Existing campaign routes
router.get("/active", brandAuth, campaignController.getActiveCampaignsByBrand);
router.get("/previous", brandAuth, campaignController.getPreviousCampaigns);
router.post("/byCategoryId", brandAuth, campaignController.getActiveCampaignsByCategories);

router.post("/checkApplied", brandAuth, campaignController.checkApplied);
router.post("/byInfluencer", influencerAuth, campaignController.getCampaignsByInfluencer);
router.post("/myCampaign", influencerAuth, campaignController.getApprovedCampaignsByInfluencer);
router.post("/applied", brandOrInfluencerAuth, campaignController.getAppliedCampaignsByInfluencer);
router.post("/history", brandAuth, campaignController.getCampaignHistoryByBrand);

router.post("/accepted", campaignController.getAcceptedCampaigns);
router.post("/accepted-inf", brandAuth, campaignController.getAcceptedInfluencers);

router.post("/contracted", influencerAuth, campaignController.getContractedCampaignsByInfluencer);
router.get("/rejected/:influencerId", campaignController.rejectedCampaign);
router.post("/filter", brandAuth, campaignController.getCampaignsByFilter);
router.post("/rejectedbyinf", brandAuth, campaignController.getRejectedCampaignsByInfluencer);

router.get("/campaignSummary", brandAuth, campaignController.getCampaignSummary);
router.get("/draft", brandAuth, campaignController.getDraftCampaignByBrand);

router.post("/history-list", campaignController.listApplicants);
router.post("/update-pending", campaignController.approveCampaignPendingUpdate);
router.post("/reject-pending", campaignController.rejectCampaignPendingUpdate);

router.get("/created-by-admin/:brandId", campaignController.getAdminCampaigns);

router.get("/category", ApiLimiter, campaignController.getCategories);
router.get("/subcategory", campaignController.getSubcategories);

router.post("/view-campaign-brand", brandAuth, campaignController.viewCampaignByIdForBrand);

router.post(
  "/recommended-influencers",
  brandAuth,
  campaignController.getRecommendedInfluencersByCampaignId
);

router.post("/update-status", brandAuth, campaignController.updateStatus);

router.post(
  "/view-campaign-by-influencer",
  influencerAuth,
  campaignController.viewCampaignByIdForInfluencer
);

// Keep old influencer active route if another page still uses it
router.post(
  "/influencer/get-all-active",
  influencerAuth,
  campaignController.getAllActiveCampaignsForInfluencer
);

// New dispute dropdown routes
router.post(
  "/get-by-brand",
  brandAuth,
  campaignController.getCampaignsByBrandId
);

router.post(
  "/get-by-influencer",
  influencerAuth,
  campaignController.getCampaignsByInfluencerId
);

router.post(
  "/brand-list",
  influencerAuth,
  campaignController.getBrandListByCampaignId
);

// Brand side calls this route, so it must use brandAuth
router.post(
  "/influencer-list",
  brandAuth,
  campaignController.getInfluencerListByCampaignId
);

router.post(
  "/upload-image",
  uploadImages.array("images", 10),
  campaignController.uploadImagesToS3
);

router.post("/edit-draft", brandAuth, campaignController.editDraftCampaign);
router.post("/get-drafts", brandAuth, campaignController.getDraftCampaigns);

router.post("/share/enable", brandAuth, campaignController.enableCampaignShare);
router.post("/share/disable", brandAuth, campaignController.disableCampaignShare);
router.get("/public/:token", campaignController.getPublicCampaignByToken);


router.post(
  "/influencer-match-score",
  campaignController.getInfluencerMatchScore
);

module.exports = router;