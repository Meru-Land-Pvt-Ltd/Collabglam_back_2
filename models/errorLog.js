const mongoose = require("mongoose");

const errorLogSchema = new mongoose.Schema(
  {
    message: { type: String, default: "", index: true },
    name: { type: String, default: "Error", index: true },
    statusCode: { type: Number, default: 500, index: true },
    errorCode: { type: String, default: "INTERNAL_SERVER_ERROR", index: true },
    stack: { type: String, default: null },

    method: { type: String, default: null, index: true },
    url: { type: String, default: null, index: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },

    role: { type: String, default: null, index: true },
    adminId: { type: String, default: null, index: true },
    brandId: { type: String, default: null, index: true },
    influencerId: { type: String, default: null, index: true },
    actorEmail: { type: String, default: null, index: true },
    tokenAvailable: { type: Boolean, default: false },
    userId: { type: String, default: null, index: true },

    requestBody: { type: mongoose.Schema.Types.Mixed, default: {} },
    requestParams: { type: mongoose.Schema.Types.Mixed, default: {} },
    requestQuery: { type: mongoose.Schema.Types.Mixed, default: {} },

    environment: {
      type: String,
      default: process.env.NODE_ENV || "development",
      index: true,
    },

    // New fields
    isResolved: {
      type: Boolean,
      default: false,
      index: true,
    },

    priority: {
      type: String,
      enum: ["high", "medium", "low"],
      default: "medium",
      index: true,
    },
  },
  { timestamps: true }
);

errorLogSchema.index({ isResolved: 1, priority: 1, createdAt: -1 });
errorLogSchema.index({ errorCode: 1, statusCode: 1, createdAt: -1 });
errorLogSchema.index({ message: "text", errorCode: "text", url: "text", actorEmail: "text" });

module.exports = mongoose.models.ErrorLog || mongoose.model("ErrorLog", errorLogSchema);