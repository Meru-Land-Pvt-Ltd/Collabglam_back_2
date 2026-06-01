// models/MissingEmail.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const EMAIL_RX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;

const PLATFORM_ENUM = ['youtube'];

const YouTubeSchema = new mongoose.Schema(
  {
    channelId: { type: String, index: true },
    title: { type: String },
    handle: { type: String },
    urlByHandle: { type: String },
    urlById: { type: String },
    description: { type: String },
    country: { type: String },
    subscriberCount: { type: Number, min: 0 },
    videoCount: { type: Number, min: 0 },
    viewCount: { type: Number, min: 0 },
    topicCategories: [{ type: String }],
    topicCategoryLabels: [{ type: String }],
    fetchedAt: { type: Date },
  },
  { _id: false }
);

const MissingEmailSchema = new mongoose.Schema(
  {
    missingEmailId: {
      type: String,
      required: true,
      unique: true,
      default: uuidv4,
      index: true,
    },

    email: {
      type: String,
      required: false,
      lowercase: true,
      trim: true,
      default: null,
      validate: {
        validator: (v) => !v || EMAIL_RX.test(v),
        message: 'Invalid email address',
      },
    },

    handle: {
      type: String,
      required: [true, 'Handle is required'],
      lowercase: true,
      trim: true,
      validate: {
        validator: (v) => HANDLE_RX.test(v || ''),
        message:
          'Handle must start with "@" and contain letters, numbers, ".", "_" or "-"',
      },
    },

    platform: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      enum: {
        values: PLATFORM_ENUM,
        message: 'Platform must be youtube',
      },
      default: 'youtube',
    },

    status: {
      type: String,
      enum: ['pending', 'resolved'],
      default: 'pending',
      index: true,
    },

    youtube: {
      type: YouTubeSchema,
      default: undefined,
    },

    createdByAdminId: {
      type: String,
      index: true,
      default: null,
      ref: 'Admin',
    },
  },
  { timestamps: true }
);

MissingEmailSchema.index({ handle: 1 }, { unique: true });
MissingEmailSchema.index({ email: 1 }, { sparse: true });
MissingEmailSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.MissingEmail ||
  mongoose.model('MissingEmail', MissingEmailSchema);