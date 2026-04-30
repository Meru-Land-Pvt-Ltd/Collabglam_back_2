const { Schema, model } = require("mongoose");
const { OWNER_ROLE } = require("../constants/outreach");

const OutreachMailboxAssignmentSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },

    displayName: {
      type: String,
      default: "",
      trim: true,
    },

    mailboxName: {
      type: String,
      default: "",
      trim: true,
    },

    senderName: {
      type: String,
      default: "",
      trim: true,
    },

    role: {
      type: String,
      enum: Object.values(OWNER_ROLE),
      required: true,
    },

    adminId: {
      type: Schema.Types.ObjectId,
      ref: "Master",
      required: true,
    },

    provider: {
      type: String,
      enum: ["google", "microsoft", "unknown"],
      default: "unknown",
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    isPrimary: {
      type: Boolean,
      default: false,
    },

    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "Master",
      default: null,
    },

    assignedAt: {
      type: Date,
      default: Date.now,
    },

    unassignedAt: {
      type: Date,
      default: null,
    },

    instantlyMeta: {
      status: { type: Number, default: null },
      warmupStatus: { type: Number, default: null },
      dailyLimit: { type: Number, default: null },
      warmupScore: { type: Number, default: null },
    },
  },
  { timestamps: true }
);

OutreachMailboxAssignmentSchema.index({ adminId: 1, role: 1, isActive: 1 });
OutreachMailboxAssignmentSchema.index({ role: 1, isActive: 1 });
OutreachMailboxAssignmentSchema.index({ adminId: 1, role: 1, isPrimary: -1, assignedAt: 1 });

OutreachMailboxAssignmentSchema.index(
  { adminId: 1, role: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isActive: true,
      role: { $in: [OWNER_ROLE.REVENUE_HEAD, OWNER_ROLE.BME] },
    },
  }
);

OutreachMailboxAssignmentSchema.index(
  { adminId: 1, role: 1, isPrimary: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isActive: true,
      role: { $in: [OWNER_ROLE.SDR, OWNER_ROLE.IME] },
      isPrimary: true,
    },
  }
);

module.exports = model("OutreachMailboxAssignment", OutreachMailboxAssignmentSchema);