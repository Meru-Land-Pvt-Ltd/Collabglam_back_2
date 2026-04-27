const { Schema, model } = require("mongoose");
const {
  PROSPECT_STAGE,
  OWNER_ROLE,
} = require("../constants/outreach");

const ProspectBrandSchema = new Schema(
  {
    companyName: { type: String, required: true, trim: true },
    domain: { type: String, trim: true, lowercase: true, default: "" },
    website: { type: String, trim: true, default: "" },

    primaryContact: {
      name: { type: String, trim: true, default: "" },
      email: { type: String, trim: true, lowercase: true, required: true },
      title: { type: String, trim: true, default: "" },
      linkedinUrl: { type: String, trim: true, default: "" },
      phone: { type: String, trim: true, default: "" },
    },

    source: {
      type: String,
      enum: ["manual", "csv", "import", "api"],
      default: "manual",
    },

    notes: { type: String, trim: true, default: "" },
    tags: { type: [String], default: [] },

    customFields: {
      type: Map,
      of: Schema.Types.Mixed,
      default: {},
    },

    templateVariables: {
      type: Map,
      of: String,
      default: {},
    },

    csvMeta: {
      headers: { type: [String], default: [] },
      mappedAt: { type: Date, default: null },
      sourceFileName: { type: String, default: "" },
    },

    sdrId: { type: Schema.Types.ObjectId, ref: "Master", default: null },
    RHId: { type: Schema.Types.ObjectId, ref: "Master", default: null },
    preAssignedBmeId: { type: Schema.Types.ObjectId, ref: "Master", default: null },
    assignedBmeId: { type: Schema.Types.ObjectId, ref: "Master", default: null },
    assignedImeId: { type: Schema.Types.ObjectId, ref: "Master", default: null },

    flowType: {
      type: String,
      enum: ["standard_brand", "ime_influencer"],
      default: "standard_brand",
    },

    contactType: {
      type: String,
      enum: ["brand", "influencer"],
      default: "brand",
    },

    currentOwnerRole: {
      type: String,
      enum: Object.values(OWNER_ROLE),
      default: OWNER_ROLE.SDR,
    },

    currentOwnerId: { type: Schema.Types.ObjectId, ref: "Master", default: null },

    stage: {
      type: String,
      enum: Object.values(PROSPECT_STAGE),
      default: PROSPECT_STAGE.NEW,
    },

    sdrWriteLocked: { type: Boolean, default: false },

    instantly: {
      workspaceId: { type: String, default: "" },
      campaignId: { type: String, default: "" },
      leadListId: { type: String, default: "" },
      leadId: { type: String, default: "" },
      threadId: { type: String, default: "" },
      lastEmailId: { type: String, default: "" },
      lastSequenceStep: { type: String, default: "" },
      senderAccountEmail: { type: String, default: "" },
    },

    reply: {
      received: { type: Boolean, default: false },
      firstReplyAt: { type: Date, default: null },
      lastReplyAt: { type: Date, default: null },
      snippet: { type: String, default: "" },
      subject: { type: String, default: "" },
      classification: {
        type: String,
        enum: ["unknown", "interested", "not_interested", "wrong_person", "meeting_request"],
        default: "unknown",
      },
    },

    launchedAt: { type: Date, default: null },
    qualifiedAt: { type: Date, default: null },
    handedOffAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },

    convertedBrandId: { type: Schema.Types.ObjectId, ref: "Brand", default: null },
  },
  { timestamps: true }
);

ProspectBrandSchema.index({ "primaryContact.email": 1 }, { unique: true });
ProspectBrandSchema.index({ domain: 1 });
ProspectBrandSchema.index({ sdrId: 1, stage: 1 });
ProspectBrandSchema.index({ RHId: 1, stage: 1 });
ProspectBrandSchema.index({ assignedBmeId: 1, stage: 1 });
ProspectBrandSchema.index({ currentOwnerId: 1, currentOwnerRole: 1 });
ProspectBrandSchema.index({ "instantly.leadId": 1 });
ProspectBrandSchema.index({ "instantly.campaignId": 1 });

module.exports = model("ProspectBrand", ProspectBrandSchema);