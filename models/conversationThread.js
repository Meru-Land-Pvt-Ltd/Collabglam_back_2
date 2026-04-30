const { Schema, model } = require("mongoose");
const {
  THREAD_STATUS,
  OWNER_ROLE,
  MESSAGE_DIRECTION,
} = require("../constants/outreach");

const ConversationMailboxesSchema = new Schema(
  {
    // Mailbox used when the original campaign/sequence email was sent.
    campaignSenderEmail: { type: String, default: "", trim: true, lowercase: true },
    campaignSenderName: { type: String, default: "", trim: true },

    // Mailbox that should currently reply in this thread.
    currentReplyFromEmail: { type: String, default: "", trim: true, lowercase: true },
    currentReplyFromName: { type: String, default: "", trim: true },

    // Revenue Head mailbox.
    RHEmail: { type: String, default: "", trim: true, lowercase: true },
    RHName: { type: String, default: "", trim: true },

    // BME mailbox.
    bmeEmail: { type: String, default: "", trim: true, lowercase: true },
    bmeName: { type: String, default: "", trim: true },

    // IME mailbox.
    imeEmail: { type: String, default: "", trim: true, lowercase: true },
    imeName: { type: String, default: "", trim: true },
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

    instantlyThreadId: {
      type: String,
      default: "",
      trim: true,
    },

    instantlyCampaignId: {
      type: String,
      default: "",
      trim: true,
    },

    mailboxes: {
      type: ConversationMailboxesSchema,
      default: () => ({}),
    },

    subject: {
      type: String,
      default: "",
      trim: true,
    },

    // Kept for backward compatibility with existing controllers/UI.
    brandEmail: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },

    brandName: {
      type: String,
      default: "",
      trim: true,
    },

    status: {
      type: String,
      enum: Object.values(THREAD_STATUS),
      default: THREAD_STATUS.OPEN,
    },

    handoffAt: {
      type: Date,
      default: null,
    },

    lastMessageAt: {
      type: Date,
      default: null,
    },

    lastInboundAt: {
      type: Date,
      default: null,
    },

    lastOutboundAt: {
      type: Date,
      default: null,
    },

    unreadForRevenueHead: {
      type: Boolean,
      default: false,
    },

    unreadForBme: {
      type: Boolean,
      default: false,
    },

    unreadForIme: {
      type: Boolean,
      default: false,
    },
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
ConversationThreadSchema.index({ campaignId: 1 });
ConversationThreadSchema.index({ instantlyThreadId: 1 });
ConversationThreadSchema.index({ instantlyCampaignId: 1 });
ConversationThreadSchema.index({ lastMessageAt: -1 });

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

    providerMessageId: {
      type: String,
      default: "",
      trim: true,
    },

    providerThreadId: {
      type: String,
      default: "",
      trim: true,
    },

    /*
      Important:
      Store exact email + display name per message.

      Do not rely only on thread owner/admin name because the actual mailbox
      can be different. Example:
      from: khushikumari@collabglam.com
      fromName: Khushi Kumari

      This fixes wrong display like "Aditya Kumar" when the mail was actually
      sent/received through Khushi Kumari's mailbox.
    */
    from: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },

    fromName: {
      type: String,
      default: "",
      trim: true,
    },

    to: {
      type: [String],
      default: [],
      set: (values) =>
        Array.isArray(values)
          ? values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
          : [],
    },

    toNames: {
      type: [String],
      default: [],
      set: (values) =>
        Array.isArray(values)
          ? values.map((value) => String(value || "").trim()).filter(Boolean)
          : [],
    },

    cc: {
      type: [String],
      default: [],
      set: (values) =>
        Array.isArray(values)
          ? values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
          : [],
    },

    ccNames: {
      type: [String],
      default: [],
      set: (values) =>
        Array.isArray(values)
          ? values.map((value) => String(value || "").trim()).filter(Boolean)
          : [],
    },

    bcc: {
      type: [String],
      default: [],
      set: (values) =>
        Array.isArray(values)
          ? values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
          : [],
    },

    bccNames: {
      type: [String],
      default: [],
      set: (values) =>
        Array.isArray(values)
          ? values.map((value) => String(value || "").trim()).filter(Boolean)
          : [],
    },

    subject: {
      type: String,
      default: "",
      trim: true,
    },

    bodyText: {
      type: String,
      default: "",
    },

    bodyHtml: {
      type: String,
      default: "",
    },

    repliedByAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Master",
      default: null,
    },

    sentAt: {
      type: Date,
      default: null,
    },

    receivedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

ConversationMessageSchema.index({ threadId: 1, createdAt: 1 });
ConversationMessageSchema.index({ prospectId: 1, createdAt: -1 });
ConversationMessageSchema.index({ providerMessageId: 1 });
ConversationMessageSchema.index({ providerThreadId: 1 });
ConversationMessageSchema.index({ from: 1 });
ConversationMessageSchema.index({ to: 1 });

const ConversationThread = model("ConversationThread", ConversationThreadSchema);
const ConversationMessage = model(
  "ConversationMessage",
  ConversationMessageSchema
);

module.exports = {
  ConversationThread,
  ConversationMessage,
};