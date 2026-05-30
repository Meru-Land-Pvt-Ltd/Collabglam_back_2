"use strict";

const CONTRACT_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  BRAND_SENT_DRAFT: "BRAND_SENT_DRAFT",
  BRAND_EDITED: "BRAND_EDITED",
  INFLUENCER_EDITED: "INFLUENCER_EDITED",
  BRAND_ACCEPTED: "BRAND_ACCEPTED",
  INFLUENCER_ACCEPTED: "INFLUENCER_ACCEPTED",
  BRAND_FINAL_UPDATE: "BRAND_FINAL_UPDATE",
  READY_TO_SIGN: "READY_TO_SIGN",
  CONTRACT_SIGNED: "CONTRACT_SIGNED",
  MILESTONES_CREATED: "MILESTONES_CREATED",
  REJECTED: "REJECTED",
  SUPERSEDED: "SUPERSEDED",
});

const LEGACY_STATUS_MAP = Object.freeze({
  BRAND_FINAL_UPADTE: CONTRACT_STATUS.BRAND_FINAL_UPDATE,
  BRAND_FINAL_UPDATE: CONTRACT_STATUS.BRAND_FINAL_UPDATE,
});

const PAYMENT_TYPE = Object.freeze({
  FIXED: "fixed_payment",
  MILESTONE: "milestone_based",
  GIFTING: "product_gifting",
});

const CONTRACT_ROLE = Object.freeze({
  BRAND: "brand",
  INFLUENCER: "influencer",
  COLLABGLAM: "collabglam",
  SYSTEM: "system",
  ADMIN: "admin",
});

const SIGNER_ROLES = Object.freeze(["brand", "influencer", "collabglam"]);
const CONTRACT_STATUS_VALUES = Object.freeze(Object.values(CONTRACT_STATUS));
const LEGACY_STATUS_VALUES = Object.freeze(Object.keys(LEGACY_STATUS_MAP));
const CONTRACT_STATUS_ENUM = Object.freeze([...new Set([...CONTRACT_STATUS_VALUES, ...LEGACY_STATUS_VALUES])]);
const PAYMENT_TYPE_VALUES = Object.freeze(Object.values(PAYMENT_TYPE));

function normalizeContractStatus(status) {
  if (!status) return CONTRACT_STATUS.DRAFT;
  const value = String(status).trim().toUpperCase();
  if (CONTRACT_STATUS_VALUES.includes(value)) return value;
  if (LEGACY_STATUS_MAP[value]) return LEGACY_STATUS_MAP[value];
  return CONTRACT_STATUS.BRAND_SENT_DRAFT;
}

function normalizePaymentType(value) {
  if (!value) return PAYMENT_TYPE.FIXED;
  const raw = String(value).trim().toLowerCase();
  if (["fixed", "fixed_payment", "fixed-payment"].includes(raw)) return PAYMENT_TYPE.FIXED;
  if (["milestone", "milestone_based", "milestone-based"].includes(raw)) return PAYMENT_TYPE.MILESTONE;
  if (["gifting", "product_gifting", "product-gifting"].includes(raw)) return PAYMENT_TYPE.GIFTING;
  return PAYMENT_TYPE.FIXED;
}

module.exports = {
  CONTRACT_STATUS,
  LEGACY_STATUS_MAP,
  PAYMENT_TYPE,
  CONTRACT_ROLE,
  SIGNER_ROLES,
  CONTRACT_STATUS_ENUM,
  PAYMENT_TYPE_VALUES,
  normalizeContractStatus,
  normalizePaymentType,
};