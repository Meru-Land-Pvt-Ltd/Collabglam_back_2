// routes/campaignIntelligenceRoutes.js

const express = require("express");
const router = express.Router();

const {
  getCampaignIntelligence,
} = require("../controllers/campaignIntelligenceController");

router.get("/:campaignId", getCampaignIntelligence);

module.exports = router;