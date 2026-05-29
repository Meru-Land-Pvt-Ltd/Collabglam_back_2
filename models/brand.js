const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const { Schema } = mongoose;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_FREE_PLAN_ID = "4c6e497d-a6f9-4c3b-8d64-65bf843be685";

const AUTH_PROVIDERS = ["password", "google"];


const workspaceUserSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: [emailRegex, "Invalid email"],
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
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
    role: { type: String, enum: ["Brand", "Influencer"], default: "Brand" },

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

function isPendingAdminCreatedBrand(doc) {
  return doc?.isAdminCreated === true && doc?.signupCompleted === false;
}

function isGoogleProvider(doc) {
  const authProvider = String(doc?.authProvider || "").toLowerCase();
  const provider = String(doc?.provider || "").toLowerCase();

  return authProvider === "google" || provider === "google";
}

const brandSchema = new Schema(
  {
    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      match: [emailRegex, "Invalid email"],
    },

    brandName: {
      type: String,
      required: [true, "Brand name is required"],
      trim: true,
    },

    name: {
      type: String,
      default: "",
      trim: true,
    },

    companySize: {
      type: String,
      default: "",
      trim: true,
    },

    pocContact: {
      type: String,
      default: "",
      trim: true,
    },

    website: {
      type: String,
      default: "",
      trim: true,
    },

    companyDetails: {
      type: String,
      default: "",
      trim: true,
    },

    timeZone: {
      type: String,
      default: "GMT+5:30 Indian standard time",
      trim: true,
    },

    currencyFormat: {
      type: String,
      default: "$ Dollars",
      trim: true,
    },

    region: {
      type: String,
      default: "All",
      trim: true,
    },

    preferredLanguage: {
      type: String,
      default: "English",
      trim: true,
    },

    industry: {
      type: String,
      required: [
        function requiredIndustry() {
          return !isPendingAdminCreatedBrand(this);
        },
        "Industry is required",
      ],
      default: "",
      trim: true,
    },

    authProvider: {
      type: String,
      enum: AUTH_PROVIDERS,
      default: "password",
      trim: true,
      lowercase: true,
    },

    provider: {
      type: String,
      enum: AUTH_PROVIDERS,
      default: "password",
      trim: true,
      lowercase: true,
    },

    googleId: {
      type: String,
      default: undefined,
      trim: true,
    },

    googleSub: {
      type: String,
      default: undefined,
      trim: true,
    },

    isEmailVerified: {
      type: Boolean,
      default: false,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },

    password: {
      type: String,
      required: [
        function requiredPassword() {
          return !(isGoogleProvider(this) || isPendingAdminCreatedBrand(this));
        },
        "Password is required",
      ],
      minlength: 8,
      select: false,
    },

    proxyEmail: {
      type: String,
      default: undefined,
      trim: true,
      lowercase: true,
      set: (value) => {
        const cleaned = String(value || "").trim().toLowerCase();
        return cleaned ? cleaned : undefined;
      },
      validate: {
        validator(value) {
          return value == null || emailRegex.test(value);
        },
        message: "Invalid proxy email",
      },
    },

    isAdminCreated: {
      type: Boolean,
      default: false,
    },

    signupCompleted: {
      type: Boolean,
      default: true,
    },

    createdByAdmin: {
      type: Schema.Types.ObjectId,
      ref: "Master",
      default: null,
    },

    adminCreatedRole: {
      type: String,
      default: "",
      trim: true,
    },

    adminCreatedAt: {
      type: Date,
      default: null,
    },

    signupCompletedAt: {
      type: Date,
      default: null,
    },

    profilePic: {
      type: String,
      default: "",
      trim: true,
    },

    page1: { type: [Schema.Types.Mixed], default: [] },
    page2: { type: [Schema.Types.Mixed], default: [] },
    page3: { type: [Schema.Types.Mixed], default: [] },

    ispage1Skip: { type: Boolean, default: false },
    ispage2Skip: { type: Boolean, default: false },
    ispage3Skip: { type: Boolean, default: false },
    isProfilePicSkip: { type: Boolean, default: false },

    workspaceUsers: {
      type: [workspaceUserSchema],
      default: [],
    },

    subscription: { type: subscriptionSchema, default: () => ({}) },
    subscriptionExpired: { type: Boolean, default: false },

    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        delete ret.password;
        ret.brandId = String(ret._id);
        return ret;
      },
    },
    toObject: {
      transform(_doc, ret) {
        delete ret.password;
        ret.brandId = String(ret._id);
        return ret;
      },
    },
  }
);

brandSchema.index({ email: 1 }, { unique: true });
brandSchema.index({ googleId: 1 }, { unique: true, sparse: true });
brandSchema.index({ googleSub: 1 }, { unique: true, sparse: true });
brandSchema.index({ authProvider: 1, createdAt: -1 });
brandSchema.index({ provider: 1, createdAt: -1 });
brandSchema.index({ isAdminCreated: 1, signupCompleted: 1, createdAt: -1 });
brandSchema.index({ createdByAdmin: 1, adminCreatedAt: -1 });
brandSchema.index({ "workspaceUsers.email": 1, "workspaceUsers.status": 1 });

brandSchema.pre("save", async function preSave(next) {
  try {
    if (!this.isModified("password")) return next();

    const pwd = String(this.password || "");

    if (!pwd) return next();

    const alreadyHashed = /^\$2[aby]\$\d{2}\$/.test(pwd) && pwd.length === 60;

    if (alreadyHashed) return next();

    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(pwd, salt);

    return next();
  } catch (error) {
    return next(error);
  }
});

brandSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(String(candidate || ""), String(this.password));
};

const BrandModel = mongoose.models.Brand || mongoose.model("Brand", brandSchema);

module.exports = BrandModel;
module.exports.BrandModel = BrandModel;