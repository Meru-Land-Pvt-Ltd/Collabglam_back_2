"use strict";

const express = require("express");

let upload = null;
try {
  upload = require("../middlewares/upload");
} catch {
  try {
    upload = require("../middlewares/multer");
  } catch {
    upload = require("multer")();
  }
}

const {
  sendSignupOtp,
  verifyOtpSignUp,
  saveBrandOnboarding,
  signInBrand,
  uploadBrandProfilePic,
  sendOtpForgotBrand,
  verifyOtpForgotBrand,
  updatePasswordBrand,
  getBrandById,
  getBrandLiteById,
  getBrandProfile,
  updateBrandProfile,
  verifyBrandCoupon,
  addbookmarkProfile,
  getbookmarkProfile,
  getFolderList,
  createFolder,
  saveGoodFitInfluencer,
  getGoodFitInfluencers,
  getCampaignGoodFitList,
  saveCampaignGoodFitItem,
  getBrandSettingOverview,
  getBrandSettingProfile,
  updateBrandSettingProfile,
  updateBrandSettingProfilePhoto,
  updateBrandSettingPassword,
  googleAuthBrand,
} = require("../controllers/brandController");

const { brandAuth } = require("../auth/brandAuth");

const router = express.Router();

router.post(
  "/upload-brand-profile-pic",
  upload.single("brandProfilePic"),
  brandAuth,
  uploadBrandProfilePic
);

router.post("/send-otp-signup", sendSignupOtp);
router.post("/verify-otp-signup", verifyOtpSignUp);
router.post("/save-brand-onboarding", brandAuth, saveBrandOnboarding);
router.post("/signin", signInBrand);
router.post("/google-auth", googleAuthBrand);
router.post("/send-otp-forgot", sendOtpForgotBrand);
router.post("/verify-otp-forgot", verifyOtpForgotBrand);
router.post("/update-password", updatePasswordBrand);

router.get("/lite", brandAuth, getBrandLiteById);

router.post("/profile", brandAuth, getBrandProfile);
router.post("/profile/update", brandAuth, updateBrandProfile);
router.post("/verify-coupon", brandAuth, verifyBrandCoupon);

/**
 * Brand-owned folders.
 * These use BrandFolder, not PitchFolder.
 */
router.get("/folder/list", brandAuth, getFolderList);
router.post("/folder/create", brandAuth, createFolder);

router.get("/folder/good-fit/list", brandAuth, getGoodFitInfluencers);
router.post("/folder/good-fit", brandAuth, saveGoodFitInfluencer);

// Fully managed campaign good-fit sync.
// Reads admin pitch folder goodFit items and creates/appends a BrandFolder named after the campaign.
router.post(
  "/campaign/:campaignId/good-fit/:itemId",
  brandAuth,
  saveCampaignGoodFitItem
);

router.get("/campaign/:campaignId/good-fit", brandAuth, getCampaignGoodFitList);

/**
 * Bookmark compatibility.
 * Kept under /brand/bookmark/profile for the current frontend.
 */
router.post("/bookmark/profile", brandAuth, addbookmarkProfile);
router.get("/bookmark/profile", brandAuth, getbookmarkProfile);

router.get("/setting/overview", brandAuth, getBrandSettingOverview);

router.get("/setting/profile", brandAuth, getBrandSettingProfile);

router.post("/setting/profile", brandAuth, updateBrandSettingProfile);

router.patch("/setting/profile", brandAuth, updateBrandSettingProfile);

router.post(
  "/setting/profile/photo",
  brandAuth,
  upload.single("brandProfilePic"),
  updateBrandSettingProfilePhoto
);

router.patch(
  "/setting/profile/password",
  brandAuth,
  updateBrandSettingPassword
);

router.get("/:id", getBrandById);

module.exports = router;