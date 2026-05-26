const Stripe = require("stripe");
const { ApiResponse } = require("../core/http/ApiResponse");
const { HttpStatus } = require("../core/http/HttpStatus");
const { BrandWalletModel } = require("../models/brandWallet");
const saveErrorLog = require("../services/errorLog.service");

// ---------------- Helpers ----------------
const clean = (v) => String(v ?? "").trim();

const getRequestId = (req) =>
  req.requestId || req.id || req.headers?.["x-request-id"] || "NA";

const EC = (code) => code;

const toNumber = (v, def = 0) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;

  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  return def;
};

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const calcAllocationTotal = (allocations = []) =>
  allocations.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

const calcReleasedTotal = (allocations = []) =>
  allocations.reduce((sum, item) => sum + (Number(item.releasedAmount) || 0), 0);

const syncCampaignFreeze = (freeze) => {
  if (!freeze) return null;

  freeze.influencerAllocations = Array.isArray(freeze.influencerAllocations)
    ? freeze.influencerAllocations
    : [];

  freeze.influencerAllocations.forEach((allocation) => {
    allocation.amount = roundMoney(allocation.amount);
    allocation.releasedAmount = roundMoney(allocation.releasedAmount);

    allocation.pendingAmount = Math.max(
      0,
      roundMoney(
        Number(allocation.amount || 0) - Number(allocation.releasedAmount || 0)
      )
    );

    if (allocation.pendingAmount <= 0 && allocation.amount > 0) {
      allocation.status = "released";
    } else if (allocation.releasedAmount > 0) {
      allocation.status = "partially_released";
    } else {
      allocation.status = "allocated";
    }
  });

  const totalFrozenAmount = roundMoney(freeze.totalFrozenAmount);
  const totalAllocatedAmount = roundMoney(
    calcAllocationTotal(freeze.influencerAllocations)
  );
  const totalReleasedAmount = roundMoney(
    calcReleasedTotal(freeze.influencerAllocations)
  );

  freeze.totalFrozenAmount = totalFrozenAmount;
  freeze.totalAllocatedAmount = totalAllocatedAmount;
  freeze.totalReleasedAmount = totalReleasedAmount;

  freeze.currentFrozenAmount = Math.max(
    0,
    roundMoney(totalFrozenAmount - totalReleasedAmount)
  );

  freeze.availableToAllocate = Math.max(
    0,
    roundMoney(totalFrozenAmount - totalAllocatedAmount)
  );

  if (freeze.currentFrozenAmount <= 0 && totalFrozenAmount > 0) {
    freeze.status = "released";
  } else if (freeze.availableToAllocate <= 0 && totalFrozenAmount > 0) {
    freeze.status = "fully_allocated";
  } else {
    freeze.status = "active";
  }

  freeze.updatedAt = new Date();

  return freeze;
};

const calcFrozenAll = (freezes = []) =>
  roundMoney(
    freezes.reduce((sum, freeze) => {
      syncCampaignFreeze(freeze);
      return sum + (Number(freeze.currentFrozenAmount) || 0);
    }, 0)
  );

const syncWalletBalances = (wallet) => {
  wallet.freezes = Array.isArray(wallet.freezes) ? wallet.freezes : [];
  wallet.freezes.forEach(syncCampaignFreeze);

  wallet.walletBalance = roundMoney(wallet.walletBalance);
  wallet.frozenBalance = calcFrozenAll(wallet.freezes);

  return {
    walletBalance: wallet.walletBalance,
    frozenBalance: wallet.frozenBalance,
  };
};

const ensureCampaignFreeze = (wallet, brandId, campaignId) => {
  wallet.freezes = Array.isArray(wallet.freezes) ? wallet.freezes : [];

  let freezeIndex = wallet.freezes.findIndex(
    (f) =>
      String(f.brandId) === String(brandId) &&
      String(f.campaignId) === String(campaignId)
  );

  if (freezeIndex === -1) {
    wallet.freezes.push({
      brandId,
      campaignId,
      totalFrozenAmount: 0,
      currentFrozenAmount: 0,
      availableToAllocate: 0,
      totalAllocatedAmount: 0,
      totalReleasedAmount: 0,
      status: "active",
      influencerAllocations: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    freezeIndex = wallet.freezes.length - 1;
  }

  const campaignFreeze = wallet.freezes[freezeIndex];
  syncCampaignFreeze(campaignFreeze);

  return campaignFreeze;
};

const getOrCreateWallet = async (brandId) => {
  let wallet = await BrandWalletModel.findOne({ brandId });

  if (!wallet) {
    wallet = await BrandWalletModel.create({
      brandId,
      walletBalance: 0,
      frozenBalance: 0,
      freezes: [],
      topups: [],
      freezeHistories: [],
      allocationHistories: [],
      withdrawHistories: [],
    });
  }

  syncWalletBalances(wallet);
  await wallet.save();

  return wallet;
};

let stripeClient = null;

const getStripeClient = () => {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }

  return stripeClient;
};

// ======================================================================
// GET /brand-wallet?brandId=xxxx
// ======================================================================
const getBrandWallet = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(
      typeof req.query.brandId === "string" ? req.query.brandId : ""
    );

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({ brandId });

    if (!wallet) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          brandId,
          walletBalance: 0,
          frozenBalance: 0,
          freezes: [],
        },
        requestId
      );
    }

    const snap = syncWalletBalances(wallet);
    await wallet.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId,
        walletBalance: snap.walletBalance,
        frozenBalance: snap.frozenBalance,
        freezes: wallet.freezes || [],
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "GET_BRAND_WALLET_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// POST /brand-wallet/topup
// body: { brandId, amount, currency, successUrl, cancelUrl }
// Creates Stripe Checkout Session
// ======================================================================
const topupBrandWallet = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const amount = roundMoney(Math.max(0, toNumber(req.body.amount, 0)));
    const currency = clean(req.body.currency || "usd").toLowerCase();
    const successUrl = clean(req.body.successUrl);
    const cancelUrl = clean(req.body.cancelUrl);

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    if (!amount || amount <= 0) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "amount must be > 0",
        requestId
      );
    }

    if (!successUrl || !cancelUrl) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "successUrl and cancelUrl are required",
        requestId
      );
    }

    const stripe = getStripeClient();

    await getOrCreateWallet(brandId);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: Math.round(amount * 100),
            product_data: {
              name: "Brand wallet topup",
              description: `Wallet topup for brand ${brandId}`,
            },
          },
        },
      ],
      metadata: {
        brandId,
        amount: String(amount),
        currency,
      },
    });

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Stripe checkout session created",
        brandId,
        amount,
        currency,
        sessionId: session.id,
        checkoutUrl: session.url,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "TOPUP_BRAND_WALLET_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// POST /brand-wallet/topup/confirm
// body: { brandId, sessionId }
// Verifies Stripe payment and credits available walletBalance
// ======================================================================
const confirmBrandWalletTopup = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const sessionId = clean(req.body.sessionId);

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    if (!sessionId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "sessionId is required",
        requestId
      );
    }

    const stripe = getStripeClient();

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"],
    });

    if (!session) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.NOT_FOUND,
        EC("NOT_FOUND"),
        "Stripe session not found",
        requestId
      );
    }

    if (clean(session.metadata?.brandId) !== brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "brandId does not match Stripe session",
        requestId
      );
    }

    if (session.payment_status !== "paid") {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("PAYMENT_NOT_COMPLETED"),
        "Stripe payment is not completed",
        requestId
      );
    }

    const amount = roundMoney(toNumber(session.amount_total, 0) / 100);
    const currency = clean(session.currency || "usd").toLowerCase();

    if (!amount || amount <= 0) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Invalid paid amount received from Stripe",
        requestId
      );
    }

    const wallet = await getOrCreateWallet(brandId);

    wallet.topups = Array.isArray(wallet.topups) ? wallet.topups : [];

    const alreadyCredited = wallet.topups.some(
      (t) =>
        clean(t?.stripeSessionId) === session.id &&
        clean(t?.status).toLowerCase() === "success"
    );

    if (!alreadyCredited) {
      const walletBalanceBefore = roundMoney(wallet.walletBalance);
      const walletBalanceAfter = roundMoney(walletBalanceBefore + amount);

      wallet.walletBalance = walletBalanceAfter;

      wallet.topups.push({
        amount,
        currency,
        status: "success",
        source: "stripe",
        stripeSessionId: session.id,
        stripePaymentIntentId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id || "",
        walletBalanceBefore,
        walletBalanceAfter,
        createdAt: new Date(),
      });

      wallet.markModified("topups");
    }

    syncWalletBalances(wallet);
    await wallet.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: alreadyCredited
          ? "Wallet topup already confirmed"
          : "Wallet topped up successfully",
        brandId,
        addedAmount: amount,
        walletBalance: wallet.walletBalance,
        frozenBalance: wallet.frozenBalance,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "CONFIRM_BRAND_WALLET_TOPUP_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// POST /brand-wallet/freeze-campaign
// body: { brandId, campaignId, amount, note? }
// Deducts amount from walletBalance and moves it to frozenBalance
// ======================================================================
const freezeAmountForCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const campaignId = clean(req.body.campaignId);
    const amount = roundMoney(Math.max(0, toNumber(req.body.amount, 0)));
    const note = clean(req.body.note);

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    if (!campaignId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "campaignId is required",
        requestId
      );
    }

    if (!amount || amount <= 0) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "amount must be > 0",
        requestId
      );
    }

    const wallet = await getOrCreateWallet(brandId);

    syncWalletBalances(wallet);

    if (amount > Number(wallet.walletBalance || 0)) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("INSUFFICIENT_WALLET_BALANCE"),
        "Freeze amount cannot be greater than walletBalance",
        requestId
      );
    }

    const walletBalanceBefore = roundMoney(wallet.walletBalance);
    const walletBalanceAfter = roundMoney(walletBalanceBefore - amount);

    const frozenBalanceBefore = roundMoney(wallet.frozenBalance);

    const campaignFreeze = ensureCampaignFreeze(wallet, brandId, campaignId);

    const campaignFrozenBefore = roundMoney(campaignFreeze.totalFrozenAmount);
    const campaignFrozenAfter = roundMoney(campaignFrozenBefore + amount);

    wallet.walletBalance = walletBalanceAfter;

    campaignFreeze.totalFrozenAmount = campaignFrozenAfter;

    syncCampaignFreeze(campaignFreeze);
    syncWalletBalances(wallet);

    const frozenBalanceAfter = roundMoney(wallet.frozenBalance);

    wallet.freezeHistories = Array.isArray(wallet.freezeHistories)
      ? wallet.freezeHistories
      : [];

    wallet.freezeHistories.push({
      brandId,
      campaignId,
      amount,
      walletBalanceBefore,
      walletBalanceAfter,
      frozenBalanceBefore,
      frozenBalanceAfter,
      campaignFrozenBefore,
      campaignFrozenAfter,
      note,
      createdAt: new Date(),
    });

    wallet.markModified("freezes");
    wallet.markModified("freezeHistories");

    await wallet.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Amount frozen for campaign successfully",
        brandId,
        campaignId,
        frozenAmount: amount,
        walletBalance: wallet.walletBalance,
        frozenBalance: wallet.frozenBalance,
        campaignFreeze,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "FREEZE_AMOUNT_FOR_CAMPAIGN_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// POST /brand-wallet/allocate-to-influencer
// body: { brandId, campaignId, influencerId, amount?, note? }
// If amount is not passed, allocates all availableToAllocate to influencer
// ======================================================================
const allocateToInfluencer = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const campaignId = clean(req.body.campaignId);
    const influencerId = clean(req.body.influencerId);
    const requestedAmount = roundMoney(toNumber(req.body.amount, 0));
    const note = clean(req.body.note);

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    if (!campaignId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "campaignId is required",
        requestId
      );
    }

    if (!influencerId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "influencerId is required",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({ brandId });

    if (!wallet) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.NOT_FOUND,
        EC("NOT_FOUND"),
        "Brand wallet not found",
        requestId
      );
    }

    const campaignFreeze = (wallet.freezes || []).find(
      (freeze) =>
        String(freeze.brandId) === String(brandId) &&
        String(freeze.campaignId) === String(campaignId)
    );

    if (!campaignFreeze) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.NOT_FOUND,
        EC("NOT_FOUND"),
        "No frozen amount found for this campaign",
        requestId
      );
    }

    syncCampaignFreeze(campaignFreeze);

    const availableToAllocateBefore = roundMoney(
      campaignFreeze.availableToAllocate
    );

    const amount =
      requestedAmount && requestedAmount > 0
        ? requestedAmount
        : availableToAllocateBefore;

    if (!amount || amount <= 0) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "No amount available to allocate",
        requestId
      );
    }

    if (amount > availableToAllocateBefore) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("INSUFFICIENT_CAMPAIGN_FREEZE_BALANCE"),
        "Allocation amount cannot be greater than campaign available frozen amount",
        requestId
      );
    }

    campaignFreeze.influencerAllocations = Array.isArray(
      campaignFreeze.influencerAllocations
    )
      ? campaignFreeze.influencerAllocations
      : [];

    let allocation = campaignFreeze.influencerAllocations.find(
      (item) => String(item.influencerId) === String(influencerId)
    );

    if (!allocation) {
      campaignFreeze.influencerAllocations.push({
        influencerId,
        amount: 0,
        releasedAmount: 0,
        pendingAmount: 0,
        status: "allocated",
        allocatedAt: new Date(),
        lastAllocatedAt: new Date(),
      });

      allocation =
        campaignFreeze.influencerAllocations[
          campaignFreeze.influencerAllocations.length - 1
        ];
    }

    const influencerAllocatedBefore = roundMoney(allocation.amount);
    const influencerAllocatedAfter = roundMoney(
      influencerAllocatedBefore + amount
    );

    allocation.amount = influencerAllocatedAfter;
    allocation.pendingAmount = roundMoney(
      Number(allocation.amount || 0) - Number(allocation.releasedAmount || 0)
    );
    allocation.lastAllocatedAt = new Date();

    syncCampaignFreeze(campaignFreeze);

    const availableToAllocateAfter = roundMoney(
      campaignFreeze.availableToAllocate
    );

    wallet.allocationHistories = Array.isArray(wallet.allocationHistories)
      ? wallet.allocationHistories
      : [];

    wallet.allocationHistories.push({
      brandId,
      campaignId,
      influencerId,
      amount,
      availableToAllocateBefore,
      availableToAllocateAfter,
      influencerAllocatedBefore,
      influencerAllocatedAfter,
      note,
      createdAt: new Date(),
    });

    wallet.markModified("freezes");
    wallet.markModified("allocationHistories");

    syncWalletBalances(wallet);

    await wallet.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Amount allocated to influencer successfully",
        brandId,
        campaignId,
        influencerId,
        allocatedAmount: amount,
        walletBalance: wallet.walletBalance,
        frozenBalance: wallet.frozenBalance,
        campaignFreeze,
        influencerAllocation: allocation,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "ALLOCATE_TO_INFLUENCER_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// POST /brand-wallet/withdraw
// body: { brandId, amount, currency?, method?, transactionId?, note? }
// Withdraws from walletBalance only
// ======================================================================
const withdrawBrandWalletAmount = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const amount = roundMoney(Math.max(0, toNumber(req.body.amount, 0)));
    const currency = clean(req.body.currency || "usd").toLowerCase();
    const method = clean(req.body.method || "manual");
    const transactionId = clean(req.body.transactionId);
    const note = clean(req.body.note);

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    if (!amount || amount <= 0) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "amount must be > 0",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({ brandId });

    if (!wallet) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.NOT_FOUND,
        EC("NOT_FOUND"),
        "Brand wallet not found",
        requestId
      );
    }

    syncWalletBalances(wallet);

    if (amount > Number(wallet.walletBalance || 0)) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("INSUFFICIENT_WALLET_BALANCE"),
        "Withdraw amount cannot be greater than walletBalance",
        requestId
      );
    }

    const walletBalanceBefore = roundMoney(wallet.walletBalance);
    const walletBalanceAfter = roundMoney(walletBalanceBefore - amount);

    wallet.walletBalance = walletBalanceAfter;

    wallet.withdrawHistories = Array.isArray(wallet.withdrawHistories)
      ? wallet.withdrawHistories
      : [];

    wallet.withdrawHistories.push({
      brandId,
      amount,
      currency,
      status: "success",
      method,
      transactionId: transactionId || null,
      walletBalanceBefore,
      walletBalanceAfter,
      note,
      createdAt: new Date(),
    });

    wallet.markModified("withdrawHistories");

    syncWalletBalances(wallet);

    await wallet.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Wallet amount withdrawn successfully",
        brandId,
        withdrawnAmount: amount,
        walletBalance: wallet.walletBalance,
        frozenBalance: wallet.frozenBalance,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "WITHDRAW_BRAND_WALLET_AMOUNT_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// GET /brand-wallet/freeze-amount?brandId=xxx&campaignId=xxx&influencerId=xxx
// ======================================================================
const getFrozenAmountForCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(
      typeof req.query.brandId === "string" ? req.query.brandId : ""
    );
    const campaignId = clean(
      typeof req.query.campaignId === "string" ? req.query.campaignId : ""
    );
    const influencerId = clean(
      typeof req.query.influencerId === "string" ? req.query.influencerId : ""
    );

    if (!brandId || !campaignId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "brandId and campaignId are required",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({ brandId });

    if (!wallet) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          brandId,
          campaignId,
          walletBalance: 0,
          frozenBalance: 0,
          totalFrozenAmount: 0,
          currentFrozenAmount: 0,
          totalAllocatedAmount: 0,
          totalReleasedAmount: 0,
          availableToAllocate: 0,
          influencer: influencerId
            ? {
                influencerId,
                amount: 0,
                releasedAmount: 0,
                pendingAmount: 0,
              }
            : null,
        },
        requestId
      );
    }

    syncWalletBalances(wallet);

    const campaignFreeze = (wallet.freezes || []).find(
      (f) =>
        String(f.brandId) === String(brandId) &&
        String(f.campaignId) === String(campaignId)
    );

    if (!campaignFreeze) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          brandId,
          campaignId,
          walletBalance: wallet.walletBalance,
          frozenBalance: wallet.frozenBalance,
          totalFrozenAmount: 0,
          currentFrozenAmount: 0,
          totalAllocatedAmount: 0,
          totalReleasedAmount: 0,
          availableToAllocate: 0,
          influencer: influencerId
            ? {
                influencerId,
                amount: 0,
                releasedAmount: 0,
                pendingAmount: 0,
              }
            : null,
        },
        requestId
      );
    }

    syncCampaignFreeze(campaignFreeze);

    let influencer = null;

    if (influencerId) {
      const allocation = (campaignFreeze.influencerAllocations || []).find(
        (a) => String(a.influencerId) === String(influencerId)
      );

      influencer = allocation
        ? {
            influencerId,
            amount: Number(allocation.amount || 0),
            releasedAmount: Number(allocation.releasedAmount || 0),
            pendingAmount: Number(allocation.pendingAmount || 0),
            status: allocation.status || "allocated",
          }
        : {
            influencerId,
            amount: 0,
            releasedAmount: 0,
            pendingAmount: 0,
          };
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId,
        campaignId,
        walletBalance: wallet.walletBalance,
        frozenBalance: wallet.frozenBalance,
        totalFrozenAmount: Number(campaignFreeze.totalFrozenAmount || 0),
        currentFrozenAmount: Number(campaignFreeze.currentFrozenAmount || 0),
        totalAllocatedAmount: Number(campaignFreeze.totalAllocatedAmount || 0),
        totalReleasedAmount: Number(campaignFreeze.totalReleasedAmount || 0),
        availableToAllocate: Number(campaignFreeze.availableToAllocate || 0),
        influencer,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "GET_FROZEN_AMOUNT_FOR_CAMPAIGN_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// GET /brand-wallet/topup-history?brandId=xxx
// ======================================================================
const getWalletTopup = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(
      typeof req.query.brandId === "string" ? req.query.brandId : ""
    );

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({ brandId })
      .select("brandId topups")
      .lean();

    if (!wallet) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          brandId,
          wallettopup: [],
        },
        requestId
      );
    }

    const wallettopup = Array.isArray(wallet.topups)
      ? [...wallet.topups].sort(
          (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        )
      : [];

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId,
        wallettopup,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "GET_WALLET_TOPUP_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// GET /brand-wallet/history?brandId=xxx
// ======================================================================
const getBrandWalletHistory = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(
      typeof req.query.brandId === "string" ? req.query.brandId : ""
    );

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({ brandId })
      .select(
        "brandId topups freezeHistories allocationHistories withdrawHistories"
      )
      .lean();

    if (!wallet) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          brandId,
          topups: [],
          freezeHistories: [],
          allocationHistories: [],
          withdrawHistories: [],
          transactions: [],
        },
        requestId
      );
    }

    const topups = Array.isArray(wallet.topups) ? wallet.topups : [];
    const freezeHistories = Array.isArray(wallet.freezeHistories)
      ? wallet.freezeHistories
      : [];
    const allocationHistories = Array.isArray(wallet.allocationHistories)
      ? wallet.allocationHistories
      : [];
    const withdrawHistories = Array.isArray(wallet.withdrawHistories)
      ? wallet.withdrawHistories
      : [];

    const transactions = [
      ...topups.map((item) => ({
        type: "topup",
        amount: item.amount,
        currency: item.currency,
        status: item.status,
        createdAt: item.createdAt,
        raw: item,
      })),
      ...freezeHistories.map((item) => ({
        type: "campaign_freeze",
        amount: item.amount,
        campaignId: item.campaignId,
        createdAt: item.createdAt,
        raw: item,
      })),
      ...allocationHistories.map((item) => ({
        type: "influencer_allocation",
        amount: item.amount,
        campaignId: item.campaignId,
        influencerId: item.influencerId,
        createdAt: item.createdAt,
        raw: item,
      })),
      ...withdrawHistories.map((item) => ({
        type: "withdraw",
        amount: item.amount,
        currency: item.currency,
        status: item.status,
        createdAt: item.createdAt,
        raw: item,
      })),
    ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId,
        topups: [...topups].sort(
          (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        ),
        freezeHistories: [...freezeHistories].sort(
          (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        ),
        allocationHistories: [...allocationHistories].sort(
          (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        ),
        withdrawHistories: [...withdrawHistories].sort(
          (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        ),
        transactions,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, 500, "GET_BRAND_WALLET_HISTORY_ERROR");
    const message = err instanceof Error ? err.message : "Internal error";

    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

module.exports = {
  getBrandWallet,
  topupBrandWallet,
  confirmBrandWalletTopup,

  freezeAmountForCampaign,
  allocateToInfluencer,
  withdrawBrandWalletAmount,

  getFrozenAmountForCampaign,
  getWalletTopup,
  getBrandWalletHistory,

  calcFrozenAll,
  syncCampaignFreeze,
  syncWalletBalances,
  ensureCampaignFreeze,
  getOrCreateWallet,
};