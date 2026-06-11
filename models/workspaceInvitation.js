const mongoose = require("mongoose");

const { Schema } = mongoose;

const workspaceInvitationSchema = new Schema(
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

    // Real owner/main brand id that owns this workspace.
    ownerBrandId: {
      type: String,
      default: "",
      index: true,
      trim: true,
    },

    // Same as brandId, explicit active workspace brand id.
    workspaceBrandId: {
      type: String,
      default: "",
      index: true,
      trim: true,
    },

    // Real owner/login email for display/audit.
    brandRealEmail: {
      type: String,
      default: "",
      lowercase: true,
      index: true,
      trim: true,
    },

    // Empty email means a generic share-link invitation.
    email: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
      index: true,
    },

    inviteType: {
      type: String,
      enum: ["email", "link"],
      default: "email",
      index: true,
    },

    role: {
      type: String,
      enum: [
        "admin",
        "marketing_manager",
        "campaign_manager",
        "finance_manager",
        "content_reviewer",
        "viewer",
        "agency_member",
      ],
      default: "admin",
      index: true,
    },

    accessType: {
      type: String,
      enum: ["full_access", "limited_access"],
      default: "full_access",
    },

    permissions: {
      type: Object,
      default: {},
    },

    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    status: {
      type: String,
      enum: ["pending", "accepted", "expired", "cancelled"],
      default: "pending",
      index: true,
    },

    invitedBy: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    acceptedBy: {
      type: String,
      default: "",
      trim: true,
    },

    acceptedCount: {
      type: Number,
      default: 0,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    acceptedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

workspaceInvitationSchema.index({ workspaceId: 1, email: 1, status: 1 });
workspaceInvitationSchema.index({ workspaceId: 1, inviteType: 1, status: 1 });
workspaceInvitationSchema.index({ email: 1, status: 1, expiresAt: 1 });

const WorkspaceInvitationModel =
  mongoose.models.WorkspaceInvitation ||
  mongoose.model("WorkspaceInvitation", workspaceInvitationSchema);

module.exports = WorkspaceInvitationModel;
module.exports.WorkspaceInvitationModel = WorkspaceInvitationModel;