// routes/campaignReviewRoutes.js
const express = require("express");
const ctrl = require("../controllers/campaignReviewController");
const { adminAuth } = require("../middlewares/adminAuth");

const router = express.Router();

router.get("/public/:token", ctrl.getReviewByToken);
router.post("/public/:token", ctrl.submitReviewByToken);

router.get("/admin/options", adminAuth, ctrl.listAdminReviewOptions);
router.post("/admin/generate-links", adminAuth, ctrl.generateReviewLinks);
router.get("/admin", adminAuth, ctrl.listAdminReviews);
router.post("/admin/:id/revoke", adminAuth, ctrl.revokeReviewLink);

router.get("/summary", ctrl.getReviewSummary);

module.exports = router;