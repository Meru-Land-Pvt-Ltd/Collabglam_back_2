const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NamedRefSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, required: false },
    name: { type: String, required: true, trim: true },
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

    name: {
      type: String,
      trim: true,
      default: "",
    },

    countryId: {
      type: Schema.Types.ObjectId,
      ref: "Country",
      required: false,
    },

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

    country: {
      type: String,
      default: "",
      trim: true,
    },

    location: {
      type: String,
      default: "",
      trim: true,
    },

    languages: {
      type: [NamedRefSchema],
      default: [],
    },

    categories: {
      type: [NamedRefSchema],
      default: [],
    },

    password: {
      type: String,
      select: false,
    },

    primaryPlatform: {
      type: String,
      default: null,
      trim: true,
    },

    page1: {
      type: [Schema.Types.Mixed],
      required: true,
      default: [],
    },

    page2: {
      type: [Schema.Types.Mixed],
      default: [],
    },

    page3: {
      type: [Schema.Types.Mixed],
      default: [],
    },

    ispage2Skip: {
      type: Boolean,
      default: false,
    },

    ispage3Skip: {
      type: Boolean,
      default: false,
    },

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
    partialFilterExpression: {
      proxyEmail: { $type: "string", $ne: "" },
    },
  }
);

const InfluencerModel =
  models.Influencer || model("Influencer", InfluencerSchema);

module.exports = { InfluencerModel };