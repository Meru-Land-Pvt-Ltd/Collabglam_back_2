// models/NewInvitations.js
"use strict";

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
  },
  {
    timestamps: true,
  }
);

/**
 * Important:
 * Do NOT add unique index on:
 * - brandId + handle + platform
 * - brandId + campaignId + handle + platform
 *
 * This lets your controller decide:
 * - same campaign = exists
 * - different campaign = create new invitation
 */

InvitationSchema.index({ brandId: 1, campaignId: 1 });
InvitationSchema.index({ brandId: 1, handle: 1, platform: 1 });
InvitationSchema.index({ brandId: 1, campaignId: 1, handle: 1, platform: 1 });
InvitationSchema.index({ brandId: 1, userId: 1 });
InvitationSchema.index({ brandId: 1, modashUserId: 1 });
InvitationSchema.index({ brandId: 1, campaignId: 1, status: 1 });
InvitationSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.Invitations ||
  mongoose.models.Invitation ||
  mongoose.model("Invitations", InvitationSchema);