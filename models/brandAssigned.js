const mongoose = require("mongoose");

const brandAssignedSchema = new mongoose.Schema(
  {
    brandId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
      index: true,
    },

    RHId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Master",
      default: null,
      index: true,
    },

    bdmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Master",
      default: null,
      index: true,
    },

    status: {
      type: String,
      enum: ["active", "inactive", "pending"],
      default: "active",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

brandAssignedSchema.index({ brandId: 1, status: 1 });
brandAssignedSchema.index({ brandId: 1, RHId: 1, bdmId: 1 });

module.exports =
  mongoose.models.BrandAssigned ||
  mongoose.model("BrandAssigned", brandAssignedSchema);