const express = require("express");
const router = express.Router();

const {
  getBrandWallet,
  topupBrandWallet,
  confirmBrandWalletTopup,

  freezeAmountForCampaign,  
  allocateToInfluencer,
  withdrawBrandWalletAmount,

  getFrozenAmountForCampaign,
  getWalletTopup,
  getBrandWalletHistory,
} = require("../controllers/brandWalletController");

router.get("/", getBrandWallet);

router.post("/topup", topupBrandWallet);
router.post("/topup/confirm", confirmBrandWalletTopup);

router.post("/freeze-campaign", freezeAmountForCampaign);
router.post("/allocate-to-influencer", allocateToInfluencer);
router.post("/withdraw", withdrawBrandWalletAmount);

router.get("/freeze-amount", getFrozenAmountForCampaign);
router.get("/topupHistory", getWalletTopup);
router.get("/history", getBrandWalletHistory);

module.exports = router;