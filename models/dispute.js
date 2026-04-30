const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const ID_PREFIX = "ds";
const ID_DIGITS = 6;

const ISSUE_TYPE_ENUM = [
  "content_not_as_expected",
  "delay_or_missed_deadline",
  "payment_issue",
  "revision_issue",
  "agreement_issue",
  "scope_change",
  "no_response",
  "other",
];

// Generate a short incremental disputeId like "ds000001"
async function generateShortDisputeId(DisputeModel) {
  const last = await DisputeModel.findOne().sort({ createdAt: -1 }).lean();

  if (!last || !last.disputeId) {
    return ID_PREFIX + String(1).padStart(ID_DIGITS, "0");
  }

  const digitsMatch = String(last.disputeId).match(/(\d+)$/);
  const prevNum = digitsMatch ? parseInt(digitsMatch[1], 10) : 0;
  const nextNum = Math.max(0, prevNum) + 1;

  return ID_PREFIX + String(nextNum).padStart(ID_DIGITS, "0");
}

const attachmentSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    originalName: { type: String },
    mimeType: { type: String },
    size: { type: Number },
  },
  { _id: false }
);

const evidenceSchema = new mongoose.Schema(
  {
    evidenceId: { type: String, required: true, default: uuidv4 },
    evidenceName: { type: String, required: true, trim: true },
    notes: { type: String, default: "" },

    attachments: { type: [attachmentSchema], default: [] },

    createdBy: {
      role: {
        type: String,
        enum: ["Admin", "Brand", "Influencer"],
        required: true,
      },
      id: { type: String, required: true },
      name: { type: String, default: null },
    },

    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const commentSchema = new mongoose.Schema(
  {
    commentId: { type: String, required: true, default: uuidv4 },
    authorRole: {
      type: String,
      enum: ["Admin", "Brand", "Influencer"],
      required: true,
    },
    authorId: { type: String, required: true },
    text: { type: String, required: true },
    attachments: { type: [attachmentSchema], default: [] },

    parentCommentId: { type: String, default: null },
    threadRootCommentId: { type: String, default: null },

    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const disputeSchema = new mongoose.Schema(
  {
    disputeId: { type: String, required: true, unique: true },

    campaignId: {
      type: String,
      required: false,
      default: null,
      ref: "Campaign",
    },

    brandId: { type: String, required: true, ref: "Brand" },
    influencerId: { type: String, required: true, ref: "Influencer" },

    createdBy: {
      id: { type: String, required: true },
      role: {
        type: String,
        enum: ["Brand", "Influencer"],
        required: true,
      },
    },

    subject: { type: String, required: true },
    description: { type: String, default: "" },
    evidence: { type: [evidenceSchema], default: [] },
    issueType: {
      type: [
        {
          type: String,
          enum: ISSUE_TYPE_ENUM,
        },
      ],
      default: ["other"],
    },
    otherIssueDescription: {
      type: String,
      default: "",
      trim: true,
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },

    status: {
      type: String,
      enum: [
        "open",
        "in_review",
        "awaiting_user",
        "evidence_submitted",
        "in_negotiation",
        "resolution_proposed",
        "resolved",
        "rejected",
        "revoked",
      ],
      default: "open",
    },

    assignedTo: {
      adminId: { type: String, default: null },
      name: { type: String, default: null },
    },

    // Admin-specific hide list. This does not change dispute.status.
    // When an admin clicks "Not Interested", their adminId is stored here.
    adminNotInterested: {
      type: [String],
      default: [],
    },

    attachments: { type: [attachmentSchema], default: [] },

    comments: { type: [commentSchema], default: [] },
  },
  { timestamps: true }
);

disputeSchema.pre("validate", async function preValidate() {
  if (this.disputeId) return;
  const DisputeModel = this.constructor;
  this.disputeId = await generateShortDisputeId(DisputeModel);
});

disputeSchema.index({ brandId: 1, createdAt: -1 });
disputeSchema.index({ influencerId: 1, createdAt: -1 });
disputeSchema.index({ campaignId: 1, createdAt: -1 });
disputeSchema.index({ status: 1, createdAt: -1 });
disputeSchema.index({ adminNotInterested: 1, createdAt: -1 });

module.exports = mongoose.model("Dispute", disputeSchema);