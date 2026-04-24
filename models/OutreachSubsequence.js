const { Schema, model } = require("mongoose");

const SubsequenceStepSchema = new Schema(
  {
    stepOrder: { type: Number, required: true },
    type: { type: String, enum: ["email"], default: "email" },
    delay: { type: Number, default: 0 },
    delayUnit: { type: String, enum: ["minutes", "hours", "days"], default: "days" },
    variants: {
      type: [
        {
          subject: { type: String, default: "" },
          body: { type: String, default: "" },
        },
      ],
      default: [{ subject: "", body: "" }],
    },
  },
  { _id: false }
);

const OutreachSubsequenceSchema = new Schema(
  {
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "OutreachCampaign",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["draft", "launched", "paused", "completed"],
      default: "draft",
    },

    trigger: {
      statuses: { type: [String], default: [] },
      activities: { type: [String], default: [] },
      phrases: { type: [String], default: [] },
    },

    scheduleMode: {
      type: String,
      enum: ["inherit", "custom"],
      default: "inherit",
    },

    schedule: {
      timezone: { type: String, default: "Asia/Kolkata" },
      startDate: { type: String, default: "" },
      endDate: { type: String, default: "" },
      windows: {
        type: [
          {
            name: { type: String, default: "Default Schedule" },
            from: { type: String, default: "10:00" },
            to: { type: String, default: "18:00" },
            days: { type: Schema.Types.Mixed, default: {} },
          },
        ],
        default: [],
      },
    },

    dailyLimitMode: {
      type: String,
      enum: ["inherit", "custom", "none"],
      default: "inherit",
    },
    dailyLimit: { type: Number, default: 0 },
    ignoreAccountDailyLimits: { type: Boolean, default: false },

    sequences: {
      type: [SubsequenceStepSchema],
      default: [
        {
          stepOrder: 1,
          type: "email",
          delay: 0,
          delayUnit: "days",
          variants: [{ subject: "", body: "" }],
        },
      ],
    },

    instantly: {
      subsequenceId: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

OutreachSubsequenceSchema.index({ campaignId: 1, createdAt: -1 });

module.exports = model("OutreachSubsequence", OutreachSubsequenceSchema);