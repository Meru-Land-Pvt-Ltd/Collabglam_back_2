const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const InfluencerAllocationSchema = new Schema(
  {
    influencerId: { type: String, required: true, index: true },

    amount: { type: Number, default: 0, min: 0 },

    releasedAmount: { type: Number, default: 0, min: 0 },

    pendingAmount: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: ["allocated", "partially_released", "released"],
      default: "allocated",
      index: true,
    },

    allocatedAt: { type: Date, default: Date.now },
    lastAllocatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const CampaignFreezeSchema = new Schema(
  {
    brandId: { type: String, required: true, index: true },
    campaignId: { type: String, required: true, index: true },

    totalFrozenAmount: { type: Number, default: 0, min: 0 },

    currentFrozenAmount: { type: Number, default: 0, min: 0 },

    availableToAllocate: { type: Number, default: 0, min: 0 },

    totalAllocatedAmount: { type: Number, default: 0, min: 0 },

    totalReleasedAmount: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: ["active", "fully_allocated", "released"],
      default: "active",
      index: true,
    },

    influencerAllocations: {
      type: [InfluencerAllocationSchema],
      default: [],
    },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const WalletTopupSchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "usd", lowercase: true },

    status: {
      type: String,
      enum: ["success", "pending", "failed"],
      default: "success",
      index: true,
    },

    source: {
      type: String,
      enum: ["stripe", "admin_manual"],
      default: "stripe",
    },

    stripeSessionId: { type: String, default: null, index: true },
    stripePaymentIntentId: { type: String, default: null },
    paymentIntentId: { type: String, default: null },

    walletBalanceBefore: { type: Number, default: 0, min: 0 },
    walletBalanceAfter: { type: Number, default: 0, min: 0 },

    note: { type: String, default: "" },

    addedByAdminId: { type: String, default: null },
    addedByAdminEmail: { type: String, default: null },

    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const FreezeHistorySchema = new Schema(
  {
    brandId: { type: String, required: true, index: true },
    campaignId: { type: String, required: true, index: true },

    amount: { type: Number, required: true, min: 0 },

    walletBalanceBefore: { type: Number, default: 0, min: 0 },
    walletBalanceAfter: { type: Number, default: 0, min: 0 },

    frozenBalanceBefore: { type: Number, default: 0, min: 0 },
    frozenBalanceAfter: { type: Number, default: 0, min: 0 },

    campaignFrozenBefore: { type: Number, default: 0, min: 0 },
    campaignFrozenAfter: { type: Number, default: 0, min: 0 },

    note: { type: String, default: "" },

    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const AllocationHistorySchema = new Schema(
  {
    brandId: { type: String, required: true, index: true },
    campaignId: { type: String, required: true, index: true },
    influencerId: { type: String, required: true, index: true },

    amount: { type: Number, required: true, min: 0 },

    availableToAllocateBefore: { type: Number, default: 0, min: 0 },
    availableToAllocateAfter: { type: Number, default: 0, min: 0 },

    influencerAllocatedBefore: { type: Number, default: 0, min: 0 },
    influencerAllocatedAfter: { type: Number, default: 0, min: 0 },

    note: { type: String, default: "" },

    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const WithdrawHistorySchema = new Schema(
  {
    brandId: { type: String, required: true, index: true },

    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "usd", lowercase: true },

    status: {
      type: String,
      enum: ["success", "pending", "failed"],
      default: "success",
      index: true,
    },

    method: {
      type: String,
      enum: ["manual", "bank", "upi", "stripe", "razorpayx"],
      default: "manual",
    },

    transactionId: { type: String, default: null },

    walletBalanceBefore: { type: Number, default: 0, min: 0 },
    walletBalanceAfter: { type: Number, default: 0, min: 0 },

    note: { type: String, default: "" },

    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const BrandWalletSchema = new Schema(
  {
    brandId: { type: String, required: true, unique: true, index: true },
    walletBalance: { type: Number, default: 0, min: 0 },
    frozenBalance: { type: Number, default: 0, min: 0 },

    freezes: { type: [CampaignFreezeSchema], default: [] },

    topups: { type: [WalletTopupSchema], default: [] },

    freezeHistories: { type: [FreezeHistorySchema], default: [] },

    allocationHistories: { type: [AllocationHistorySchema], default: [] },

    withdrawHistories: { type: [WithdrawHistorySchema], default: [] },
  },
  { timestamps: true }
);

BrandWalletSchema.index({ brandId: 1 });
BrandWalletSchema.index({ brandId: 1, "freezes.campaignId": 1 });
BrandWalletSchema.index({
  brandId: 1,
  "freezes.campaignId": 1,
  "freezes.influencerAllocations.influencerId": 1,
});
BrandWalletSchema.index({ brandId: 1, "topups.stripeSessionId": 1 });
BrandWalletSchema.index({ brandId: 1, "freezeHistories.campaignId": 1 });
BrandWalletSchema.index({
  brandId: 1,
  "allocationHistories.campaignId": 1,
  "allocationHistories.influencerId": 1,
});

const BrandWalletModel = model("BrandWallet", BrandWalletSchema);

module.exports = { BrandWalletModel };