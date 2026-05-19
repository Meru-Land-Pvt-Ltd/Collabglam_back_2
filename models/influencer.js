const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_FREE_PLAN_ID = "49ad0056-3d32-4543-b5da-db24b76dbd5a";

const NamedRefSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, required: false },
    name: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const subscriptionFeatureSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    value: { type: Schema.Types.Mixed, default: null },
    limit: { type: Number, required: true, default: 0 },
    used: { type: Number, default: 0 },
    note: { type: String, default: null, trim: true },
    resetsEvery: { type: String, default: null, trim: true },
    resetsAt: { type: Date, default: null },
  },
  { _id: false }
);

const internalCreditsSchema = new Schema(
  {
    used: { type: Number, default: 0 },
    resetsAt: { type: Date, default: null },
  },
  { _id: false }
);

const subscriptionSchema = new Schema(
  {
    planId: { type: String, required: true, default: DEFAULT_FREE_PLAN_ID },
    planName: { type: String, required: true, default: "free" },
    role: { type: String, enum: ["Brand", "Influencer"], default: "Influencer" },

    planRef: {
      type: Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      default: null,
    },

    monthlyCost: { type: Number, default: 0 },
    annualCost: { type: Number, default: 0 },

    billingCycle: {
      type: String,
      enum: ["monthly", "annual"],
      default: "monthly",
    },

    autoRenew: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "archived"], default: "active" },

    durationMins: { type: Number, default: 43200 },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },

    features: { type: [subscriptionFeatureSchema], default: [] },
    internalCredits: { type: internalCreditsSchema, default: () => ({}) },
  },
  { _id: false }
);

const InfluencerSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [emailRegex, "Invalid email"],
    },

    name: { type: String, trim: true, default: "" },

    countryId: { type: Schema.Types.ObjectId, ref: "Country", required: false },

    countryName: {
      type: String,
      required: [
        function requiredCountryName() {
          return !(this.isAdminCreated === true && this.signupCompleted === false);
        },
        "Country name is required",
      ],
      default: "",
      trim: true,
    },

    country: { type: String, default: "", trim: true },
    location: { type: String, default: "", trim: true },

    languages: { type: [NamedRefSchema], default: [] },
    categories: { type: [NamedRefSchema], default: [] },

    password: { type: String, select: false },

    primaryPlatform: { type: String, default: null, trim: true },

    page1: { type: [Schema.Types.Mixed], required: true, default: [] },
    page2: { type: [Schema.Types.Mixed], default: [] },
    page3: { type: [Schema.Types.Mixed], default: [] },

    ispage2Skip: { type: Boolean, default: false },
    ispage3Skip: { type: Boolean, default: false },

    proxyEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: undefined,
      validate: {
        validator(value) {
          return !value || emailRegex.test(value);
        },
        message: "Invalid proxy email",
      },
    },

    isAdminCreated: { type: Boolean, default: false },
    signupCompleted: { type: Boolean, default: true },

    createdByAdmin: { type: Schema.Types.ObjectId, ref: "Master", default: null },
    adminCreatedRole: { type: String, default: "", trim: true },
    adminCreatedAt: { type: Date, default: null },
    signupCompletedAt: { type: Date, default: null },

    subscription: { type: subscriptionSchema, default: () => ({}) },
    subscriptionExpired: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        delete ret.password;
        return ret;
      },
    },
    toObject: {
      transform(_doc, ret) {
        delete ret.password;
        return ret;
      },
    },
  }
);

InfluencerSchema.index(
  { proxyEmail: 1 },
  {
    unique: true,
    partialFilterExpression: { proxyEmail: { $type: "string", $ne: "" } },
  }
);

InfluencerSchema.index({ isAdminCreated: 1, signupCompleted: 1, createdAt: -1 });
InfluencerSchema.index({ createdByAdmin: 1, adminCreatedAt: -1 });

const InfluencerModel = models.Influencer || model("Influencer", InfluencerSchema);

module.exports = { InfluencerModel };