const mongoose = require("mongoose");
const { Schema } = mongoose;

const MailContentSchema = new Schema(
  {
    provider: {
      type: String,
      default: "aws_ses",
      trim: true,
    },

    messageId: {
      type: String,
      default: null,
      trim: true,
    },

    from: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
    },

    to: {
      type: [String],
      default: [],
    },

    cc: {
      type: [String],
      default: [],
    },

    bcc: {
      type: [String],
      default: [],
    },

    replyTo: {
      type: [String],
      default: [],
    },

    subject: {
      type: String,
      default: null,
      trim: true,
    },

    text: {
      type: String,
      default: null,
    },

    html: {
      type: String,
      default: null,
    },

    inReplyTo: {
      type: String,
      default: null,
      trim: true,
    },

    references: {
      type: [String],
      default: [],
    },

    configurationSetName: {
      type: String,
      default: null,
      trim: true,
    },

    emailTags: {
      type: [Schema.Types.Mixed],
      default: [],
    },

    sentAt: {
      type: Date,
      default: null,
    },

    error: {
      type: String,
      default: null,
    },
  },
  { _id: false }
);

const CampaignInvitationSchema = new Schema(
  {
    brandId: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
      index: true,
    },

    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },

    influencerId: {
      type: Schema.Types.ObjectId,
      ref: "Influencer",
      required: true,
      index: true,
    },

    platform: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      index: true,
    },

    handle: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      index: true,
    },

    modashUserId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    missingEmailId: {
      type: String,
      default: null,
      trim: true,
    },

    emailTo: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
    },

    status: {
      type: String,
      enum: ["sent", "accepted", "failed", "reject"],
      default: "sent",
      index: true,
    },

    sentAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    failReason: {
      type: String,
      default: null,
      trim: true,
    },

    aiScore: {
      type: Number,
      default: null,
      min: 0,
      max: 100,
    },

    rawAiScore: {
      type: Number,
      default: null,
    },

    recommendationReason: {
      type: String,
      default: "",
      trim: true,
    },

    recommendationMeta: {
      source: {
        type: String,
        default: "campaign_recommendation",
        trim: true,
      },

      campaignMatchReason: {
        type: String,
        default: "",
        trim: true,
      },

      matchedCategories: {
        type: [String],
        default: [],
      },

      matchedPlatforms: {
        type: [String],
        default: [],
      },

      scoreBreakdown: {
        type: Schema.Types.Mixed,
        default: null,
      },
    },

    createdByAdminId: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
      index: true,
    },

    mailContent: {
      type: MailContentSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  }
);

CampaignInvitationSchema.index(
  {
    brandId: 1,
    campaignId: 1,
    influencerId: 1,
  },
  {
    unique: true,
  }
);

CampaignInvitationSchema.index({
  campaignId: 1,
  status: 1,
  createdAt: -1,
});

CampaignInvitationSchema.index({
  brandId: 1,
  status: 1,
  createdAt: -1,
});

CampaignInvitationSchema.index({
  influencerId: 1,
  status: 1,
  createdAt: -1,
});

CampaignInvitationSchema.index({
  modashUserId: 1,
  platform: 1,
});

module.exports =
  mongoose.models.CampaignInvitation ||
  mongoose.model("CampaignInvitation", CampaignInvitationSchema);