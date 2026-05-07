// routes/notificationsRoutes.js
const express = require("express");
const ctrl = require("../controllers/notificationController");
const { adminAuth } = require("../middlewares/adminAuth");

const router = express.Router();

// Influencer notifications
router.get("/influencer", ctrl.listForInfluencer);
router.post("/influencer/mark-read", ctrl.markReadForInfluencer);
router.post("/influencer/mark-all-read", ctrl.markAllReadForInfluencer);
router.post("/influencer/delete", ctrl.deleteForInfluencer);

// Brand notifications
router.get("/brand", ctrl.listForBrand);
router.post("/brand/mark-read", ctrl.markReadForBrand);
router.post("/brand/mark-all-read", ctrl.markAllReadForBrand);
router.post("/brand/delete", ctrl.deleteForBrand);

// Admin notifications
router.get("/admin", adminAuth, ctrl.listForAdmin);
router.post("/admin/mark-read", adminAuth, ctrl.markReadForAdmin);
router.post("/admin/mark-all-read", adminAuth, ctrl.markAllReadForAdmin);
router.post("/admin/delete", adminAuth, ctrl.deleteForAdmin);

module.exports = router;