const express = require("express");
const router = express.Router();

const {
  getBrandWallet,
  topupBrandWallet,
  getFrozenAmountForCampaign,
  confirmBrandWalletTopup,
  getWalletTopup,
} = require("../controllers/brandWalletController");

router.get("/", getBrandWallet);
router.post("/topup", topupBrandWallet);
router.post("/topup/confirm", confirmBrandWalletTopup);
router.get("/freeze-amount", getFrozenAmountForCampaign);
router.get("/topupHistory", getWalletTopup);

module.exports = router;