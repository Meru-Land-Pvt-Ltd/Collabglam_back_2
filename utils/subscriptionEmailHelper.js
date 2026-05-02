const crypto = require("crypto");
const { sendEmail, uploadEmailRecordToS3 } = require("../services/emailService");

const BrandModelImport = require("../models/brand");
const InfluencerModelImport = require("../models/influencer");

const BrandModel =
  BrandModelImport.BrandModel ||
  BrandModelImport.default ||
  BrandModelImport;

const InfluencerModel =
  InfluencerModelImport.InfluencerModel ||
  InfluencerModelImport.default ||
  InfluencerModelImport;

const SUBSCRIPTION_EMAIL_MIN_INTERVAL_HOURS = Number(
  process.env.SUBSCRIPTION_EMAIL_MIN_INTERVAL_HOURS || 24
);

// After 5 successful sends for same user + same event, stop forever.
const SUBSCRIPTION_EMAIL_MAX_SENDS = Number(
  process.env.SUBSCRIPTION_EMAIL_MAX_SENDS || 5
);

// Prevent duplicate emails if two cron/jobs hit at the same time.
const SUBSCRIPTION_EMAIL_RESERVATION_TTL_MINUTES = Number(
  process.env.SUBSCRIPTION_EMAIL_RESERVATION_TTL_MINUTES || 15
);

function getUserEmail(user) {
  return String(
    user?.email ||
    user?.proxyEmail ||
    user?.contactEmail ||
    ""
  ).trim().toLowerCase();
}

function getUserDisplayName(user, userType) {
  if (userType === "Brand") {
    return user?.brandName || user?.name || "Brand User";
  }

  return user?.name || user?.fullName || user?.username || "Influencer";
}

function getUserModel(userType) {
  const normalized = String(userType || "").trim().toLowerCase();

  if (normalized === "brand") return BrandModel;
  if (normalized === "influencer") return InfluencerModel;

  return null;
}

function getUserId(user) {
  return user?._id || user?.id || user?.brandId || user?.influencerId || null;
}

function sanitizeEventKey(eventType) {
  return (
    String(eventType || "subscription_update")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_") || "subscription_update"
  );
}

function getNestedValue(obj, dottedPath) {
  return String(dottedPath || "")
    .split(".")
    .reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
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
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
      <h2>${heading}</h2>
      <p>Hello ${userName},</p>
      <p>${intro}</p>
      <p><strong>Plan:</strong> ${planName || "N/A"}</p>
      <p><strong>Ends on:</strong> ${endDate}</p>
      <p>If you need help, please contact support.</p>
      <p>- ${appName}</p>
    </div>
  `;

  return { subject, text, html };
}

async function reserveSubscriptionLifecycleEmail({
  userType,
  user,
  eventType,
  to,
}) {
  const Model = getUserModel(userType);
  const userId = getUserId(user);

  if (!Model || !userId) {
    console.warn("[subscription-email] skipped: cannot apply email limit", {
      userType,
      userId,
      eventType,
      to,
    });

    return {
      allowed: false,
      reason: "missing_model_or_user_id",
    };
  }

  const eventKey = sanitizeEventKey(eventType);
  const basePath = `subscription.emailLifecycle.${eventKey}`;

  const now = new Date();
  const minIntervalAgo = new Date(
    now.getTime() - SUBSCRIPTION_EMAIL_MIN_INTERVAL_HOURS * 60 * 60 * 1000
  );
  const reservationExpiredBefore = new Date(
    now.getTime() - SUBSCRIPTION_EMAIL_RESERVATION_TTL_MINUTES * 60 * 1000
  );

  const reservationId =
    crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex");

  const filter = {
    _id: userId,
    $and: [
      {
        $or: [
          { [`${basePath}.permanentlyStoppedAt`]: { $exists: false } },
          { [`${basePath}.permanentlyStoppedAt`]: null },
        ],
      },
      {
        $or: [
          { [`${basePath}.sentCount`]: { $exists: false } },
          { [`${basePath}.sentCount`]: { $lt: SUBSCRIPTION_EMAIL_MAX_SENDS } },
        ],
      },
      {
        $or: [
          { [`${basePath}.lastSentAt`]: { $exists: false } },
          { [`${basePath}.lastSentAt`]: null },
          { [`${basePath}.lastSentAt`]: { $lte: minIntervalAgo } },
        ],
      },
      {
        $or: [
          { [`${basePath}.reservedAt`]: { $exists: false } },
          { [`${basePath}.reservedAt`]: null },
          { [`${basePath}.reservedAt`]: { $lte: reservationExpiredBefore } },
        ],
      },
    ],
  };

  const update = {
    $set: {
      [`${basePath}.reservedAt`]: now,
      [`${basePath}.reservationId`]: reservationId,
      [`${basePath}.lastAttemptEmail`]: to,
      [`${basePath}.lastAttemptAt`]: now,
    },
    $setOnInsert: {
      [`${basePath}.sentCount`]: 0,
    },
  };

  const reservedDoc = await Model.findOneAndUpdate(filter, update, {
    new: false,
    projection: { [basePath]: 1 },
    strict: false,
    strictQuery: false,
  })
    .lean()
    .exec();

  if (!reservedDoc) {
    console.log("[subscription-email] skipped by limit", {
      userType,
      userId: String(userId),
      eventType,
      to,
      rule: `max ${SUBSCRIPTION_EMAIL_MAX_SENDS} total and 1 every ${SUBSCRIPTION_EMAIL_MIN_INTERVAL_HOURS} hours`,
    });

    return {
      allowed: false,
      reason: "daily_or_permanent_limit_reached",
    };
  }

  const previousState = getNestedValue(reservedDoc, basePath) || {};
  const previousCount = Number(previousState.sentCount || 0);
  const nextCount = previousCount + 1;

  return {
    allowed: true,
    Model,
    userId,
    eventKey,
    basePath,
    reservationId,
    nextCount,
    shouldStopPermanently: nextCount >= SUBSCRIPTION_EMAIL_MAX_SENDS,
  };
}

async function commitSubscriptionLifecycleEmailReservation({
  reservation,
  emailMessageId,
  to,
}) {
  if (!reservation?.allowed) return;

  const now = new Date();

  const setFields = {
    [`${reservation.basePath}.lastSentAt`]: now,
    [`${reservation.basePath}.lastSentEmail`]: to,
    [`${reservation.basePath}.lastMessageId`]: emailMessageId || null,
  };

  if (reservation.shouldStopPermanently) {
    setFields[`${reservation.basePath}.permanentlyStoppedAt`] = now;
  }

  await reservation.Model.updateOne(
    {
      _id: reservation.userId,
      [`${reservation.basePath}.reservationId`]: reservation.reservationId,
    },
    {
      $inc: {
        [`${reservation.basePath}.sentCount`]: 1,
      },
      $set: setFields,
      $unset: {
        [`${reservation.basePath}.reservedAt`]: "",
        [`${reservation.basePath}.reservationId`]: "",
      },
    },
    {
      strict: false,
      strictQuery: false,
    }
  ).exec();
}

async function releaseSubscriptionLifecycleEmailReservation({
  reservation,
  error,
}) {
  if (!reservation?.allowed) return;

  await reservation.Model.updateOne(
    {
      _id: reservation.userId,
      [`${reservation.basePath}.reservationId`]: reservation.reservationId,
    },
    {
      $set: {
        [`${reservation.basePath}.lastFailedAt`]: new Date(),
        [`${reservation.basePath}.lastError`]: String(
          error?.message || error || "Unknown error"
        ).slice(0, 500),
      },
      $unset: {
        [`${reservation.basePath}.reservedAt`]: "",
        [`${reservation.basePath}.reservationId`]: "",
      },
    },
    {
      strict: false,
      strictQuery: false,
    }
  ).exec();
}

async function sendSubscriptionLifecycleEmail({
  userType,
  user,
  plan,
  oldPlanName = null,
  eventType,
}) {
  let reservation = null;

  try {
    const to = getUserEmail(user);

    if (!to) {
      console.warn(`[subscription-email] skipped: no email for ${userType}`, {
        userId: user?._id || user?.influencerId,
        eventType,
      });
      return;
    }

    reservation = await reserveSubscriptionLifecycleEmail({
      userType,
      user,
      eventType,
      to,
    });

    if (!reservation.allowed) {
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

    await commitSubscriptionLifecycleEmailReservation({
      reservation,
      emailMessageId: emailResp?.messageId || null,
      to,
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
        lifecycleSendCount: reservation.nextCount,
        permanentlyStoppedAfterThisSend: reservation.shouldStopPermanently,
      });
    } catch (archiveErr) {
      console.error("[subscription-email] archive failed:", archiveErr);
    }
  } catch (err) {
    console.error("[subscription-email] send failed:", err);

    try {
      await releaseSubscriptionLifecycleEmailReservation({
        reservation,
        error: err,
      });
    } catch (releaseErr) {
      console.error("[subscription-email] reservation release failed:", releaseErr);
    }
  }
}

module.exports = {
  sendSubscriptionLifecycleEmail,
};