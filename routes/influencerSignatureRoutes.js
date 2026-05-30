"use strict";

const express = require("express");
const multer = require("multer");

const {
  listInfluencerSignatures,
  getPrimaryInfluencerSignature,
  createInfluencerSignature,
  setPrimaryInfluencerSignature,
  deleteInfluencerSignature,
} = require("../controllers/influencerSignatureController");

const router = express.Router();

const allowedMimeTypes = new Set([
  "image/svg+xml",
  "image/png",
  "image/jpg",
  "image/jpeg",
  "image/webp",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return cb(new Error("Only SVG, PNG, JPG, JPEG, or WEBP signatures are allowed."));
    }

    cb(null, true);
  },
});

router.get("/contract/influencer-signatures/:influencerId", listInfluencerSignatures);
router.get("/contract/influencer-signature/:influencerId", getPrimaryInfluencerSignature);

router.post(
  "/contract/influencer-signatures/:influencerId",
  upload.single("signature"),
  createInfluencerSignature
);

// Backward-compatible upload endpoint if older frontend code posts here.
router.post(
  "/contract/influencer-signature/upload",
  upload.single("signature"),
  createInfluencerSignature
);

router.patch(
  "/contract/influencer-signatures/:influencerId/:signatureId/primary",
  setPrimaryInfluencerSignature
);

router.delete(
  "/contract/influencer-signatures/:influencerId/:signatureId",
  deleteInfluencerSignature
);

module.exports = router;
