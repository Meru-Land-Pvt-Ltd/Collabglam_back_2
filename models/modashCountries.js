const mongoose = require("mongoose");

const modashCountrySchema = new mongoose.Schema(
  {
    countryName: {
      type: String,
      required: true,
      trim: true,
    },

    countryCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },

    flag: {
      type: String,
      default: "",
    },

  
    modashId: {
      type: Number,
      required: true,
      unique: true,
    },

    platform: {
      type: String,
      required: true,
      enum: ["instagram", "tiktok", "youtube"],
      lowercase: true,
      trim: true,
    },
  },
  {
    versionKey: false,
  }
);

modashCountrySchema.index(
  { countryCode: 1, platform: 1 },
  { unique: true }
);

modashCountrySchema.index(
  { modashId: 1, platform: 1 },
  { unique: true }
);

module.exports = mongoose.model("ModashCountry", modashCountrySchema);