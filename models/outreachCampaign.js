const { Schema, model } = require("mongoose");
const { OUTREACH_CAMPAIGN_STATUS } = require("../constants/outreach");

const DayMapSchema = new Schema(
  {
    0: { type: Boolean, default: false },
    1: { type: Boolean, default: true },
    2: { type: Boolean, default: true },
    3: { type: Boolean, default: true },
    4: { type: Boolean, default: true },
    5: { type: Boolean, default: true },
    6: { type: Boolean, default: false },
  },
  { _id: false }
);

const CampaignScheduleWindowSchema = new Schema(
  {
    name: { type: String, default: "Default Weekday Schedule" },
    from: { type: String, default: "10:00" },
    to: { type: String, default: "18:00" },
    days: { type: DayMapSchema, default: () => ({}) },
  },
  { _id: false }
);

const CampaignVariantSchema = new Schema(
  {
    subject: { type: String, default: "" },
    body: { type: String, default: "" },
  },
  { _id: false }
);

const CampaignSequenceStepSchema = new Schema(
  {
    stepOrder: { type: Number, default: 1 },
    type: { type: String, enum: ["email"], default: "email" },
    delay: { type: Number, default: 1 },
    delayUnit: { type: String, enum: ["minutes", "hours", "days"], default: "days" },
    preDelay: { type: Number, default: 0 },
    preDelayUnit: { type: String, enum: ["minutes", "hours", "days"], default: "days" },
    variants: { type: [CampaignVariantSchema], default: [] },
  },
  { _id: false }
);

const CampaignSendingOptionsSchema = new Schema(
  {
    dailyLimit: { type: Number, default: 100 },
    dailyMaxLeads: { type: Number, default: 100 },
    emailGap: { type: Number, default: 10 },
    randomWaitMax: { type: Number, default: 10 },
    stopOnReply: { type: Boolean, default: true },
    stopOnAutoReply: { type: Boolean, default: false },
    linkTracking: { type: Boolean, default: true },
    openTracking: { type: Boolean, default: true },
    textOnly: { type: Boolean, default: false },
    firstEmailTextOnly: { type: Boolean, default: false },
    isEvergreen: { type: Boolean, default: false },
    prioritizeNewLeads: { type: Boolean, default: false },
    matchLeadEsp: { type: Boolean, default: false },
    stopForCompany: { type: Boolean, default: true },
    insertUnsubscribeHeader: { type: Boolean, default: false },
    allowRiskyContacts: { type: Boolean, default: false },
    disableBounceProtect: { type: Boolean, default: false },
    ccList: { type: [String], default: [] },
    bccList: { type: [String], default: [] },
  },
  { _id: false }
);

const CampaignConfigurationSchema = new Schema(
  {
    schedule: {
      timezone: { type: String, default: "Asia/Kolkata" },
      startDate: { type: String, default: "" },
      endDate: { type: String, default: "" },
      windows: { type: [CampaignScheduleWindowSchema], default: [] },
    },
    sequences: { type: [CampaignSequenceStepSchema], default: [] },
    sendingOptions: { type: CampaignSendingOptionsSchema, default: () => ({}) },
    lastSyncedAt: { type: Date, default: null },
    lastSyncedBy: { type: Schema.Types.ObjectId, ref: "Master", default: null },
  },
  { _id: false }
);

const TeamMailboxesSchema = new Schema(
  {
    RHEmail: { type: String, default: "" },
    IMEEmail: { type: String, default: "" },
  },
  { _id: false }
);

const CampaignStatsSchema = new Schema(
  {
    totalProspects: { type: Number, default: 0 },
    totalSent: { type: Number, default: 0 },
    totalClicked: { type: Number, default: 0 },
    totalReplies: { type: Number, default: 0 },
    totalOpportunities: { type: Number, default: 0 },
    totalQualified: { type: Number, default: 0 },
    totalAssigned: { type: Number, default: 0 },
    progressPercent: { type: Number, default: 0 },
  },
  { _id: false }
);

const CampaignSyncSchema = new Schema(
  {
    providerStatus: {
      type: String,
      enum: ["idle", "syncing", "synced", "error"],
      default: "idle",
    },
    lastErrorCode: { type: String, default: "" },
    lastErrorMessage: { type: String, default: "" },
    lastSyncedAt: { type: Date, default: null },
    lastAnalyticsSyncedAt: { type: Date, default: null },
  },
  { _id: false }
);

const InstantlyCampaignSchema = new Schema(
  {
    workspaceId: { type: String, default: "" },
    campaignId: { type: String, default: "" },
    leadListId: { type: String, default: "" },
    accountEmails: { type: [String], default: [] },
    senderAccountEmail: { type: String, default: "" },
    rawCampaignPayload: { type: Schema.Types.Mixed, default: null },
    shareLink: { type: String, default: "" },
  },
  { _id: false }
);

const OutreachCampaignSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },

    flowType: {
      type: String,
      enum: ["standard_brand", "ime_influencer"],
      default: "standard_brand",
    },

    sdrId: { type: Schema.Types.ObjectId, ref: "Master", default: null },
    RHId: { type: Schema.Types.ObjectId, ref: "Master", default: null },
    IMEId: { type: Schema.Types.ObjectId, ref: "Master", default: null },
    createdByAdminId: { type: Schema.Types.ObjectId, ref: "Master", required: true },

    status: {
      type: String,
      enum: Object.values(OUTREACH_CAMPAIGN_STATUS),
      default: OUTREACH_CAMPAIGN_STATUS.DRAFT,
    },

    prospectIds: [{ type: Schema.Types.ObjectId, ref: "ProspectBrand" }],

    configuration: {
      type: CampaignConfigurationSchema,
      default: () => ({
        schedule: {
          timezone: process.env.INSTANTLY_DEFAULT_TIMEZONE || "Asia/Kolkata",
          startDate: "",
          endDate: "",
          windows: [
            {
              name: "Default Weekday Schedule",
              from: "10:00",
              to: "18:00",
              days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false },
            },
          ],
        },
        sequences: [
          {
            stepOrder: 1,
            type: "email",
            delay: 1,
            delayUnit: "days",
            preDelay: 0,
            preDelayUnit: "days",
            variants: [
              {
                subject: { type: String, default: "" },
                body: { type: String, default: "" },
                attachments: {
                  type: [
                    {
                      id: { type: String, default: "" },
                      name: { type: String, default: "" },
                      url: { type: String, default: "" },
                      mimeType: { type: String, default: "" },
                      size: { type: Number, default: 0 },
                      kind: {
                        type: String,
                        enum: ["image", "file"],
                        default: "file",
                      },
                    },
                  ],
                  default: [],
                },
              },
            ]
          },
        ],
        sendingOptions: {},
      }),
    },

    instantly: {
      type: InstantlyCampaignSchema,
      default: () => ({}),
    },

    teamMailboxes: {
      type: TeamMailboxesSchema,
      default: () => ({}),
    },

    stats: {
      type: CampaignStatsSchema,
      default: () => ({}),
    },

    templateVariables: {
      type: [String],
      default: [],
    },

    csvSchema: {
      fileName: { type: String, default: "" },
      totalRows: { type: Number, default: 0 },
      columns: {
        type: [
          {
            header: { type: String, default: "" },
            variableKey: { type: String, default: "" },
            inferredType: { type: String, default: "custom" },
            selectedType: { type: String, default: "custom" },
            samples: { type: [String], default: [] },
          },
        ],
        default: [],
      },
      updatedAt: { type: Date, default: null },
    },

    sync: {
      type: CampaignSyncSchema,
      default: () => ({}),
    },

    launchValidatedAt: { type: Date, default: null },
    launchedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

OutreachCampaignSchema.index({ flowType: 1, status: 1, createdAt: -1 });
OutreachCampaignSchema.index({ sdrId: 1, status: 1, createdAt: -1 });
OutreachCampaignSchema.index({ RHId: 1, status: 1, createdAt: -1 });
OutreachCampaignSchema.index({ IMEId: 1, status: 1, createdAt: -1 });
OutreachCampaignSchema.index({ "instantly.campaignId": 1 });
OutreachCampaignSchema.index({ "sync.providerStatus": 1, createdAt: -1 });

module.exports = model("OutreachCampaign", OutreachCampaignSchema);