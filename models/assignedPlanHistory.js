const mongoose = require("mongoose");

const BrandAssignedPlanHistorySchema = new mongoose.Schema(
  {
    brandId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
      index: true,
    },

    planId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    oldPlanName: {
      type: String,
      default: "free",
      trim: true,
    },

    newPlanName: {
      type: String,
      required: true,
      trim: true,
    },

    billingCycle: {
      type: String,
      enum: ["monthly", "annual", "yearly"],
      default: "monthly",
    },

    startedAt: {
      type: Date,
      default: null,
    },

    expiresAt: {
      type: Date,
      default: null,
    },

    durationDays: {
      type: Number,
      default: null,
    },

    assignedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
      index: true,
    },

    assignedByAdminEmail: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },

    source: {
      type: String,
      enum: ["admin_manual"],
      default: "admin_manual",
    },

    status: {
      type: String,
      enum: ["assigned", "expired", "cancelled"],
      default: "assigned",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

BrandAssignedPlanHistorySchema.index({ brandId: 1, createdAt: -1 });
BrandAssignedPlanHistorySchema.index({ planId: 1, createdAt: -1 });
BrandAssignedPlanHistorySchema.index({ assignedByAdminId: 1, createdAt: -1 });
BrandAssignedPlanHistorySchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model(
  "BrandAssignedPlanHistory",
  BrandAssignedPlanHistorySchema
);