const { Schema, model } = require("mongoose");
const { REVIEW_STATUS } = require("../constants/outreach");

const ReplyReviewQueueSchema = new Schema(
  {
    prospectId: { type: Schema.Types.ObjectId, ref: "ProspectBrand", required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: "OutreachCampaign", default: null },

    sdrId: { type: Schema.Types.ObjectId, ref: "Master", required: true },
    RHId: { type: Schema.Types.ObjectId, ref: "Master", required: true },
    assignedBmeId: { type: Schema.Types.ObjectId, ref: "Master", default: null },

    instantlyThreadId: { type: String, default: "" },
    instantlyEmailId: { type: String, default: "" },

    latestReplySnippet: { type: String, default: "" },
    latestReplySubject: { type: String, default: "" },

    reviewStatus: {
      type: String,
      enum: Object.values(REVIEW_STATUS),
      default: REVIEW_STATUS.PENDING,
    },

    disposition: {
      type: String,
      enum: ["unknown", "qualified", "not_relevant", "wrong_person", "unsubscribe", "spam"],
      default: "unknown",
    },

    reviewerNotes: { type: String, default: "" },

    reviewedBy: { type: Schema.Types.ObjectId, ref: "Master", default: null },
    reviewedAt: { type: Date, default: null },
    assignedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ReplyReviewQueueSchema.index({ RHId: 1, reviewStatus: 1, createdAt: -1 });
ReplyReviewQueueSchema.index({ prospectId: 1, reviewStatus: 1 });

module.exports = model("ReplyReviewQueue", ReplyReviewQueueSchema);