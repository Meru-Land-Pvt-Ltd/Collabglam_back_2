const express = require("express");
const router = express.Router();

const {
  createDeliverableApproval,
  adminCreateDeliverableApproval,
  updateDeliverableApprovalStatus,
  listDeliverablesByCampaign,
  listInfluencerDeliverablesByCampaign,
  listInfluencerDeliverablesByCampaign2,
  getAllDeliverables,
  getAllDeliverablesByBrandOrInfluencerPost,
  getAllDeliverablesByMilestoneIdPost,
  getDeliverableStatusByInfluencerIdPost,
  getDeliverablesByMilestoneHistoryIdPost
} = require("../controllers/delieverableController");

const { influencerAuth } = require("../auth/influencerAuth");
const { brandAuth } = require("../auth/brandAuth");
const brandOrInfluencerAuth = require("../auth/brandOrInfluencerAuth");

// Use the same adminAuth path you use in admin routes.
const { adminAuth } = require("../middlewares/adminAuth");

// Influencer creates their own deliverable
router.post("/create", influencerAuth, createDeliverableApproval);

// Admin creates deliverable on behalf of influencer
router.post("/admin/create", adminAuth, adminCreateDeliverableApproval);

router.post(
  "/:deliverableId/approval-status",
  updateDeliverableApprovalStatus
);

router.get("/campaign/:campaignId", listDeliverablesByCampaign);

router.get(
  "/influencer/:influencerId/campaign/:campaignId",
  listInfluencerDeliverablesByCampaign
);

router.get(
  "/influencer/campaign/:campaignId",
  listInfluencerDeliverablesByCampaign2
);

router.get("/getall", getAllDeliverables);
router.post("/by-brand", getAllDeliverablesByBrandOrInfluencerPost);
router.post("/by-milestone", getAllDeliverablesByMilestoneIdPost);

router.post(
  "/status/by-influencer",
  getDeliverableStatusByInfluencerIdPost
);

router.post(
  "/by-milestonehistoryId",
  getDeliverablesByMilestoneHistoryIdPost
);

module.exports = router;