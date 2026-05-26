const mongoose = require("mongoose");

const errorLogSchema = new mongoose.Schema(
  {
    message: {
      type: String,
      required: true,
    },

    name: {
      type: String,
      default: "Error",
    },

    statusCode: {
      type: Number,
      default: 500,
    },

    errorCode: {
      type: String,
      default: null,
    },

    stack: {
      type: String,
    },

    method: {
      type: String,
    },

    url: {
      type: String,
    },

    ip: {
      type: String,
    },

    userAgent: {
      type: String,
    },

    role: {
      type: String,
      default: null,
    },

    adminId: {
      type: String,
      default: null,
    },

    brandId: {
      type: String,
      default: null,
    },

    influencerId: {
      type: String,
      default: null,
    },

    actorEmail: {
      type: String,
      default: null,
    },

    tokenAvailable: {
      type: Boolean,
      default: false,
    },

    userId: {
      type: String,
      default: null,
    },

    requestBody: {
      type: Object,
      default: {},
    },

    requestParams: {
      type: Object,
      default: {},
    },

    requestQuery: {
      type: Object,
      default: {},
    },

    environment: {
      type: String,
      default: process.env.NODE_ENV || "development",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("ErrorLog", errorLogSchema);