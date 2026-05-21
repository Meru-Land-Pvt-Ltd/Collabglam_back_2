// models/milestone.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const attachmentSchema = new Schema(
  {
    name: {
      type: String,
      default: "",
      trim: true,
    },
    url: {
      type: String,
      default: "",
      trim: true,
    },
    type: {
      type: String,
      default: "",
      trim: true,
    },
    size: {
      type: Number,
      default: 0,
    },
    key: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
    _id: true,
  }
);

const revisionSchema = new Schema(
  {
    deliverableId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    issueName: {
      type: String,
      required: true,
      trim: true,
    },

    revisionType: {
      type: String,
      enum: ["free", "paid"],
      required: true,
      default: "free",
    },

    revisionBudget: {
      type: Number,
      default: 0,
      min: 0,
    },

    deliveryName: {
      type: String,
      required: true,
      trim: true,
    },

    issueDeliverableLink: {
      type: String,
      required: true,
      trim: true,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
    },

    attachments: {
      type: [attachmentSchema],
      default: [],
    },

    submissionDate: {
      type: Date,
      required: true,
    },

    status: {
      type: String,
      enum: ["pending", "submitted", "approved", "revision"],
      default: "pending",
      index: true,
    },

    raisedByRole: {
      type: String,
      enum: ["Brand", "Influencer", "Admin"],
      default: "Brand",
    },

    raisedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    _id: true,
  }
);

const deliverableLinkSchema = new Schema(
  {
    label: {
      type: String,
      default: "",
      trim: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    timestamps: true,
    _id: true,
  }
);

const deliverableSchema = new Schema(
  {
    deliverableName: {
      type: String,
      required: true,
      trim: true,
    },

    deliveries: {
      type: [String],
      default: [],
    },

    aspectRatio: {
      type: String,
      default: "",
      trim: true,
    },

    platforms: {
      type: [String],
      default: [],
    },

    quantity: {
      type: Number,
      default: 1,
      min: 1,
    },

    deliverableLinks: {
      type: [deliverableLinkSchema],
      default: [],
    },

    submittedAt: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: ["pending", "submitted", "approved", "revision"],
      default: "pending",
      index: true,
    },

    comments: {
      type: String,
      default: "",
      trim: true,
    },

    approvedRole: {
      type: String,
      default: "",
      trim: true,
    },

    approvalId: {
      type: String,
      default: "",
      trim: true,
    },

    approvedAt: {
      type: Date,
      default: null,
    },

    revisionRequestedAt: {
      type: Date,
      default: null,
    },

    revisions: {
      type: [revisionSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    _id: true,
  }
);

const milestoneHistorySchema = new Schema(
  {
    influencerId: {
      type: Schema.Types.ObjectId,
      ref: "Influencer",
      required: true,
      index: true,
    },

    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },

    contractMongoId: {
      type: Schema.Types.ObjectId,
      ref: "Contract",
      default: null,
      index: true,
    },

    // Optional because admin-created milestones do not use contract.
    contractId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    adminId: {
      type: Schema.Types.ObjectId,
      ref: "Master",
      default: null,
      index: true,
    },

    createdByRole: {
      type: String,
      enum: ["brand", "admin", ""],
      default: "brand",
      trim: true,
      index: true,
    },

    createdByModel: {
      type: String,
      enum: ["Brand", "Master", "Admin", ""],
      default: "",
      trim: true,
    },

    milestoneTitle: {
      type: String,
      required: true,
      trim: true,
    },

    milestoneDescription: {
      type: String,
      default: "",
      trim: true,
    },

    milestoneBudget: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Existing release/admin payout code uses amount.
    amount: {
      type: Number,
      default: 0,
      min: 0,
    },

    attachments: {
      type: [attachmentSchema],
      default: [],
    },

    deliverables: {
      type: [deliverableSchema],
      default: [],
    },

    startDate: {
      type: Date,
      default: null,
    },

    endDate: {
      type: Date,
      default: null,
    },

    graceDays: {
      type: Number,
      default: 0,
      min: 0,
    },

    submissionLink: {
      type: String,
      default: "",
      trim: true,
    },

    needDraftFirst: {
      type: Boolean,
      default: false,
    },

    draftDate: {
      type: Date,
      default: null,
    },

    // 0 = influencer has not accepted milestone
    // 1 = influencer accepted milestone, brand/admin cannot edit locked flows
    isAccepted: {
      type: Number,
      enum: [0, 1],
      default: 0,
      index: true,
    },

    released: {
      type: Boolean,
      default: false,
    },

    releasedAt: {
      type: Date,
      default: null,
    },

    payoutStatus: {
      type: String,
      enum: ["pending", "initiated", "paid"],
      default: "pending",
      index: true,
    },

    paidAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const milestoneSchema = new Schema(
  {
    brandId: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
      index: true,
    },

    totalAmount: {
      type: Number,
      required: true,
      default: 0,
    },

    milestoneHistory: {
      type: [milestoneHistorySchema],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

milestoneSchema.index({ brandId: 1, createdAt: -1 });

milestoneSchema.index({
  "milestoneHistory.influencerId": 1,
  "milestoneHistory.campaignId": 1,
});

milestoneSchema.index({
  "milestoneHistory.contractId": 1,
});

milestoneSchema.index({
  "milestoneHistory.adminId": 1,
});

milestoneSchema.index({
  "milestoneHistory.createdByRole": 1,
});

milestoneSchema.index({
  "milestoneHistory.deliverables._id": 1,
});

milestoneSchema.index({
  "milestoneHistory.isAccepted": 1,
});

milestoneSchema.index({
  "milestoneHistory.payoutStatus": 1,
});

milestoneSchema.index({
  "milestoneHistory.deliverables.revisions._id": 1,
});

milestoneSchema.index({
  "milestoneHistory.deliverables.revisions.deliverableId": 1,
});

module.exports =
  mongoose.models.Milestone || mongoose.model("Milestone", milestoneSchema);