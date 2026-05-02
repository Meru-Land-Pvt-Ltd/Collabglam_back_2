// utils/subscriptionHelper.js
const SubscriptionPlan = require("../models/subscription");

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !(v instanceof Date);
}

function normalizeRole(role = "Influencer") {
  const value = String(role || "Influencer").trim().toLowerCase();

  if (value === "brand") return "Brand";
  if (value === "influencer") return "Influencer";
  if (value === "creator") return "Creator";
  if (value === "agency") return "Agency";

  return "Influencer";
}

// Subscription is valid for the full expiry date.
// Example: expiry date is Apr 29 => active until Apr 29 11:59:59.999 PM.
function endOfSubscriptionDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid date");

  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfToday(value = new Date()) {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isExpiredByDate(expiresAt, now = new Date()) {
  if (!expiresAt) return false;

  try {
    const expiryEnd = endOfSubscriptionDay(expiresAt);
    return expiryEnd.getTime() < new Date(now).getTime();
  } catch {
    return true;
  }
}

function computeExpiry(plan = {}, fromDate = new Date(), overrides = null) {
  // allow calling computeExpiry(plan, { overrides })
  if (isPlainObject(fromDate)) {
    overrides = fromDate;
    fromDate = new Date();
  }

  overrides = isPlainObject(overrides) ? overrides : {};

  const start = new Date(fromDate);
  if (Number.isNaN(start.getTime())) throw new Error("Invalid fromDate");

  // 1) explicit expiresAt wins, but normalize it to end of that date
  if (overrides.expiresAt) {
    const dt = endOfSubscriptionDay(overrides.expiresAt);

    if (dt.getTime() <= start.getTime()) {
      const todayEnd = endOfSubscriptionDay(start);
      if (todayEnd.getTime() > start.getTime()) return todayEnd;
      return new Date(start.getTime() + 60 * 1000);
    }

    return dt;
  }

  // 2) duration overrides
  let minutesOverride = 0;

  if (overrides.durationMins != null) {
    minutesOverride = toNum(overrides.durationMins);
  } else if (overrides.durationMinutes != null) {
    minutesOverride = toNum(overrides.durationMinutes);
  } else if (overrides.durationDays != null) {
    minutesOverride = toNum(overrides.durationDays) * 1440;
  }

  // 3) plan defaults
  const planMinutes =
    (toNum(plan.durationMins) > 0 && toNum(plan.durationMins)) ||
    (toNum(plan.durationMinutes) > 0 && toNum(plan.durationMinutes)) ||
    (toNum(plan.durationDays) > 0 && toNum(plan.durationDays) * 1440) ||
    0;

  // 4) fallback default
  const defaultMinutes =
    overrides.billingCycle === "annual" ? 525600 : 43200; // 365d vs 30d

  const minutes =
    (minutesOverride > 0 && minutesOverride) ||
    (planMinutes > 0 && planMinutes) ||
    defaultMinutes;

  const rawExpiry = new Date(start.getTime() + minutes * 60 * 1000);
  const expiry = endOfSubscriptionDay(rawExpiry);

  if (expiry.getTime() <= start.getTime()) {
    return new Date(start.getTime() + 60 * 1000);
  }

  return expiry;
}

async function getFreePlan(role = "Influencer") {
  const roleNorm = normalizeRole(role);

  const plan = await SubscriptionPlan.findOne({
    role: roleNorm,
    status: "active",
    $or: [
      { name: /^free$/i },
      { planId: new RegExp(`${roleNorm.toLowerCase()}_free`, "i") },
      { planId: /_free$/i },
      { name: /free/i },
      { monthlyCost: 0 },
      { isFree: true },
      { slug: "free" },
    ],
  }).lean();

  if (plan) {
    return {
      _id: plan._id,
      planId: plan.planId,
      role: plan.role,
      name: plan.name || "free",
      displayName: plan.displayName || "FREE",
      monthlyCost: plan.monthlyCost || 0,
      annualCost: plan.annualCost || 0,
      durationDays: plan.durationDays,
      durationMins: plan.durationMins,
      durationMinutes: plan.durationMinutes,
      features: Array.isArray(plan.features) ? plan.features : [],
    };
  }

  // fallback so registration / degradation never crashes
  return {
    planId: `${roleNorm.toLowerCase()}_free`,
    role: roleNorm,
    name: "free",
    displayName: "FREE",
    monthlyCost: 0,
    annualCost: 0,
    durationDays: null,
    durationMins: null,
    durationMinutes: null,
    features: [],
  };
}

module.exports = {
  computeExpiry,
  getFreePlan,
  normalizeRole,
  endOfSubscriptionDay,
  startOfToday,
  isExpiredByDate,
};