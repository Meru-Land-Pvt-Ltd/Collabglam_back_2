const mongoose = require("mongoose");
const crypto = require("crypto");

const BrandSchema = new mongoose.Schema(
  {
    brand_id: {
      type: String,
      default: () => crypto.randomUUID(),
      unique: true,
      index: true,
    },

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

    // Core Identity
    brand_alias: { type: String, default: null },
    domain: { type: String, default: null },
    website_url: { type: String, default: null },
    logo_url: { type: String, default: null },
    brand_description: { type: String, default: null },

    // Product + Positioning
    core_offerings: { type: String, default: null },
    flagship_products: { type: String, default: null },
    key_products_or_services: { type: String, default: null },
    value_proposition: { type: String, default: null },
    unique_selling_proposition: { type: String, default: null },
    target_audience: { type: String, default: null },
    ideal_customer_profile: { type: String, default: null },
    brand_positioning: { type: String, default: null },
    key_differentiators: { type: String, default: null },
    use_cases: { type: String, default: null },

    // Company Classification
    industry: { type: String, default: null },
    sub_industry: { type: String, default: null },
    brand_category: { type: String, default: null },
    company_type: { type: String, default: null },
    business_model: { type: String, default: null },
    founded_year: { type: String, default: null },
    headquarters_city: { type: String, default: null },
    headquarters_state: { type: String, default: null },
    headquarters_country: { type: String, default: null },
    operating_regions: { type: String, default: null },
    shipping_regions: { type: String, default: null },
    company_mission: { type: String, default: null },
    company_vision: { type: String, default: null },

    // Financials + Scale
    last_year_revenue: { type: String, default: null },
    last_year_revenue_year: { type: String, default: null },
    employee_count: { type: String, default: null },
    company_size_category: { type: String, default: null },
    annual_revenue: { type: String, default: null },
    revenue_range: { type: String, default: null },
    funding_total: { type: String, default: null },
    funding_stage: { type: String, default: null },
    valuation: { type: String, default: null },
    profitability_status: { type: String, default: null },
    growth_rate: { type: String, default: null },
    brand_maturity: { type: String, default: null },

    // Digital Footprint
    instagram_url: { type: String, default: null },
    instagram_followers: { type: String, default: null },
    instagram_engagement_rate: { type: String, default: null },
    youtube_url: { type: String, default: null },
    youtube_subscribers: { type: String, default: null },
    linkedin_url: { type: String, default: null },
    facebook_url: { type: String, default: null },
    twitter_url: { type: String, default: null },
    website_traffic_monthly: { type: String, default: null },
    app_downloads: { type: String, default: null },
    app_store_presence: { type: String, default: null },
    play_store_url: { type: String, default: null },
    app_store_url: { type: String, default: null },

    // Content Forensics
    blog_url: { type: String, default: null },
    blog_insights: {
      content_type: { type: String, default: null },
      content_frequency: { type: String, default: null },
      primary_topics: { type: String, default: null },
      growth_strategy: { type: String, default: null },
    },

    blog_page_text: { type: String, default: null },
    newsroom_url: { type: String, default: null },
    press_page_url: { type: String, default: null },
    resources_page_url: { type: String, default: null },
    case_studies_url: { type: String, default: null },
    webinars_url: { type: String, default: null },
    podcast_url: { type: String, default: null },
    content_strategy: { type: String, default: null },
    content_pillars: { type: String, default: null },
    content_tone: { type: String, default: null },
    blog_summary: { type: String, default: null },
    recent_blog_titles: { type: String, default: null },
    recent_blog_topics: { type: String, default: null },
    recent_news_or_launches: { type: String, default: null },

    // Leadership + Partnerships
    leadership_team: { type: String, default: null },
    founder_name: { type: String, default: null },
    ceo_name: { type: String, default: null },
    key_executives: { type: String, default: null },
    leadership_overview: { type: String, default: null },
    notable_partnerships: { type: String, default: null },
    notable_clients: { type: String, default: null },
    notable_partnerships_or_clients: { type: String, default: null },
    investors_or_backers: { type: String, default: null },

    // Commerce + Distribution
    marketplaces_or_store_presence: { type: String, default: null },
    retail_presence: { type: String, default: null },
    distributor_network: { type: String, default: null },

    // Contact + Support
    primary_contact_name: { type: String, default: null },
    contact_designation: { type: String, default: null },
    contact_email: { type: String, default: null },
    contact_phone: { type: String, default: null },
    linkedin_contact_url: { type: String, default: null },
    contact_department: { type: String, default: null },

    about_page_url: { type: String, default: null },
    contact_page_url: { type: String, default: null },
    general_email: { type: String, default: null },
    sales_email: { type: String, default: null },
    support_email: { type: String, default: null },
    public_phone: { type: String, default: null },
    public_address: { type: String, default: null },
    customer_support_channels: { type: String, default: null },
    faq_page_url: { type: String, default: null },
    help_center_url: { type: String, default: null },
    return_policy_summary: { type: String, default: null },
    warranty_summary: { type: String, default: null },

    // Scraping Metadata
    website_pages_scraped: [{ type: String }],
    social_links_detected: [{ type: String }],
    last_scraped_at: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("BrandInfo", BrandSchema);