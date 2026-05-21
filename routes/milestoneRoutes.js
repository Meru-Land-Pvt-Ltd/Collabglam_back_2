const express = require("express");
const router = express.Router();

const {
  createMilestone,
  getMilestonesByCampaign,
  getWalletBalance,
  getMilestonesByInfluencerAndCampaign,
  getMilestonesByInfluencer,
  getMilestonesByBrand,
  releaseMilestone,
  getInfluencerPaidTotal,
  adminListPayouts,
  adminMarkMilestonePaid,
  getPayoutDetailsByInfluencer,
  editMilestone,
  getAllDeliverablesByMilestone,
  addRevision,
  submitDeliverable,
  approveDeliverable,
  acceptMilestoneByInfluencer,
  updateDeliverableStatus,
} = require("../controllers/milestoneController");

// Brand: create milestone and freeze amount in BrandWallet
router.post("/create", createMilestone);

router.post("/edit", editMilestone);

// Get milestones by campaign
router.post("/byCampaign", getMilestonesByCampaign);

router.post("/balance", getWalletBalance);
router.post("/getMilestome", getMilestonesByInfluencerAndCampaign);

router.post("/byInfluencer", getMilestonesByInfluencer);

router.post("/byBrand", getMilestonesByBrand);

router.post("/release", releaseMilestone);

router.post("/influencer-payout", getInfluencerPaidTotal);

router.post("/adminListPayouts", adminListPayouts);

router.post("/adminMarkMilestonePaid", adminMarkMilestonePaid);

router.post("/getPayoutDetailsByInfluencer", getPayoutDetailsByInfluencer);

router.post("/getAllDeliverables", getAllDeliverablesByMilestone);

router.post("/addRevision", addRevision);

router.post("/submitDeliverable", submitDeliverable);

router.post("/approveDeliverable", approveDeliverable);

router.post("/acceptByInfluencer", acceptMilestoneByInfluencer);
  
router.post("/updateDeliverableStatus", updateDeliverableStatus);

module.exports = router;