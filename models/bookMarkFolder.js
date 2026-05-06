// models/BookmarkFolder.js

const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;

const NamedValueSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, required: false },
    name: { type: String, default: "", trim: true },
    value: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const BookmarkProfileSchema = new Schema(
  {
    influencerId: { type: String, default: "", trim: true },
    creatorId: { type: String, default: "", trim: true },
    userId: { type: String, default: "", trim: true },
    modashId: { type: String, default: "", trim: true },

    name: { type: String, default: "", trim: true },
    fullname: { type: String, default: "", trim: true },
    username: { type: String, default: "", trim: true },
    handle: { type: String, default: "", trim: true },

    email: { type: String, default: "", lowercase: true, trim: true },

    provider: { type: String, default: "", trim: true },
    platform: { type: String, default: "", trim: true },

    country: { type: String, default: "", trim: true },
    location: { type: String, default: "", trim: true },

    categories: { type: [Schema.Types.Mixed], default: [] },
    niche: { type: [Schema.Types.Mixed], default: [] },

    followers: { type: Number, default: 0 },
    engagementRate: { type: Number, default: 0 },
    engagements: { type: Number, default: 0 },
    averageViews: { type: Number, default: 0 },

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
    source: { type: String, default: "standard", trim: true },

    profileKey: { type: String, default: "", trim: true },
    raw: { type: Schema.Types.Mixed, default: null },

    bookmarkedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const BookmarkFolderSchema = new Schema(
  {
    brandId: { type: String, required: true, trim: true },
    brandRef: { type: Schema.Types.ObjectId, ref: "Brand", default: null },

    name: { type: String, required: true, trim: true, default: "bookmarked" },
    title: { type: String, required: true, trim: true, default: "Bookmarked" },
    slug: { type: String, required: true, trim: true, default: "bookmarked" },
    description: { type: String, default: "", trim: true },

    type: {
      type: String,
      enum: ["bookmark"],
      default: "bookmark",
    },

    items: { type: [BookmarkProfileSchema], default: [] },

    // Keep this for compatibility with older controller logic.
    bookmarks: { type: [BookmarkProfileSchema], default: [] },

    createdBy: { type: Schema.Types.ObjectId, ref: "Brand", default: null },
    createdByRole: { type: String, default: "Brand", trim: true },

    archivedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

BookmarkFolderSchema.pre("save", function syncBookmarks(next) {
  if (this.isModified("items") && !this.isModified("bookmarks")) {
    this.bookmarks = this.items;
  }

  if (this.isModified("bookmarks") && !this.isModified("items")) {
    this.items = this.bookmarks;
  }

  next();
});

BookmarkFolderSchema.index(
  { brandId: 1, slug: 1, archivedAt: 1 },
  { unique: false }
);

BookmarkFolderSchema.index({ brandId: 1, name: 1, archivedAt: 1 });
BookmarkFolderSchema.index({ brandId: 1, updatedAt: -1 });
BookmarkFolderSchema.index({ "items.profileKey": 1 });
BookmarkFolderSchema.index({ "items.influencerId": 1 });
BookmarkFolderSchema.index({ "items.handle": 1 });

const BookmarkFolder =
  models.BookmarkFolder || model("BookmarkFolder", BookmarkFolderSchema);

module.exports = { BookmarkFolder };