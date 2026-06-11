const mongoose = require("mongoose");

const { Schema } = mongoose;

const workspaceActivitySchema = new Schema(
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

    action: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    module: {
      type: String,
      enum: [
        "workspace",
        "campaign",
        "application",
        "contract",
        "deliverable",
        "payment",
        "report",
        "team",
        "settings",
      ],
      required: true,
      index: true,
    },

    performedBy: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    performedRole: {
      type: String,
      default: "",
      trim: true,
    },

    message: {
      type: String,
      default: "",
      trim: true,
    },

    metadata: {
      type: Object,
      default: {},
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

workspaceActivitySchema.index({ workspaceId: 1, createdAt: -1 });

const WorkspaceActivityModel =
  mongoose.models.WorkspaceActivity ||
  mongoose.model("WorkspaceActivity", workspaceActivitySchema);

module.exports = WorkspaceActivityModel;
module.exports.WorkspaceActivityModel = WorkspaceActivityModel;