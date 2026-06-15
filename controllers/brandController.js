const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const OpenAI = require("openai");

const BrandInfo = require("../models/brandInfo");
const BrandModelImport = require("../models/brand");
const BrandCoupon = require("../models/brandCoupon");
const { BrandFolderModel } = require("../models/brandFolder");
let PitchFolderForBrandGoodFit = null;
try {
  const PitchFolderImport = require("../models/pitchFolder");
  PitchFolderForBrandGoodFit =
    PitchFolderImport.PitchFolder ||
    PitchFolderImport.PitchFolderModel ||
    PitchFolderImport.default ||
    PitchFolderImport;
} catch {
  PitchFolderForBrandGoodFit = null;
}
const VerifyOtpModelImport = require("../models/verifyOtp");
let BrandCampaignModelImport = null;
try {
  BrandCampaignModelImport = require("../models/campaign");
} catch {
  BrandCampaignModelImport = null;
}
const OtpTemplateImport = require("../template/otpTemplate");
const ResetOtpTemplateImport = require("../template/resetOtp");
const EmailServiceImport = require("../services/emailService");
const ApiResponseImport = require("../core/http/ApiResponse");
const HttpStatusImport = require("../core/http/HttpStatus");
const ApiErrorImport = require("../core/http/ApiError");
const SubscriptionPlan = require("../models/subscription");
const { uploadBrandProfilePicToS3 } = require("../utils/uploadBase64ImagesToS3");
const { BookmarkFolder } = require("../models/bookMarkFolder");
const saveErrorLog = require("../services/errorLog.service");

void OpenAI;
void BrandInfo;

let firebaseAdmin = null;

try {
  firebaseAdmin = require("firebase-admin");
} catch {
  firebaseAdmin = null;
}

const BrandModel =
  BrandModelImport.BrandModel || BrandModelImport.default || BrandModelImport;

const VerifyOtpModel =
  VerifyOtpModelImport.VerifyOtpModel ||
  VerifyOtpModelImport.default ||
  VerifyOtpModelImport;

const BrandCampaignModel =
  BrandCampaignModelImport?.CampaignModel ||
  BrandCampaignModelImport?.Campaign ||
  BrandCampaignModelImport?.default ||
  BrandCampaignModelImport;

const buildOtpEmailTemplate =
  OtpTemplateImport.buildOtpEmailTemplate ||
  OtpTemplateImport.default ||
  OtpTemplateImport;

const resetOtpEmailTemplate =
  ResetOtpTemplateImport.resetOtpEmailTemplate ||
  ResetOtpTemplateImport.default ||
  ResetOtpTemplateImport;

const sendEmail =
  EmailServiceImport.sendEmail ||
  EmailServiceImport.default ||
  EmailServiceImport;

const ApiResponse =
  ApiResponseImport.ApiResponse ||
  ApiResponseImport.default ||
  ApiResponseImport;

const HttpStatus =
  HttpStatusImport.HttpStatus ||
  HttpStatusImport.default ||
  HttpStatusImport;

const ApiError = ApiErrorImport.ApiError || ApiErrorImport;
const ValidationError = ApiErrorImport.ValidationError;
const UnauthorizedError = ApiErrorImport.UnauthorizedError;
const ConflictError = ApiErrorImport.ConflictError;
const InternalError = ApiErrorImport.InternalError;
const NotFoundError = ApiErrorImport.NotFoundError;
const RateLimitError = ApiErrorImport.RateLimitError;

let ErrorCodes;
try {
  ErrorCodes = require("../core/http/errorCodes").ErrorCodes;
} catch {
  ErrorCodes = {
    AUTH_INVALID_TOKEN: "AUTH_INVALID_TOKEN",
    AUTH_FORBIDDEN: "AUTH_FORBIDDEN",
    OTP_RATE_LIMIT: "OTP_RATE_LIMIT",
    OTP_DAILY_LIMIT: "OTP_DAILY_LIMIT",
    SIGNIN_RATE_LIMIT: "SIGNIN_RATE_LIMIT",
    SIGNIN_DAILY_LIMIT: "SIGNIN_DAILY_LIMIT",
    INTERNAL_ERROR: "INTERNAL_ERROR",
    CONFLICT: "CONFLICT",
    VALIDATION_FAILED: "VALIDATION_FAILED",
    RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
    RATE_LIMITED: "RATE_LIMITED",
  };
}

const OTP_TTL_MIN = Number(process.env.OTP_TTL_MINUTES || 3);
const RESET_TTL_MIN = Number(process.env.RESET_PASSWORD_TTL_MINUTES || 15);

const OTP_TTL_MS = OTP_TTL_MIN * 60 * 1000;
const RESET_TTL_MS = RESET_TTL_MIN * 60 * 1000;

const OTP_TOTAL = 6;
const OTP_BATCH_LIMIT = 3;
const OTP_COOLDOWN_MIN = 15;
const OTP_RESET_HOURS = 24;

const SIGNIN_TOTAL = 9;
const SIGNIN_BATCH = 3;
const SIGNIN_LOCK_1_MIN = 1;
const SIGNIN_LOCK_15_MIN = 15;
const SIGNIN_LOCK_24_HOURS = 24;

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const safeTrim = (value) => String(value || "").trim();

const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());

const isPasswordLenOk = (password) => {
  const len = String(password || "").trim().length;
  return len >= 8 && len <= 16;
};

const genOtp = () => String(Math.floor(100000 + Math.random() * 900000));

function isPendingAdminCreatedBrand(doc = {}) {
  return doc?.isAdminCreated === true && doc?.signupCompleted === false;
}

function assertNotPendingAdminCreatedBrand(brand) {
  if (isPendingAdminCreatedBrand(brand)) {
    throw new ValidationError(
      "This brand was added by admin. Please complete signup first using the same email."
    );
  }
}

function assertCallable(fn, name) {
  if (typeof fn !== "function") {
    throw new Error(`${name} export is invalid`);
  }
}

assertCallable(buildOtpEmailTemplate, "buildOtpEmailTemplate");
assertCallable(resetOtpEmailTemplate, "resetOtpEmailTemplate");
assertCallable(sendEmail, "sendEmail");

const hashOtp = (email, otp) => {
  const secret = process.env.OTP_SECRET || "dev-secret";

  return crypto
    .createHash("sha256")
    .update(`${normalizeEmail(email)}:${String(otp)}:${secret}`)
    .digest("hex");
};

function signJwt(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new InternalError("JWT_SECRET is missing in env");

  return jwt.sign(payload, secret, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

function signResetJwt(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new InternalError("JWT_SECRET is missing in env");

  return jwt.sign(payload, secret, {
    expiresIn: `${RESET_TTL_MIN}m`,
  });
}

function getBearerToken(req) {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid Authorization header");
  }

  return auth.slice(7).trim();
}

function isQAArray(value) {
  if (!Array.isArray(value)) return false;

  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    if (typeof item.question !== "string" || !item.question.trim()) return false;
    if (!Array.isArray(item.answers) || item.answers.length === 0) return false;

    return item.answers.every(
      (answer) => typeof answer === "string" && answer.trim().length > 0
    );
  });
}

function msToWaitString(ms) {
  const sec = Math.ceil(ms / 1000);
  if (sec <= 60) return `${sec} seconds`;

  const min = Math.ceil(sec / 60);
  if (min <= 60) return `${min} minutes`;

  const hr = Math.ceil(min / 60);
  return `${hr} hours`;
}

function buildSafeSignupPayload(body) {
  return {
    brandName: safeTrim(body.brandName),
    name: safeTrim(body.name) || safeTrim(body.brandName),
    companySize: safeTrim(body.companySize),
    industry: safeTrim(body.industry),
    passwordHash: String(body.password || ""),
  };
}

function featureValueToLimit(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && value.unlimited === true) return -1;
  return 0;
}

function buildSubscriptionFromPlan(plan) {
  const now = new Date();

  return {
    planId: plan.planId,
    planName: plan.name,
    role: plan.role || "Brand",
    planRef: plan._id,
    monthlyCost: plan.monthlyCost ?? 0,
    annualCost: plan.annualCost ?? 0,
    billingCycle: "monthly",
    autoRenew: plan.autoRenew ?? false,
    status: plan.status || "active",
    durationMins: plan.durationMins ?? 43200,
    startedAt: now,
    expiresAt: null,
    features: (plan.features || []).map((feature) => ({
      key: feature.key,
      value: feature.value ?? null,
      limit: featureValueToLimit(feature.value),
      used: 0,
      note: feature.note ?? null,
      resetsEvery: null,
      resetsAt: null,
    })),
    internalCredits: {
      used: 0,
      resetsAt: null,
    },
  };
}

function validateSignupRequest(body) {
  const brandName = safeTrim(body.brandName);
  const email = normalizeEmail(body.email);
  const industry = safeTrim(body.industry);
  const password = String(body.password || "");

  if (!brandName) throw new ValidationError("Brand name is required");

  if (!email || !isValidEmail(email)) {
    throw new ValidationError("Valid email is required");
  }

  if (!industry) throw new ValidationError("Industry is required");
  if (!password.trim()) throw new ValidationError("Password is required");

  if (!isPasswordLenOk(password)) {
    throw new ValidationError("Password must be 8 to 16 characters.");
  }
}

function rethrowAsApiError(err) {
  if (err instanceof ApiError) throw err;

  if (err && err.code === 11000) {
    const field =
      Object.keys(err.keyPattern || err.keyValue || {})[0] || "unknown";
    const value = err.keyValue?.[field];

    if (field === "email") {
      throw new ConflictError("Email already registered. Please login.", {
        field,
        value,
      });
    }

    throw new ConflictError(
      `${field} already exists. Please use a different value.`,
      { field, value }
    );
  }

  if (err && err.name === "ValidationError") {
    const fields = err.errors ? Object.keys(err.errors) : [];
    throw new ValidationError(err.message, { fields });
  }

  if (err && err.name === "CastError") {
    throw new ValidationError("Invalid input", { field: err.path });
  }

  throw err;
}

function handleControllerError(next, err, context = "brandController") {
  try {
    rethrowAsApiError(err);
  } catch (mapped) {
    err = mapped;
  }

  if (!(err instanceof ApiError)) {
    console.error(`[${context}]`, {
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    });
  }

  if (err instanceof ApiError) return next(err);
  return next(new InternalError("Internal server error", null, err));
}

async function findBrandByEmail(email, includePassword = false) {
  let query = BrandModel.findOne({ email: normalizeEmail(email) });

  if (includePassword) {
    query = query.select("+password");
  }

  return query.exec();
}

async function clearPendingOtpDocs(email, purpose) {
  await VerifyOtpModel.deleteMany({
    email: normalizeEmail(email),
    role: "brand",
    docType: "otp",
    purpose,
    status: 0,
  }).exec();
}

async function clearAllOtpDocs(email, purpose) {
  await VerifyOtpModel.deleteMany({
    email: normalizeEmail(email),
    role: "brand",
    docType: "otp",
    purpose,
  }).exec();
}

async function createOtpDoc({
  email,
  purpose,
  otpPlain,
  userId = null,
  signupPayload = null,
}) {
  return VerifyOtpModel.create({
    email: normalizeEmail(email),
    role: "brand",
    otp: hashOtp(email, otpPlain),
    status: 0,
    userId,
    docType: "otp",
    purpose,
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    signupPayload,
  });
}

async function getLatestPendingOtp(email, purpose) {
  return VerifyOtpModel.findOne({
    email: normalizeEmail(email),
    role: "brand",
    docType: "otp",
    purpose,
    status: 0,
  })
    .sort({ createdAt: -1 })
    .exec();
}

function assertValidOtpDoc(otpDoc, email, otp) {
  if (!otpDoc) {
    throw new ValidationError(
      "OTP not requested or expired. Please request a new OTP."
    );
  }

  if (otpDoc.expiresAt && Date.now() > new Date(otpDoc.expiresAt).getTime()) {
    throw new ValidationError("OTP expired. Please request a new OTP.");
  }

  const incomingHash = hashOtp(email, String(otp));
  if (incomingHash !== otpDoc.otp) {
    throw new ValidationError("Invalid OTP");
  }
}

async function markOtpUsed(otpDoc, options = {}) {
  const { userId = null, extendExpiryMs = null } = options;

  const update = {
    status: 1,
    userId: userId || otpDoc.userId || null,
  };

  if (extendExpiryMs && Number(extendExpiryMs) > 0) {
    update.expiresAt = new Date(Date.now() + Number(extendExpiryMs));
  }

  await VerifyOtpModel.updateOne(
    { _id: otpDoc._id, status: 0 },
    { $set: update }
  ).exec();
}

async function getSigninLimitDoc(email) {
  return VerifyOtpModel.findOneAndUpdate(
    {
      email: normalizeEmail(email),
      role: "brand",
      docType: "limit",
      key: "signin_limit",
    },
    {
      $setOnInsert: {
        email: normalizeEmail(email),
        role: "brand",
        docType: "limit",
        key: "signin_limit",
        otp: "__SIGNIN_LIMIT__",
        status: 0,
        userId: null,
        signinFailedCount: 0,
        signinCooldownUntil: null,
        signinResetAt: null,
      },
    },
    { new: true, upsert: true }
  ).exec();
}

async function enforceOtpLimitByKey(email, key) {
  const normalizedEmail = normalizeEmail(email);
  const nowMs = Date.now();

  const limitDoc = await VerifyOtpModel.findOneAndUpdate(
    {
      email: normalizedEmail,
      role: "brand",
      docType: "limit",
      key,
    },
    {
      $setOnInsert: {
        email: normalizedEmail,
        role: "brand",
        otp: key === "signup_limit" ? "__SIGNUP_LIMIT__" : "__FORGOT_LIMIT__",
        status: 0,
        userId: null,
        docType: "limit",
        key,
        signupOtpSend: OTP_TOTAL,
        signupOtpBatchCount: 0,
        signupOtpCooldownUntil: null,
        signupOtpResetAt: null,
      },
    },
    { new: true, upsert: true }
  ).exec();

  if (
    limitDoc.signupOtpResetAt &&
    nowMs >= new Date(limitDoc.signupOtpResetAt).getTime()
  ) {
    limitDoc.signupOtpSend = OTP_TOTAL;
    limitDoc.signupOtpBatchCount = 0;
    limitDoc.signupOtpCooldownUntil = null;
    limitDoc.signupOtpResetAt = null;
    await limitDoc.save();
  }

  if ((limitDoc.signupOtpSend ?? OTP_TOTAL) <= 0) {
    if (!limitDoc.signupOtpResetAt) {
      limitDoc.signupOtpResetAt = new Date(
        nowMs + OTP_RESET_HOURS * 60 * 60 * 1000
      );
      await limitDoc.save();
    }

    throw new RateLimitError("Try again after 24 hours.", {
      code: ErrorCodes.OTP_DAILY_LIMIT,
    });
  }

  if (
    limitDoc.signupOtpCooldownUntil &&
    nowMs < new Date(limitDoc.signupOtpCooldownUntil).getTime()
  ) {
    const waitMs =
      new Date(limitDoc.signupOtpCooldownUntil).getTime() - nowMs;

    throw new RateLimitError(`Try again in ${msToWaitString(waitMs)}.`, {
      code: ErrorCodes.OTP_RATE_LIMIT,
    });
  }

  limitDoc.signupOtpSend = (limitDoc.signupOtpSend ?? OTP_TOTAL) - 1;
  limitDoc.signupOtpBatchCount = (limitDoc.signupOtpBatchCount ?? 0) + 1;

  if (limitDoc.signupOtpBatchCount >= OTP_BATCH_LIMIT) {
    limitDoc.signupOtpCooldownUntil = new Date(
      nowMs + OTP_COOLDOWN_MIN * 60 * 1000
    );
    limitDoc.signupOtpBatchCount = 0;
  }

  if (limitDoc.signupOtpSend <= 0) {
    limitDoc.signupOtpSend = 0;
    limitDoc.signupOtpResetAt = new Date(
      nowMs + OTP_RESET_HOURS * 60 * 60 * 1000
    );
  }

  await limitDoc.save();
}

async function enforceSigninLimit(email) {
  const nowMs = Date.now();
  const doc = await getSigninLimitDoc(email);

  if (doc.signinResetAt && nowMs >= new Date(doc.signinResetAt).getTime()) {
    doc.signinFailedCount = 0;
    doc.signinCooldownUntil = null;
    doc.signinResetAt = null;
    await doc.save();
  }

  if (
    doc.signinCooldownUntil &&
    nowMs < new Date(doc.signinCooldownUntil).getTime()
  ) {
    const waitMs = new Date(doc.signinCooldownUntil).getTime() - nowMs;

    throw new RateLimitError(
      `Too many failed login attempts. Try again in ${msToWaitString(waitMs)}.`,
      { code: ErrorCodes.SIGNIN_RATE_LIMIT }
    );
  }

  if ((doc.signinFailedCount ?? 0) >= SIGNIN_TOTAL) {
    if (!doc.signinResetAt) {
      doc.signinResetAt = new Date(
        nowMs + SIGNIN_LOCK_24_HOURS * 60 * 60 * 1000
      );
      await doc.save();
    }

    throw new RateLimitError(
      "Too many failed login attempts. Try again after 24 hours.",
      { code: ErrorCodes.SIGNIN_DAILY_LIMIT }
    );
  }
}

async function recordFailedSignin(email) {
  const nowMs = Date.now();
  const doc = await getSigninLimitDoc(email);

  if (doc.signinResetAt && nowMs >= new Date(doc.signinResetAt).getTime()) {
    doc.signinFailedCount = 0;
    doc.signinCooldownUntil = null;
    doc.signinResetAt = null;
  }

  doc.signinFailedCount = (doc.signinFailedCount ?? 0) + 1;

  if (doc.signinFailedCount % SIGNIN_BATCH === 0) {
    const batchNo = doc.signinFailedCount / SIGNIN_BATCH;

    if (batchNo === 1) {
      doc.signinCooldownUntil = new Date(nowMs + SIGNIN_LOCK_1_MIN * 60 * 1000);
    } else if (batchNo === 2) {
      doc.signinCooldownUntil = new Date(
        nowMs + SIGNIN_LOCK_15_MIN * 60 * 1000
      );
    } else {
      doc.signinCooldownUntil = new Date(
        nowMs + SIGNIN_LOCK_24_HOURS * 60 * 60 * 1000
      );
      doc.signinResetAt = doc.signinCooldownUntil;
      doc.signinFailedCount = SIGNIN_TOTAL;
    }
  }

  await doc.save();

  if (
    doc.signinCooldownUntil &&
    nowMs < new Date(doc.signinCooldownUntil).getTime()
  ) {
    const waitMs = new Date(doc.signinCooldownUntil).getTime() - nowMs;

    throw new RateLimitError(
      (doc.signinFailedCount ?? 0) >= SIGNIN_TOTAL
        ? "Too many failed login attempts. Try again after 24 hours."
        : `Too many failed login attempts. Try again in ${msToWaitString(
          waitMs
        )}.`,
      {
        code:
          (doc.signinFailedCount ?? 0) >= SIGNIN_TOTAL
            ? ErrorCodes.SIGNIN_DAILY_LIMIT
            : ErrorCodes.SIGNIN_RATE_LIMIT,
      }
    );
  }
}

async function resetSigninLimit(email) {
  await VerifyOtpModel.updateOne(
    {
      email: normalizeEmail(email),
      role: "brand",
      docType: "limit",
      key: "signin_limit",
    },
    {
      $set: {
        signinFailedCount: 0,
        signinCooldownUntil: null,
        signinResetAt: null,
      },
    }
  ).exec();
}

function getFirebaseAdminAuth() {
  if (!firebaseAdmin) {
    throw new InternalError("firebase-admin package is missing.");
  }

  if (!firebaseAdmin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (projectId && clientEmail && privateKey) {
      firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    } else {
      firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.applicationDefault(),
        projectId,
      });
    }
  }

  return firebaseAdmin.auth();
}

function makeBrandNameFromGoogleUser(decoded = {}) {
  const email = normalizeEmail(decoded.email);
  const localPart = email.split("@")[0] || "Brand";

  return (
    safeTrim(decoded.name) ||
    safeTrim(decoded.displayName) ||
    localPart
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() ||
    "Brand"
  );
}

async function getActiveFreeBrandPlan() {
  const freePlan = await SubscriptionPlan.findOne({
    role: "Brand",
    name: "free",
    status: "active",
  });

  if (!freePlan) {
    throw new InternalError("Free brand plan not found");
  }

  return freePlan;
}

async function sendSignupOtp(req, res, next) {
  const requestId = req.requestId || "";
  let otpDoc = null;

  try {
    validateSignupRequest(req.body || {});

    const email = normalizeEmail(req.body.email);
    const existingBrand = await findBrandByEmail(email);

    if (existingBrand && !isPendingAdminCreatedBrand(existingBrand)) {
      throw new ConflictError("Email already registered. Please login.");
    }

    await enforceOtpLimitByKey(email, "signup_limit");
    await clearPendingOtpDocs(email, "signup");

    const otpPlain = genOtp();
    const signupPayload = buildSafeSignupPayload(req.body);

    otpDoc = await createOtpDoc({
      email,
      purpose: "signup",
      otpPlain,
      signupPayload,
    });

    const { subject, text, html } = buildOtpEmailTemplate({
      otp: otpPlain,
      role: "Brand",
      expiryMinutes: OTP_TTL_MIN,
      purpose: "signup",
    });

    await sendEmail({ to: email, subject, text, html });

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "OTP sent successfully",
        email,
      },
      requestId
    );
  } catch (err) {
    if (otpDoc?._id) {
      try {
        await VerifyOtpModel.deleteOne({ _id: otpDoc._id }).exec();
      } catch (cleanupErr) {
        console.error("[sendSignupOtp.cleanup]", {
          name: cleanupErr?.name,
          message: cleanupErr?.message,
        });
      }
    }

    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SEND_SIGNUP_OTP_ERROR");
    return handleControllerError(next, err, "sendSignupOtp");
  }
}

async function verifyOtpSignUp(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || "").trim();

    if (!email || !isValidEmail(email)) {
      throw new ValidationError("Valid email is required");
    }

    if (!/^\d{6}$/.test(otp)) {
      throw new ValidationError("Valid 6-digit OTP is required");
    }

    const otpDoc = await getLatestPendingOtp(email, "signup");

    if (!otpDoc) {
      const existingBrand = await findBrandByEmail(email);

      if (existingBrand && !isPendingAdminCreatedBrand(existingBrand)) {
        throw new ConflictError("Email already registered. Please login.");
      }

      throw new ValidationError(
        "OTP not requested or expired. Please request a new OTP."
      );
    }

    assertValidOtpDoc(otpDoc, email, otp);

    const payload = otpDoc.signupPayload || {};

    if (!payload.brandName || !payload.industry || !payload.passwordHash) {
      throw new ValidationError(
        "Signup details missing. Please request OTP again."
      );
    }

    const existingBrand = await findBrandByEmail(email);

    if (existingBrand && !isPendingAdminCreatedBrand(existingBrand)) {
      await clearAllOtpDocs(email, "signup");
      throw new ConflictError("Email already registered. Please login.");
    }

    const freePlan = await SubscriptionPlan.findOne({
      role: "Brand",
      name: "free",
      status: "active",
    });

    if (!freePlan && !existingBrand?.subscription?.planId) {
      throw new InternalError("Free brand plan not found");
    }

    let brand;

    if (existingBrand && isPendingAdminCreatedBrand(existingBrand)) {
      existingBrand.brandName = safeTrim(payload.brandName);
      existingBrand.name = safeTrim(payload.name) || safeTrim(payload.brandName);
      existingBrand.companySize = safeTrim(payload.companySize);
      existingBrand.industry = safeTrim(payload.industry);
      existingBrand.password = payload.passwordHash;

      existingBrand.signupCompleted = true;
      existingBrand.signupCompletedAt = new Date();

      // Keep this true for audit history. signupCompleted=true means it is no longer a placeholder.
      existingBrand.isAdminCreated = true;

      if (!existingBrand.subscription?.planId && freePlan) {
        existingBrand.subscription = buildSubscriptionFromPlan(freePlan);
      }

      brand = await existingBrand.save();
    } else {
      brand = await BrandModel.create({
        email,
        brandName: safeTrim(payload.brandName),
        name: safeTrim(payload.name) || safeTrim(payload.brandName),
        companySize: safeTrim(payload.companySize),
        industry: safeTrim(payload.industry),
        password: payload.passwordHash,
        isAdminCreated: false,
        signupCompleted: true,
        signupCompletedAt: new Date(),
        subscription: buildSubscriptionFromPlan(freePlan),
      });
    }

    await markOtpUsed(otpDoc, { userId: brand._id });
    await clearAllOtpDocs(email, "signup");
    await clearAllOtpDocs(email, "reset_password");

    const token = signJwt({
      brandId: String(brand._id),
      role: "brand",
      email: brand.email,
    });

    return ApiResponse.sendOk(
      res,
      HttpStatus.CREATED,
      {
        message: "Brand signup successful",
        brandId: String(brand._id),
        token,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "VERIFY_OTP_SIGN_UP_ERROR");
    return handleControllerError(next, err, "verifyOtpSignUp");
  }
}

async function saveBrandOnboarding(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const user = req.user;

    if (!user?.brandId) throw new ValidationError("Invalid token payload");
    if (user.role !== "brand") throw new ValidationError("Invalid role");

    const {
      page1,
      page2,
      page3,
      ispage1Skip,
      ispage2Skip,
      ispage3Skip,
      proxyEmail,
      profilePic,
      isProfilePicSkip,
    } = req.body || {};

    const hasAny =
      page1 !== undefined ||
      page2 !== undefined ||
      page3 !== undefined ||
      ispage1Skip !== undefined ||
      ispage2Skip !== undefined ||
      ispage3Skip !== undefined ||
      proxyEmail !== undefined ||
      profilePic !== undefined ||
      isProfilePicSkip !== undefined;

    if (!hasAny) throw new ValidationError("Nothing to update");

    const update = {};

    if (page1 !== undefined || ispage1Skip !== undefined) {
      if (ispage1Skip !== undefined && typeof ispage1Skip !== "boolean") {
        throw new ValidationError("ispage1Skip must be boolean");
      }

      if (ispage1Skip === true) {
        update.page1 = [];
        update.ispage1Skip = true;
      } else {
        if (page1 === undefined) {
          throw new ValidationError(
            "page1 is required when ispage1Skip is false"
          );
        }

        if (!isQAArray(page1)) {
          throw new ValidationError(
            "page1 must be an array of { question, answers[] }"
          );
        }

        update.page1 = page1;
        update.ispage1Skip = false;
      }
    }

    if (page2 !== undefined || ispage2Skip !== undefined) {
      if (ispage2Skip !== undefined && typeof ispage2Skip !== "boolean") {
        throw new ValidationError("ispage2Skip must be boolean");
      }

      if (ispage2Skip === true) {
        update.page2 = [];
        update.ispage2Skip = true;
      } else {
        if (page2 === undefined) {
          throw new ValidationError(
            "page2 is required when ispage2Skip is false"
          );
        }

        if (!isQAArray(page2)) {
          throw new ValidationError(
            "page2 must be an array of { question, answers[] }"
          );
        }

        update.page2 = page2;
        update.ispage2Skip = false;
      }
    }

    if (page3 !== undefined || ispage3Skip !== undefined) {
      if (ispage3Skip !== undefined && typeof ispage3Skip !== "boolean") {
        throw new ValidationError("ispage3Skip must be boolean");
      }

      if (ispage3Skip === true) {
        update.page3 = [];
        update.ispage3Skip = true;
      } else {
        if (page3 === undefined) {
          throw new ValidationError(
            "page3 is required when ispage3Skip is false"
          );
        }

        if (!isQAArray(page3)) {
          throw new ValidationError(
            "page3 must be an array of { question, answers[] }"
          );
        }

        update.page3 = page3;
        update.ispage3Skip = false;
      }
    }

    if (proxyEmail !== undefined) {
      if (typeof proxyEmail !== "string") {
        throw new ValidationError("proxyEmail must be a string");
      }

      const cleanedProxyEmail = normalizeEmail(proxyEmail);
      if (cleanedProxyEmail && !isValidEmail(cleanedProxyEmail)) {
        throw new ValidationError("proxyEmail must be a valid email");
      }

      update.proxyEmail = cleanedProxyEmail;
    }

    if (profilePic !== undefined) {
      if (typeof profilePic !== "string" || !profilePic.trim()) {
        throw new ValidationError("profilePic must be a non-empty string");
      }

      update.profilePic = profilePic.trim();
      update.isProfilePicSkip = false;
    }

    if (isProfilePicSkip !== undefined) {
      if (typeof isProfilePicSkip !== "boolean") {
        throw new ValidationError("isProfilePicSkip must be boolean");
      }

      if (isProfilePicSkip === true) {
        update.profilePic = "";
        update.isProfilePicSkip = true;
      } else {
        update.isProfilePicSkip = false;
      }
    }

    const brand = await BrandModel.findByIdAndUpdate(user.brandId, update, {
      new: true,
      runValidators: true,
    }).exec();

    if (!brand) throw new NotFoundError("Brand not found");

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Brand onboarding saved successfully",
        brandId: String(brand._id),
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SAVE_BRAND_ONBOARDING_ERROR");
    return handleControllerError(next, err, "saveBrandOnboarding");
  }
}

function hasCompletedOnboardingStep(step) {
  if (Array.isArray(step)) {
    return step.some((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return Object.keys(item).length > 0;
      }

      return Boolean(item);
    });
  }

  if (step && typeof step === "object") {
    return Object.keys(step).length > 0;
  }

  return Boolean(step);
}

function computeBrandNextRoute(brand) {
  const aliasDone = Boolean(String(brand?.proxyEmail || "").trim());

  const page1Done =
    hasCompletedOnboardingStep(brand?.page1) || brand?.ispage1Skip === true;

  const page2Done =
    hasCompletedOnboardingStep(brand?.page2) || brand?.ispage2Skip === true;

  const page3Done =
    hasCompletedOnboardingStep(brand?.page3) || brand?.ispage3Skip === true;

  let route = "campaign";

  if (!aliasDone) route = "brandAlias";
  else if (!page1Done) route = "page1";
  else if (!page2Done) route = "page2";
  else if (!page3Done) route = "page3";

  return {
    route,
    aliasDone,
    page1Done,
    page2Done,
    page3Done,
  };
}

async function signInBrand(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!email || !isValidEmail(email)) {
      throw new ValidationError("Valid email is required");
    }

    if (!password.trim()) {
      throw new ValidationError("Valid password is required");
    }

    await enforceSigninLimit(email);

    const brand = await findBrandByEmail(email, true);

    if (!brand) {
      throw new NotFoundError("Email does not exist. Please sign up.");
    }

    assertNotPendingAdminCreatedBrand(brand);

    if (!brand.password) {
      throw new ValidationError("Password not set. Please use forgot password.");
    }

    const ok = await brand.comparePassword(password);

    if (!ok) {
      await recordFailedSignin(email);
      throw new ValidationError("Incorrect password");
    }

    await resetSigninLimit(email);

    const token = signJwt({
      brandId: String(brand._id),
      role: "brand",
      email: brand.email,
    });

    const routeInfo = computeBrandNextRoute(brand);

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Brand sign in successful",
        brandId: String(brand._id),
        token,
        route: routeInfo.route,
        onboarding: {
          page1Done: routeInfo.page1Done,
          page2Done: routeInfo.page2Done,
          page3Done: routeInfo.page3Done,
        },
        page1: brand.page1 || [],
        page2: brand.page2 || [],
        page3: brand.page3 || [],
        ispage1Skip: brand.ispage1Skip || false,
        ispage2Skip: brand.ispage2Skip || false,
        ispage3Skip: brand.ispage3Skip || false,
        isProfilePicSkip: brand.isProfilePicSkip || false,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SIGN_IN_BRAND_ERROR");
    return handleControllerError(next, err, "signInBrand");
  }
}

async function googleAuthBrand(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const idToken = String(req.body?.idToken || "").trim();

    if (!idToken) {
      throw new ValidationError("Firebase idToken is required.");
    }

    const decoded = await getFirebaseAdminAuth().verifyIdToken(idToken);
    const googleProfilePic = safeTrim(decoded.picture);

    const email = normalizeEmail(decoded.email);

    if (!email || !isValidEmail(email)) {
      throw new ValidationError("Google account email is invalid.");
    }

    if (decoded.email_verified !== true) {
      throw new UnauthorizedError("Google email is not verified.");
    }

    let brand = await findBrandByEmail(email);
    const isNewBrand = !brand;

    const googleUpdate = {
      googleId: safeTrim(decoded.uid),
      googleSub: safeTrim(decoded.uid),
      isEmailVerified: true,
      lastLoginAt: new Date(),
    };

    if (!brand) {
      const freePlan = await getActiveFreeBrandPlan();
      const brandName = makeBrandNameFromGoogleUser(decoded);

      brand = await BrandModel.create({
        email,
        brandName,
        name: brandName,
        companySize: "",
        industry: "Other",
        authProvider: "google",
        provider: "google",
        googleId: safeTrim(decoded.uid),
        googleSub: safeTrim(decoded.uid),
        isEmailVerified: true,
        profilePic: googleProfilePic,
        isProfilePicSkip: !googleProfilePic,
        isAdminCreated: false,
        signupCompleted: true,
        signupCompletedAt: new Date(),
        lastLoginAt: new Date(),
        subscription: buildSubscriptionFromPlan(freePlan),
      });
    } else {
      assertNotPendingAdminCreatedBrand(brand);

      brand.googleId = safeTrim(decoded.uid);
      brand.googleSub = safeTrim(decoded.uid);
      brand.isEmailVerified = true;
      brand.lastLoginAt = new Date();

      // ✅ Add it here
      if (googleProfilePic && !brand.profilePic) {
        brand.profilePic = googleProfilePic;
        brand.isProfilePicSkip = false;
      }

      if (!brand.authProvider) {
        brand.authProvider = brand.password ? "password" : "google";
      }

      if (!brand.provider) {
        brand.provider = brand.password ? "password" : "google";
      }

      if (!brand.subscription?.planId) {
        const freePlan = await getActiveFreeBrandPlan();
        brand.subscription = buildSubscriptionFromPlan(freePlan);
      }

      await brand.save();
    }

    const token = signJwt({
      brandId: String(brand._id),
      role: "brand",
      email: brand.email,
    });

    const routeInfo = computeBrandNextRoute(brand);

    return ApiResponse.sendOk(
      res,
      isNewBrand ? HttpStatus.CREATED : HttpStatus.OK,
      {
        message: isNewBrand
          ? "Google brand signup started"
          : "Google brand sign in successful",
        brandId: String(brand._id),
        token,
        email: brand.email,
        brandName: brand.brandName || brand.name || "",
        name: brand.name || brand.brandName || "",
        profilePic: brand.profilePic || googleProfilePic || "",
        isNewBrand,
        route: routeInfo.route,
        onboarding: {
          aliasDone: routeInfo.aliasDone,
          page1Done: routeInfo.page1Done,
          page2Done: routeInfo.page2Done,
          page3Done: routeInfo.page3Done,
        },
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "GOOGLE_AUTH_BRAND_ERROR"
    );

    return handleControllerError(next, err, "googleAuthBrand");
  }
}

async function sendOtpForgotBrand(req, res, next) {
  const requestId = req.requestId || "";
  let otpDoc = null;

  try {
    const email = normalizeEmail(req.body?.email);

    if (!email || !isValidEmail(email)) {
      throw new ValidationError("Valid email is required");
    }

    const brand = await findBrandByEmail(email);

    if (!brand) {
      throw new NotFoundError("Brand account not found");
    }

    assertNotPendingAdminCreatedBrand(brand);

    await enforceOtpLimitByKey(email, "forgot_limit");
    await clearPendingOtpDocs(email, "reset_password");

    const otpPlain = genOtp();

    otpDoc = await createOtpDoc({
      email,
      purpose: "reset_password",
      otpPlain,
      userId: brand._id,
    });

    const { subject, text, html } = resetOtpEmailTemplate({
      otp: otpPlain,
      role: "Brand",
      expiryMinutes: OTP_TTL_MIN,
      purpose: "reset_password",
    });

    await sendEmail({ to: email, subject, text, html });

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "OTP sent for password reset",
        email,
      },
      requestId
    );
  } catch (err) {
    if (otpDoc?._id) {
      try {
        await VerifyOtpModel.deleteOne({ _id: otpDoc._id }).exec();
      } catch (cleanupErr) {
        console.error("[sendOtpForgotBrand.cleanup]", {
          name: cleanupErr?.name,
          message: cleanupErr?.message,
        });
      }
    }

    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SEND_OTP_FORGOT_BRAND_ERROR");
    return handleControllerError(next, err, "sendOtpForgotBrand");
  }
}

async function verifyOtpForgotBrand(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || "").trim();

    if (!email || !isValidEmail(email)) {
      throw new ValidationError("Valid email is required");
    }

    if (!/^\d{6}$/.test(otp)) {
      throw new ValidationError("Valid 6-digit OTP is required");
    }

    const brand = await findBrandByEmail(email);

    if (!brand) {
      throw new NotFoundError("Brand account not found");
    }

    assertNotPendingAdminCreatedBrand(brand);

    const otpDoc = await getLatestPendingOtp(email, "reset_password");
    assertValidOtpDoc(otpDoc, email, otp);

    await markOtpUsed(otpDoc, {
      userId: brand._id,
      extendExpiryMs: RESET_TTL_MS,
    });

    const resetToken = signResetJwt({
      tokenType: "pwd_reset",
      role: "brand",
      brandId: String(brand._id),
      email: brand.email,
      resetId: String(otpDoc._id),
    });

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "OTP verified",
        resetToken,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "VERIFY_OTP_FORGOT_BRAND_ERROR");
    return handleControllerError(next, err, "verifyOtpForgotBrand");
  }
}

async function updatePasswordBrand(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const token = getBearerToken(req);
    const secret = process.env.JWT_SECRET;

    if (!secret) throw new InternalError("JWT_SECRET is missing in env");

    const decoded = jwt.verify(token, secret);

    if (
      decoded?.tokenType !== "pwd_reset" ||
      decoded?.role !== "brand" ||
      !decoded?.brandId ||
      !decoded?.resetId ||
      !decoded?.email
    ) {
      throw new UnauthorizedError("Invalid reset token");
    }

    const newPassword = String(req.body?.newPassword || "");

    if (!newPassword.trim()) {
      throw new ValidationError("newPassword is required");
    }

    if (!isPasswordLenOk(newPassword)) {
      throw new ValidationError("Password must be 8 to 16 characters.");
    }

    const otpDoc = await VerifyOtpModel.findOne({
      _id: decoded.resetId,
      email: normalizeEmail(decoded.email),
      role: "brand",
      status: 1,
      docType: "otp",
      purpose: "reset_password",
    }).exec();

    if (!otpDoc) {
      throw new ValidationError("Invalid or expired reset request");
    }

    const verifiedAt = new Date(otpDoc.updatedAt || otpDoc.createdAt).getTime();
    if (Date.now() - verifiedAt > RESET_TTL_MS) {
      throw new ValidationError("Reset session expired. Verify OTP again.");
    }

    const brand = await BrandModel.findById(decoded.brandId)
      .select("+password")
      .exec();

    if (!brand) {
      throw new NotFoundError("Brand not found");
    }

    assertNotPendingAdminCreatedBrand(brand);

    const samePassword = await brand.comparePassword(newPassword);

    if (samePassword) {
      throw new ValidationError(
        "New password cannot be the same as your last password"
      );
    }

    brand.password = newPassword;
    await brand.save();

    await VerifyOtpModel.deleteMany({
      email: normalizeEmail(decoded.email),
      role: "brand",
      docType: "otp",
      purpose: "reset_password",
    }).exec();

    await resetSigninLimit(decoded.email);

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      { message: "Password updated successfully" },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "UPDATE_PASSWORD_BRAND_ERROR");
    return handleControllerError(next, err, "updatePasswordBrand");
  }
}

async function getBrandById(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const id = req.query.id || req.query.brandId || req.params.id;

    if (!id) {
      throw new ValidationError("Query parameter id or brandId is required.");
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ValidationError("Invalid brand id.");
    }

    const brand = await BrandModel.findById(id).lean().exec();

    if (!brand) {
      throw new NotFoundError("Brand not found.");
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        ...brand,
        brandId: String(brand._id),
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_BRAND_BY_ID_ERROR");
    return handleControllerError(next, err, "getBrandById");
  }
}

async function getBrandLiteById(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const id =
      req.query.brandId ||
      req.query.id ||
      req.params.brandId ||
      req.params.id;

    if (!id) {
      throw new ValidationError("Query parameter brandId or id is required.");
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ValidationError("Invalid brand id.");
    }

    const brand = await BrandModel.findById(id)
      .select("name proxyEmail profilePic subscriptionDetails subscription")
      .lean()
      .exec();

    if (!brand) {
      throw new NotFoundError("Brand not found.");
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId: String(brand._id),
        name: brand.name || "",
        proxyEmail: brand.proxyEmail || "",
        profilePic: brand.profilePic || "",
        subscriptionDetails:
          brand.subscriptionDetails ?? brand.subscription ?? null,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_BRAND_LITE_BY_ID_ERROR");
    return handleControllerError(next, err, "getBrandLiteById");
  }
}

async function getBrandProfile(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const { brandId } = req.body || {};

    if (!brandId) {
      throw new ValidationError("brandId is required in request body.");
    }

    if (!mongoose.Types.ObjectId.isValid(brandId)) {
      throw new ValidationError("Invalid brandId.");
    }

    const brand = await BrandModel.findById(brandId).lean().exec();

    if (!brand) {
      throw new NotFoundError("Brand not found.");
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Brand profile fetched successfully",
        brandId: String(brand._id),
        ...brand,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_BRAND_PROFILE_ERROR");
    return handleControllerError(next, err, "getBrandProfile");
  }
}

async function updateBrandProfile(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const {
      brandId,
      brandName,
      companySize,
      brandType,
      platform,
      profilePic,
    } = req.body || {};

    if (!brandId) {
      throw new ValidationError("brandId is required.");
    }

    if (!mongoose.Types.ObjectId.isValid(brandId)) {
      throw new ValidationError("Invalid brandId.");
    }

    const brand = await BrandModel.findById(brandId).lean().exec();

    if (!brand) {
      throw new NotFoundError("Brand not found.");
    }

    const update = {};

    if (brandName !== undefined) {
      update.brandName = safeTrim(brandName);
      update.name = safeTrim(brandName);
    }

    if (companySize !== undefined) {
      update.companySize = safeTrim(companySize);
    }

    if (profilePic !== undefined) {
      update.profilePic = safeTrim(profilePic);
      update.isProfilePicSkip = !safeTrim(profilePic);
    }

    if (brandType !== undefined) {
      const page1 = Array.isArray(brand.page1) ? [...brand.page1] : [];
      const idx = page1.findIndex((x) =>
        String(x?.question || "")
          .toLowerCase()
          .includes("what type of brand")
      );

      const row = {
        question: "What type of brand are you?",
        answers: [safeTrim(brandType)],
      };

      if (idx >= 0) page1[idx] = row;
      else page1.unshift(row);

      update.page1 = page1;
      update.ispage1Skip = false;
    }

    if (platform !== undefined) {
      update.page3 = [
        {
          question: "Preferred platforms",
          answers: [safeTrim(platform)],
        },
      ];
      update.ispage3Skip = false;
    }

    const updatedBrand = await BrandModel.findByIdAndUpdate(brandId, update, {
      new: true,
      runValidators: true,
    }).exec();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Brand profile updated successfully",
        brandId: String(updatedBrand._id),
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "UPDATE_BRAND_PROFILE_ERROR");
    return handleControllerError(next, err, "updateBrandProfile");
  }
}

const uploadBrandProfilePic = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Brand profile image is required",
      });
    }

    const uploadedImage = await uploadBrandProfilePicToS3(
      req.file,
      "brand-profile-pic"
    );

    return res.status(200).json({
      success: true,
      message: "Brand profile image uploaded successfully",
      data: uploadedImage,
    });
  } catch (error) {
    console.error("Brand profile image upload error:", error);
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "UPLOAD_BRAND_PROFILE_PIC_ERROR");

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to upload brand profile image",
    });
  }
};






async function verifyBrandCoupon(req, res) {
  try {
    const { brandId, subscriptionId, mode, promocode } = req.body;

    if (!brandId) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Brand ID is required",
      });
    }

    if (!subscriptionId) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Subscription ID is required",
      });
    }

    if (!mode) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Mode is required",
      });
    }

    if (!promocode) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Promocode is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(brandId)) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Invalid Brand ID",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(subscriptionId)) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Invalid Subscription ID",
      });
    }

    const coupon = await BrandCoupon.findOne({
      brandId,
      subscriptionId,
      mode: mode.trim(),
      promocode: { $regex: `^${promocode.trim()}$`, $options: "i" },
    })
      .populate("subscriptionId", "name monthlyCost annualCost currency")
      .lean();

    if (!coupon) {
      return res.status(404).json({
        success: false,
        verified: false,
        message: "Invalid promocode or this promocode is not valid for this subscription",
      });
    }

    if (coupon.hasUsed) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Promocode has already been used",
      });
    }

    if (new Date(coupon.expiredAt) < new Date()) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Promocode has expired",
      });
    }

    return res.status(200).json({
      success: true,
      verified: true,
      message: "Promocode verified successfully",
      data: {
        couponId: coupon._id,
        brandId: coupon.brandId,
        subscriptionId: coupon.subscriptionId,
        mode: coupon.mode,
        promocode: coupon.promocode,
        newPrice: coupon.newPrice,
        expiredAt: coupon.expiredAt,
        hasUsed: coupon.hasUsed,
      },
    });
  } catch (error) {
    console.error("verifyBrandCoupon error:", error);
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "VERIFY_BRAND_COUPON_ERROR");

    return res.status(500).json({
      success: false,
      verified: false,
      message: "Failed to verify promocode",
      error: error.message,
    });
  }
}

const bookmarkCleanStr = (value) => String(value || "").trim();

const getBookmarkBrandIdFromReq = (req) => {
  return bookmarkCleanStr(
    req.brand?._id ||
    req.brand?.id ||
    req.user?.brandId ||
    req.user?._id ||
    req.user?.id ||
    req.body?.brandId ||
    req.query?.brandId
  );
};

const getBookmarkProfileKey = (item = {}) => {
  const influencerId = bookmarkCleanStr(
    item.influencerId ||
    item.creatorId ||
    item.userId ||
    item.modashId ||
    item._id
  );

  if (influencerId) return `id:${influencerId}`;

  const email = bookmarkCleanStr(item.email).toLowerCase();
  if (email) return `email:${email}`;

  const link = bookmarkCleanStr(
    item.primaryLink || item.profileUrl || item.url || item.links?.[0]
  )
    .toLowerCase()
    .replace(/\/+$/, "");

  if (link) return `link:${link}`;

  const provider = bookmarkCleanStr(item.provider || item.platform).toLowerCase();

  const handle = bookmarkCleanStr(item.handle || item.username)
    .toLowerCase()
    .replace(/^@+/, "");

  if (provider || handle) return `handle:${provider}:${handle}`;

  const name = bookmarkCleanStr(
    item.name || item.fullname || item.fullName || item.username
  ).toLowerCase();

  return name ? `name:${name}:${provider}` : "";
};

async function addbookmarkProfile(req, res) {
  try {
    const brandId = getBookmarkBrandIdFromReq(req);

    if (!brandId) {
      return res.status(401).json({
        success: false,
        error: "Brand authentication is required",
      });
    }

    const incomingProfiles = Array.isArray(req.body?.profiles)
      ? req.body.profiles
      : Array.isArray(req.body?.influencers)
        ? req.body.influencers
        : req.body?.profile
          ? [req.body.profile]
          : req.body?.influencer
            ? [req.body.influencer]
            : [req.body];

    const profiles = incomingProfiles
      .filter(Boolean)
      .map((item) => {
        const primaryLink = bookmarkCleanStr(
          item.primaryLink || item.profileUrl || item.url
        );

        const avatar = bookmarkCleanStr(
          item.picture ||
          item.avatarUrl ||
          item.profileImage ||
          item.profilePicture ||
          item.image ||
          item.thumbnail ||
          item.avatar ||
          item.profilePicUrl
        );

        const categories = Array.isArray(item.categories)
          ? item.categories
          : Array.isArray(item.niche)
            ? item.niche
            : item.category
              ? [item.category]
              : item.niche
                ? [item.niche]
                : [];

        const profile = {
          influencerId: bookmarkCleanStr(
            item.influencerId || item.creatorId || item.userId || item._id
          ),
          creatorId: bookmarkCleanStr(
            item.creatorId || item.influencerId || item.userId || item._id
          ),
          userId: bookmarkCleanStr(
            item.userId || item.influencerId || item.creatorId || item._id
          ),
          modashId: bookmarkCleanStr(item.modashId),

          name: bookmarkCleanStr(
            item.name || item.fullname || item.fullName || item.username
          ),
          fullname: bookmarkCleanStr(item.fullname || item.fullName || item.name),
          username: bookmarkCleanStr(item.username || item.handle),
          handle: bookmarkCleanStr(item.handle || item.username),

          email: bookmarkCleanStr(item.email).toLowerCase(),

          provider: bookmarkCleanStr(item.provider || item.platform),
          platform: bookmarkCleanStr(item.platform || item.provider),

          country: bookmarkCleanStr(item.country),
          location: bookmarkCleanStr(item.location || item.country),

          categories,
          niche: categories,

          followers: Number(item.followers || item.followerCount || 0),
          engagementRate: Number(item.engagementRate || 0),
          engagements: Number(item.engagements || 0),
          averageViews: Number(item.averageViews || 0),

          primaryLink,
          profileUrl: bookmarkCleanStr(item.profileUrl || primaryLink),
          url: bookmarkCleanStr(item.url || primaryLink),
          links: Array.isArray(item.links)
            ? item.links.filter(Boolean).map(bookmarkCleanStr)
            : primaryLink
              ? [primaryLink]
              : [],

          picture: avatar,
          avatarUrl: bookmarkCleanStr(item.avatarUrl || avatar),
          profileImage: bookmarkCleanStr(item.profileImage || avatar),

          bio: bookmarkCleanStr(item.bio),
          description: bookmarkCleanStr(item.description || item.bio),

          isVerified: Boolean(item.isVerified || item.verified),
          verified: Boolean(item.verified || item.isVerified),
          isPrivate: Boolean(item.isPrivate),

          searchType: bookmarkCleanStr(item.searchType || "standard"),
          source: bookmarkCleanStr(item.source || "standard"),

          raw: item,
          bookmarkedAt: new Date(),
        };

        profile.profileKey =
          bookmarkCleanStr(item.profileKey) || getBookmarkProfileKey(profile);

        return profile;
      })
      .filter((item) => {
        return (
          item.profileKey ||
          item.influencerId ||
          item.creatorId ||
          item.userId ||
          item.email ||
          item.primaryLink ||
          item.handle ||
          item.name
        );
      });

    if (!profiles.length) {
      return res.status(400).json({
        success: false,
        error: "At least one influencer profile is required",
      });
    }

    let folder = await BookmarkFolder.findOne({
      brandId,
      name: "bookmarked",
      archivedAt: null,
    });

    if (!folder) {
      folder = await BookmarkFolder.create({
        brandId,
        name: "bookmarked",
        title: "Bookmarked",
        slug: "bookmarked",
        description: "Saved influencer profiles",
        type: "bookmark",
        items: [],
        bookmarks: [],
        createdBy: req.brand?._id || req.user?._id || null,
        createdByRole: "Brand",
        archivedAt: null,
      });
    }

    const existingItems = Array.isArray(folder.items)
      ? folder.items
      : Array.isArray(folder.bookmarks)
        ? folder.bookmarks
        : [];

    const existingKeys = new Set(
      existingItems
        .map((item) => item.profileKey || getBookmarkProfileKey(item))
        .filter(Boolean)
    );

    const newProfiles = profiles.filter((profile) => {
      const key = profile.profileKey || getBookmarkProfileKey(profile);

      if (!key || existingKeys.has(key)) return false;

      existingKeys.add(key);
      return true;
    });

    if (newProfiles.length) {
      folder.items = [...existingItems, ...newProfiles];
      folder.bookmarks = folder.items;
      folder.updatedAt = new Date();

      await folder.save();
    }

    return res.status(newProfiles.length ? 201 : 200).json({
      success: true,
      message: newProfiles.length
        ? "Profile bookmarked successfully"
        : "Profile already exists in bookmarked folder",
      data: {
        folder: {
          _id: String(folder._id),
          name: folder.name,
          title: folder.title || folder.name,
          slug: folder.slug,
          description: folder.description || "",
          itemCount: Array.isArray(folder.items) ? folder.items.length : 0,
          createdAt: folder.createdAt,
          updatedAt: folder.updatedAt,
        },
        addedCount: newProfiles.length,
        skippedCount: profiles.length - newProfiles.length,
        addedItems: newProfiles,
      },
    });
  } catch (err) {
    console.error("[addbookmarkProfile] Error:", err);
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "ADD_BOOKMARK_PROFILE_ERROR");

    return res.status(500).json({
      success: false,
      error: err?.message || "Internal error",
    });
  }
}

async function getbookmarkProfile(req, res) {
  try {
    const brandId = getBookmarkBrandIdFromReq(req);

    if (!brandId) {
      return res.status(401).json({
        success: false,
        error: "Brand authentication is required",
      });
    }

    const folder = await BookmarkFolder.findOne({
      brandId,
      name: "bookmarked",
      archivedAt: null,
    }).lean();

    const items = folder
      ? Array.isArray(folder.items)
        ? folder.items
        : Array.isArray(folder.bookmarks)
          ? folder.bookmarks
          : []
      : [];

    const savedKeys = Array.from(
      new Set(
        items
          .map((item) => item.profileKey || getBookmarkProfileKey(item))
          .filter(Boolean)
      )
    );

    return res.status(200).json({
      success: true,
      message: "Bookmarked profiles fetched successfully",
      data: {
        folder: folder
          ? {
            _id: String(folder._id),
            name: folder.name,
            title: folder.title || folder.name,
            slug: folder.slug,
            description: folder.description || "",
            itemCount: items.length,
            createdAt: folder.createdAt,
            updatedAt: folder.updatedAt,
          }
          : null,
        totalCount: items.length,
        savedKeys,
        items,
      },
    });
  } catch (err) {
    console.error("[getbookmarkProfile] Error:", err);
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_BOOKMARK_PROFILE_ERROR");

    return res.status(500).json({
      success: false,
      error: err?.message || "Internal error",
    });
  }
}



/* -------------------------------------------------------------------------- */
/*                         Brand-owned folder controllers                      */
/* -------------------------------------------------------------------------- */

const folderCleanStr = (value) =>
  value === undefined || value === null ? "" : String(value).trim();

function folderToObjectId(value) {
  const id = folderCleanStr(value);
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function folderSlugify(value) {
  return folderCleanStr(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function getFolderAuthedBrandId(req = {}) {
  return folderCleanStr(
    req.brand?._id ||
    req.brand?.id ||
    req.brand?.brandId ||
    req.brandId ||
    req.user?.brandId ||
    req.user?.brand?._id ||
    req.user?.brand?.id ||
    req.user?._id ||
    req.user?.id ||
    req.auth?.brandId
  );
}

function getFolderRequestedBrandId(req = {}) {
  return folderCleanStr(
    req.query?.brandId ||
    req.body?.brandId ||
    req.params?.brandId ||
    getFolderAuthedBrandId(req)
  );
}

function normalizeBrandFolderKind(value = "all") {
  const raw = folderCleanStr(value).toLowerCase();

  if (!raw || raw === "all") return "all";

  if (
    ["folder", "folders", "pitch_sheet", "pitchsheet", "manual"].includes(raw)
  ) {
    return "folder";
  }

  if (["bookmark", "bookmarks", "bookmarked"].includes(raw)) {
    return "bookmark";
  }

  if (["good_fit", "good-fit", "goodfit", "saved"].includes(raw)) {
    return "good_fit";
  }

  return "folder";
}

function buildBrandScopedFolderFilter(brandId) {
  const id = folderCleanStr(brandId);
  const objectId = folderToObjectId(id);

  const brandOr = [{ brandId: id }];

  if (objectId) {
    brandOr.push({ brandId: objectId }, { brandRef: objectId });
  }

  return {
    archivedAt: null,
    $or: brandOr,
  };
}

function brandFolderSearchMatches(folder = {}, search = "") {
  const q = folderCleanStr(search).toLowerCase();
  if (!q) return true;

  return [
    folder.title,
    folder.name,
    folder.slug,
    folder.description,
    folder.type,
    folder.creatorTier,
    folder.linkedCampaign?.campaignTitle,
    folder.linkedCampaign?.productOrServiceName,
    folder.linkedCampaign?.campaignsId,
    folder.linkedCampaign?.brandName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(q);
}

function brandFolderMatchesCampaign(folder = {}, campaignId = "") {
  const id = folderCleanStr(campaignId);
  if (!id) return true;

  const linked = folder.linkedCampaign || {};

  return [
    linked.campaignId,
    linked.campaignsId,
    linked._id,
    folder.campaignId,
    folder.campaignsId,
  ]
    .map((value) => folderCleanStr(value))
    .filter(Boolean)
    .includes(id);
}

function serializeBrandFolderCard(folder = {}) {
  const itemCount = Array.isArray(folder.items)
    ? folder.items.length
    : Number(folder.itemCount || 0);

  return {
    _id: String(folder._id),
    id: String(folder._id),

    brandId: folderCleanStr(folder.brandId),
    brandName: folderCleanStr(folder.brandName),

    title: folderCleanStr(folder.title || folder.name),
    name: folderCleanStr(folder.name || folder.title),
    slug: folderCleanStr(folder.slug),
    description: folderCleanStr(folder.description),

    type: folderCleanStr(folder.type || "folder"),
    creatorTier: folderCleanStr(folder.creatorTier),

    linkedCampaign: folder.linkedCampaign || null,

    itemCount,
    isDefault: !!folder.isDefault,

    createdAt: folder.createdAt || null,
    updatedAt: folder.updatedAt || null,
    archivedAt: folder.archivedAt || null,
  };
}

function serializeBrandFolderDetail(folder = {}) {
  return {
    ...serializeBrandFolderCard(folder),
    items: Array.isArray(folder.items) ? folder.items : [],
  };
}

async function buildUniqueBrandFolderSlug(brandId, title, excludeId = null) {
  const base = folderSlugify(title) || "folder";
  let slug = base;
  let counter = 2;

  while (true) {
    const filter = {
      ...buildBrandScopedFolderFilter(brandId),
      slug,
    };

    if (excludeId && mongoose.Types.ObjectId.isValid(String(excludeId))) {
      filter._id = { $ne: new mongoose.Types.ObjectId(String(excludeId)) };
    }

    const existing = await BrandFolderModel.findOne(filter).select("_id").lean();

    if (!existing) return slug;

    slug = `${base}-${counter}`;
    counter += 1;
  }
}

function folderIsPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function folderGetSourceItem(rawItem = {}) {
  const item = folderIsPlainObject(rawItem) ? rawItem : {};
  const raw = folderIsPlainObject(item.raw) ? item.raw : item;

  return {
    item,
    raw,
    source: {
      ...raw,
      ...item,
    },
  };
}

function folderFirstText(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      const nested = folderFirstText(...value);
      if (nested) return nested;
      continue;
    }

    if (folderIsPlainObject(value)) {
      const nested = folderFirstText(
        value.code,
        value.isoCode,
        value.countryCode,
        value.languageCode,
        value.name,
        value.title,
        value.label,
        value.value,
        value.country,
        value.language,
        value.city,
        value.region
      );

      if (nested) return nested;
      continue;
    }

    const text = folderCleanStr(value);
    if (text) return text;
  }

  return "";
}

function folderArrayValues(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value.filter(Boolean);
    }

    if (typeof value === "string" && value.trim()) {
      return value
        .split(",")
        .map((item) => folderCleanStr(item))
        .filter(Boolean);
    }
  }

  return [];
}

function folderNumberValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;

    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }

  return null;
}

function folderBooleanValue(...values) {
  for (const value of values) {
    if (value === true) return true;
    if (value === false) return false;

    const text = folderCleanStr(value).toLowerCase();
    if (["true", "1", "yes"].includes(text)) return true;
    if (["false", "0", "no"].includes(text)) return false;
  }

  return false;
}

function getBrandFolderProfileKey(item = {}) {
  const { source } = folderGetSourceItem(item);

  const explicitProfileKey = folderCleanStr(source.profileKey);
  if (explicitProfileKey) return explicitProfileKey;

  const influencerId = folderFirstText(
    source.influencerId,
    source.creatorId,
    source.userId,
    source.modashId,
    source.channelId,
    source.id,
    source._id
  );

  if (influencerId) return `id:${influencerId}`;

  const email = folderFirstText(source.email).toLowerCase();
  if (email) return `email:${email}`;

  const link = folderFirstText(
    source.primaryLink,
    source.profileUrl,
    source.profile_url,
    source.url,
    source.links?.[0]
  )
    .toLowerCase()
    .replace(/\/+$/, "");

  if (link) return `link:${link}`;

  const handle = folderFirstText(
    source.handle,
    source.username,
    source.userName,
    source.screenName
  )
    .toLowerCase()
    .replace(/^@+/, "");

  const provider = folderFirstText(source.provider, source.platform).toLowerCase();

  if (handle) return `handle:${provider || "unknown"}:${handle}`;

  const name = folderFirstText(
    source.name,
    source.fullname,
    source.fullName
  ).toLowerCase();

  return name ? `name:${name}:${provider}` : "";
}

function normalizeBrandFolderItem(rawItem = {}, status = "saved") {
  const { item, raw, source } = folderGetSourceItem(rawItem);

  const profileKey = getBrandFolderProfileKey(source);

  const influencerId = folderFirstText(
    source.influencerId,
    source.creatorId,
    source.userId,
    source.modashId,
    source.channelId,
    source.id,
    source._id
  );

  const provider = folderFirstText(source.provider, source.platform);
  const platform = folderFirstText(source.platform, source.provider);

  const handle = folderFirstText(
    source.handle,
    source.username,
    source.userName,
    source.screenName
  ).replace(/^@+/, "");

  const primaryLink = folderFirstText(
    source.primaryLink,
    source.profileUrl,
    source.profile_url,
    source.url,
    source.links?.[0]
  );

  const picture = folderFirstText(
    source.picture,
    source.avatarUrl,
    source.profileImage,
    source.profilePicture,
    source.image,
    source.thumbnail,
    source.avatar,
    source.profilePicUrl,
    source.photo
  );

  const country = folderFirstText(
    source.country,
    source.countryCode,
    source.location?.country,
    source.location?.countryCode,
    source.location?.isoCode,
    source.profile?.country,
    source.account?.country,
    source.audience?.country,
    source.audience?.countries?.[0],
    source.audience?.geoCountries?.[0],
    source.audience?.topCountries?.[0]
  );

  const language = folderFirstText(
    source.language,
    source.languageCode,
    source.languages,
    source.profile?.language,
    source.account?.language,
    source.audience?.language,
    source.audience?.languages,
    source.stats?.language
  );

  const location = folderFirstText(
    source.location?.name,
    source.location?.fullName,
    source.location?.city,
    source.location?.region,
    source.location,
    country
  );

  const categories = folderArrayValues(
    source.categories,
    source.niche,
    source.category ? [source.category] : [],
    source.topicTags,
    source.interests
  );

  const links = Array.from(
    new Set(
      [
        ...(Array.isArray(source.links) ? source.links : []),
        primaryLink,
      ]
        .map(folderCleanStr)
        .filter(Boolean)
    )
  );

  const normalized = {
    profileKey,

    influencerId,
    creatorId: folderFirstText(source.creatorId, influencerId),
    userId: folderFirstText(source.userId, influencerId),
    modashId: folderFirstText(source.modashId),
    channelId: folderFirstText(source.channelId),

    name: folderFirstText(
      source.name,
      source.fullname,
      source.fullName,
      source.username,
      handle
    ),
    fullname: folderFirstText(source.fullname, source.fullName, source.name),
    fullName: folderFirstText(source.fullName, source.fullname, source.name),
    username: folderFirstText(source.username, source.userName, handle),
    userName: folderFirstText(source.userName, source.username, handle),
    handle,

    email: folderFirstText(source.email).toLowerCase(),
    emails: folderArrayValues(source.emails, source.contacts?.emails),

    provider,
    platform,

    country,
    countryCode: folderFirstText(source.countryCode, country),

    language,
    languageCode: folderFirstText(source.languageCode, language),
    languages: folderArrayValues(source.languages, source.audience?.languages),

    location,
    city: folderFirstText(source.city, source.location?.city),
    region: folderFirstText(
      source.region,
      source.state,
      source.location?.region,
      source.location?.state
    ),

    categories,
    niche: categories,

    followers: folderNumberValue(
      source.followers,
      source.followerCount,
      source.stats?.followers
    ),
    engagements: folderNumberValue(
      source.engagements,
      source.stats?.engagements
    ),
    engagementRate: folderNumberValue(
      source.engagementRate,
      source.stats?.engagementRate
    ),
    averageViews: folderNumberValue(
      source.averageViews,
      source.avgViews,
      source.stats?.avgViews,
      source.stats?.views
    ),

    primaryLink,
    profileUrl: folderFirstText(source.profileUrl, source.profile_url, primaryLink),
    url: folderFirstText(source.url, primaryLink),
    links,

    picture,
    avatarUrl: folderFirstText(source.avatarUrl, picture),
    profileImage: folderFirstText(source.profileImage, picture),

    bio: folderFirstText(source.bio, source.description),
    description: folderFirstText(source.description, source.bio),

    isVerified: folderBooleanValue(source.isVerified, source.verified),
    verified: folderBooleanValue(source.verified, source.isVerified),
    isPrivate: folderBooleanValue(source.isPrivate),

    searchType: folderFirstText(source.searchType) || "standard",

    // Keep source as string if it was string, otherwise default.
    source: typeof source.source === "string"
      ? folderCleanStr(source.source || "standard")
      : "standard",

    status,

    // Important full nested details
    audience: source.audience || raw.audience || null,
    stats: source.stats || raw.stats || null,
    contacts: source.contacts || raw.contacts || null,
    profile: source.profile || raw.profile || null,
    account: source.account || raw.account || null,

    raw: {
      ...raw,
      ...item,
    },

    addedAt: source.addedAt || new Date(),
    updatedAt: new Date(),
  };

  return normalized;
}

async function findBrandFolderCampaignSnapshot(campaignId, brandId) {
  const id = folderCleanStr(campaignId);

  if (!id) return null;

  if (!BrandCampaignModel || typeof BrandCampaignModel.findOne !== "function") {
    return {
      campaignId: id,
      campaignsId: id,
      campaignTitle: id,
      productOrServiceName: "",
      brandId,
      brandName: "",
    };
  }

  const campaignOr = [{ campaignsId: id }];

  const objectId = folderToObjectId(id);
  if (objectId) campaignOr.push({ _id: objectId });

  const campaign = await BrandCampaignModel.findOne({ $or: campaignOr }).lean();

  if (!campaign) return null;

  const requestedBrandId = folderCleanStr(brandId);
  const campaignBrandId = folderCleanStr(campaign.brandId);

  if (requestedBrandId && campaignBrandId && campaignBrandId !== requestedBrandId) {
    const brandObjectId = folderToObjectId(requestedBrandId);

    if (!brandObjectId || String(campaign.brandId) !== String(brandObjectId)) {
      return null;
    }
  }

  return {
    campaignId: campaign._id ? String(campaign._id) : id,
    campaignsId: folderCleanStr(campaign.campaignsId),
    campaignTitle: folderCleanStr(
      campaign.campaignTitle ||
      campaign.title ||
      campaign.name ||
      campaign.productOrServiceName
    ),
    productOrServiceName: folderCleanStr(campaign.productOrServiceName),
    brandId: campaign.brandId ? String(campaign.brandId) : requestedBrandId,
    brandName: folderCleanStr(campaign.brandName),
  };
}

async function getOrCreateBrandDefaultFolder({ brandId, type, title, req }) {
  let folder = await BrandFolderModel.findOne({
    ...buildBrandScopedFolderFilter(brandId),
    type,
    isDefault: true,
  });

  if (folder) return folder;

  const slug = await buildUniqueBrandFolderSlug(brandId, title);

  return BrandFolderModel.create({
    brandId,
    brandRef: folderToObjectId(brandId),
    brandName: folderCleanStr(req?.brand?.name || req?.body?.brandName),
    title,
    name: title,
    slug,
    description: "",
    type,
    creatorTier: "",
    linkedCampaign: null,
    items: [],
    itemCount: 0,
    isDefault: true,
    createdByBrand: req?.brand?._id || req?.brand?.id || brandId,
    archivedAt: null,
  });
}

function upsertProfilesIntoBrandFolder(folder, profiles) {
  const existingKeys = new Set(
    (folder.items || []).map((item) => item.profileKey).filter(Boolean)
  );

  let added = 0;
  let skipped = 0;

  profiles.forEach((profile) => {
    const key = profile.profileKey;

    if (!key || existingKeys.has(key)) {
      skipped += 1;
      return;
    }

    existingKeys.add(key);
    folder.items.push(profile);
    added += 1;
  });

  folder.itemCount = folder.items.length;
  folder.updatedAt = new Date();

  return { added, skipped };
}


function campaignValueMatches(left, right) {
  const a = folderCleanStr(left);
  const b = folderCleanStr(right);
  return Boolean(a && b && a === b);
}

function buildAssignedCampaignLookupValues(rawCampaignId, campaign = {}) {
  return [
    rawCampaignId,
    campaign._id ? String(campaign._id) : "",
    campaign.id,
    campaign.campaignId,
    campaign.campaignsId,
  ]
    .map(folderCleanStr)
    .filter(Boolean);
}

function brandFolderCampaignMatches(folderCampaign = {}, lookupValues = []) {
  if (!lookupValues.length) return false;

  const values = [
    folderCampaign.campaignId,
    folderCampaign._id,
    folderCampaign.id,
    folderCampaign.campaignsId,
  ].map(folderCleanStr);

  return values.some((value) => lookupValues.includes(value));
}

function pitchFolderMatchesBrandForGoodFit(folder = {}, brandId = "") {
  const wanted = folderCleanStr(brandId);
  if (!wanted) return false;

  return [
    folder.brandId,
    folder.brandRef,
    folder.brand?._id,
    folder.brand?.id,
    folder.assignedCampaign?.brandId,
    folder.assignedCampaign?.brandRef,
  ]
    .map(folderCleanStr)
    .some((value) => value === wanted);
}

function pitchFolderMatchesCampaignForGoodFit(folder = {}, lookupValues = []) {
  if (!lookupValues.length) return false;

  const assignedCampaign = folder.assignedCampaign || {};

  return brandFolderCampaignMatches(assignedCampaign, lookupValues);
}

function getCampaignDisplayNameForBrandFolder(campaign = {}) {
  return (
    folderCleanStr(
      campaign.campaignTitle ||
      campaign.productOrServiceName ||
      campaign.title ||
      campaign.name ||
      campaign.campaignsId
    ) || "Campaign"
  );
}

function isTruthyFullyManagedValue(value) {
  if (value === true) return true;

  const text = folderCleanStr(value).toLowerCase();

  if (!text) return false;

  if (["true", "1", "yes", "y"].includes(text)) return true;

  return [
    "fully_managed",
    "fully-managed",
    "fully managed",
    "full_managed",
    "full-managed",
    "full managed",
    "fullymanaged",
    "fullmanaged",
    "managed",
    "done_for_you",
    "done-for-you",
    "done for you",
    "doneforyou",
    "admin_review",
    "admin-review",
    "admin review",
  ].includes(text);
}

function isFullyManagedCampaign(campaign = {}) {
  if (!campaign || typeof campaign !== "object") return false;

  if (isTruthyFullyManagedValue(campaign.isFullyManaged)) return true;
  if (isTruthyFullyManagedValue(campaign.fullyManaged)) return true;
  if (isTruthyFullyManagedValue(campaign.isFullManaged)) return true;
  if (isTruthyFullyManagedValue(campaign.fullManaged)) return true;
  if (isTruthyFullyManagedValue(campaign.managedByAdmin)) return true;
  if (isTruthyFullyManagedValue(campaign.isAdminCreated)) return true;

  const createdByRole = folderCleanStr(
    campaign.createdBy?.role ||
    campaign.createdByRole ||
    campaign.createdByType ||
    campaign.ownerRole
  ).toLowerCase();

  if (createdByRole === "admin" || createdByRole === "master") return true;

  if (isTruthyFullyManagedValue(campaign.approvalMode)) return true;

  const values = [
    campaign.campaignType,
    campaign.type,
    campaign.planType,
    campaign.planName,
    campaign.campaignPlan,
    campaign.managementType,
    campaign.serviceType,
    campaign.workflowType,
    campaign.mode,
    campaign.source,
    campaign.creatorManagement,
    campaign.packageType,
    campaign.packageName,
    campaign.subscriptionPlan,
  ];

  return values.some(isTruthyFullyManagedValue);
}

function buildBrandCampaignPayload(campaign = {}, brandId = "") {
  return {
    campaignId: campaign._id ? String(campaign._id) : folderCleanStr(campaign.campaignId),
    campaignsId: folderCleanStr(campaign.campaignsId),
    campaignTitle: folderCleanStr(
      campaign.campaignTitle ||
      campaign.title ||
      campaign.name ||
      campaign.productOrServiceName
    ),
    productOrServiceName: folderCleanStr(campaign.productOrServiceName),
    brandId: campaign.brandId ? String(campaign.brandId) : folderCleanStr(brandId),
    brandName: folderCleanStr(campaign.brandName),
    assignedAt: campaign.assignedAt || null,
  };
}

async function findBrandCampaignByAnyId(campaignId, brandId) {
  const id = folderCleanStr(campaignId);

  if (!id || !BrandCampaignModel || typeof BrandCampaignModel.findOne !== "function") {
    return null;
  }

  const lookupOr = [{ campaignsId: id }, { campaignId: id }, { id }];

  const objectId = folderToObjectId(id);
  if (objectId) lookupOr.push({ _id: objectId });

  const campaign = await BrandCampaignModel.findOne({ $or: lookupOr }).lean();

  if (!campaign) return null;

  const requestedBrandId = folderCleanStr(brandId);
  const campaignBrandId = folderCleanStr(campaign.brandId);

  if (requestedBrandId && campaignBrandId && campaignBrandId !== requestedBrandId) {
    const brandObjectId = folderToObjectId(requestedBrandId);

    if (!brandObjectId || String(campaign.brandId) !== String(brandObjectId)) {
      return null;
    }
  }

  return campaign;
}

async function findPitchFoldersForBrandCampaignGoodFit(rawCampaignId, campaign, brandId) {
  const lookupValues = buildAssignedCampaignLookupValues(rawCampaignId, campaign);

  if (!PitchFolderForBrandGoodFit || typeof PitchFolderForBrandGoodFit.find !== "function") {
    return [];
  }

  const candidateOr = [];

  lookupValues.forEach((value) => {
    candidateOr.push(
      { "assignedCampaign.campaignId": value },
      { "assignedCampaign.campaignsId": value },
      { "assignedCampaign._id": value },
      { "assignedCampaign.id": value }
    );

    const objectId = folderToObjectId(value);
    if (objectId) {
      candidateOr.push(
        { "assignedCampaign.campaignId": objectId },
        { "assignedCampaign._id": objectId }
      );
    }
  });

  const docs = await PitchFolderForBrandGoodFit.find({
    archivedAt: null,
    "items.goodFit": true,
    ...(candidateOr.length ? { $or: candidateOr } : {}),
  })
    .sort({ updatedAt: -1 })
    .lean();

  return docs.filter((folder) => {
    return (
      pitchFolderMatchesCampaignForGoodFit(folder, lookupValues) &&
      pitchFolderMatchesBrandForGoodFit(folder, brandId)
    );
  });
}

async function findPitchFoldersForBrandCampaign(rawCampaignId, campaign, brandId) {
  const lookupValues = buildAssignedCampaignLookupValues(rawCampaignId, campaign);

  if (!PitchFolderForBrandGoodFit || typeof PitchFolderForBrandGoodFit.find !== "function") {
    return [];
  }

  const candidateOr = [];

  lookupValues.forEach((value) => {
    candidateOr.push(
      { "assignedCampaign.campaignId": value },
      { "assignedCampaign.campaignsId": value },
      { "assignedCampaign._id": value },
      { "assignedCampaign.id": value }
    );

    const objectId = folderToObjectId(value);
    if (objectId) {
      candidateOr.push(
        { "assignedCampaign.campaignId": objectId },
        { "assignedCampaign._id": objectId }
      );
    }
  });

  const docs = await PitchFolderForBrandGoodFit.find({
    archivedAt: null,
    ...(candidateOr.length ? { $or: candidateOr } : {}),
  })
    .sort({ updatedAt: -1 })
    .lean();

  return docs.filter((folder) => {
    return (
      pitchFolderMatchesCampaignForGoodFit(folder, lookupValues) &&
      pitchFolderMatchesBrandForGoodFit(folder, brandId)
    );
  });
}


function normalizePitchGoodFitItemForBrandFolder(item = {}, source = {}, campaignPayload = {}) {
  const raw = item.raw && typeof item.raw === "object" ? item.raw : item;
  const normalized = normalizeBrandFolderItem(
    {
      ...raw,
      ...item,
      status: "good_fit",
      goodFit: true,
      campaignId: campaignPayload.campaignId,
      campaignsId: campaignPayload.campaignsId,
      campaignTitle: campaignPayload.campaignTitle,
      pitchFolderId: source.pitchFolderId,
      pitchFolderTitle: source.pitchFolderTitle,
      pitchItemId: source.pitchItemId,
    },
    "good_fit"
  );

  normalized.source = {
    source: "fully_managed_pitch_good_fit",
    pitchFolderId: source.pitchFolderId,
    pitchFolderTitle: source.pitchFolderTitle,
    pitchItemId: source.pitchItemId,
    campaignId: campaignPayload.campaignId,
    campaignsId: campaignPayload.campaignsId,
    campaignTitle: campaignPayload.campaignTitle,
    importedAt: new Date(),
  };

  normalized.status = "good_fit";
  normalized.raw = {
    ...raw,
    ...item,
    goodFit: true,
    source: normalized.source,
  };

  return normalized;
}

async function getOrCreateCampaignBrandFolder({ brandId, campaign, campaignPayload, req }) {
  const title = getCampaignDisplayNameForBrandFolder(campaign);
  const linkedCampaign = campaignPayload;
  const lookupValues = buildAssignedCampaignLookupValues(campaignPayload.campaignId, {
    ...campaign,
    campaignId: campaignPayload.campaignId,
    campaignsId: campaignPayload.campaignsId,
  });

  const existingFolders = await BrandFolderModel.find({
    ...buildBrandScopedFolderFilter(brandId),
    type: "folder",
  });

  const existing = existingFolders.find((folder) => {
    if (folder.isDefault) return false;

    const linked = folder.linkedCampaign || {};

    if (brandFolderCampaignMatches(linked, lookupValues)) return true;

    const folderTitle = folderCleanStr(folder.title || folder.name).toLowerCase();
    return folderTitle && folderTitle === title.toLowerCase();
  });

  if (existing) {
    if (!existing.linkedCampaign || !existing.linkedCampaign.campaignId) {
      existing.linkedCampaign = linkedCampaign;
    }
    return existing;
  }

  const slug = await buildUniqueBrandFolderSlug(brandId, title);

  return BrandFolderModel.create({
    title,
    name: title,
    slug,
    description: "",
    brandId,
    brandRef: folderToObjectId(brandId),
    brandName: folderCleanStr(req?.brand?.name || campaignPayload.brandName),
    type: "folder",
    creatorTier: "Fully Managed",
    linkedCampaign,
    items: [],
    itemCount: 0,
    isDefault: false,
    createdByBrand: req?.brand?._id || req?.brand?.id || brandId,
    archivedAt: null,
  });
}

async function importFullyManagedCampaignGoodFitToBrandFolder({
  req,
  brandId,
  rawCampaignId,
}) {
  const campaign = await findBrandCampaignByAnyId(rawCampaignId, brandId);

  if (!campaign) {
    return {
      statusCode: 404,
      body: {
        success: false,
        error: "Campaign not found",
      },
    };
  }

  const campaignPayload = buildBrandCampaignPayload(campaign, brandId);
  const pitchFolders = await findPitchFoldersForBrandCampaignGoodFit(
    rawCampaignId,
    campaign,
    brandId
  );

  const assignedPitchFolders = pitchFolders.length
    ? pitchFolders
    : await findPitchFoldersForBrandCampaign(rawCampaignId, campaign, brandId);

  if (!isFullyManagedCampaign(campaign) && !assignedPitchFolders.length) {
    return {
      statusCode: 400,
      body: {
        success: false,
        error:
          "Only fully managed campaigns assigned to pitch folders can save good-fit creators",
      },
    };
  }

  const brandFolder = await getOrCreateCampaignBrandFolder({
    brandId,
    campaign,
    campaignPayload,
    req,
  });

  const uniqueProfileMap = new Map();

  pitchFolders.forEach((pitchFolder) => {
    const items = Array.isArray(pitchFolder.items) ? pitchFolder.items : [];

    items
      .filter((item) => item?.goodFit === true)
      .forEach((item) => {
        const source = {
          pitchFolderId: String(pitchFolder._id || ""),
          pitchFolderTitle: folderCleanStr(pitchFolder.title || pitchFolder.name),
          pitchItemId: String(item._id || item.id || ""),
        };

        const normalized = normalizePitchGoodFitItemForBrandFolder(
          item,
          source,
          campaignPayload
        );

        if (!normalized.profileKey) return;

        if (!uniqueProfileMap.has(normalized.profileKey)) {
          uniqueProfileMap.set(normalized.profileKey, normalized);
        }
      });
  });

  const profiles = Array.from(uniqueProfileMap.values());
  const result = upsertProfilesIntoBrandFolder(brandFolder, profiles);

  if (result.added || !brandFolder.isNew) {
    brandFolder.itemCount = brandFolder.items.length;
    await brandFolder.save();
  }

  const folderPayload = serializeBrandFolderDetail(brandFolder.toObject());

  return {
    statusCode: 200,
    body: {
      success: true,
      message: profiles.length
        ? "Campaign good fit influencers synced into brand folder"
        : "Brand folder created, but no good fit influencers were found yet",
      data: {
        campaign: campaignPayload,
        folder: folderPayload,
        totalFolderCount: 1,
        totalCampaignCount: 1,
        totalGoodFitCount: brandFolder.items.length,
        importedGoodFitCount: profiles.length,
        addedCount: result.added,
        skippedCount: result.skipped,
        campaigns: [campaignPayload],
        folders: [folderPayload],
        items: folderPayload.items,
      },
    },
  };
}


function findPitchFolderItemById(pitchFolders = [], itemId = "") {
  const wanted = folderCleanStr(itemId);

  if (!wanted) return null;

  for (const pitchFolder of pitchFolders) {
    const items = Array.isArray(pitchFolder.items) ? pitchFolder.items : [];

    for (const item of items) {
      const candidateIds = [
        item?._id,
        item?.id,
        item?.itemId,
        item?.profileKey,
        item?.influencerId,
        item?.creatorId,
        item?.userId,
        item?.modashId,
      ]
        .map(folderCleanStr)
        .filter(Boolean);

      if (candidateIds.includes(wanted)) {
        return {
          pitchFolder,
          item,
        };
      }
    }
  }

  return null;
}

async function saveCampaignGoodFitItem(req, res) {
  try {
    const brandId = getFolderAuthedBrandId(req);
    const rawCampaignId = folderCleanStr(req.params?.campaignId || req.body?.campaignId);
    const rawItemId = folderCleanStr(req.params?.itemId || req.body?.itemId);
    const payloadProfile =
      req.body?.profile ||
      req.body?.influencer ||
      req.body?.creator ||
      req.body?.item ||
      null;

    if (!brandId) {
      return res.status(401).json({
        success: false,
        error: "Brand authentication is required",
      });
    }

    if (!rawCampaignId) {
      return res.status(400).json({
        success: false,
        error: "campaignId is required",
      });
    }

    if (!rawItemId && !payloadProfile) {
      return res.status(400).json({
        success: false,
        error: "itemId or profile payload is required",
      });
    }

    const campaign = await findBrandCampaignByAnyId(rawCampaignId, brandId);

    if (!campaign) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found",
      });
    }

    const campaignPayload = buildBrandCampaignPayload(campaign, brandId);

    const assignedPitchFolders = await findPitchFoldersForBrandCampaign(
      rawCampaignId,
      campaign,
      brandId
    );

    if (!isFullyManagedCampaign(campaign) && !assignedPitchFolders.length) {
      return res.status(400).json({
        success: false,
        error:
          "Only fully managed campaigns assigned to pitch folders can save good-fit creators",
      });
    }

    const match = rawItemId
      ? findPitchFolderItemById(assignedPitchFolders, rawItemId)
      : null;

    const pitchFolder = match?.pitchFolder || null;
    const item = match?.item || payloadProfile;

    if (!item) {
      return res.status(404).json({
        success: false,
        error: "Creator payload was not found",
      });
    }

    const brandFolder = await getOrCreateCampaignBrandFolder({
      brandId,
      campaign,
      campaignPayload,
      req,
    });

    const source = {
      pitchFolderId: String(
        pitchFolder?._id ||
        payloadProfile?.pitchFolderId ||
        req.body?.pitchFolderId ||
        ""
      ),
      pitchFolderTitle: folderCleanStr(
        pitchFolder?.title ||
        pitchFolder?.name ||
        payloadProfile?.pitchFolderTitle ||
        req.body?.pitchFolderTitle
      ),
      pitchItemId: String(item._id || item.id || rawItemId || ""),
    };

    const normalized = normalizePitchGoodFitItemForBrandFolder(
      {
        ...item,
        ...payloadProfile,
        goodFit: true,
      },
      source,
      campaignPayload
    );

    const result = normalized.profileKey
      ? upsertProfilesIntoBrandFolder(brandFolder, [normalized])
      : { added: 0, skipped: 0 };

    brandFolder.itemCount = brandFolder.items.length;
    await brandFolder.save();

    const folderPayload = serializeBrandFolderDetail(brandFolder.toObject());

    return res.status(result.added ? 201 : 200).json({
      success: true,
      message: result.added
        ? "Creator saved to campaign brand folder"
        : "Creator already exists in campaign brand folder",
      data: {
        campaign: campaignPayload,
        folder: folderPayload,
        item: normalized,
        addedCount: result.added,
        skippedCount: result.skipped,
        saved: true,
      },
    });
  } catch (err) {
    console.error("[saveCampaignGoodFitItem] Error:", err);
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SAVE_CAMPAIGN_GOOD_FIT_ITEM_ERROR");

    return res.status(500).json({
      success: false,
      error: err?.message || "Internal error",
    });
  }
}


async function getCampaignGoodFitList(req, res) {
  try {
    const brandId = getFolderAuthedBrandId(req);
    const rawCampaignId = folderCleanStr(req.params?.campaignId || req.query?.campaignId);

    if (!brandId) {
      return res.status(401).json({
        success: false,
        error: "Brand authentication is required",
      });
    }

    if (!rawCampaignId) {
      return res.status(400).json({
        success: false,
        error: "campaignId is required",
      });
    }

    const result = await importFullyManagedCampaignGoodFitToBrandFolder({
      req,
      brandId,
      rawCampaignId,
    });

    return res.status(result.statusCode).json(result.body);
  } catch (err) {
    console.error("[getCampaignGoodFitList] Error:", err);
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_CAMPAIGN_GOOD_FIT_LIST_ERROR");

    return res.status(500).json({
      success: false,
      error: err?.message || "Internal error",
    });
  }
}


async function getFolderList(req, res) {
  try {
    const authedBrandId = getFolderAuthedBrandId(req);
    const brandId = getFolderRequestedBrandId(req) || authedBrandId;

    if (!authedBrandId) {
      return res.status(401).json({
        success: false,
        error: "Brand authentication is required",
      });
    }

    const folderKind = normalizeBrandFolderKind(
      req.query?.type || req.query?.folderType || "all"
    );

    const search = folderCleanStr(req.query?.search || req.query?.q);
    const campaignId = folderCleanStr(req.query?.campaignId);

    const hasItemsOnly = ["1", "true", "yes", "on"].includes(
      folderCleanStr(
        req.query?.hasItems ||
        req.query?.onlyWithItems ||
        req.query?.hasInfluencers
      ).toLowerCase()
    );

    const includeItems = ["1", "true", "yes", "on"].includes(
      folderCleanStr(req.query?.includeItems).toLowerCase()
    );

    const includeFolders = folderKind === "all" || folderKind === "folder";
    const includeBookmarks = folderKind === "all" || folderKind === "bookmark";
    const includeGoodFit = folderKind === "all" || folderKind === "good_fit";

    const baseFilter = buildBrandScopedFolderFilter(brandId);

    if (folderKind !== "all") {
      baseFilter.type = folderKind;
    }

    const docs = await BrandFolderModel.find(baseFilter)
      .sort({ isDefault: -1, updatedAt: -1, createdAt: -1 })
      .lean();

    const cards = docs
      .filter((folder) => brandFolderMatchesCampaign(folder, campaignId))
      .filter((folder) => brandFolderSearchMatches(folder, search))
      .filter((folder) => {
        if (!hasItemsOnly) return true;

        const count = Array.isArray(folder.items)
          ? folder.items.length
          : Number(folder.itemCount || 0);

        return count > 0;
      })
      .map(includeItems ? serializeBrandFolderDetail : serializeBrandFolderCard);

    const normalFolders = includeFolders
      ? cards.filter((folder) => folder.type === "folder")
      : [];

    const bookmarkFolders = includeBookmarks
      ? cards.filter((folder) => folder.type === "bookmark")
      : [];

    const goodFitFolders = includeGoodFit
      ? cards.filter((folder) => folder.type === "good_fit")
      : [];

    const folders = [...normalFolders, ...bookmarkFolders, ...goodFitFolders];

    return res.json({
      success: true,
      message: "Folders fetched successfully",
      data: {
        totalCount: folders.length,
        folderCount: normalFolders.length,
        bookmarkCount: bookmarkFolders.length,
        goodFitCount: goodFitFolders.length,

        folders,

        groups: {
          folders: normalFolders,
          bookmarks: bookmarkFolders,
          goodFit: goodFitFolders,
        },
      },
    });
  } catch (err) {
    console.error("[getFolderList] Error:", err);
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_FOLDER_LIST_ERROR");

    return res.status(500).json({
      success: false,
      error: err?.message || "Internal error",
    });
  }
}

async function createFolder(req, res) {
  try {
    const authedBrandId = getFolderAuthedBrandId(req);

    if (!authedBrandId) {
      return res.status(401).json({
        success: false,
        error: "Brand authentication is required",
      });
    }

    const body = req.body || {};
    const brandId = authedBrandId;
    const brandRef = folderToObjectId(brandId);

    const requestedFolderKind = normalizeBrandFolderKind(
      body.type || body.folderType || body.kind || "folder"
    );

    const type = requestedFolderKind === "all" ? "folder" : requestedFolderKind;

    const title = folderCleanStr(body.title || body.name);

    if (!title) {
      return res.status(400).json({
        success: false,
        error: "title is required",
      });
    }

    const description = folderCleanStr(body.description);
    const campaignId = folderCleanStr(body.campaignId || body.campaignsId);

    const linkedCampaign = campaignId
      ? await findBrandFolderCampaignSnapshot(campaignId, brandId)
      : null;

    if (campaignId && !linkedCampaign) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found for this brand",
      });
    }

    const slug = await buildUniqueBrandFolderSlug(brandId, title);

    const rawItems = Array.isArray(body.items) ? body.items : [];
    const initialItems = [];
    const seenInitialKeys = new Set();

    for (const rawItem of rawItems) {
      const normalizedItem = normalizeBrandFolderItem(rawItem, "saved");
      const itemKey = normalizedItem.profileKey;

      if (!itemKey || seenInitialKeys.has(itemKey)) continue;

      seenInitialKeys.add(itemKey);
      initialItems.push(normalizedItem);
    }

    const doc = await BrandFolderModel.create({
      title,
      name: title,
      slug,
      description,

      brandId,
      brandRef,
      brandName: folderCleanStr(body.brandName || req.brand?.name),

      type,
      creatorTier: folderCleanStr(body.creatorTier || body.tier),

      linkedCampaign,

      items: initialItems,
      itemCount: initialItems.length,

      isDefault: false,
      createdByBrand: req.brand?._id || req.brand?.id || brandId,
      archivedAt: null,
    });

    return res.status(201).json({
      success: true,
      message: "Folder created successfully",
      data: serializeBrandFolderDetail(doc.toObject()),
    });
  } catch (err) {
    console.error("[createFolder] Error:", err);
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "CREATE_FOLDER_ERROR");

    const duplicate = err?.code === 11000;

    return res.status(duplicate ? 409 : 500).json({
      success: false,
      error: duplicate
        ? "A folder with this name already exists"
        : err?.message || "Internal error",
    });
  }
}

async function saveGoodFitInfluencer(req, res) {
  try {
    const brandId = getFolderAuthedBrandId(req);

    if (!brandId) {
      return res.status(401).json({
        success: false,
        error: "Brand authentication is required",
      });
    }

    const incomingProfiles = Array.isArray(req.body?.profiles)
      ? req.body.profiles
      : Array.isArray(req.body?.influencers)
        ? req.body.influencers
        : req.body?.profile
          ? [req.body.profile]
          : req.body?.influencer
            ? [req.body.influencer]
            : [req.body];

    const profiles = incomingProfiles
      .filter(Boolean)
      .map((item) => {
        const normalized = normalizeBrandFolderItem(item, "good_fit");
        normalized.source = {
          source: folderCleanStr(item.source || req.body.source || "brand_good_fit"),
          pitchFolderId: folderCleanStr(item.pitchFolderId || req.body.pitchFolderId),
          pitchFolderTitle: folderCleanStr(item.pitchFolderTitle || req.body.pitchFolderTitle),
          pitchItemId: folderCleanStr(item.pitchItemId || req.body.pitchItemId),
          campaignId: folderCleanStr(item.campaignId || req.body.campaignId),
          campaignsId: folderCleanStr(item.campaignsId || req.body.campaignsId),
          campaignTitle: folderCleanStr(item.campaignTitle || req.body.campaignTitle),
          importedAt: new Date(),
        };
        return normalized;
      })
      .filter((item) => item.profileKey);

    if (!profiles.length) {
      return res.status(400).json({
        success: false,
        error: "At least one influencer profile is required",
      });
    }

    const folder = await getOrCreateBrandDefaultFolder({
      brandId,
      type: "good_fit",
      title: "Good Fit Influencers",
      req,
    });

    const result = upsertProfilesIntoBrandFolder(folder, profiles);
    await folder.save();

    return res.status(result.added ? 201 : 200).json({
      success: true,
      message: result.added
        ? "Good fit influencer saved successfully"
        : "Good fit influencer already exists",
      data: {
        folder: serializeBrandFolderDetail(folder.toObject()),
        addedCount: result.added,
        skippedCount: result.skipped,
        savedKeys: folder.items.map((item) => item.profileKey).filter(Boolean),
      },
    });
  } catch (err) {
    console.error("[saveGoodFitInfluencer] Error:", err);
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SAVE_GOOD_FIT_INFLUENCER_ERROR");

    return res.status(500).json({
      success: false,
      error: err?.message || "Internal error",
    });
  }
}

async function getGoodFitInfluencers(req, res) {
  try {
    const brandId = getFolderAuthedBrandId(req);

    if (!brandId) {
      return res.status(401).json({
        success: false,
        error: "Brand authentication is required",
      });
    }

    const folder = await BrandFolderModel.findOne({
      ...buildBrandScopedFolderFilter(brandId),
      type: "good_fit",
      isDefault: true,
    }).lean();

    const items = Array.isArray(folder?.items) ? folder.items : [];

    return res.status(200).json({
      success: true,
      message: "Good fit influencers fetched successfully",
      data: {
        folder: folder ? serializeBrandFolderCard(folder) : null,
        totalCount: items.length,
        savedKeys: items.map((item) => item.profileKey).filter(Boolean),
        items,
      },
    });
  } catch (err) {
    console.error("[getGoodFitInfluencers] Error:", err);
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_GOOD_FIT_INFLUENCERS_ERROR");

    return res.status(500).json({
      success: false,
      error: err?.message || "Internal error",
    });
  }
}

/* Brand bookmark compatibility now uses BrandFolder, not the old BookmarkFolder model. */
async function addbookmarkProfile(req, res) {
  try {
    const brandId = getFolderAuthedBrandId(req);

    if (!brandId) {
      return res.status(401).json({
        success: false,
        error: "Brand authentication is required",
      });
    }

    const incomingProfiles = Array.isArray(req.body?.profiles)
      ? req.body.profiles
      : Array.isArray(req.body?.influencers)
        ? req.body.influencers
        : req.body?.profile
          ? [req.body.profile]
          : req.body?.influencer
            ? [req.body.influencer]
            : [req.body];

    const profiles = incomingProfiles
      .filter(Boolean)
      .map((item) => normalizeBrandFolderItem(item, "bookmarked"))
      .filter((item) => item.profileKey);

    if (!profiles.length) {
      return res.status(400).json({
        success: false,
        error: "At least one influencer profile is required",
      });
    }

    const folder = await getOrCreateBrandDefaultFolder({
      brandId,
      type: "bookmark",
      title: "bookmarked",
      req,
    });

    const result = upsertProfilesIntoBrandFolder(folder, profiles);
    await folder.save();

    return res.status(result.added ? 201 : 200).json({
      success: true,
      message: result.added
        ? "Profile bookmarked successfully"
        : result.updated
          ? "Profile bookmark updated successfully"
          : "Profile already exists in bookmarked folder",
      data: {
        folder: serializeBrandFolderDetail(folder.toObject()),
        addedCount: result.added,
        skippedCount: result.skipped,
        updatedCount: result.updated,
        savedKeys: folder.items.map((item) => item.profileKey).filter(Boolean),
      },
    });
  } catch (err) {
    console.error("[addbookmarkProfile] Error:", err);
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "ADD_BOOKMARK_PROFILE_ERROR");

    return res.status(500).json({
      success: false,
      error: err?.message || "Internal error",
    });
  }
}

async function getbookmarkProfile(req, res) {
  try {
    const brandId = getFolderAuthedBrandId(req);

    if (!brandId) {
      return res.status(401).json({
        success: false,
        error: "Brand authentication is required",
      });
    }

    const folder = await BrandFolderModel.findOne({
      ...buildBrandScopedFolderFilter(brandId),
      type: "bookmark",
      isDefault: true,
    }).lean();

    const items = Array.isArray(folder?.items) ? folder.items : [];

    return res.status(200).json({
      success: true,
      message: "Bookmarked profiles fetched successfully",
      data: {
        folder: folder ? serializeBrandFolderCard(folder) : null,
        totalCount: items.length,
        savedKeys: items.map((item) => item.profileKey).filter(Boolean),
        items,
      },
    });
  } catch (err) {
    console.error("[getbookmarkProfile] Error:", err);
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_BOOKMARK_PROFILE_ERROR");

    return res.status(500).json({
      success: false,
      error: err?.message || "Internal error",
    });
  }
}

function getQAAnswers(items = [], keywords = []) {
  const list = Array.isArray(items) ? items : [];
  const normalizedKeywords = keywords.map((item) =>
    safeTrim(item).toLowerCase()
  );

  const match = list.find((item) => {
    const question = safeTrim(item?.question).toLowerCase();
    return normalizedKeywords.some((keyword) => question.includes(keyword));
  });

  if (!match) return [];

  if (Array.isArray(match.answers)) {
    return match.answers.map(safeTrim).filter(Boolean);
  }

  const single = safeTrim(match.answer || match.value);
  return single ? [single] : [];
}

function getQAAnswer(items = [], keywords = []) {
  return getQAAnswers(items, keywords)[0] || "";
}

function upsertQAAnswer(items = [], question, answer) {
  const list = Array.isArray(items) ? JSON.parse(JSON.stringify(items)) : [];

  const cleanQuestion = safeTrim(question);
  const questionKey = cleanQuestion.toLowerCase();

  const answers = Array.isArray(answer)
    ? answer.map(safeTrim).filter(Boolean)
    : safeTrim(answer)
      ? [safeTrim(answer)]
      : [];

  const index = list.findIndex((item) =>
    safeTrim(item?.question).toLowerCase().includes(questionKey)
  );

  const row = {
    question: cleanQuestion,
    answers,
  };

  if (index >= 0) {
    list[index] = row;
  } else {
    list.push(row);
  }

  return list;
}

function isGoogleSignedBrand(brand = {}) {
  return Boolean(
    brand.googleId ||
    brand.googleSub ||
    safeTrim(brand.authProvider).toLowerCase() === "google" ||
    safeTrim(brand.provider).toLowerCase() === "google"
  );
}

function isStrongProfilePassword(password) {
  const value = String(password || "");

  return (
    value.length >= 8 &&
    value.length <= 16 &&
    /[0-9]/.test(value) &&
    /[A-Z]/.test(value) &&
    /[^A-Za-z0-9]/.test(value)
  );
}

function getSettingBrandId(req = {}) {
  return safeTrim(
    req.user?.brandId ||
    req.brand?.brandId ||
    req.brand?._id ||
    req.brand?.id ||
    req.auth?.brandId
  );
}

function getUploadedImageUrl(uploadedImage) {
  if (!uploadedImage) return "";
  if (typeof uploadedImage === "string") return uploadedImage;

  return (
    uploadedImage.profilePic ||
    uploadedImage.url ||
    uploadedImage.Location ||
    uploadedImage.location ||
    uploadedImage.secure_url ||
    uploadedImage.data?.profilePic ||
    uploadedImage.data?.url ||
    uploadedImage.data?.Location ||
    ""
  );
}

function serializeSettingProfile(brand = {}) {
  const brandName = safeTrim(brand.brandName || brand.name);
  const pocName = safeTrim(brand.name);

  return {
    brandId: String(brand._id || ""),
    workspaceTitle: `${brandName || "Brand"}’s Workspace`,

    profilePic: safeTrim(brand.profilePic),

    brandName,
    brandEmail: normalizeEmail(brand.email),
    companySize: safeTrim(brand.companySize),

    // name = pocName
    pocName,

    brandEmailAlias: safeTrim(brand.proxyEmail),
    industryName: safeTrim(brand.industry),
    pocContact: safeTrim(brand.pocContact),
    website: safeTrim(brand.website),

    companyDetails: safeTrim(brand.companyDetails),

    onboarding: {
      brandType: getQAAnswer(brand.page1, [
        "brand type",
        "type of brand",
      ]),
      organizationRole: getQAAnswer(brand.page2, [
        "role in organisation",
        "role in organization",
        "your role",
      ]),
      preferredPlatform: getQAAnswer(brand.page3, [
        "preferred platform",
        "platform",
      ]),
      preferredPlatforms: getQAAnswers(brand.page3, [
        "preferred platform",
        "platform",
      ]),
    },

    demographic: {
      timeZone:
        safeTrim(brand.timeZone) || "GMT+5:30 Indian standard time",
      currencyFormat: safeTrim(brand.currencyFormat) || "$ Dollars",
      region: safeTrim(brand.region) || "All",
      preferredLanguage: safeTrim(brand.preferredLanguage) || "English",
    },

    auth: {
      isGoogleAccount: isGoogleSignedBrand(brand),
    },
  };
}

function isSettingProfileCompleted(brand = {}) {
  const profile = serializeSettingProfile(brand);

  return Boolean(
    profile.profilePic &&
    profile.brandName &&
    profile.brandEmail &&
    profile.companySize &&
    profile.pocName &&
    profile.industryName &&
    profile.pocContact &&
    profile.website &&
    profile.companyDetails &&
    profile.onboarding.brandType &&
    profile.onboarding.organizationRole &&
    profile.onboarding.preferredPlatform &&
    profile.demographic.timeZone &&
    profile.demographic.currencyFormat &&
    profile.demographic.region &&
    profile.demographic.preferredLanguage
  );
}

function normalizeFeatureKey(value) {
  return safeTrim(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findFeature(subscription = {}, keys = []) {
  const features = Array.isArray(subscription.features)
    ? subscription.features
    : [];

  const wanted = keys.map(normalizeFeatureKey);

  return features.find((feature) =>
    wanted.includes(normalizeFeatureKey(feature.key))
  );
}

function buildCreditUsage(subscription = {}) {
  const items = [
    {
      label: "Influencer Search",
      keys: ["influencerSearch", "influencer_search", "search"],
      fallbackTotal: 20,
      color: "green",
    },
    {
      label: "Influencer Profile Views",
      keys: ["influencer_profile_views_per_month"],
      fallbackTotal: 0,
      color: "green",
    },
    {
      label: "Invites Per Month",
      keys: ["invitesPerMonth", "invites", "monthly_invites"],
      fallbackTotal: 3,
      color: "red",
    },
    {
      label: "Active Campaign",
      keys: ["activeCampaign", "activeCampaigns", "campaigns"],
      fallbackTotal: 10,
      color: "green",
    },
  ];

  return items.map((item) => {
    const feature = findFeature(subscription, item.keys);

    const used = Number(feature?.used ?? 0);
    const total = Number(feature?.limit ?? item.fallbackTotal);

    return {
      label: item.label,
      used: Number.isFinite(used) ? used : 0,
      total: Number.isFinite(total) ? total : item.fallbackTotal,
      color: item.color,
    };
  });
}

function buildPlanData(brand = {}) {
  const subscription = brand.subscription || {};
  const planName = safeTrim(subscription.planName || "free");
  const monthlyCost = Number(subscription.monthlyCost || 0);

  return {
    planName,
    planTitle: `${planName.toUpperCase()} PLAN`,
    monthlyCost,
    billingCycle: safeTrim(subscription.billingCycle || "monthly"),
    creditUsage: buildCreditUsage(subscription),
  };
}

function buildUsersData(brand = {}) {
  const profile = serializeSettingProfile(brand);

  return {
    used: 1,
    total: 3,
    noSeatsAvailable: false,
    items: [
      {
        id: String(brand._id || ""),
        name: profile.pocName || profile.brandName || "Brand User",
        email: profile.brandEmail,
        avatar: profile.profilePic,
        relation: "You",
        role: "Owner",
        access: "Owner",
        action: "Transfer Ownership",
      },
    ],
  };
}

function buildWorkspacesData(brand = {}) {
  const profile = serializeSettingProfile(brand);

  return {
    used: 1,
    total: 1,
    limitReached: true,
    items: [
      {
        id: String(brand._id || ""),
        name: `${profile.brandName || "Brand"} workspace`,
        email: profile.brandEmail,
        logo: profile.profilePic,
        relation: "You",
        role: "Owner",
        meta: "Created by you",
        action: "Delete",
      },
    ],
  };
}

function buildSettingOverviewPayload(brand = {}) {
  return {
    profileCompleted: isSettingProfileCompleted(brand),
    profile: serializeSettingProfile(brand),
    plan: buildPlanData(brand),
    users: buildUsersData(brand),
    workspaces: buildWorkspacesData(brand),
  };
}

async function getBrandSettingOverview(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const brandId = getSettingBrandId(req);

    if (!brandId || !mongoose.Types.ObjectId.isValid(brandId)) {
      throw new ValidationError("Invalid brand authentication.");
    }

    const brand = await BrandModel.findById(brandId).lean().exec();

    if (!brand) {
      throw new NotFoundError("Brand not found.");
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Brand setting overview fetched successfully",
        ...buildSettingOverviewPayload(brand),
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_BRAND_SETTING_OVERVIEW_ERROR");
    return handleControllerError(next, err, "getBrandSettingOverview");
  }
}

async function getBrandSettingProfile(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const brandId = getSettingBrandId(req);

    if (!brandId || !mongoose.Types.ObjectId.isValid(brandId)) {
      throw new ValidationError("Invalid brand authentication.");
    }

    const brand = await BrandModel.findById(brandId).lean().exec();

    if (!brand) {
      throw new NotFoundError("Brand not found.");
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Brand setting profile fetched successfully",
        ...buildSettingOverviewPayload(brand),
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_BRAND_SETTING_PROFILE_ERROR");
    return handleControllerError(next, err, "getBrandSettingProfile");
  }
}

async function updateBrandSettingProfile(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const brandId = getSettingBrandId(req);

    if (!brandId || !mongoose.Types.ObjectId.isValid(brandId)) {
      throw new ValidationError("Invalid brand authentication.");
    }

    const brand = await BrandModel.findById(brandId).lean().exec();

    if (!brand) {
      throw new NotFoundError("Brand not found.");
    }

    const body = req.body || {};
    const update = {};
    const unset = {};

    if (body.brandName !== undefined) {
      const brandName = safeTrim(body.brandName);

      if (!brandName) {
        throw new ValidationError("Brand name cannot be empty.");
      }

      update.brandName = brandName;
    }

    if (body.companySize !== undefined) {
      update.companySize = safeTrim(body.companySize);
    }

    if (body.pocName !== undefined) {
      update.name = safeTrim(body.pocName);
    }

    if (body.pocContact !== undefined) {
      update.pocContact = safeTrim(body.pocContact);
    }

    if (body.website !== undefined) {
      update.website = safeTrim(body.website);
    }

    if (body.companyDetails !== undefined) {
      update.companyDetails = safeTrim(body.companyDetails);
    }

    if (body.industryName !== undefined || body.industry !== undefined) {
      const industry = safeTrim(body.industryName ?? body.industry);

      if (!industry) {
        throw new ValidationError("Industry name cannot be empty.");
      }

      update.industry = industry;
    }

    if (body.brandEmailAlias !== undefined || body.proxyEmail !== undefined) {
      const proxyEmail = normalizeEmail(body.brandEmailAlias ?? body.proxyEmail);

      if (proxyEmail && !isValidEmail(proxyEmail)) {
        throw new ValidationError("Brand email alias must be a valid email.");
      }

      if (proxyEmail) {
        update.proxyEmail = proxyEmail;
      } else {
        unset.proxyEmail = 1;
      }
    }

    if (body.brandType !== undefined) {
      update.page1 = upsertQAAnswer(
        brand.page1,
        "Tell us about brand type?",
        body.brandType
      );
      update.ispage1Skip = false;
    }

    if (body.organizationRole !== undefined) {
      update.page2 = upsertQAAnswer(
        brand.page2,
        "Tell us about your role in Organisation ?",
        body.organizationRole
      );
      update.ispage2Skip = false;
    }

    if (
      body.preferredPlatform !== undefined ||
      body.preferredPlatforms !== undefined
    ) {
      update.page3 = upsertQAAnswer(
        brand.page3,
        "Preferred platforms",
        body.preferredPlatforms ?? body.preferredPlatform
      );
      update.ispage3Skip = false;
    }

    if (body.timeZone !== undefined) {
      update.timeZone = safeTrim(body.timeZone);
    }

    if (body.currencyFormat !== undefined) {
      update.currencyFormat = safeTrim(body.currencyFormat);
    }

    if (body.region !== undefined) {
      update.region = safeTrim(body.region);
    }

    if (body.preferredLanguage !== undefined) {
      update.preferredLanguage = safeTrim(body.preferredLanguage);
    }

    if (body.profilePic !== undefined) {
      update.profilePic = safeTrim(body.profilePic);
      update.isProfilePicSkip = !safeTrim(body.profilePic);
    }

    const updateQuery = {};

    if (Object.keys(update).length) updateQuery.$set = update;
    if (Object.keys(unset).length) updateQuery.$unset = unset;

    if (!Object.keys(updateQuery).length) {
      throw new ValidationError("Nothing to update.");
    }

    const updatedBrand = await BrandModel.findByIdAndUpdate(
      brandId,
      updateQuery,
      {
        new: true,
        runValidators: true,
      }
    )
      .lean()
      .exec();

    if (!updatedBrand) {
      throw new NotFoundError("Brand not found.");
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Brand setting profile updated successfully",
        ...buildSettingOverviewPayload(updatedBrand),
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "UPDATE_BRAND_SETTING_PROFILE_ERROR");
    return handleControllerError(next, err, "updateBrandSettingProfile");
  }
}

async function updateBrandSettingPassword(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const brandId = getSettingBrandId(req);

    if (!brandId || !mongoose.Types.ObjectId.isValid(brandId)) {
      throw new ValidationError("Invalid brand authentication.");
    }

    const newPassword = String(req.body?.newPassword || "");
    const confirmPassword = String(req.body?.confirmPassword || "");

    if (!newPassword.trim()) {
      throw new ValidationError("New password is required.");
    }

    if (!confirmPassword.trim()) {
      throw new ValidationError("Re-enter password is required.");
    }

    if (newPassword !== confirmPassword) {
      throw new ValidationError("Passwords do not match.");
    }

    if (!isStrongProfilePassword(newPassword)) {
      throw new ValidationError(
        "Password must be 8 to 16 characters and include a number, uppercase letter, and special character."
      );
    }

    const brand = await BrandModel.findById(brandId).select("+password").exec();

    if (!brand) {
      throw new NotFoundError("Brand not found.");
    }

    if (isGoogleSignedBrand(brand)) {
      throw new ValidationError(
        "You are using Google credentials. Please update your password in your Google account."
      );
    }

    if (brand.password) {
      const samePassword = await brand.comparePassword(newPassword);

      if (samePassword) {
        throw new ValidationError(
          "New password cannot be the same as your current password."
        );
      }
    }

    brand.password = newPassword;
    await brand.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Password updated successfully",
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "UPDATE_BRAND_SETTING_PASSWORD_ERROR");
    return handleControllerError(next, err, "updateBrandSettingPassword");
  }
}

async function updateBrandSettingProfilePhoto(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const brandId = getSettingBrandId(req);

    if (!brandId || !mongoose.Types.ObjectId.isValid(brandId)) {
      throw new ValidationError("Invalid brand authentication.");
    }

    if (!req.file) {
      throw new ValidationError("Brand profile image is required.");
    }

    const uploadedImage = await uploadBrandProfilePicToS3(
      req.file,
      "brand-profile-pic"
    );

    const profilePic = getUploadedImageUrl(uploadedImage);

    if (!profilePic) {
      throw new InternalError("Profile image uploaded but URL was not returned.");
    }

    const brand = await BrandModel.findByIdAndUpdate(
      brandId,
      {
        profilePic,
        isProfilePicSkip: false,
      },
      {
        new: true,
        runValidators: true,
      }
    )
      .lean()
      .exec();

    if (!brand) {
      throw new NotFoundError("Brand not found.");
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Brand profile photo updated successfully",
        uploadedImage,
        ...buildSettingOverviewPayload(brand),
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "UPDATE_BRAND_SETTING_PROFILE_PHOTO_ERROR");
    return handleControllerError(next, err, "updateBrandSettingProfilePhoto");
  }
}

module.exports = {
  sendSignupOtp,
  verifyOtpSignUp,
  saveBrandOnboarding,
  signInBrand,
  googleAuthBrand,
  uploadBrandProfilePic,
  sendOtpForgotBrand,
  verifyOtpForgotBrand,
  updatePasswordBrand,
  getBrandById,
  getBrandLiteById,
  getBrandProfile,
  updateBrandProfile,
  verifyBrandCoupon,
  getGoodFitInfluencers,
  getCampaignGoodFitList,
  saveCampaignGoodFitItem,
  saveGoodFitInfluencer,
  createFolder,
  getFolderList,
  addbookmarkProfile,
  getbookmarkProfile,
  getBrandSettingOverview,
  getBrandSettingProfile,
  updateBrandSettingProfile,
  updateBrandSettingProfilePhoto,
  updateBrandSettingPassword,
};