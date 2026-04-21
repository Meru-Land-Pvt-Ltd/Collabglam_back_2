const { Schema, model } = require("mongoose");
const {
  THREAD_STATUS,
  OWNER_ROLE,
  MESSAGE_DIRECTION,
} = require("../constants/outreach");

const ConversationMailboxesSchema = new Schema(
  {
    campaignSenderEmail: { type: String, default: "" },
    currentReplyFromEmail: { type: String, default: "" },
    RHEmail: { type: String, default: "" },
    bmeEmail: { type: String, default: "" },
    imeEmail: { type: String, default: "" },
  },
  { _id: false }
);

const ConversationThreadSchema = new Schema(
  {
    prospectId: {
      type: Schema.Types.ObjectId,
      ref: "ProspectBrand",
      required: true,
    },
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "OutreachCampaign",
      default: null,
    },
    brandId: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
      default: null,
    },

    ownerRole: {
      type: String,
      enum: Object.values(OWNER_ROLE),
      required: true,
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "Master",
      required: true,
    },

    instantlyThreadId: { type: String, default: "" },
    instantlyCampaignId: { type: String, default: "" },

    mailboxes: {
      type: ConversationMailboxesSchema,
      default: () => ({}),
    },

    subject: { type: String, default: "" },

    // Kept as-is for backward compatibility with existing controllers/UI.
    brandEmail: { type: String, default: "" },
    brandName: { type: String, default: "" },

    status: {
      type: String,
      enum: Object.values(THREAD_STATUS),
      default: THREAD_STATUS.OPEN,
    },

    handoffAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null },
    lastInboundAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },

    unreadForRevenueHead: { type: Boolean, default: false },
    unreadForBme: { type: Boolean, default: false },
    unreadForIme: { type: Boolean, default: false },
  },
  { timestamps: true }
);

ConversationThreadSchema.index({
  ownerRole: 1,
  ownerId: 1,
  status: 1,
  updatedAt: -1,
});
ConversationThreadSchema.index({ prospectId: 1 });
ConversationThreadSchema.index({ instantlyThreadId: 1 });

const ConversationMessageSchema = new Schema(
  {
    threadId: {
      type: Schema.Types.ObjectId,
      ref: "ConversationThread",
      required: true,
    },
    prospectId: {
      type: Schema.Types.ObjectId,
      ref: "ProspectBrand",
      required: true,
    },

    direction: {
      type: String,
      enum: Object.values(MESSAGE_DIRECTION),
      required: true,
    },

    provider: {
      type: String,
      enum: ["instantly"],
      default: "instantly",
    },
    providerMessageId: { type: String, default: "" },
    providerThreadId: { type: String, default: "" },

    from: { type: String, default: "" },
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    bcc: { type: [String], default: [] },

    subject: { type: String, default: "" },
    bodyText: { type: String, default: "" },
    bodyHtml: { type: String, default: "" },

    repliedByAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Master",
      default: null,
    },
    sentAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ConversationMessageSchema.index({ threadId: 1, createdAt: 1 });
ConversationMessageSchema.index({ providerMessageId: 1 });

const ConversationThread = model("ConversationThread", ConversationThreadSchema);
const ConversationMessage = model("ConversationMessage", ConversationMessageSchema);

module.exports = {
  ConversationThread,
  ConversationMessage,
};