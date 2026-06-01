// models/NewInvitations.js
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;
const PLATFORM_ENUM = ["youtube", "instagram", "tiktok"];
const STATUS_ENUM = ["invited", "available"];

const InvitationSchema = new mongoose.Schema(
  {
    invitationId: {
      type: String,
      required: true,
      unique: true,
      default: uuidv4,
      index: true,
    },

    handle: {
      type: String,
      required: [true, "Handle is required"],
      trim: true,
      lowercase: true,
      set: (v) => {
        if (!v) return v;
        const t = String(v).trim().toLowerCase();
        return t.startsWith("@") ? t : `@${t}`;
      },
      validate: {
        validator: (v) => HANDLE_RX.test(v || ""),
        message:
          'Handle must start with "@" and contain letters, numbers, ".", "_" or "-"',
      },
    },

    platform: {
      type: String,
      required: [true, "Platform is required"],
      trim: true,
      lowercase: true,
      enum: {
        values: PLATFORM_ENUM,
        message: "Platform must be one of: youtube, instagram, tiktok",
      },
    },

    userId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    modashUserId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    brandId: {
      type: String,
      required: [true, "brandId is required"],
      index: true,
      ref: "Brand",
    },

    campaignId: {
      type: String,
      required: [true, "campaignId is required"],
      index: true,
      ref: "Campaign",
    },

    status: {
      type: String,
      required: true,
      enum: {
        values: STATUS_ENUM,
        message: "Status must be one of: invited, available",
      },
      default: "invited",
      index: true,
    },

    missingEmailId: {
      type: String,
      default: null,
      index: true,
      ref: "MissingEmail",
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
    emailTo: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },

    emailFrom: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },

    emailSubject: {
      type: String,
      default: "",
      trim: true,
    },

    emailMessageId: {
      type: String,
      default: null,
      trim: true,
    },

    emailSentAt: {
      type: Date,
      default: null,
    },

    followUpEmailTo: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },

    followUpEmailFrom: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },

    followUpSubject: {
      type: String,
      default: "",
      trim: true,
    },

    followUpMessageId: {
      type: String,
      default: null,
      trim: true,
    },

    followUpSentAt: {
      type: Date,
      default: null,
      index: true,
    },

    permanentCampaignLock: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);


InvitationSchema.index({ brandId: 1, campaignId: 1 });
InvitationSchema.index({ brandId: 1, handle: 1, platform: 1 });
InvitationSchema.index({ brandId: 1, campaignId: 1, handle: 1, platform: 1 });
InvitationSchema.index({ brandId: 1, userId: 1 });
InvitationSchema.index({ brandId: 1, modashUserId: 1 });
InvitationSchema.index({ brandId: 1, campaignId: 1, status: 1 });
InvitationSchema.index({ createdAt: -1 });
InvitationSchema.index({ brandId: 1, campaignId: 1, handle: 1, platform: 1, permanentCampaignLock: 1 });
InvitationSchema.index({ followUpSentAt: -1 });

module.exports =
  mongoose.models.Invitations ||
  mongoose.models.Invitation ||
  mongoose.model("Invitations", InvitationSchema);