const mongoose = require('mongoose');

const productOptions = [
  'Consumer Electronics',
  'Beauty & Skincare',
  'Fitness & Sports',
  'Fashion & Apparel',
  'Food & Beverage',
  'Software & SaaS',
  'Home & Lifestyle',
  'Finance & Fintech',
  'Other',
];

const budgetOptions = [
  'Under $1,000',
  '$1,000–$5,000',
  '$5,000–$15,000',
  '$15,000–$50,000',
  '$50,000+',
];

const platformOptions = ['YouTube', 'Instagram', 'TikTok', 'Multi-Platform'];

const marketOptions = [
  'United States',
  'United Kingdom',
  'India',
  'Canada',
  'Australia',
  'Global',
];

const managedOptions = [
  'Yes — I want CollabGlam to manage everything',
  "No — I'll use the platform myself",
  'Not sure yet, tell me more',
];

const matchedCreatorSchema = new mongoose.Schema(
  {
    productType: {
      type: String,
      required: [true, 'Product category is required.'],
      enum: productOptions,
      trim: true,
    },

    budget: {
      type: String,
      required: [true, 'Campaign budget is required.'],
      enum: budgetOptions,
      trim: true,
    },

    platform: {
      type: String,
      required: [true, 'Target platform is required.'],
      enum: platformOptions,
      trim: true,
    },

    market: {
      type: String,
      required: [true, 'Primary market is required.'],
      enum: marketOptions,
      trim: true,
    },

    brandName: {
      type: String,
      required: [true, 'Brand name is required.'],
      trim: true,
      minlength: [2, 'Brand name must be at least 2 characters.'],
      maxlength: [120, 'Brand name cannot exceed 120 characters.'],
    },

    email: {
      type: String,
      required: [true, 'Business email is required.'],
      trim: true,
      lowercase: true,
      match: [
        /^\S+@\S+\.\S+$/,
        'Please enter a valid business email address.',
      ],
    },

    managedPlan: {
      type: String,
      required: [true, 'Managed plan preference is required.'],
      enum: managedOptions,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('MatchedCreator', matchedCreatorSchema);