'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;
const Mixed = Schema.Types.Mixed;

const YoutubeInsightPublicShareSchema = new Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    reportId: { type: Schema.Types.ObjectId, ref: 'YoutubeInsightReport', default: null, index: true },
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', default: null, index: true },
    brandName: { type: String, trim: true, default: '' },

    sourceContext: {
      type: String,
      enum: ['public_insight_os', 'brand_insight_os', 'unknown'],
      default: 'unknown',
      index: true
    },

    title: { type: String, trim: true, default: '' },
    creatorName: { type: String, trim: true, default: '' },
    videoUrl: { type: String, trim: true, default: '' },

    // Snapshot keeps public links working for non-logged-in reports that were
    // generated in browser session only, and also protects old links if a report
    // is later deleted or access-filtered.
    snapshot: { type: Mixed, default: null },

    createdByUserId: { type: Schema.Types.ObjectId, default: null, index: true },
    createdByAdminId: { type: Schema.Types.ObjectId, default: null, index: true },
    createdByEmail: { type: String, trim: true, lowercase: true, default: '' },

    isActive: { type: Boolean, default: true, index: true },
    accessCount: { type: Number, default: 0 },
    lastAccessedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: true }
  },
  { timestamps: true }
);

YoutubeInsightPublicShareSchema.index({ token: 1, isActive: 1 });
YoutubeInsightPublicShareSchema.index({ reportId: 1, createdAt: -1 });
YoutubeInsightPublicShareSchema.index({ brandId: 1, createdAt: -1 });

module.exports = mongoose.model('YoutubeInsightPublicShare', YoutubeInsightPublicShareSchema);