const mongoose = require("mongoose");

const { Schema } = mongoose;

const workspaceSchema = new Schema(
  {
    // Active workspace brand id. For default workspace this is the main brand id. For extra workspaces this is a workspace-specific cloned brand id.
    brandId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    // Real owner/main brand account id. This never changes when workspace brandId is cloned.
    ownerBrandId: {
      type: String,
      default: "",
      index: true,
      trim: true,
    },

    // Real owner/login email. Workspace clone brand may use internal unique email.
    brandRealEmail: {
      type: String,
      default: "",
      lowercase: true,
      index: true,
      trim: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    logo: {
      type: String,
      default: "",
      trim: true,
    },

    status: {
      type: String,
      enum: ["active", "suspended", "archived", "deleted"],
      default: "active",
      index: true,
    },

    createdBy: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },

    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        ret.workspaceId = String(ret._id);
        return ret;
      },
    },
    toObject: {
      transform(_doc, ret) {
        ret.workspaceId = String(ret._id);
        return ret;
      },
    },
  }
);

workspaceSchema.index({ brandId: 1, status: 1, createdAt: -1 });
workspaceSchema.index({ ownerBrandId: 1, status: 1, createdAt: -1 });
workspaceSchema.index({ createdBy: 1, status: 1, createdAt: -1 });

const WorkspaceModel =
  mongoose.models.Workspace || mongoose.model("Workspace", workspaceSchema);

module.exports = WorkspaceModel;
module.exports.WorkspaceModel = WorkspaceModel;