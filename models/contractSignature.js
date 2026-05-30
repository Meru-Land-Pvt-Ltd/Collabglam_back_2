"use strict";

const mongoose = require("mongoose");
const { Schema } = mongoose;

const MAX_SIGNATURE_BYTES = Number(process.env.CONTRACT_SIGNATURE_MAX_BYTES || 5 * 1024 * 1024);

function parseSignatureDataUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return { signatureDataUrl: "", mimeType: "", sizeBytes: 0 };

  const match = raw.match(/^data:(image\/(?:png|jpeg|jpg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) {
    const error = new Error("Invalid signature. Signature must be an image base64 data URL.");
    error.status = 400;
    throw error;
  }

  const sizeBytes = Buffer.from(match[2], "base64").length;
  if (sizeBytes > MAX_SIGNATURE_BYTES) {
    const error = new Error(`Signature image must be ${MAX_SIGNATURE_BYTES / 1024} KB or less.`);
    error.status = 400;
    throw error;
  }

  return { signatureDataUrl: raw, mimeType: match[1].toLowerCase(), sizeBytes };
}

const ContractSignatureSchema = new Schema(
  {
    contractId: { type: String, required: true, index: true, trim: true },
    role: { type: String, enum: ["brand", "influencer", "collabglam"], required: true, index: true },
    signed: { type: Boolean, default: false },

    savedSignatureId: { type: String, default: "", index: true, trim: true },

    byUserId: { type: String, default: "", trim: true },
    name: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },

    signatureDataUrl: { type: String, default: "" },
    mimeType: { type: String, default: "", trim: true },
    sizeBytes: { type: Number, default: 0 },

    ipAddress: { type: String, default: "", trim: true },
    userAgent: { type: String, default: "", trim: true },

    signedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

ContractSignatureSchema.index({ contractId: 1, role: 1 }, { unique: true });

ContractSignatureSchema.pre("validate", function signaturePreValidate(next) {
  try {
    if (this.signatureDataUrl) {
      const info = parseSignatureDataUrl(this.signatureDataUrl);
      this.signatureDataUrl = info.signatureDataUrl;
      this.mimeType = this.mimeType || info.mimeType;
      this.sizeBytes = info.sizeBytes;
      this.signed = true;
      this.signedAt = this.signedAt || new Date();
    }
    next();
  } catch (error) {
    next(error);
  }
});

ContractSignatureSchema.statics.upsertSigned = function upsertSigned({
  contractId,
  role,
  byUserId = "",
  name = "",
  email = "",
  signatureDataUrl = "",
  savedSignatureId = "",
  ipAddress = "",
  userAgent = "",
}) {
  return this.findOneAndUpdate(
    { contractId, role },
    {
      $set: {
        signed: true,
        savedSignatureId,
        byUserId,
        name,
        email,
        signatureDataUrl,
        ipAddress,
        userAgent,
        signedAt: new Date(),
        revokedAt: null,
        revokeReason: "",
      },
    },
    { upsert: true, new: true, runValidators: true }
  );
};

module.exports = mongoose.models.ContractSignature || mongoose.model("ContractSignature", ContractSignatureSchema);
