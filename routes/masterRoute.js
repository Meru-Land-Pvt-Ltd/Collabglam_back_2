const express = require("express");
const multer = require("multer");
const router = express.Router();

const adminController = require("../controllers/masterController");
const { adminAuth } = require("../middlewares/adminAuth");
const { superOrRevenueHead } = require("../middlewares/adminRoleGuard");

const upload = multer({ storage: multer.memoryStorage() });

router.post("/login", adminController.adminLogin);
router.post("/invite", adminAuth, superOrRevenueHead, adminController.inviteAdmin);
router.post("/accept-invite", adminController.acceptInviteSetPassword);

router.get("/list", adminAuth, adminController.listAdmins);
router.get("/me", adminAuth, adminController.adminMe);

// Employees role/status/access update
router.put("/update-status", adminAuth, adminController.updateStatus);

router.get(
  "/fully-managed-brand-list",
  adminAuth,
  adminController.fullyManagedBrandList
);

router.post(
  "/assign-brand",
  adminAuth,
  superOrRevenueHead,
  adminController.assignBrand
);

// Brand assignment status update
router.put(
  "/assignment/update-status",
  adminAuth,
  superOrRevenueHead,
  adminController.updateBrandAssignment
);

// Brand assignment RH update
router.put(
  "/assignment/update-rh",
  adminAuth,
  superOrRevenueHead,
  adminController.updateBrandAssignmentStatusAndRH
);

router.get(
  "/get-executive-list",
  adminAuth,
  adminController.listExecutiveAdmin
);

router.get(
  "/get-rm-list",
  adminAuth,
  adminController.rmlist
);

router.get(
  "/get-brand-list",
  adminAuth,
  adminController.allocateBrand
);

router.get(
  "/campaign/list",
  adminAuth,
  adminController.listCampaignsForAdmin
);

router.post(
  "/brand-info",
  adminAuth,
  adminController.BrandInformation
);

router.post(
  "/assign-campaign-ime",
  adminAuth,
  superOrRevenueHead,
  adminController.assignCampaignIme
);

router.post(
  "/send-bulk-csv",
  adminAuth,
  upload.single("file"),
  adminController.sendBulkEmailCsv
);

module.exports = router;