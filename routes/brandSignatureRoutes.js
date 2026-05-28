"use strict";

const express = require("express");
const multer = require("multer");

const {
  listBrandSignatures,
  getPrimaryBrandSignature,
  createBrandSignature,
  setPrimaryBrandSignature,
  deleteBrandSignature,
} = require("../controllers/brandSignatureController");

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
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return cb(new Error("Only SVG, PNG, JPG, JPEG, or WEBP signatures are allowed."));
    }

    cb(null, true);
  },
});

router.get("/contract/brand-signatures/:brandId", listBrandSignatures);
router.get("/contract/signature/:brandId", getPrimaryBrandSignature);

router.post(
  "/contract/brand-signatures/:brandId",
  upload.single("signature"),
  createBrandSignature
);

router.post(
  "/contract/signature/upload",
  upload.single("signature"),
  createBrandSignature
);

router.patch(
  "/contract/brand-signatures/:brandId/:signatureId/primary",
  setPrimaryBrandSignature
);

router.delete(
  "/contract/brand-signatures/:brandId/:signatureId",
  deleteBrandSignature
);

module.exports = router;