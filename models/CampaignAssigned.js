const mongoose = require("mongoose");

const campaignAssignedSchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },

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

    idmId: {
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

campaignAssignedSchema.index({ campaignId: 1, status: 1 });
campaignAssignedSchema.index({ campaignId: 1, idmId: 1 });

module.exports =
  mongoose.models.CampaignAssigned ||
  mongoose.model("CampaignAssigned", campaignAssignedSchema);