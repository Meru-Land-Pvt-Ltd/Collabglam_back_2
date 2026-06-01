// controllers/subscriptionController.js

const SubscriptionPlan = require("../models/subscription");

const BrandModelImport = require("../models/brand");
const InfluencerModelImport = require("../models/influencer");

const Brand =
  BrandModelImport?.BrandModel ||
  BrandModelImport?.default ||
  BrandModelImport;

const Influencer =
  InfluencerModelImport?.InfluencerModel ||
  InfluencerModelImport?.default ||
  InfluencerModelImport;

const subscriptionHelper = require("../utils/subscriptionHelper");
const { sendEmail, uploadEmailRecordToS3 } = require("../services/emailService");
const saveErrorLog = require("../services/errorLog.service");

function assertValidModel(Model, label) {
  if (!Model || typeof Model.find !== "function") {
    throw new Error(`${label} model is invalid. Expected a Mongoose model.`);
  }
}

assertValidModel(Brand, "Brand");
assertValidModel(Influencer, "Influencer");

function featureValueToLimit(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && value.unlimited === true) return -1;
  return 0;
}

function getUserEmail(user) {
  return String(
    user?.email ||
    user?.proxyEmail ||
    user?.contactEmail ||
    ""
  )
    .trim()
    .toLowerCase();
}

function getUserDisplayName(user, userType) {
  if (userType === "Brand") {
    return user?.brandName || user?.name || "Brand User";
  }

  return user?.name || user?.fullName || user?.username || "Influencer";
}

function formatDateTime(value) {
  if (!value) return "N/A";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "N/A";
  return d.toUTCString();
}

function buildSubscriptionEmailTemplate({
  userType,
  userName,
  planName,
  oldPlanName,
  expiresAt,
  eventType,
}) {
  const endDate = formatDateTime(expiresAt);
  const appName = "Collabglam";

  let subject = "";
  let heading = "";
  let intro = "";

  if (eventType === "upgraded") {
    subject = `${appName}: Your ${userType} plan has been upgraded`;
    heading = "Your subscription has been upgraded";
    intro = oldPlanName
      ? `Your plan has been upgraded from <strong>${oldPlanName}</strong> to <strong>${planName}</strong>.`
      : `Your subscription is now active on the <strong>${planName}</strong> plan.`;
  } else if (eventType === "renewed") {
    subject = `${appName}: Your ${userType} plan has been renewed`;
    heading = "Your subscription has been renewed";
    intro = `Your <strong>${planName}</strong> subscription has been renewed successfully.`;
  } else if (eventType === "expiring_soon") {
    subject = `${appName}: Your ${userType} subscription is about to end`;
    heading = "Your subscription is ending soon";
    intro = `Your <strong>${planName}</strong> subscription is about to expire.`;
  } else if (eventType === "expired") {
    subject = `${appName}: Your ${userType} subscription has ended`;
    heading = "Your subscription has ended";
    intro = `Your <strong>${planName}</strong> subscription has expired.`;
  } else {
    subject = `${appName}: Subscription update`;
    heading = "Subscription update";
    intro = `There is an update on your <strong>${planName}</strong> subscription.`;
  }

  const text = [
    `Hello ${userName},`,
    "",
    intro.replace(/<[^>]+>/g, ""),
    `Plan: ${planName || "N/A"}`,
    `Ends on: ${endDate}`,
    "",
    "If you need help, please contact support.",
    "",
    `- ${appName}`,
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;">
      <h2>${heading}</h2>
      <p>Hello ${userName},</p>
      <p>${intro}</p>
      <p><strong>Plan:</strong> ${planName || "N/A"}</p>
      <p><strong>Ends on:</strong> ${endDate}</p>
      <p>If you need help, please contact support.</p>
      <p>– ${appName}</p>
    </div>
  `;

  return { subject, text, html };
}

async function sendSubscriptionLifecycleEmail({
  userType,
  user,
  plan,
  oldPlanName = null,
  eventType,
}) {
  try {
    const to = getUserEmail(user);

    if (!to) {
      console.warn(`[subscription-email] skipped: no email for ${userType}`, {
        userId: user?._id || user?.influencerId,
        eventType,
      });
      return;
    }

    const userName = getUserDisplayName(user, userType);
    const planName =
      plan?.displayName ||
      plan?.label ||
      plan?.name ||
      user?.subscription?.planName ||
      "Plan";
    const expiresAt = user?.subscription?.expiresAt || null;

    const { subject, text, html } = buildSubscriptionEmailTemplate({
      userType,
      userName,
      planName,
      oldPlanName,
      expiresAt,
      eventType,
    });

    const emailResp = await sendEmail({
      to,
      subject,
      text,
      html,
      emailTags: [
        { Name: "module", Value: "subscription" },
        { Name: "event", Value: eventType },
        { Name: "userType", Value: String(userType).toLowerCase() },
      ],
    });

    try {
      await uploadEmailRecordToS3({
        type: "subscription_lifecycle",
        eventType,
        userType,
        userId: String(user?._id || user?.influencerId || ""),
        email: to,
        planId: plan?.planId || user?.subscription?.planId || null,
        planName,
        oldPlanName,
        expiresAt,
        emailMessageId: emailResp?.messageId || null,
        sentAt: new Date().toISOString(),
      });
    } catch (archiveErr) {
      console.error("[subscription-email] archive failed:", archiveErr);
    }
  } catch (err) {
    console.error("[subscription-email] send failed:", err);
  }
}

const HIDDEN_FEATURE_KEYS = new Set([
  "marketplace_fee_percent",
  "platform_fee_on_payouts_percent",
]);

function sanitizePlanForResponse(plan) {
  if (!plan || typeof plan !== "object") return plan;

  const out = { ...plan };

  if (Array.isArray(plan.features)) {
    out.features = plan.features.filter(
      (f) => f && typeof f === "object" && !HIDDEN_FEATURE_KEYS.has(f.key)
    );
  }

  return out;
}

function sanitizePlansForResponse(plans) {
  if (!Array.isArray(plans)) return [];
  return plans.map(sanitizePlanForResponse);
}

function getQueryForUser(userType, userId) {
  return userType === "Brand" ? { _id: userId } : { _id: userId };
}

function buildFeatureSnapshot(plan, previousFeatures = [], options = {}) {
  const { preserveUsed = false, capUsedToLimit = false } = options;

  const previousMap = new Map(
    (Array.isArray(previousFeatures) ? previousFeatures : [])
      .filter((f) => f && f.key)
      .map((f) => [f.key, f])
  );

  return (plan.features || []).map((f) => {
    const limit = featureValueToLimit(f.value);
    const oldUsedRaw = previousMap.get(f.key)?.used;
    const oldUsed = Number(oldUsedRaw);

    let used =
      preserveUsed && Number.isFinite(oldUsed) && oldUsed > 0 ? oldUsed : 0;

    // On downgrade to free, do not allow used to exceed free limit.
    // Example: paid used 120, free limit 20 => used becomes 20, remaining = 0.
    if (capUsedToLimit && limit >= 0) {
      used = Math.min(used, limit);
    }

    return {
      key: f.key,
      limit,
      used,
    };
  });
}

function isFreePlanLike(planOrSub = {}) {
  const name = String(planOrSub?.name || planOrSub?.planName || "")
    .trim()
    .toLowerCase();

  return (
    name === "free" ||
    planOrSub?.monthlyCost === 0 ||
    planOrSub?.isFree === true ||
    String(planOrSub?.slug || "").toLowerCase() === "free"
  );
}

async function downgradeUserToFreePlan(user, userType, now = new Date(), options = {}) {
  const freePlan = await subscriptionHelper.getFreePlan(userType);

  const oldSubscription = user.subscription || {};
  const previousFeatures = Array.isArray(oldSubscription.features)
    ? oldSubscription.features
    : [];

  const alreadyFree =
    String(oldSubscription.planId || "") === String(freePlan.planId || "") ||
    String(oldSubscription.planName || "").toLowerCase() === "free";

  user.subscription = user.subscription || {};

  // Use actual free planId while degrading.
  user.subscription.planId = freePlan.planId;
  user.subscription.planName = freePlan.name || "free";
  user.subscription.startedAt = alreadyFree
    ? oldSubscription.startedAt || now
    : now;

  // Free plan should not expire automatically.
  user.subscription.expiresAt = null;

  // Do not reload free credits for users already on free.
  // For paid -> free, preserve used values so credits do not restart from 0.
  if (
    !alreadyFree ||
    options.rebuildFeatures === true ||
    !Array.isArray(user.subscription.features) ||
    user.subscription.features.length === 0
  ) {
    user.subscription.features = buildFeatureSnapshot(freePlan, previousFeatures, {
      preserveUsed: true,
      capUsedToLimit: true,
    });
  }

  user.subscription.lastExpiringSoonEmailSentAt = null;

  if (options.markExpiredEmailSent) {
    user.subscription.lastExpiredEmailSentAt = now;
  }

  user.subscriptionExpired = false;

  await user.save();

  return freePlan;
}

async function maybeDowngradeExpiredUser(user, userType, now = new Date()) {
  const sub = user?.subscription || {};

  if (!sub.planId) {
    return { downgraded: false, reason: "no_plan" };
  }

  if (!subscriptionHelper.isExpiredByDate(sub.expiresAt, now)) {
    return { downgraded: false, reason: "not_expired" };
  }

  const currentPlan = await SubscriptionPlan.findOne({
    planId: sub.planId,
  }).lean();

  if (isFreePlanLike(currentPlan) || isFreePlanLike(sub)) {
    await downgradeUserToFreePlan(user, userType, now, {
      rebuildFeatures: false,
    });

    return {
      downgraded: false,
      reason: "already_free",
      oldPlan: currentPlan,
    };
  }

  const freePlan = await downgradeUserToFreePlan(user, userType, now);

  return {
    downgraded: true,
    reason: "expired_paid_plan",
    oldPlan: currentPlan,
    freePlan,
  };
}

function normalizedMonthlyCost(plan) {
  if (!plan) return 0;
  if (plan.isCustomPricing) return Number.MAX_SAFE_INTEGER;
  if (typeof plan.monthlyCost === "number") return plan.monthlyCost;
  if (typeof plan.annualCost === "number") return plan.annualCost / 12;
  return 0;
}

// POST /subscription-plans/create
exports.createPlan = async (req, res) => {
  try {
    const {
      role,
      name,
      displayName,
      label,
      monthlyCost,
      annualCost,
      currency,
      isCustomPricing,
      isStartingAt,
      bestFor,
      mainOutcome,
      overview,
      cta,
      features,
      addons,
      durationDays,
      durationMins,
      durationMinutes,
      autoRenew,
      status,
      sortOrder,
    } = req.body;

    if (!role || !name || monthlyCost == null) {
      return res
        .status(400)
        .json({ message: "role, name and monthlyCost are required" });
    }

    if (!["Brand", "Influencer"].includes(role)) {
      return res.status(400).json({ message: "role must be Brand or Influencer" });
    }

    const plan = new SubscriptionPlan({
      role,
      name,
      displayName: displayName || name.toUpperCase(),
      label: label || undefined,
      monthlyCost,
      annualCost: annualCost ?? undefined,
      currency: currency || "USD",
      isCustomPricing: !!isCustomPricing,
      isStartingAt: !!isStartingAt,
      bestFor: bestFor || undefined,
      mainOutcome: mainOutcome || undefined,
      overview: overview || undefined,
      cta: cta || undefined,
      features: Array.isArray(features) ? features : [],
      addons: Array.isArray(addons) ? addons : [],
      durationDays: durationDays ?? undefined,
      durationMins: durationMins ?? undefined,
      durationMinutes: durationMinutes ?? undefined,
      autoRenew: autoRenew ?? true,
      status: status || "active",
      sortOrder: sortOrder ?? 100,
    });

    await plan.save();
    return res.status(201).json({ message: "Subscription plan created", plan });
  } catch (err) {
    console.error("createPlan error:", err);


    await saveErrorLog(req, err, err?.code === 11000 ? 409 : err?.response?.status || err?.statusCode || err?.status || 500, "CREATE_PLAN_ERROR"); if (err?.code === 11000) {
      return res.status(409).json({
        message: "Plan already exists (duplicate role+name or planId).",
        detail: err.keyValue,
      });
    }

    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/list
exports.getPlans = async (req, res) => {
  const { role, includeArchived } = req.body || {};
  const filter = {};

  if (role) filter.role = role;
  if (!includeArchived) filter.status = "active";

  try {
    const plans = await SubscriptionPlan.find(filter)
      .sort({ sortOrder: 1, monthlyCost: 1 })
      .lean();

    const safePlans = sanitizePlansForResponse(plans);

    return res.status(200).json({ message: "Plans retrieved", plans: safePlans });
  } catch (err) {
    console.error("getPlans error:", err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, "GET_PLANS_ERROR"); return res.status(500).json({ message: "Internal server error" });
  }
};

// GET /subscription-plans/getById?id=<planId>
exports.getPlanById = async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ message: "Query param id is required" });

  try {
    const plan = await SubscriptionPlan.findOne({ planId: id }).lean();
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    const safePlan = sanitizePlanForResponse(plan);
    return res.status(200).json({ message: "Plan retrieved", plan: safePlan });
  } catch (err) {
    console.error("getPlanById error:", err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, "GET_PLAN_BY_ID_ERROR"); return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/update
exports.updatePlan = async (req, res) => {
  const { planId, id, ...updates } = req.body || {};
  const targetPlanId = planId || id;

  if (!targetPlanId) {
    return res.status(400).json({ message: "planId (or id) is required" });
  }

  delete updates.planId;

  try {
    const plan = await SubscriptionPlan.findOneAndUpdate(
      { planId: targetPlanId },
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();

    if (!plan) return res.status(404).json({ message: "Plan not found" });

    return res.status(200).json({ message: "Plan updated", plan });
  } catch (err) {
    console.error("updatePlan error:", err);


    await saveErrorLog(req, err, err?.code === 11000 ? 409 : err?.response?.status || err?.statusCode || err?.status || 500, "UPDATE_PLAN_ERROR"); if (err?.code === 11000) {
      return res.status(409).json({
        message: "Update causes duplicate role+name (or duplicate unique field).",
        detail: err.keyValue,
      });
    }

    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/delete
exports.deletePlan = async (req, res) => {
  const { planId, id } = req.body || {};
  const targetPlanId = planId || id;

  if (!targetPlanId) {
    return res.status(400).json({ message: "Plan id (planId or id) is required" });
  }

  try {
    const plan = await SubscriptionPlan.findOneAndDelete({ planId: targetPlanId });
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    return res.status(200).json({ message: "Plan deleted" });
  } catch (err) {
    console.error("deletePlan error:", err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, "DELETE_PLAN_ERROR"); return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/assign
// body: { userType: 'Brand'|'Influencer', userId, planId }
exports.assignPlan = async (req, res) => {
  try {
    const { userType, userId, planId } = req.body || {};

    if (!userType || !userId || !planId) {
      return res
        .status(400)
        .json({ message: "userType, userId & planId are required" });
    }

    if (!["Brand", "Influencer"].includes(userType)) {
      return res.status(400).json({ message: "userType must be Brand or Influencer" });
    }

    const Model = userType === "Brand" ? Brand : Influencer;

    const plan = await SubscriptionPlan.findOne({
      planId,
      role: userType,
      status: "active",
    }).lean();

    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }

    const {
      billingCycle,
      durationDays,
      durationMinutes,
      durationMins,
      expiresAt,
    } = req.body || {};

    const now = new Date();

    const query = getQueryForUser(userType, userId);

    const existingUser = await Model.findOne(query);
    if (!existingUser) {
      return res
        .status(404)
        .json({ message: `${userType} with ID ${userId} not found` });
    }

    const isFreeAssignment = isFreePlanLike(plan);

    const expire = isFreeAssignment
      ? null
      : subscriptionHelper.computeExpiry(plan, {
        billingCycle: billingCycle || "monthly",
        durationDays,
        durationMinutes,
        durationMins,
        expiresAt,
      });

    const featureSnapshot = buildFeatureSnapshot(
      plan,
      existingUser?.subscription?.features,
      {
        preserveUsed: isFreeAssignment,
        capUsedToLimit: isFreeAssignment,
      }
    );

    const oldPlanName = existingUser?.subscription?.planName || "free";

    existingUser.subscription = existingUser.subscription || {};
    existingUser.subscription.planId = plan.planId;
    existingUser.subscription.planName = plan.name;
    existingUser.subscription.startedAt = now;
    existingUser.subscription.expiresAt = expire;
    existingUser.subscription.features = featureSnapshot;
    existingUser.subscription.lastExpiringSoonEmailSentAt = null;
    existingUser.subscription.lastExpiredEmailSentAt = null;
    existingUser.subscriptionExpired = false;

    await existingUser.save();

    await sendSubscriptionLifecycleEmail({
      userType,
      user: existingUser,
      plan,
      oldPlanName,
      eventType: "upgraded",
    });

    return res.json({
      message: `${userType} subscribed to "${plan.name}". It will expire at ${expire.toISOString()}`,
      subscription: existingUser.subscription,
    });
  } catch (error) {
    console.error("assignPlan error:", error);
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "ASSIGN_PLAN_ERROR"
    );

    return res
      .status(500)
      .json({ message: "Internal server error while assigning plan." });
  }
};

// POST /subscription-plans/renew
exports.renewPlan = async (req, res) => {
  try {
    const { userType, userId } = req.body || {};

    if (!userType || !userId) {
      return res.status(400).json({ message: "userType & userId required" });
    }

    if (!["Brand", "Influencer"].includes(userType)) {
      return res.status(400).json({ message: "userType must be Brand or Influencer" });
    }

    const Model = userType === "Brand" ? Brand : Influencer;
    const query = getQueryForUser(userType, userId);

    const user = await Model.findOne(query);

    if (!user) {
      return res
        .status(404)
        .json({ message: `${userType} with ID ${userId} not found` });
    }

    const currentPlanId = user?.subscription?.planId;
    if (!currentPlanId) {
      return res.status(400).json({ message: "User has no active subscription planId" });
    }

    const plan = await SubscriptionPlan.findOne({ planId: currentPlanId }).lean();
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    const now = new Date();
    const isFreeRenewal = isFreePlanLike(plan);

    const currentExpiry = user?.subscription?.expiresAt
      ? new Date(user.subscription.expiresAt)
      : null;

    const renewalBase =
      currentExpiry && !Number.isNaN(currentExpiry.getTime()) && currentExpiry > now
        ? currentExpiry
        : now;

    const newExpires = isFreeRenewal
      ? null
      : subscriptionHelper.computeExpiry(plan, renewalBase, {
        billingCycle: "monthly",
      });

    user.subscription.planId = plan.planId;
    user.subscription.planName = plan.name;
    user.subscription.startedAt = now;
    user.subscription.expiresAt = newExpires;
    user.subscription.features = buildFeatureSnapshot(
      plan,
      user.subscription.features,
      {
        preserveUsed: isFreeRenewal,
        capUsedToLimit: isFreeRenewal,
      }
    );
    user.subscription.lastExpiringSoonEmailSentAt = null;
    user.subscription.lastExpiredEmailSentAt = null;
    user.subscriptionExpired = false;

    await user.save();

    await sendSubscriptionLifecycleEmail({
      userType,
      user,
      plan,
      eventType: "renewed",
    });

    return res.json({
      message: `${userType} subscription renewed until ${newExpires.toISOString()}`,
      subscription: user.subscription,
    });
  } catch (err) {
    console.error("renewPlan error:", err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, "RENEW_PLAN_ERROR"); return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/me
// POST /subscription-plans/me
exports.getMyPlan = async (req, res) => {
  try {
    const { userType, userId } = req.body || {};

    if (!userType || !userId) {
      return res.status(400).json({ message: "userType & userId required" });
    }

    if (!["Brand", "Influencer"].includes(userType)) {
      return res.status(400).json({ message: "userType must be Brand or Influencer" });
    }

    const Model = userType === "Brand" ? Brand : Influencer;
    const query = getQueryForUser(userType, userId);

    const user = await Model.findOne(query);
    if (!user) return res.status(404).json({ message: `${userType} not found` });

    await maybeDowngradeExpiredUser(user, userType);

    const sub = user.subscription || {};
    const planDoc = sub.planId
      ? await SubscriptionPlan.findOne({ planId: sub.planId }).lean()
      : null;

    const safePlanDoc = planDoc ? sanitizePlanForResponse(planDoc) : null;

    return res.json({
      message: "Current subscription fetched",
      plan: safePlanDoc,
      startedAt: sub.startedAt || null,
      expiresAt: sub.expiresAt || null,
      expired: !!user.subscriptionExpired,
    });
  } catch (err) {
    console.error("getMyPlan error:", err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, "GET_MY_PLAN_ERROR"); return res.status(500).json({ message: "Internal server error" });
  }
};

exports.checkBrandPlanChange = async (req, res) => {
  try {
    const { brandId, userId, planId } = req.body || {};
    const targetBrandId = brandId || userId;

    if (!targetBrandId || !planId) {
      return res.status(400).json({ message: "brandId/userId & planId are required" });
    }

    const brand = await Brand.findOne({ _id: targetBrandId }).lean();
    if (!brand) return res.status(404).json({ message: "Brand not found" });

    const requestedPlan = await SubscriptionPlan.findOne({ planId }).lean();
    if (!requestedPlan) {
      return res.status(404).json({ message: "Requested plan not found" });
    }

    const sub = brand.subscription || {};
    const currentPlanId = sub.planId;

    if (!currentPlanId) {
      return res.status(200).json({
        status: "can_subscribe",
        canProceed: true,
        message: "You have no active plan. You can subscribe to this plan.",
        currentPlanId: null,
        requestedPlanId: requestedPlan.planId,
        requestedPlan: sanitizePlanForResponse(requestedPlan),
      });
    }

    const now = new Date();
    const isExpired =
      brand.subscriptionExpired === true ||
      (sub.expiresAt && new Date(sub.expiresAt).getTime() < now.getTime());

    if (isExpired) {
      return res.status(200).json({
        status: "expired_can_subscribe",
        canProceed: true,
        message: "Your subscription is expired. You can subscribe to this plan.",
        currentPlanId,
        requestedPlanId: requestedPlan.planId,
        requestedPlan: sanitizePlanForResponse(requestedPlan),
      });
    }

    if (currentPlanId === requestedPlan.planId) {
      return res.status(200).json({
        status: "same_plan",
        canProceed: false,
        message: "You are already subscribed to the same plan.",
        currentPlanId,
        requestedPlanId: requestedPlan.planId,
      });
    }

    const currentPlan = await SubscriptionPlan.findOne({ planId: currentPlanId }).lean();

    if (!currentPlan) {
      return res.status(200).json({
        status: "can_subscribe",
        canProceed: true,
        message: "Current plan details not found, you can subscribe to this plan.",
        currentPlanId,
        requestedPlanId: requestedPlan.planId,
        requestedPlan: sanitizePlanForResponse(requestedPlan),
      });
    }

    const currentRank = normalizedMonthlyCost(currentPlan);
    const requestedRank = normalizedMonthlyCost(requestedPlan);

    if (requestedRank < currentRank) {
      return res.status(200).json({
        status: "already_higher",
        canProceed: false,
        message: `You are already on a higher plan (${currentPlan.name}).`,
        currentPlanId: currentPlan.planId,
        requestedPlanId: requestedPlan.planId,
        currentPlan: sanitizePlanForResponse(currentPlan),
        requestedPlan: sanitizePlanForResponse(requestedPlan),
      });
    }

    if (requestedRank > currentRank) {
      return res.status(200).json({
        status: "can_upgrade",
        canProceed: true,
        message: `You can upgrade from ${currentPlan.name} to ${requestedPlan.name}.`,
        currentPlanId: currentPlan.planId,
        requestedPlanId: requestedPlan.planId,
        currentPlan: sanitizePlanForResponse(currentPlan),
        requestedPlan: sanitizePlanForResponse(requestedPlan),
      });
    }

    return res.status(200).json({
      status: "same_tier_different_plan",
      canProceed: true,
      message: `This plan is in the same tier as your current plan (${currentPlan.name}). You can switch if allowed.`,
      currentPlanId: currentPlan.planId,
      requestedPlanId: requestedPlan.planId,
      currentPlan: sanitizePlanForResponse(currentPlan),
      requestedPlan: sanitizePlanForResponse(requestedPlan),
    });
  } catch (err) {
    console.error("checkBrandPlanChange error:", err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, "CHECK_BRAND_PLAN_CHANGE_ERROR"); return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getCurrentBrandPlanLite = async (req, res) => {
  try {
    const brandId = req.query?.brandId;

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required in query" });
    }

    const brand = await Brand.findOne({ _id: brandId });
    if (!brand) {
      return res.status(404).json({ message: "Brand not found" });
    }

    await maybeDowngradeExpiredUser(brand, "Brand");

    const sub = brand.subscription || {};

    if (!sub.planId) {
      const freePlan = await subscriptionHelper.getFreePlan("Brand");

      return res.status(200).json({
        brandPlanId: freePlan.planId,
        brandPlanName: "free",
      });
    }

    let brandPlanId = sub.planId || null;
    let brandPlanName = sub.planName || null;

    if (brandPlanId && !brandPlanName) {
      const plan = await SubscriptionPlan.findOne({ planId: brandPlanId })
        .select("name")
        .lean();

      brandPlanName = plan?.name || null;
    }

    return res.status(200).json({
      brandPlanId,
      brandPlanName: brandPlanName ? String(brandPlanName).toLowerCase() : null,
    });
  } catch (err) {
    console.error("getCurrentBrandPlanLite error:", err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, "GET_CURRENT_BRAND_PLAN_LITE_ERROR"); return res.status(500).json({ message: "Internal server error" });
  }
};

exports.sendExpiringSoonEmails = async (req, res) => {
  try {
    const now = new Date();
    const withinHours = Number(req.body?.withinHours || 48);
    const end = new Date(now.getTime() + withinHours * 60 * 60 * 1000);

    const processUsers = async (Model, userType) => {
      assertValidModel(Model, userType);

      const users = await Model.find({
        "subscription.planId": { $exists: true, $ne: null },
        subscriptionExpired: { $ne: true },
        "subscription.expiresAt": { $gt: now, $lte: end },

        // Send expiring soon email only if it was never sent before.
        $or: [
          { "subscription.lastExpiringSoonEmailSentAt": { $exists: false } },
          { "subscription.lastExpiringSoonEmailSentAt": null },
        ],
      });

      let count = 0;
      let skippedAlreadySent = 0;

      for (const user of users) {
        // Atomic lock: mark as sent before sending email.
        // This prevents duplicate hourly sends or parallel API calls.
        const lockedUser = await Model.findOneAndUpdate(
          {
            _id: user._id,
            $or: [
              { "subscription.lastExpiringSoonEmailSentAt": { $exists: false } },
              { "subscription.lastExpiringSoonEmailSentAt": null },
            ],
          },
          {
            $set: {
              "subscription.lastExpiringSoonEmailSentAt": now,
            },
          },
          { new: true }
        );

        if (!lockedUser) {
          skippedAlreadySent += 1;
          continue;
        }

        const plan = await SubscriptionPlan.findOne({
          planId: lockedUser?.subscription?.planId,
        }).lean();

        await sendSubscriptionLifecycleEmail({
          userType,
          user: lockedUser,
          plan,
          eventType: "expiring_soon",
        });

        count += 1;
      }

      return {
        sent: count,
        skippedAlreadySent,
      };
    };

    const brandResult = await processUsers(Brand, "Brand");
    const influencerResult = await processUsers(Influencer, "Influencer");

    return res.status(200).json({
      message: "Expiring soon emails processed once only",
      brand: brandResult,
      influencer: influencerResult,
      totalSent: brandResult.sent + influencerResult.sent,
      totalSkippedAlreadySent:
        brandResult.skippedAlreadySent + influencerResult.skippedAlreadySent,
    });
  } catch (err) {
    console.error("sendExpiringSoonEmails error:", err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, "SEND_EXPIRING_SOON_EMAILS_ERROR"); return res.status(500).json({ message: "Internal server error" });
  }
};

exports.sendExpiredSubscriptionEmails = async (req, res) => {
  try {
    const now = new Date();
    const todayStart = subscriptionHelper.startOfToday(now);

    const processUsers = async (Model, userType) => {
      assertValidModel(Model, userType);

      // Only process after expiry date has fully passed.
      const users = await Model.find({
        "subscription.planId": { $exists: true, $ne: null },
        "subscription.expiresAt": {
          $exists: true,
          $ne: null,
          $lt: todayStart,
        },
      });

      let emailCount = 0;
      let downgradedCount = 0;
      let alreadyFreeCount = 0;
      let skippedEmailAlreadySent = 0;

      for (const user of users) {
        const currentPlan = await SubscriptionPlan.findOne({
          planId: user?.subscription?.planId,
        }).lean();

        if (isFreePlanLike(currentPlan) || isFreePlanLike(user?.subscription)) {
          await downgradeUserToFreePlan(user, userType, now, {
            rebuildFeatures: false,
          });

          alreadyFreeCount += 1;
          continue;
        }

        let userToDowngrade = user;

        const expiredEmailAlreadySent =
          !!user?.subscription?.lastExpiredEmailSentAt;

        if (!expiredEmailAlreadySent) {
          // Atomic lock: mark expired email as sent before sending.
          // This ensures hourly cron/API cannot send duplicate expired emails.
          const lockedUser = await Model.findOneAndUpdate(
            {
              _id: user._id,
              $or: [
                { "subscription.lastExpiredEmailSentAt": { $exists: false } },
                { "subscription.lastExpiredEmailSentAt": null },
              ],
            },
            {
              $set: {
                "subscription.lastExpiredEmailSentAt": now,
              },
            },
            { new: true }
          );

          if (lockedUser) {
            userToDowngrade = lockedUser;

            await sendSubscriptionLifecycleEmail({
              userType,
              user: lockedUser,
              plan: currentPlan,
              eventType: "expired",
            });

            emailCount += 1;
          } else {
            skippedEmailAlreadySent += 1;
          }
        } else {
          skippedEmailAlreadySent += 1;
        }

        // Always downgrade expired paid user to free,
        // but do not send email again if already sent.
        await downgradeUserToFreePlan(userToDowngrade, userType, now, {
          markExpiredEmailSent: false,
        });

        downgradedCount += 1;
      }

      return {
        emailCount,
        downgradedCount,
        alreadyFreeCount,
        skippedEmailAlreadySent,
      };
    };

    const brandResult = await processUsers(Brand, "Brand");
    const influencerResult = await processUsers(Influencer, "Influencer");

    return res.status(200).json({
      message: "Expired subscriptions processed. Emails are sent once only.",
      brand: brandResult,
      influencer: influencerResult,
      totalEmails: brandResult.emailCount + influencerResult.emailCount,
      totalDowngraded:
        brandResult.downgradedCount + influencerResult.downgradedCount,
      totalAlreadyFree:
        brandResult.alreadyFreeCount + influencerResult.alreadyFreeCount,
      totalSkippedEmailAlreadySent:
        brandResult.skippedEmailAlreadySent +
        influencerResult.skippedEmailAlreadySent,
    });
  } catch (err) {
    console.error("sendExpiredSubscriptionEmails error:", err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, "SEND_EXPIRED_SUBSCRIPTION_EMAILS_ERROR"); return res.status(500).json({ message: "Internal server error" });
  }
};



function isFreePlanLike(planOrSub = {}) {
  const name = String(planOrSub?.name || planOrSub?.planName || "")
    .trim()
    .toLowerCase();

  return (
    name === "free" ||
    planOrSub?.monthlyCost === 0 ||
    planOrSub?.isFree === true ||
    String(planOrSub?.slug || "").toLowerCase() === "free"
  );
}

function getFeatureLimit(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && value.unlimited === true) return -1;
  return 0;
}

function buildFreeFeatureSnapshot(freePlan, previousFeatures = []) {
  const previousMap = new Map(
    (Array.isArray(previousFeatures) ? previousFeatures : [])
      .filter((f) => f && f.key)
      .map((f) => [f.key, f])
  );

  return (freePlan.features || []).map((feature) => {
    const limit = getFeatureLimit(feature.value);

    const previousUsed = Number(previousMap.get(feature.key)?.used || 0);
    let used = Number.isFinite(previousUsed) && previousUsed > 0 ? previousUsed : 0;

    // Do not reload credits.
    // If paid used is more than free limit, cap it to free limit.
    if (limit >= 0) {
      used = Math.min(used, limit);
    }

    return {
      key: feature.key,
      limit,
      used,
    };
  });
}


// POST /subscription-plans/brand/move-expired-to-free
// body:
// {
//   "brandId": "singleBrandMongoId"
// }
//
// OR
//
// {
//   "brandIds": ["brandMongoId1", "brandMongoId2"]
// }
exports.moveExpiredBrandsToFree = async (req, res) => {
  try {
    const { brandId, brandIds } = req.body || {};

    const ids = Array.isArray(brandIds)
      ? brandIds
      : brandId
        ? [brandId]
        : [];

    if (!ids.length) {
      return res.status(400).json({
        message: "brandId or brandIds is required in body",
      });
    }

    const freePlan = await SubscriptionPlan.findOne({
      role: "Brand",
      status: "active",
      $or: [
        { name: /^free$/i },
        { monthlyCost: 0 },
        { planId: /_free$/i },
        { name: /free/i },
        { isFree: true },
        { slug: "free" },
      ],
    }).lean();

    if (!freePlan) {
      return res.status(404).json({
        message: "Active Brand free plan not found",
      });
    }

    const now = new Date();

    const brands = await Brand.find({
      _id: { $in: ids },
    });

    const result = {
      requested: ids.length,
      found: brands.length,
      movedToFree: 0,
      skippedNotExpired: 0,
      skippedAlreadyFree: 0,
      skippedNoSubscription: 0,
      failed: [],
      updatedBrands: [],
    };

    for (const brand of brands) {
      try {
        const sub = brand.subscription || {};

        if (!sub.planId) {
          result.skippedNoSubscription += 1;
          result.updatedBrands.push({
            brandId: String(brand._id),
            status: "skipped_no_subscription",
          });
          continue;
        }

        const currentPlan = await SubscriptionPlan.findOne({
          planId: sub.planId,
        }).lean();

        if (isFreePlanLike(currentPlan) || isFreePlanLike(sub)) {
          result.skippedAlreadyFree += 1;
          result.updatedBrands.push({
            brandId: String(brand._id),
            status: "skipped_already_free",
            currentPlanId: sub.planId,
            currentPlanName: sub.planName,
          });
          continue;
        }

        const expiresAt = sub.expiresAt ? new Date(sub.expiresAt) : null;

        if (
          !expiresAt ||
          Number.isNaN(expiresAt.getTime()) ||
          expiresAt.getTime() > now.getTime()
        ) {
          result.skippedNotExpired += 1;
          result.updatedBrands.push({
            brandId: String(brand._id),
            status: "skipped_not_expired",
            currentPlanId: sub.planId,
            currentPlanName: sub.planName,
            expiresAt: sub.expiresAt || null,
          });
          continue;
        }

        const oldPlanId = sub.planId;
        const oldPlanName = sub.planName;

        brand.subscription = brand.subscription || {};
        brand.subscription.planId = freePlan.planId;
        brand.subscription.planName = freePlan.name || "free";
        brand.subscription.startedAt = now;

        // Free plan should not expire.
        brand.subscription.expiresAt = null;

        // Preserve used credits. Do not restart from 0.
        brand.subscription.features = buildFreeFeatureSnapshot(
          freePlan,
          sub.features
        );

        brand.subscription.lastExpiringSoonEmailSentAt = null;
        brand.subscription.lastExpiredEmailSentAt = now;

        // After moving to free, user is no longer in expired state.
        brand.subscriptionExpired = false;

        await brand.save();

        result.movedToFree += 1;
        result.updatedBrands.push({
          brandId: String(brand._id),
          status: "moved_to_free",
          oldPlanId,
          oldPlanName,
          newPlanId: freePlan.planId,
          newPlanName: freePlan.name || "free",
        });
      } catch (brandErr) {
        result.failed.push({
          brandId: String(brand?._id || ""),
          error: brandErr.message,
        });
      }
    }

    return res.status(200).json({
      message: "Expired selected brands processed",
      freePlanId: freePlan.planId,
      freePlanName: freePlan.name || "free",
      result,
    });
  } catch (err) {
    console.error("moveExpiredBrandsToFree error:", err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, "MOVE_EXPIRED_BRANDS_TO_FREE_ERROR"); return res.status(500).json({
      message: "Internal server error while moving brands to free",
    });
  }
};