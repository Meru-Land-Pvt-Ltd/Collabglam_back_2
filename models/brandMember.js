const mongoose = require("mongoose");

const { Schema } = mongoose;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PERMISSION_RESOURCES = [
  "campaigns",
  "influencers",
  "deliverables_milestones",
  "payments_contracts",
  "team_invitations",
  "inbox_communication",
];

const ACCESS_TYPES = ["full", "limited", "custom"];
const ACCESS_LEVELS = ["none", "view", "edit"];
const MEMBER_STATUSES = ["active", "inactive", "invited", "removed"];

const permissionSchema = new Schema(
  {
    key: {
      type: String,
      enum: PERMISSION_RESOURCES,
      required: true,
    },
    level: {
      type: String,
      enum: ACCESS_LEVELS,
      default: "none",
    },
  },
  { _id: false }
);

const brandMemberSchema = new Schema(
  {
    brandId: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
      index: true,
    },

    memberBrandId: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
      default: null,
      index: true,
    },

    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: [emailRegex, "Invalid email"],
    },

    name: {
      type: String,
      default: "",
      trim: true,
    },

    profilePic: {
      type: String,
      default: "",
      trim: true,
    },

    accessType: {
      type: String,
      enum: ACCESS_TYPES,
      default: "limited",
    },

    permissions: {
      type: [permissionSchema],
      default: [],
    },

    status: {
      type: String,
      enum: MEMBER_STATUSES,
      default: "active",
    },

    invitedBy: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
      default: null,
    },

    invitedAt: {
      type: Date,
      default: null,
    },

    inviteSentAt: {
      type: Date,
      default: null,
    },

    joinedAt: {
      type: Date,
      default: null,
    },

    removedAt: {
      type: Date,
      default: null,
    },

    removedBy: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
      default: null,
    },

    ownershipTransferredAt: {
      type: Date,
      default: null,
    },

    ownershipTransferredBy: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

brandMemberSchema.index({ brandId: 1, email: 1 }, { unique: true });
brandMemberSchema.index({ brandId: 1, status: 1 });
brandMemberSchema.index({ memberBrandId: 1, status: 1 });
brandMemberSchema.index({ email: 1, status: 1 });

const BrandMember =
  mongoose.models.BrandMember ||
  mongoose.model("BrandMember", brandMemberSchema);

module.exports = BrandMember;
module.exports.BrandMember = BrandMember;