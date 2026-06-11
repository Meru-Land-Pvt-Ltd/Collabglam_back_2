const mongoose = require("mongoose");

const { Schema } = mongoose;

const permissionSchema = new Schema(
  {
    campaigns: {
      view: { type: Boolean, default: false },
      create: { type: Boolean, default: false },
      update: { type: Boolean, default: false },
      delete: { type: Boolean, default: false },
    },

    influencers: {
      view: { type: Boolean, default: false },
      manage: { type: Boolean, default: false },
    },

    contracts: {
      view: { type: Boolean, default: false },
      create: { type: Boolean, default: false },
      update: { type: Boolean, default: false },
      approve: { type: Boolean, default: false },
    },

    deliverables: {
      view: { type: Boolean, default: false },
      review: { type: Boolean, default: false },
      approve: { type: Boolean, default: false },
    },

    payments: {
      view: { type: Boolean, default: false },
      manage: { type: Boolean, default: false },
      approve: { type: Boolean, default: false },
    },

    reports: {
      view: { type: Boolean, default: false },
    },

    team: {
      view: { type: Boolean, default: false },
      invite: { type: Boolean, default: false },
      remove: { type: Boolean, default: false },
      changeRole: { type: Boolean, default: false },
    },

    settings: {
      view: { type: Boolean, default: false },
      update: { type: Boolean, default: false },
    },
  },
  { _id: false }
);

const workspaceMemberSchema = new Schema(
  {
    workspaceId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    brandId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    userId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    email: {
      type: String,
      lowercase: true,
      trim: true,
      index: true,
      default: "",
    },

    role: {
      type: String,
      enum: [
        "owner",
        "admin",
        "marketing_manager",
        "campaign_manager",
        "finance_manager",
        "content_reviewer",
        "viewer",
        "agency_member",
      ],
      default: "viewer",
      index: true,
    },

    accessType: {
      type: String,
      enum: ["full_access", "limited_access"],
      default: "limited_access",
    },

    permissions: {
      type: permissionSchema,
      default: () => ({}),
    },

    status: {
      type: String,
      enum: ["pending", "accepted", "suspended", "removed"],
      default: "accepted",
      index: true,
    },

    invitedBy: {
      type: String,
      default: "",
      trim: true,
    },

    joinedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

workspaceMemberSchema.index(
  { workspaceId: 1, userId: 1 },
  { unique: true }
);
workspaceMemberSchema.index({ workspaceId: 1, email: 1 });

const WorkspaceMemberModel =
  mongoose.models.WorkspaceMember ||
  mongoose.model("WorkspaceMember", workspaceMemberSchema);

module.exports = WorkspaceMemberModel;
module.exports.WorkspaceMemberModel = WorkspaceMemberModel;