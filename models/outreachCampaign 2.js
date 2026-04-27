const { Schema, model } = require("mongoose");
const { OUTREACH_CAMPAIGN_STATUS } = require("../constants/outreach");

const OutreachCampaignSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },

    sdrId: { type: Schema.Types.ObjectId, ref: "Master", required: true },
    RHId: { type: Schema.Types.ObjectId, ref: "Master", required: true },
    assignedBmeId: { type: Schema.Types.ObjectId, ref: "Master", required: true },

    status: {
      type: String,
      enum: Object.values(OUTREACH_CAMPAIGN_STATUS),
      default: OUTREACH_CAMPAIGN_STATUS.DRAFT,
    },

    prospectIds: [{ type: Schema.Types.ObjectId, ref: "ProspectBrand" }],

    instantly: {
      workspaceId: { type: String, default: "" },
      campaignId: { type: String, default: "" },
      leadListId: { type: String, default: "" },
      accountEmails: { type: [String], default: [] },
      rawCampaignPayload: { type: Schema.Types.Mixed, default: null },
    },

    sequenceMeta: {
      sequenceName: { type: String, default: "" },
      fromName: { type: String, default: "" },
      replyTo: { type: String, default: "" },
      trackingDomain: { type: String, default: "" },
    },

    stats: {
      totalProspects: { type: Number, default: 0 },
      totalReplies: { type: Number, default: 0 },
      totalQualified: { type: Number, default: 0 },
      totalAssigned: { type: Number, default: 0 },
    },

    launchValidatedAt: { type: Date, default: null },
    launchedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

OutreachCampaignSchema.index({ sdrId: 1, status: 1 });
OutreachCampaignSchema.index({ RHId: 1, status: 1 });
OutreachCampaignSchema.index({ assignedBmeId: 1, status: 1 });
OutreachCampaignSchema.index({ "instantly.campaignId": 1 });

module.exports = model("OutreachCampaign", OutreachCampaignSchema);