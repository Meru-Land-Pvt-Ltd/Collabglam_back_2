"use strict";

const mongoose = require("mongoose");
const { Schema } = mongoose;

const SIGNATURE_STATUS = Object.freeze({ ACTIVE: "active", INACTIVE: "inactive" });
const MAX_SIGNATURE_BYTES = Number(process.env.SAVED_SIGNATURE_MAX_BYTES || 5 * 1024 * 1024);

function parseSignatureDataUrl(value) {
  const signature = String(value || "").trim();

  if (!signature) {
    const error = new Error("Signature is required.");
    error.status = 400;
    throw error;
  }

  const match = signature.match(
    /^data:(image\/(?:png|jpeg|jpg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/i
  );

  if (!match) {
    const error = new Error("Invalid signature. Signature must be SVG, PNG, JPG, JPEG, or WEBP.");
    error.status = 400;
    throw error;
  }

  const sizeBytes = Buffer.from(match[2], "base64").length;

  if (sizeBytes > MAX_SIGNATURE_BYTES) {
    const error = new Error(`Signature file must be ${MAX_SIGNATURE_BYTES / 1024 / 1024} MB or less.`);
    error.status = 400;
    throw error;
  }

  return {
    signature,
    mimeType: match[1].toLowerCase(),
    sizeBytes,
  };
}

function createSignatureAssetModel({ modelName, ownerField, collection }) {
  const schema = new Schema(
    {
      [ownerField]: { type: String, required: true, index: true, trim: true },

name: { type: String, default: "Brand Signature", trim: true },
      remarks: { type: String, default: "", trim: true },

      signature: { type: String, required: true },
      mimeType: { type: String, default: "", trim: true },
      originalName: { type: String, default: "", trim: true },
      sizeBytes: { type: Number, default: 0 },

      isPrimary: { type: Boolean, default: false, index: true },

      status: {
        type: String,
        enum: Object.values(SIGNATURE_STATUS),
        default: SIGNATURE_STATUS.ACTIVE,
        index: true,
      },

      createdBy: { type: String, default: "", trim: true },
      updatedBy: { type: String, default: "", trim: true },
    },
    { timestamps: true, collection }
  );

  schema.index({ [ownerField]: 1, status: 1, isPrimary: -1, updatedAt: -1 });

  schema.pre("validate", function signatureAssetPreValidate(next) {
    try {
      if (this.signature) {
        const parsed = parseSignatureDataUrl(this.signature);
        this.signature = parsed.signature;
        this.mimeType = parsed.mimeType;
        this.sizeBytes = parsed.sizeBytes;
      }

      next();
    } catch (error) {
      next(error);
    }
  });

  schema.statics.findActive = async function findActive(ownerId) {
    const ownerValue = String(ownerId);

    const primary = await this.findOne({
      [ownerField]: ownerValue,
      status: SIGNATURE_STATUS.ACTIVE,
      isPrimary: true,
    }).sort({ updatedAt: -1 });

    if (primary) return primary;

    return this.findOne({
      [ownerField]: ownerValue,
      status: SIGNATURE_STATUS.ACTIVE,
    }).sort({ updatedAt: -1 });
  };

schema.statics.setPrimary = async function setPrimary(
  ownerId,
  signatureId,
  updatedBy = ""
) {
  const ownerValue = String(ownerId);

  const signature = await this.findOne({
    _id: signatureId,
    [ownerField]: ownerValue,
    status: SIGNATURE_STATUS.ACTIVE,
  });

  if (!signature) {
    const error = new Error("Brand signature not found.");
    error.status = 404;
    throw error;
  }

  await this.updateMany(
    {
      [ownerField]: ownerValue,
      status: SIGNATURE_STATUS.ACTIVE,
    },
    {
      $set: {
        isPrimary: false,
        updatedBy,
      },
    },
    {
      runValidators: false,
    }
  );

  await this.updateOne(
    {
      _id: signatureId,
      [ownerField]: ownerValue,
      status: SIGNATURE_STATUS.ACTIVE,
    },
    {
      $set: {
        isPrimary: true,
        updatedBy,
        name: signature.name || "Brand Signature",
      },
    },
    {
      runValidators: false,
    }
  );

  return this.findOne({
    _id: signatureId,
    [ownerField]: ownerValue,
    status: SIGNATURE_STATUS.ACTIVE,
  });
};

  return mongoose.models[modelName] || mongoose.model(modelName, schema);
}

module.exports = createSignatureAssetModel;