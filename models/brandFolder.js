const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;

const LinkedCampaignSchema = new Schema(
  {
    campaignId: { type: Schema.Types.Mixed, default: null },
    campaignsId: { type: String, default: "", trim: true },
    campaignTitle: { type: String, default: "", trim: true },
    productOrServiceName: { type: String, default: "", trim: true },
    brandId: { type: Schema.Types.Mixed, default: null },
    brandName: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const BrandFolderInfluencerSchema = new Schema(
  {
    profileKey: { type: String, required: true, trim: true },

    influencerId: { type: String, default: "", trim: true },
    creatorId: { type: String, default: "", trim: true },
    userId: { type: String, default: "", trim: true },
    modashId: { type: String, default: "", trim: true },
    channelId: { type: String, default: "", trim: true },

    name: { type: String, default: "", trim: true },
    fullname: { type: String, default: "", trim: true },
    fullName: { type: String, default: "", trim: true },
    username: { type: String, default: "", trim: true },
    userName: { type: String, default: "", trim: true },
    handle: { type: String, default: "", trim: true },

    email: { type: String, default: "", lowercase: true, trim: true },
    emails: { type: [Schema.Types.Mixed], default: [] },

    provider: { type: String, default: "", trim: true },
    platform: { type: String, default: "", trim: true },

    country: { type: String, default: "", trim: true },
    countryCode: { type: String, default: "", trim: true },

    language: { type: String, default: "", trim: true },
    languageCode: { type: String, default: "", trim: true },
    languages: { type: [Schema.Types.Mixed], default: [] },

    location: { type: String, default: "", trim: true },
    city: { type: String, default: "", trim: true },
    region: { type: String, default: "", trim: true },

    categories: { type: [Schema.Types.Mixed], default: [] },
    niche: { type: [Schema.Types.Mixed], default: [] },

    followers: { type: Number, default: null },
    engagements: { type: Number, default: null },
    engagementRate: { type: Number, default: null },
    averageViews: { type: Number, default: null },

    primaryLink: { type: String, default: "", trim: true },
    profileUrl: { type: String, default: "", trim: true },
    url: { type: String, default: "", trim: true },
    links: { type: [String], default: [] },

    picture: { type: String, default: "", trim: true },
    avatarUrl: { type: String, default: "", trim: true },
    profileImage: { type: String, default: "", trim: true },

    bio: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },

    isVerified: { type: Boolean, default: false },
    verified: { type: Boolean, default: false },
    isPrivate: { type: Boolean, default: false },

    searchType: { type: String, default: "standard", trim: true },

    status: {
      type: String,
      enum: ["saved", "good_fit", "bookmarked", "invited", "removed"],
      default: "saved",
    },

    source: {
      type: Schema.Types.Mixed,
      default: {},
    },

    audience: {
      type: Schema.Types.Mixed,
      default: null,
    },

    stats: {
      type: Schema.Types.Mixed,
      default: null,
    },

    contacts: {
      type: Schema.Types.Mixed,
      default: null,
    },

    profile: {
      type: Schema.Types.Mixed,
      default: null,
    },

    account: {
      type: Schema.Types.Mixed,
      default: null,
    },

    raw: {
      type: Schema.Types.Mixed,
      default: {},
    },

    addedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    _id: true,
    strict: false,
  }
);

const BrandFolderSchema = new Schema(
  {
    brandId: { type: Schema.Types.Mixed, required: true, index: true },
    brandRef: { type: Schema.Types.ObjectId, ref: "Brand", default: null },
    brandName: { type: String, default: "", trim: true },

    title: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true },

    description: { type: String, default: "", trim: true },

    type: {
      type: String,
      enum: ["folder", "bookmark", "good_fit"],
      default: "folder",
      index: true,
    },

    creatorTier: { type: String, default: "", trim: true },

    linkedCampaign: { type: LinkedCampaignSchema, default: null },

    items: { type: [BrandFolderInfluencerSchema], default: [] },

    itemCount: { type: Number, default: 0 },
    isDefault: { type: Boolean, default: false },
    createdByBrand: { type: Schema.Types.Mixed, default: null },

    archivedAt: { type: Date, default: null, index: true },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

BrandFolderSchema.pre("validate", function setNameSlugAndCount(next) {
  if (!this.name && this.title) this.name = this.title;
  if (!this.title && this.name) this.title = this.name;

  if (!this.slug && (this.title || this.name)) {
    this.slug = String(this.title || this.name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  this.itemCount = Array.isArray(this.items) ? this.items.length : 0;
  next();
});

BrandFolderSchema.index(
  { brandId: 1, slug: 1, archivedAt: 1 },
  {
    unique: true,
    partialFilterExpression: { archivedAt: null },
  }
);

BrandFolderSchema.index({ brandId: 1, type: 1, archivedAt: 1, updatedAt: -1 });
BrandFolderSchema.index({ brandId: 1, "items.profileKey": 1, archivedAt: 1 });

const BrandFolderModel =
  models.BrandFolder || model("BrandFolder", BrandFolderSchema);

module.exports = {
  BrandFolderModel,
  BrandFolder: BrandFolderModel,
};