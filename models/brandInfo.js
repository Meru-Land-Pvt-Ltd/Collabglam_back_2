const mongoose = require("mongoose");
const crypto = require("crypto");

const BrandSchema = new mongoose.Schema(
  {
   

    normalized_brand_name: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    input_brand_name: {
      type: String,
      required: true,
      trim: true,
    },

    brand_name: {
      type: String,
      required: true,
      trim: true,
    },

    brand_alias: { type: String, default: null },
    domain: { type: String, default: null },
    website_url: { type: String, default: null },
    logo_url: { type: String, default: null },
    brand_description: { type: String, default: null },
    industry: { type: String, default: null },
    sub_industry: { type: String, default: null },
    brand_category: { type: String, default: null },
    company_type: { type: String, default: null },
    business_model: { type: String, default: null },
    founded_year: { type: Number, default: null },
    headquarters_city: { type: String, default: null },
    headquarters_state: { type: String, default: null },
    headquarters_country: { type: String, default: null },
    operating_regions: [{ type: String }],

    last_year_revenue: { type: Number, default: null },
    last_year_revenue_year: { type: Number, default: null },

    employee_count: { type: Number, default: null },
    company_size_category: { type: String, default: null },
    annual_revenue: { type: Number, default: null },
    revenue_range: { type: String, default: null },
    funding_total: { type: Number, default: null },
    funding_stage: { type: String, default: null },
    valuation: { type: Number, default: null },
    profitability_status: { type: String, default: null },
    growth_rate: { type: Number, default: null },
    brand_maturity: { type: String, default: null },

    instagram_url: { type: String, default: null },
    instagram_followers: { type: Number, default: null },
    instagram_engagement_rate: { type: Number, default: null },
    youtube_url: { type: String, default: null },
    youtube_subscribers: { type: Number, default: null },
    linkedin_url: { type: String, default: null },
    facebook_url: { type: String, default: null },
    twitter_url: { type: String, default: null },
    website_traffic_monthly: { type: Number, default: null },
    app_downloads: { type: Number, default: null },

    primary_contact_name: { type: String, default: null },
    contact_designation: { type: String, default: null },
    contact_email: { type: String, default: null },
    contact_phone: { type: String, default: null },
    linkedin_contact_url: { type: String, default: null },
    contact_department: { type: String, default: null },    
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("BrandInfo", BrandSchema);