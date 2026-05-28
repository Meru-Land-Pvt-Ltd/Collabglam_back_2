"use strict";

const mongoose = require("mongoose");
const { normalizePaymentType } = require("../constants/contract");

const { Schema } = mongoose;

const DeliverableSchema = new Schema(
  {
    srNo: { type: Number, default: 1 },
    platform: { type: String, default: "", trim: true },
    handle: { type: String, default: "", trim: true },
    handles: { type: [String], default: [] },
    platformHandle: { type: String, default: "", trim: true },
    deliverableFormat: { type: String, default: "", trim: true },
    deliverableName: { type: String, default: "", trim: true },
    contentSpecification: { type: String, default: "", trim: true },
    qty: { type: Number, default: 1 },
    aspectRatio: { type: String, default: "", trim: true },
    draftRequired: { type: Boolean, default: false },
    draftDue: { type: String, default: "", trim: true },
    liveDate: { type: String, default: "", trim: true },
    preShootScriptRequired: { type: Boolean, default: false },
    preShootScriptDue: { type: String, default: "", trim: true },
    preShootScriptReviewBusinessDays: { type: Number, default: 2 },
  },
  { _id: false }
);

const MilestoneSchema = new Schema(
  {
    milestoneName: { type: String, default: "", trim: true },
    milestoneDescription: { type: String, default: "", trim: true },
    paymentAmount: { type: Number, default: 0 },
    triggerEvent: { type: String, default: "", trim: true },
    dueDate: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const UsageRightSchema = new Schema(
  {
    usageRight: { type: String, default: "", trim: true },
    selected: { type: Boolean, default: false },
    duration: { type: String, default: "", trim: true },
    territoryNotes: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const ContractContentSchema = new Schema(
  {
    contractId: { type: String, required: true, unique: true, index: true, trim: true },
    brandId: { type: String, required: true, index: true, trim: true },
    influencerId: { type: String, required: true, index: true, trim: true },
    campaignId: { type: String, required: true, index: true, trim: true },

    brandLegalName: { type: String, default: "", trim: true },
    brandContactPersonName: { type: String, default: "", trim: true },
    brandNoticeEmail: { type: String, default: "", trim: true, lowercase: true },
    brandNoticePhone: { type: String, default: "", trim: true },
    brandBillingAddress: { type: String, default: "", trim: true },
    brandPoc: { type: String, default: "", trim: true },
    brandPocDesignation: { type: String, default: "", trim: true },

    influencerLegalName: { type: String, default: "", trim: true },
    influencerContactName: { type: String, default: "", trim: true },
    influencerPostingHandleUrl: { type: String, default: "", trim: true },
    influencerEmail: { type: String, default: "", trim: true, lowercase: true },
    influencerPhone: { type: String, default: "", trim: true },
    influencerWhatsApp: { type: String, default: "", trim: true },
    influencerAddress: { type: String, default: "", trim: true },
    influencerTaxFormType: { type: String, default: "", trim: true },
    influencerTaxId: { type: String, default: "", trim: true },
    influencerAddressLine1: { type: String, default: "", trim: true },
    influencerAddressLine2: { type: String, default: "", trim: true },
    influencerCity: { type: String, default: "", trim: true },
    influencerState: { type: String, default: "", trim: true },
    influencerZipPostalCode: { type: String, default: "", trim: true },
    influencerCountry: { type: String, default: "", trim: true },
    influencerNotes: { type: String, default: "", trim: true },

    campaignName: { type: String, default: "", trim: true },
    campaignProductsServicesCovered: { type: String, default: "", trim: true },
    campaignTerritoryTargetCountry: { type: String, default: "Worldwide", trim: true },
    campaignEffectiveDate: { type: Date, default: null },
    campaignTitleOrId: { type: String, default: "", trim: true },
    campaignTimezone: { type: String, default: "", trim: true },
    campaignPaymentType: {
      type: String,
      enum: ["fixed_payment", "milestone_based", "product_gifting"],
      default: "fixed_payment",
      index: true,
    },

    collabglamLegalName: { type: String, default: "CollabGlam LLC", trim: true },
    collabglamAddress: {
      type: String,
      default: "CollabGlam LLC, 732 S 6th STE N, Las Vegas, Nevada 89101, USA",
      trim: true,
    },
    collabglamEmail: { type: String, default: "help@collabglam.com", trim: true, lowercase: true },
    collabglamSignatoryName: { type: String, default: "", trim: true },

    deliverables: { type: [DeliverableSchema], default: [] },
    minimumVideoSpecs: { type: String, default: "", trim: true },
    preShootScriptRequired: { type: Boolean, default: false },
    preShootScriptDue: { type: String, default: "", trim: true },
    preShootScriptReviewBusinessDays: { type: Number, default: 2 },
    mandatoryTagsMentionsLinksCodes: { type: String, default: "", trim: true },

    needRevisionRounds: { type: String, enum: ["yes", "no", ""], default: "no", trim: true },
    includedRevisionRounds: { type: Number, default: 0 },
    additionalRevisionFee: { type: String, default: "", trim: true },
    reshootObligation: { type: String, default: "", trim: true },
    reshootObligationRequired: { type: String, enum: ["yes", "no", ""], default: "yes", trim: true },
    draftDate: { type: String, default: "", trim: true },
    reshootFee: { type: String, default: "", trim: true },
    minimumLivePeriod: { type: String, default: "", trim: true },

    totalCampaignFee: { type: Number, default: 0 },
    influencerBudget: { type: Number, default: 0 },
    currency: { type: String, default: "USD", trim: true },
    wantAdvancePayment: { type: Boolean, default: false },
    advancePaymentAmount: { type: Number, default: 0 },
    advancePaymentType: { type: String, default: "", trim: true },
    paymentStructure: { type: String, default: "", trim: true },
    platformMilestonePaymentStructure: { type: String, default: "", trim: true },
    customSplit: { type: String, default: "", trim: true },
    advancePaymentTrigger: { type: String, default: "", trim: true },
    remainingPaymentTrigger: { type: String, default: "", trim: true },
    paymentProcessorFeesBorneBy: { type: String, default: "", trim: true },
    paymentProcessorFeesNotes: { type: String, default: "", trim: true },
    laneAMarketplaceFeeNote: {
      type: String,
      default: "Unless expressly stated otherwise, 10% of the applicable Influencer compensation funded through the Platform is deducted from the Influencer payout and retained by CollabGlam; the Brand-funded campaign amount remains fixed.",
      trim: true,
    },
    payoutMethod: { type: String, default: "", trim: true },
    payoutAccountId: { type: String, default: "", trim: true },
    taxId: { type: String, default: "", trim: true },
    milestones: { type: [MilestoneSchema], default: [] },

    rawSourceFileDelivery: { type: String, default: "", trim: true },
    rawFilesDeliveryDue: { type: String, default: "", trim: true },
    rawFilesFormat: { type: String, default: "", trim: true },
    analyticsReportingDeadline: { type: String, default: "", trim: true },
    analyticsReportingItems: { type: String, default: "", trim: true },

    productShippingApplicable: { type: String, default: "No", trim: true },
    shipToName: { type: String, default: "", trim: true },
    shipToAddress: { type: String, default: "", trim: true },
    shipToPhone: { type: String, default: "", trim: true },
    productReceiptConfirmationDeadline: { type: String, default: "", trim: true },
    productReturnable: { type: String, default: "", trim: true },
    returnWindowMethod: { type: String, default: "", trim: true },
    riskOfLossNotes: { type: String, default: "", trim: true },

    usageRights: { type: [UsageRightSchema], default: [] },
    attributionRequirement: { type: String, default: "", trim: true },
    attributionText: { type: String, default: "", trim: true },
    editingRights: { type: String, default: "", trim: true },
    musicStockAssetResponsibility: { type: String, default: "", trim: true },

    creativeBriefMandatoryTalkingPoints: { type: String, default: "", trim: true },
    restrictedStatements: { type: String, default: "", trim: true },

    competitorBlackout: { type: String, default: "None", trim: true },
    categoryCompetitorList: { type: String, default: "", trim: true },
    blackoutPeriod: { type: String, default: "", trim: true },
    optionalMoralsClause: { type: String, default: "", trim: true },

    killFeeOrProrata: { type: String, default: "", trim: true },
    refundOfUnearnedAdvance: { type: String, default: "", trim: true },

    governingLaw: { type: String, default: "Nevada, USA", trim: true },
    disputeResolutionMethod: { type: String, default: "AAA Arbitration", trim: true },
    disputeVenue: { type: String, default: "", trim: true },
    arbitrationSeat: { type: String, default: "Las Vegas, Nevada, USA", trim: true },
    attorneysFees: { type: String, default: "", trim: true },

    other: { type: Schema.Types.Mixed, default: {} },
    editorState: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false }
);

ContractContentSchema.index({ brandId: 1, campaignId: 1, updatedAt: -1 });
ContractContentSchema.index({ influencerId: 1, campaignId: 1, updatedAt: -1 });

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

ContractContentSchema.statics.fromLegacyContent = function fromLegacyContent({
  contractId,
  brandId,
  influencerId,
  campaignId,
  content = {},
  other = {},
}) {
  const brand = content.brand || {};
  const influencer = content.influencer || {};
  const campaign = content.campaign || {};
  const collabglam = content.collabglam || {};
  const scheduleA = content.scheduleA || {};
  const review = scheduleA.review || {};
  const commercial = scheduleA.commercial || {};
  const rawFiles = scheduleA.rawFiles || {};
  const shipping = scheduleA.shipping || {};
  const usageRights = scheduleA.usageRights || {};
  const compliance = scheduleA.compliance || {};
  const exclusivity = scheduleA.exclusivity || {};
  const cancellation = scheduleA.cancellation || {};
  const dispute = scheduleA.dispute || {};

  return {
    contractId,
    brandId,
    influencerId,
    campaignId,

    brandLegalName: brand.legalName || "",
    brandContactPersonName: brand.contactPersonName || "",
    brandNoticeEmail: brand.noticeEmail || "",
    brandNoticePhone: brand.noticePhone || "",
    brandBillingAddress: brand.billingAddress || "",
    brandPoc: brand.brandPoc || brand.poc || "",
    brandPocDesignation: brand.brandPocDesignation || brand.pocDesignation || "",

    influencerLegalName: influencer.legalName || "",
    influencerContactName: influencer.contactName || "",
    influencerPostingHandleUrl: influencer.postingHandleUrl || "",
    influencerEmail: firstDefined(influencer.email, influencer.contactEmail, ""),
    influencerPhone: firstDefined(influencer.phone, influencer.contactPhone, ""),
    influencerWhatsApp: influencer.whatsApp || influencer.whatsapp || "",
    influencerAddress: influencer.address || "",
    influencerTaxFormType: influencer.taxFormType || "",
    influencerTaxId: influencer.taxId || "",
    influencerAddressLine1: influencer.addressLine1 || "",
    influencerAddressLine2: influencer.addressLine2 || "",
    influencerCity: influencer.city || "",
    influencerState: influencer.state || "",
    influencerZipPostalCode: influencer.zipPostalCode || "",
    influencerCountry: influencer.country || "",
    influencerNotes: influencer.notes || "",

    campaignName: campaign.name || campaign.campaignName || "",
    campaignProductsServicesCovered: campaign.productsServicesCovered || "",
    campaignTerritoryTargetCountry: campaign.territoryTargetCountry || "Worldwide",
    campaignEffectiveDate: campaign.effectiveDate || null,
    campaignTitleOrId: campaign.campaignTitleOrId || "",
    campaignTimezone: campaign.timezone || "",
    campaignPaymentType: normalizePaymentType(campaign.paymentType),

    collabglamLegalName: collabglam.legalName || "CollabGlam LLC",
    collabglamAddress:
      collabglam.address ||
      "CollabGlam LLC, 732 S 6th STE N, Las Vegas, Nevada 89101, USA",
    collabglamEmail: collabglam.email || "help@collabglam.com",
    collabglamSignatoryName: collabglam.signatoryName || "",

    deliverables: Array.isArray(scheduleA.deliverables) ? scheduleA.deliverables : [],
    minimumVideoSpecs: scheduleA.minimumVideoSpecs || "",
    preShootScriptRequired: Boolean(scheduleA.preShootScriptRequired),
    preShootScriptDue: scheduleA.preShootScriptDue || "",
    preShootScriptReviewBusinessDays: Number(scheduleA.preShootScriptReviewBusinessDays || 2),
    mandatoryTagsMentionsLinksCodes: scheduleA.mandatoryTagsMentionsLinksCodes || "",

    needRevisionRounds:
      review.needRevisionRounds === "yes" || review.needRevisionRounds === true
        ? "yes"
        : "no",
    includedRevisionRounds:
      review.needRevisionRounds === "yes" || review.needRevisionRounds === true
        ? Number(review.includedRevisionRounds || 1)
        : 0,
    additionalRevisionFee:
      review.needRevisionRounds === "yes" || review.needRevisionRounds === true
        ? String(review.additionalRevisionFee || "0")
        : "",
    reshootObligation: review.reshootObligation || "",
    reshootObligationRequired:
      review.reshootObligationRequired === "no" || review.reshootObligationRequired === false
        ? "no"
        : "yes",
    draftDate: review.draftDate || "",
    reshootFee: review.reshootFee || "",
    minimumLivePeriod: review.minimumLivePeriod || "",

    totalCampaignFee: Number(commercial.totalCampaignFee || 0),
    influencerBudget: Number(commercial.influencerBudget || 0),
    currency: commercial.currency || "USD",
    wantAdvancePayment: Boolean(commercial.wantAdvancePayment),
    advancePaymentAmount: Number(commercial.advancePaymentAmount || 0),
    advancePaymentType: commercial.advancePaymentType || "",
    paymentStructure: commercial.paymentStructure || commercial.platformMilestonePaymentStructure || "",
    platformMilestonePaymentStructure: commercial.platformMilestonePaymentStructure || "",
    customSplit: commercial.customSplit || "",
    advancePaymentTrigger: commercial.advancePaymentTrigger || "",
    remainingPaymentTrigger: commercial.remainingPaymentTrigger || "",
    paymentProcessorFeesBorneBy: commercial.paymentProcessorFeesBorneBy || "",
    paymentProcessorFeesNotes: commercial.paymentProcessorFeesNotes || "",
    laneAMarketplaceFeeNote: commercial.laneAMarketplaceFeeNote || "",
    payoutMethod: commercial.payoutMethod || "",
    payoutAccountId: commercial.payoutAccountId || "",
    taxId: commercial.taxId || "",
    milestones: Array.isArray(commercial.milestones) ? commercial.milestones : [],

    rawSourceFileDelivery: rawFiles.rawSourceFileDelivery || "",
    rawFilesDeliveryDue: rawFiles.deliveryDue || "",
    rawFilesFormat: rawFiles.format || "",
    analyticsReportingDeadline: rawFiles.analyticsReportingDeadline || "",
    analyticsReportingItems: rawFiles.analyticsReportingItems || "",

    productShippingApplicable: shipping.productShippingApplicable || "No",
    shipToName: shipping.shipToName || "",
    shipToAddress: shipping.shipToAddress || "",
    shipToPhone: shipping.shipToPhone || "",
    productReceiptConfirmationDeadline: shipping.productReceiptConfirmationDeadline || "",
    productReturnable: shipping.productReturnable || "",
    returnWindowMethod: shipping.returnWindowMethod || "",
    riskOfLossNotes: shipping.riskOfLossNotes || "",

    usageRights: Array.isArray(usageRights.rows) ? usageRights.rows : [],
    attributionRequirement: usageRights.attributionRequirement || "",
    attributionText: usageRights.attributionText || "",
    editingRights: usageRights.editingRights || "",
    musicStockAssetResponsibility: usageRights.musicStockAssetResponsibility || "",

    creativeBriefMandatoryTalkingPoints: compliance.creativeBriefMandatoryTalkingPoints || "",
    restrictedStatements: compliance.restrictedStatements || "",

    competitorBlackout: exclusivity.competitorBlackout || "None",
    categoryCompetitorList: exclusivity.categoryCompetitorList || "",
    blackoutPeriod: exclusivity.blackoutPeriod || "",
    optionalMoralsClause: exclusivity.optionalMoralsClause || "",

    killFeeOrProrata: cancellation.killFeeOrProrata || "",
    refundOfUnearnedAdvance: cancellation.refundOfUnearnedAdvance || "",

    governingLaw: dispute.governingLaw || "Nevada, USA",
    disputeResolutionMethod: dispute.disputeResolutionMethod || "AAA Arbitration",
    disputeVenue: dispute.disputeVenue || "",
    arbitrationSeat: dispute.arbitrationSeat || "Las Vegas, Nevada, USA",
    attorneysFees: dispute.attorneysFees || "",

    other: other || {},
    editorState: content.editor || {},
  };
};

ContractContentSchema.methods.toLegacyContent = function toLegacyContent() {
  return {
    brand: {
      legalName: this.brandLegalName,
      contactPersonName: this.brandContactPersonName,
      noticeEmail: this.brandNoticeEmail,
      noticePhone: this.brandNoticePhone,
      billingAddress: this.brandBillingAddress,
      brandPoc: this.brandPoc,
      brandPocDesignation: this.brandPocDesignation,
    },
    influencer: {
      legalName: this.influencerLegalName,
      contactName: this.influencerContactName,
      postingHandleUrl: this.influencerPostingHandleUrl,
      email: this.influencerEmail,
      phone: this.influencerPhone,
      contactEmail: this.influencerEmail,
      contactPhone: this.influencerPhone,
      whatsApp: this.influencerWhatsApp,
      address: this.influencerAddress,
      taxFormType: this.influencerTaxFormType,
      taxId: this.influencerTaxId,
      addressLine1: this.influencerAddressLine1,
      addressLine2: this.influencerAddressLine2,
      city: this.influencerCity,
      state: this.influencerState,
      zipPostalCode: this.influencerZipPostalCode,
      country: this.influencerCountry,
      notes: this.influencerNotes,
    },
    collabglam: {
      legalName: this.collabglamLegalName,
      address: this.collabglamAddress,
      email: this.collabglamEmail,
      signatoryName: this.collabglamSignatoryName,
    },
    campaign: {
      name: this.campaignName,
      productsServicesCovered: this.campaignProductsServicesCovered,
      territoryTargetCountry: this.campaignTerritoryTargetCountry,
      effectiveDate: this.campaignEffectiveDate,
      campaignTitleOrId: this.campaignTitleOrId,
      timezone: this.campaignTimezone,
      paymentType: this.campaignPaymentType,
    },
    scheduleA: {
      deliverables: this.deliverables || [],
      minimumVideoSpecs: this.minimumVideoSpecs,
      preShootScriptRequired: this.preShootScriptRequired,
      preShootScriptDue: this.preShootScriptDue,
      preShootScriptReviewBusinessDays: this.preShootScriptReviewBusinessDays,
      mandatoryTagsMentionsLinksCodes: this.mandatoryTagsMentionsLinksCodes,
      review: {
        needRevisionRounds: this.needRevisionRounds || "no",
        includedRevisionRounds:
          this.needRevisionRounds === "yes" ? this.includedRevisionRounds : 0,
        additionalRevisionFee:
          this.needRevisionRounds === "yes" ? this.additionalRevisionFee : "",
        reshootObligation: this.reshootObligation,
        reshootObligationRequired: this.reshootObligationRequired || "yes",
        draftDate: this.draftDate,
        reshootFee: this.reshootFee,
        minimumLivePeriod: this.minimumLivePeriod,
      },
      commercial: {
        totalCampaignFee: this.totalCampaignFee,
        influencerBudget: this.influencerBudget,
        currency: this.currency,
        wantAdvancePayment: this.wantAdvancePayment,
        advancePaymentAmount: this.advancePaymentAmount,
        advancePaymentType: this.advancePaymentType,
        paymentStructure: this.paymentStructure,
        platformMilestonePaymentStructure: this.platformMilestonePaymentStructure,
        customSplit: this.customSplit,
        advancePaymentTrigger: this.advancePaymentTrigger,
        remainingPaymentTrigger: this.remainingPaymentTrigger,
        paymentProcessorFeesBorneBy: this.paymentProcessorFeesBorneBy,
        paymentProcessorFeesNotes: this.paymentProcessorFeesNotes,
        laneAMarketplaceFeeNote: this.laneAMarketplaceFeeNote,
        payoutMethod: this.payoutMethod,
        payoutAccountId: this.payoutAccountId,
        taxId: this.taxId,
        milestones: this.milestones || [],
      },
      rawFiles: {
        rawSourceFileDelivery: this.rawSourceFileDelivery,
        deliveryDue: this.rawFilesDeliveryDue,
        format: this.rawFilesFormat,
        analyticsReportingDeadline: this.analyticsReportingDeadline,
        analyticsReportingItems: this.analyticsReportingItems,
      },
      shipping: {
        productShippingApplicable: this.productShippingApplicable,
        shipToName: this.shipToName,
        shipToAddress: this.shipToAddress,
        shipToPhone: this.shipToPhone,
        productReceiptConfirmationDeadline: this.productReceiptConfirmationDeadline,
        productReturnable: this.productReturnable,
        returnWindowMethod: this.returnWindowMethod,
        riskOfLossNotes: this.riskOfLossNotes,
      },
      usageRights: {
        rows: this.usageRights || [],
        attributionRequirement: this.attributionRequirement,
        attributionText: this.attributionText,
        editingRights: this.editingRights,
        musicStockAssetResponsibility: this.musicStockAssetResponsibility,
      },
      compliance: {
        creativeBriefMandatoryTalkingPoints: this.creativeBriefMandatoryTalkingPoints,
        restrictedStatements: this.restrictedStatements,
      },
      exclusivity: {
        competitorBlackout: this.competitorBlackout,
        categoryCompetitorList: this.categoryCompetitorList,
        blackoutPeriod: this.blackoutPeriod,
        optionalMoralsClause: this.optionalMoralsClause,
      },
      cancellation: {
        killFeeOrProrata: this.killFeeOrProrata,
        refundOfUnearnedAdvance: this.refundOfUnearnedAdvance,
      },
      dispute: {
        governingLaw: this.governingLaw,
        disputeResolutionMethod: this.disputeResolutionMethod,
        disputeVenue: this.disputeVenue,
        arbitrationSeat: this.arbitrationSeat,
        attorneysFees: this.attorneysFees,
      },
    },
    editor: this.editorState || {},
  };
};

module.exports = mongoose.models.ContractContent || mongoose.model("ContractContent", ContractContentSchema);