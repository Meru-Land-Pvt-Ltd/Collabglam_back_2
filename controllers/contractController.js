"use strict";

const PDFDocument = require("pdfkit");
const moment = require("moment-timezone");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const Campaign = require("../models/campaign");
const Brand = require("../models/brand");
const Modash = require("../models/modash");
const { InfluencerModel: Influencer } = require("../models/influencer");
const ApplyCampaign = require("../models/applyCampaign");
const Contract = require("../models/contract");
const ContractContent = require("../models/contractContent");
const ContractSignature = require("../models/contractSignature");
const ContractActivity = require("../models/contractActivity");
const ContractDocument = require("../models/contractDocument");
const BrandSignature = require("../models/brandSignature");
const InfluencerSignature = require("../models/influencerSignature");

const MASTER_TEMPLATE = require("../template/ContractTemplate");
const { createAndEmit } = require("../utils/notifier");
const saveErrorLog = require("../services/errorLog.service");
const {
  hydrateContract,
  hydrateContracts,
  createOrUpdateContent,
  createOrUpdateDocument,
} = require("../services/contractAssembler.service");
const { addActivity } = require("../services/contractActivity.service");
const {
  CONTRACT_STATUS,
  PAYMENT_TYPE,
  normalizeContractStatus,
  normalizePaymentType,
} = require("../constants/contract");

let EmailSvc = {};
try {
  EmailSvc = require("../services/email/contractEmailService");
} catch (_e) {
  console.warn("[Email] contractEmailService not found. Emails/reminders will be skipped.");
}

const {
  sendContractEmail,
  startReminder,
  clearReminder,
  resetReminderOnEngagement,
} = EmailSvc;

const DEFAULT_TZ = "America/Los_Angeles";
const TIMEZONES_FILE = path.join(__dirname, "..", "data", "timezones.json");
const CURRENCIES_FILE = path.join(__dirname, "..", "data", "currencies.json");
const CONTRACT_PDF_TITLE = "COLLABGLAM BRAND–INFLUENCER CAMPAIGN COLLABORATION AGREEMENT";
const MAX_SIG_BYTES = Number(process.env.CONTRACT_SIGNATURE_MAX_BYTES || 500 * 1024);
const COLLABGLAM_SIG_FILE = path.join(__dirname, "..", "assets", "collabglam-signature.png");

let COLLABGLAM_FIXED_SIG_DATA_URL = process.env.COLLABGLAM_FIXED_SIG_DATA_URL || null;
let _tzCache = null;
let _curCache = null;
let sharedBrowserPromise = null;

(function loadCollabGlamSig() {
  if (COLLABGLAM_FIXED_SIG_DATA_URL) return;
  try {
    if (fs.existsSync(COLLABGLAM_SIG_FILE)) {
      const buf = fs.readFileSync(COLLABGLAM_SIG_FILE);
      COLLABGLAM_FIXED_SIG_DATA_URL = `data:image/png;base64,${buf.toString("base64")}`;
    }
  } catch (e) {
    console.warn("[Contract] Failed to load CollabGlam signature:", e?.message || e);
  }
})();

const ALLOWED_BRAND_PATHS = Object.freeze([
  "content.brand.legalName",
  "content.brand.contactPersonName",
  "content.brand.noticeEmail",
  "content.brand.noticePhone",
  "content.brand.billingAddress",
  "content.brand.brandPoc",
  "content.brand.brandPocDesignation",
  "content.campaign.productsServicesCovered",
  "content.campaign.territoryTargetCountry",
  "content.campaign.effectiveDate",
  "content.campaign.campaignTitleOrId",
  "content.campaign.name",
  "content.campaign.timezone",
  "content.campaign.paymentType",
  "content.scheduleA.deliverables",
  "content.scheduleA.minimumVideoSpecs",
  "content.scheduleA.preShootScriptRequired",
  "content.scheduleA.preShootScriptDue",
  "content.scheduleA.preShootScriptReviewBusinessDays",
  "content.scheduleA.mandatoryTagsMentionsLinksCodes",
  "content.scheduleA.review.needRevisionRounds",
  "content.scheduleA.review.includedRevisionRounds",
  "content.scheduleA.review.additionalRevisionFee",
  "content.scheduleA.review.reshootObligationRequired",
  "content.scheduleA.review.draftDate",
  "content.scheduleA.review.reshootObligation",
  "content.scheduleA.review.reshootFee",
  "content.scheduleA.review.minimumLivePeriod",
  "content.scheduleA.commercial.totalCampaignFee",
  "content.scheduleA.commercial.influencerBudget",
  "content.scheduleA.commercial.currency",
  "content.scheduleA.commercial.paymentStructure",
  "content.scheduleA.commercial.platformMilestonePaymentStructure",
  "content.scheduleA.commercial.customSplit",
  "content.scheduleA.commercial.advancePaymentTrigger",
  "content.scheduleA.commercial.wantAdvancePayment",
  "content.scheduleA.commercial.advancePaymentAmount",
  "content.scheduleA.commercial.advancePaymentType",
  "content.scheduleA.commercial.remainingPaymentTrigger",
  "content.scheduleA.commercial.paymentProcessorFeesBorneBy",
  "content.scheduleA.commercial.paymentProcessorFeesNotes",
  "content.scheduleA.commercial.laneAMarketplaceFeeNote",
  "content.scheduleA.commercial.payoutMethod",
  "content.scheduleA.commercial.payoutAccountId",
  "content.scheduleA.commercial.taxId",
  "content.scheduleA.commercial.milestones",
  "content.scheduleA.rawFiles.rawSourceFileDelivery",
  "content.scheduleA.rawFiles.deliveryDue",
  "content.scheduleA.rawFiles.format",
  "content.scheduleA.rawFiles.analyticsReportingDeadline",
  "content.scheduleA.rawFiles.analyticsReportingItems",
  "content.scheduleA.shipping.productShippingApplicable",
  "content.scheduleA.shipping.shipToName",
  "content.scheduleA.shipping.shipToAddress",
  "content.scheduleA.shipping.shipToPhone",
  "content.scheduleA.shipping.productReceiptConfirmationDeadline",
  "content.scheduleA.shipping.productReturnable",
  "content.scheduleA.shipping.returnWindowMethod",
  "content.scheduleA.shipping.riskOfLossNotes",
  "content.scheduleA.usageRights.rows",
  "content.scheduleA.usageRights.attributionRequirement",
  "content.scheduleA.usageRights.attributionText",
  "content.scheduleA.usageRights.editingRights",
  "content.scheduleA.usageRights.musicStockAssetResponsibility",
  "content.scheduleA.compliance.creativeBriefMandatoryTalkingPoints",
  "content.scheduleA.compliance.restrictedStatements",
  "content.scheduleA.exclusivity.competitorBlackout",
  "content.scheduleA.exclusivity.categoryCompetitorList",
  "content.scheduleA.exclusivity.blackoutPeriod",
  "content.scheduleA.exclusivity.optionalMoralsClause",
  "content.scheduleA.cancellation.killFeeOrProrata",
  "content.scheduleA.cancellation.refundOfUnearnedAdvance",
  "content.scheduleA.dispute.governingLaw",
  "content.scheduleA.dispute.disputeResolutionMethod",
  "content.scheduleA.dispute.disputeVenue",
  "content.scheduleA.dispute.arbitrationSeat",
  "content.scheduleA.dispute.attorneysFees",
  "content.collabglam.signatoryName",
]);

const ALLOWED_INFLUENCER_PATHS = Object.freeze([
  "content.influencer.legalName",
  "content.influencer.contactName",
  "content.influencer.email",
  "content.influencer.phone",
  "content.influencer.contactEmail",
  "content.influencer.contactPhone",
  "content.influencer.whatsApp",
  "content.influencer.taxFormType",
  "content.influencer.taxId",
  "content.influencer.address",
  "content.influencer.addressLine1",
  "content.influencer.addressLine2",
  "content.influencer.city",
  "content.influencer.state",
  "content.influencer.zipPostalCode",
  "content.influencer.country",
  "content.influencer.notes",
  "content.campaign.territoryTargetCountry",
  "content.campaign.effectiveDate",
  "content.campaign.timezone",
  "content.scheduleA.preShootScriptRequired",
  "content.scheduleA.preShootScriptDue",
  "content.scheduleA.preShootScriptReviewBusinessDays",
  "content.scheduleA.review.includedRevisionRounds",
  "content.scheduleA.review.additionalRevisionFee",
  "content.scheduleA.review.reshootObligationRequired",
  "content.scheduleA.review.draftDate",
  "content.scheduleA.review.reshootObligation",
  "content.scheduleA.review.reshootObligationRequired",
  "content.scheduleA.review.draftDate",
  "content.scheduleA.review.reshootFee",
  "content.scheduleA.commercial.totalCampaignFee",
  "content.scheduleA.commercial.influencerBudget",
  "content.scheduleA.commercial.currency",
  "content.scheduleA.commercial.wantAdvancePayment",
  "content.scheduleA.commercial.advancePaymentAmount",
  "content.scheduleA.commercial.advancePaymentType",
  "content.scheduleA.commercial.laneAMarketplaceFeeNote",
  "content.scheduleA.shipping.productShippingApplicable",
  "content.scheduleA.shipping.shipToName",
  "content.scheduleA.shipping.shipToAddress",
  "content.scheduleA.shipping.productReceiptConfirmationDeadline",
  "content.scheduleA.shipping.productReturnable",
]);

function respondOK(res, payload = {}, status = 200) {
  return res.status(status).json({ success: true, ...payload });
}

function respondError(res, message = "Internal server error", status = 500, err = null) {
  if (err) console.error(message, err);
  return res.status(status).json({ success: false, message });
}

function assertRequired(obj, fields) {
  const missing = (fields || []).filter((f) => obj?.[f] === undefined || obj?.[f] === null || obj?.[f] === "");
  if (missing.length) {
    const e = new Error(`Missing required field(s): ${missing.join(", ")}`);
    e.status = 400;
    throw e;
  }
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_e) {
    return fallback;
  }
}

function loadTimezones() {
  if (!_tzCache) _tzCache = safeReadJson(TIMEZONES_FILE, []);
  return _tzCache;
}

function loadCurrencies() {
  if (!_curCache) _curCache = safeReadJson(CURRENCIES_FILE, {});
  return _curCache;
}

function findTimezoneByValueOrUTC(key) {
  if (!key) return null;
  const q = String(key).toLowerCase();
  return (
    loadTimezones().find((t) =>
      (t.value && t.value.toLowerCase() === q) ||
      (t.abbr && t.abbr.toLowerCase() === q) ||
      (Array.isArray(t.utc) && t.utc.some((u) => String(u || "").toLowerCase() === q)) ||
      (t.text && t.text.toLowerCase().includes(q))
    ) || null
  );
}

function tzOr(contract, fallback = DEFAULT_TZ) {
  return contract?.requestedEffectiveDateTimezone || contract?.effectiveDateTimezone || contract?.admin?.timezone || fallback;
}

function nowInContractTz(contract) {
  return moment.tz(tzOr(contract)).toDate();
}

function buildRequestedEffectiveDate(rawDate, tz) {
  if (!rawDate) return undefined;
  const zone = tz || DEFAULT_TZ;
  const dateStr = String(rawDate).split("T")[0];
  const parts = dateStr.split("-");
  if (parts.length !== 3) return new Date(rawDate);
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (!year || !month || !day) return new Date(rawDate);
  const nowInZone = moment.tz(zone);
  nowInZone.year(year).month(month - 1).date(day);
  return nowInZone.toDate();
}

function formatDateTZ(date, tz, fmt = "MMMM D, YYYY") {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  const isDateOnlyUTC = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  if (isDateOnlyUTC) return moment.utc(d).format(fmt);
  return tz ? moment(d).tz(tz).format(fmt) : moment(d).format(fmt);
}

function compactJoin(parts, sep = ", ") {
  return (parts || []).filter(Boolean).map((s) => String(s).trim()).filter(Boolean).join(sep);
}

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getDeep(obj, pathStr) {
  return String(pathStr).split(".").reduce((acc, key) => acc?.[key], obj);
}

function setDeep(obj, pathStr, value) {
  const keys = String(pathStr).split(".");
  let ref = obj;
  while (keys.length > 1) {
    const key = keys.shift();
    if (!ref[key] || typeof ref[key] !== "object") ref[key] = {};
    ref = ref[key];
  }
  ref[keys[0]] = value;
}

function applyAllowedDeepUpdates(target, updates, allowedPaths = []) {
  const changed = [];
  for (const pathStr of allowedPaths) {
    const incoming = getDeep(updates, pathStr);
    if (incoming === undefined) continue;
    const before = getDeep(target, pathStr);
    if (JSON.stringify(before) !== JSON.stringify(incoming)) {
      setDeep(target, pathStr, incoming);
      changed.push(pathStr);
    }
  }
  return changed;
}

function mergeDeep(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(patch)) return patch.map((x) => mergeDeep(undefined, x));
  if (!patch || typeof patch !== "object") return patch;
  if (!base || typeof base !== "object" || Array.isArray(base)) base = {};
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = mergeDeep(out[k], v);
  return out;
}

function flatten(obj, prefix = "", out = {}) {
  if (obj instanceof Date || obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
    out[prefix] = obj;
    return out;
  }
  const entries = Object.entries(obj);
  if (!entries.length) out[prefix] = obj;
  for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function computeEditedFields(prevObj, nextObj, whitelistTopKeys) {
  const prev = flatten(prevObj || {});
  const next = flatten(nextObj || {});
  const fields = new Set();
  const allKeys = Object.keys({ ...prev, ...next });
  for (const key of allKeys) {
    const topKey = key.split(".")[0];
    if (whitelistTopKeys && !whitelistTopKeys.includes(topKey)) continue;
    const a = prev[key] instanceof Date ? prev[key].toISOString() : JSON.stringify(prev[key]);
    const b = next[key] instanceof Date ? next[key].toISOString() : JSON.stringify(next[key]);
    if (a !== b) fields.add(key);
  }
  return Array.from(fields).sort();
}

function renderKeyValueTable(rows = []) {
  return `
    <table border="0" cellpadding="6" cellspacing="0" style="width:100%; border-collapse:collapse;">
      ${(rows || [])
      .filter(([label]) => label)
      .map(([label, value]) => `<tr><td style="width:35%;"><strong>${esc(label)}</strong></td><td>${esc(value ?? "")}</td></tr>`)
      .join("")}
    </table>
  `.trim();
}

function renderAgreementHeaderTableHTML(content = {}, tz = DEFAULT_TZ) {
  return renderKeyValueTable([
    ["Brand Legal Name", content?.brand?.legalName || ""],
    ["Brand Contact Person Name", content?.brand?.contactPersonName || ""],
    ["Brand Notice Email / Phone", compactJoin([content?.brand?.noticeEmail, content?.brand?.noticePhone], " / ")],
    ["Brand Billing Address", content?.brand?.billingAddress || ""],
    ["Influencer Legal Name / Entity", content?.influencer?.legalName || ""],
    ["Influencer Posting Handle URL", content?.influencer?.postingHandleUrl || ""],
    ["Influencer Contact Email / Phone", compactJoin([content?.influencer?.email, content?.influencer?.phone], " / ")],
    ["Influencer Address", content?.influencer?.address || compactJoin([content?.influencer?.addressLine1, content?.influencer?.addressLine2, content?.influencer?.city, content?.influencer?.state, content?.influencer?.zipPostalCode, content?.influencer?.country])],
    ["Products / Services Covered", content?.campaign?.productsServicesCovered || ""],
    ["Territory / Target Country", content?.campaign?.territoryTargetCountry || ""],
    ["Effective Date", content?.campaign?.effectiveDate ? formatDateTZ(content.campaign.effectiveDate, tz) : ""],
    ["CollabGlam LLC", compactJoin([content?.collabglam?.legalName || "CollabGlam LLC", content?.collabglam?.address || "CollabGlam LLC, 732 S 6th STE N, Las Vegas, Nevada 89101, USA", `Email: ${content?.collabglam?.email || "help@collabglam.com"}`], " | ")],
    ["Campaign Title / Campaign ID", content?.campaign?.campaignTitleOrId || ""],
  ]);
}

function renderDeliverablesScheduleTable(rows = []) {
  const body = (Array.isArray(rows) ? rows : [])
    .map((r, i) => `
      <tr>
        <td>${esc(String(r?.srNo ?? i + 1))}</td>
        <td>${esc(r?.platformHandle || r?.platform || r?.handle || "")}</td>
        <td>${esc(r?.deliverableFormat || r?.deliverableName || "")}</td>
        <td>${esc(String(r?.qty ?? ""))}</td>
        <td>${esc(r?.draftDue || "")}</td>
        <td>${esc(r?.liveDate || "")}</td>
      </tr>
    `)
    .join("");
  return `<table><thead><tr><th>Sr. No.</th><th>Platform / Handle</th><th>Deliverable Format</th><th>Qty</th><th>Draft Due</th><th>Live Date</th></tr></thead><tbody>${body || `<tr><td colspan="6">No deliverables defined.</td></tr>`}</tbody></table>`;
}

function renderUsageRightsTable(rows = []) {
  const body = (Array.isArray(rows) ? rows : [])
    .map((r) => `<tr><td>${esc(r?.usageRight || "")}</td><td>${r?.selected ? "☑" : "☐"}</td><td>${esc(r?.duration || "")}</td><td>${esc(r?.territoryNotes || "")}</td></tr>`)
    .join("");
  return `<table><thead><tr><th>Usage Right</th><th>Selected</th><th>Duration</th><th>Territory / Notes</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderMilestonesTable(rows = []) {
  const body = (Array.isArray(rows) ? rows : [])
    .map((r, i) => `<tr><td>${esc(String(i + 1))}</td><td>${esc(r?.milestoneName || "")}</td><td>${esc(String(r?.paymentAmount ?? ""))}</td><td>${esc(r?.triggerEvent || "")}</td><td>${esc(r?.dueDate || "")}</td></tr>`)
    .join("");
  return `<table><thead><tr><th>#</th><th>Milestone</th><th>Amount</th><th>Trigger Event</th><th>Due Date</th></tr></thead><tbody>${body || `<tr><td colspan="5">No milestones defined.</td></tr>`}</tbody></table>`;
}

function renderCommercialTermsTableHTML(content = {}) {
  const commercial = content?.scheduleA?.commercial || {};
  const paymentType = normalizePaymentType(content?.campaign?.paymentType);
  const baseTable = renderKeyValueTable([
    ["Payment Type", paymentType],
    ["Total Budget", compactJoin([commercial?.totalCampaignFee, commercial?.currency], " ")],
    ["Payment Structure", commercial?.paymentStructure || commercial?.platformMilestonePaymentStructure || ""],
    ["Custom Split", commercial?.customSplit || ""],
    ["I Want Advance Payment", commercial?.wantAdvancePayment ? "Yes" : "No"],
    ...(commercial?.wantAdvancePayment
      ? [
          ["Advance Payment Amount", commercial?.advancePaymentAmount ?? ""],
          ["Advance Payment Type", commercial?.advancePaymentType || ""],
        ]
      : []),
    ["Advance Payment Trigger", commercial?.advancePaymentTrigger || ""],
    ["Remaining Payment Trigger", commercial?.remainingPaymentTrigger || ""],
    ["Payment Processor Fees Borne By", commercial?.paymentProcessorFeesBorneBy || ""],
    ["Payment Processor Fee Notes", commercial?.paymentProcessorFeesNotes || ""],
    ["Lane A Marketplace Fee", commercial?.laneAMarketplaceFeeNote || ""],
  ]);
  return paymentType === PAYMENT_TYPE.MILESTONE ? `${baseTable}<div style="height:8px;"></div>${renderMilestonesTable(commercial?.milestones || [])}` : baseTable;
}

function buildTokenMap(contract) {
  const tz = tzOr(contract);
  const c = contract.content || {};
  const review = c?.scheduleA?.review || {};
  const rawFiles = c?.scheduleA?.rawFiles || {};
  const shipping = c?.scheduleA?.shipping || {};
  const usageRights = c?.scheduleA?.usageRights || {};
  const compliance = c?.scheduleA?.compliance || {};
  const exclusivity = c?.scheduleA?.exclusivity || {};
  const cancellation = c?.scheduleA?.cancellation || {};
  const dispute = c?.scheduleA?.dispute || {};
  const effectiveDate = c?.campaign?.effectiveDate || contract.requestedEffectiveDate || contract.effectiveDate || null;
  const preShootText = c?.scheduleA?.preShootScriptRequired
    ? `Yes — due by ${c?.scheduleA?.preShootScriptDue || "N/A"} and subject to review within ${c?.scheduleA?.preShootScriptReviewBusinessDays || 2} business days`
    : "No";

  return {
    "Agreement.EffectiveDate": effectiveDate ? formatDateTZ(effectiveDate, tz) : "",
    "Agreement.EffectiveDateLong": effectiveDate ? formatDateTZ(effectiveDate, tz, "Do MMMM YYYY") : "",
    "Agreement.EffectiveDateTime": effectiveDate ? formatDateTZ(effectiveDate, tz, "MMMM D, YYYY HH:mm z") : "",
    "Agreement.HeaderTableHTML": renderAgreementHeaderTableHTML(c, tz),
    "Brand.LegalName": c?.brand?.legalName || contract.brandName || "",
    "Brand.ContactPersonName": c?.brand?.contactPersonName || "",
    "Brand.NoticeEmail": c?.brand?.noticeEmail || "",
    "Brand.NoticePhone": c?.brand?.noticePhone || "",
    "Brand.BillingAddress": c?.brand?.billingAddress || "",
    "Brand.Address": c?.brand?.billingAddress || "",
    "Influencer.LegalName": c?.influencer?.legalName || contract.influencerName || "",
    "Influencer.ContactName": c?.influencer?.contactName || c?.influencer?.legalName || "",
    "Influencer.PostingHandleUrl": c?.influencer?.postingHandleUrl || "",
    "Influencer.ContactEmail": c?.influencer?.email || "",
    "Influencer.ContactPhone": c?.influencer?.phone || "",
    "Influencer.TaxFormType": c?.influencer?.taxFormType || "",
    "Influencer.TaxId": c?.influencer?.taxId || "",
    "Influencer.AddressLine1": c?.influencer?.addressLine1 || "",
    "Influencer.AddressLine2": c?.influencer?.addressLine2 || "",
    "Influencer.City": c?.influencer?.city || "",
    "Influencer.State": c?.influencer?.state || "",
    "Influencer.ZipPostalCode": c?.influencer?.zipPostalCode || "",
    "Influencer.Country": c?.influencer?.country || "",
    "Influencer.Notes": c?.influencer?.notes || "",
    "CollabGlam.SignatoryName": c?.collabglam?.signatoryName || contract.admin?.collabglamSignatoryName || "",
    "CollabGlam.Address": c?.collabglam?.address || "CollabGlam LLC, 732 S 6th STE N, Las Vegas, Nevada 89101, USA",
    "Campaign.Title": c?.campaign?.campaignTitleOrId || "",
    "Campaign.ProductsServicesCovered": c?.campaign?.productsServicesCovered || "",
    "Campaign.Territory": c?.campaign?.territoryTargetCountry || "Worldwide",
    "SOW.CommercialTermsTableHTML": renderCommercialTermsTableHTML(c),
    "SOW.MinimumVideoSpecs": c?.scheduleA?.minimumVideoSpecs || "",
    "SOW.PreShootScriptRequiredText": preShootText,
    "SOW.MandatoryTagsMentionsLinksCodes": c?.scheduleA?.mandatoryTagsMentionsLinksCodes || "",
    "SOW.CreativeBriefMandatoryTalkingPoints": compliance?.creativeBriefMandatoryTalkingPoints || "",
    "SOW.RestrictedStatements": compliance?.restrictedStatements || "",
    "SOW.DeliverablesTableHTML": renderDeliverablesScheduleTable(c?.scheduleA?.deliverables || []),
    "SOW.ReviewTermsTableHTML": renderKeyValueTable([
      [
        "Need Revision Rounds",
        review?.needRevisionRounds === "yes" ? "Yes" : "No",
      ],
      ...(review?.needRevisionRounds === "yes"
        ? [
            ["Revision Count", review?.includedRevisionRounds ?? "-"],
            ["Revision Fees", review?.additionalRevisionFee || "0"],
          ]
        : []),
      ["Reshoot Obligation", review?.reshootObligation || ""],
      ["Reshoot Fee", review?.reshootFee || ""],
      ["Minimum Live Period", review?.minimumLivePeriod || ""],
    ]),
    "SOW.RawFilesReportingTableHTML": renderKeyValueTable([
      ["Raw / Source File Delivery", rawFiles?.rawSourceFileDelivery || ""],
      ["Files Due", rawFiles?.deliveryDue || ""],
      ["Format", rawFiles?.format || ""],
      ["Analytics / Reporting Deadline", rawFiles?.analyticsReportingDeadline || ""],
      ["Analytics Reporting Items", rawFiles?.analyticsReportingItems || ""],
    ]),
    "SOW.ProductShippingTableHTML": renderKeyValueTable([
      ["Product Shipping Applicable", shipping?.productShippingApplicable || ""],
      ["Ship-To Name", shipping?.shipToName || ""],
      ["Ship-To Address", shipping?.shipToAddress || ""],
      ["Ship-To Phone", shipping?.shipToPhone || ""],
      ["Product Receipt Confirmation Deadline", shipping?.productReceiptConfirmationDeadline || ""],
      ["Product Returnable", shipping?.productReturnable || ""],
      ["Return Window / Method", shipping?.returnWindowMethod || ""],
      ["Risk of Loss Notes", shipping?.riskOfLossNotes || ""],
    ]),
    "SOW.UsageRightsTableHTML": `${renderUsageRightsTable(usageRights?.rows || [])}${renderKeyValueTable([
      ["Attribution Requirement", usageRights?.attributionRequirement || ""],
      ["Attribution Text", usageRights?.attributionText || ""],
      ["Editing Rights", usageRights?.editingRights || ""],
      ["Music / Stock Asset Responsibility", usageRights?.musicStockAssetResponsibility || ""],
    ])}`,
    "SOW.ExclusivityTableHTML": renderKeyValueTable([
      ["Exclusivity / Competitor Blackout", exclusivity?.competitorBlackout || "-"],
      ["Category / Competitor List", exclusivity?.categoryCompetitorList || ""],
      ["Exclusivity / Blackout Period", exclusivity?.blackoutPeriod || ""],
      ["Optional Morals / Reputation Clause", exclusivity?.optionalMoralsClause || "Not included"],
    ]),
    "SOW.CancellationTableHTML": renderKeyValueTable([
      ["Kill Fee / Pro-Rata if Brand Cancels Without Cause", cancellation?.killFeeOrProrata || ""],
      ["Refund of Unearned Advance if Influencer Fails to Perform", cancellation?.refundOfUnearnedAdvance || ""],
    ]),
    "SOW.DisputeTableHTML": renderKeyValueTable([
      ["Governing Law", dispute?.governingLaw || ""],
      ["Dispute Resolution Method", dispute?.disputeResolutionMethod || ""],
      ["Venue", dispute?.disputeVenue || ""],
      ["Arbitration Seat", dispute?.arbitrationSeat || ""],
      ["Attorneys’ Fees", dispute?.attorneysFees || ""],
    ]),
  };
}

function renderTemplate(templateText, tokenMap) {
  return String(templateText || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, rawKey) => {
    const key = rawKey.replace(/\s*\(.*?\)\s*$/, "").trim();
    const v = tokenMap[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

function injectTrustedHtmlPlaceholders(legalHTML, contract) {
  const tokens = buildTokenMap(contract);
  const swaps = [
    ["[[Agreement.HeaderTableHTML]]", tokens["Agreement.HeaderTableHTML"] || ""],
    ["[[SOW.DeliverablesTableHTML]]", tokens["SOW.DeliverablesTableHTML"] || ""],
    ["[[SOW.ReviewTermsTableHTML]]", tokens["SOW.ReviewTermsTableHTML"] || ""],
    ["[[SOW.CommercialTermsTableHTML]]", tokens["SOW.CommercialTermsTableHTML"] || ""],
    ["[[SOW.RawFilesReportingTableHTML]]", tokens["SOW.RawFilesReportingTableHTML"] || ""],
    ["[[SOW.ProductShippingTableHTML]]", tokens["SOW.ProductShippingTableHTML"] || ""],
    ["[[SOW.UsageRightsTableHTML]]", tokens["SOW.UsageRightsTableHTML"] || ""],
    ["[[SOW.ExclusivityTableHTML]]", tokens["SOW.ExclusivityTableHTML"] || ""],
    ["[[SOW.CancellationTableHTML]]", tokens["SOW.CancellationTableHTML"] || ""],
    ["[[SOW.DisputeTableHTML]]", tokens["SOW.DisputeTableHTML"] || ""],
  ];
  let out = legalHTML;
  for (const [key, html] of swaps) {
    out = out.replaceAll(key, html);
    out = out.replace(new RegExp(`<p>\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*<\\/p>`, "g"), html);
  }
  return out;
}

function legalTextToHTML(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const out = [];
  let buffer = [];
  let inSigSection = false;
  const flushP = () => {
    if (!buffer.length) return;
    out.push(`<p>${esc(buffer.join("\n")).replace(/\n/g, "<br>")}</p>`);
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushP();
      continue;
    }
    if (/Agreement/i.test(line) && line.length > 30 && !out.length) {
      flushP();
      out.push(`<h1>${esc(line)}</h1>`);
      continue;
    }
    if (/^PART\s+\d+\s+—/i.test(line)) {
      flushP();
      out.push(`<h2>${esc(line)}</h2>`);
      continue;
    }
    if (/^Signatures$/i.test(line)) {
      flushP();
      out.push("<h2>Signatures</h2>");
      out.push('<div id="__SIG_PANEL__"></div>');
      inSigSection = true;
      continue;
    }
    if (inSigSection) {
      if (/^-{3,}.*End of Agreement.*-{3,}$/i.test(line)) {
        out.push(`<p style="text-align:center;margin-top:12pt;">--- End of Agreement ---</p>`);
      }
      continue;
    }
    const numeric = line.match(/^(\d+)\.\s+(.+)$/);
    if (numeric) {
      flushP();
      out.push(`<h3><span class="secno">${esc(numeric[1])}.</span> ${esc(numeric[2])}</h3>`);
      continue;
    }
    const alpha = line.match(/^([A-Z])\.\s+(.+)$/);
    if (alpha) {
      flushP();
      out.push(`<h3>${esc(alpha[1])}. ${esc(alpha[2])}</h3>`);
      continue;
    }
    buffer.push(rawLine);
  }

  flushP();
  if (!out.length) out.unshift(`<h1>${esc(CONTRACT_PDF_TITLE)}</h1>`);
  return out.join("\n");
}

function signaturePanelHTML(contract) {
  const tz = tzOr(contract);
  const roles = [
    { key: "brand", header: "BRAND", entityLabel: contract?.content?.brand?.legalName || contract.brandName || "—" },
    { key: "influencer", header: "INFLUENCER", entityLabel: contract?.content?.influencer?.legalName || contract.influencerName || "—" },
    { key: "collabglam", header: "COLLABGLAM LLC", entityLabel: "CollabGlam LLC" },
  ];
  const headerRow = roles.map(({ header }) => `<th style="text-align:center;background:#fff;font-weight:700;">${esc(header)}</th>`).join("");
  const sigCells = [];
  const nameCells = [];
  const dateCells = [];
  for (const { key, entityLabel } of roles) {
    const s = contract.signatures?.[key] || {};
    const imgSrc = s.sigImageDataUrl || (key === "collabglam" ? COLLABGLAM_FIXED_SIG_DATA_URL : "");
    const when = s.at ? formatDateTZ(s.at, tz, "MMMM D, YYYY") : "";
    const sigContent = imgSrc ? `<img class="sigimg" alt="Signature" src="${esc(imgSrc)}" style="max-height:50pt;max-width:100%;display:block;">` : `<div style="height:50pt;"></div>`;
    sigCells.push(`<td style="height:60pt;vertical-align:bottom;padding:4pt;">${sigContent}</td>`);
    nameCells.push(`<td style="padding:4pt;"><strong>Name:</strong> ${esc(s.name || entityLabel || "")}</td>`);
    dateCells.push(`<td style="padding:4pt;"><strong>Date:</strong> ${esc(when)}</td>`);
  }
  return `<table style="width:100%;border-collapse:collapse;table-layout:fixed;margin-top:10pt;"><thead><tr>${headerRow}</tr></thead><tbody><tr>${sigCells.join("")}</tr><tr>${nameCells.join("")}</tr><tr>${dateCells.join("")}</tr></tbody></table>`;
}

function renderContractHTML({ contract, templateText }) {
  let legalHTML = legalTextToHTML(templateText);
  legalHTML = legalHTML.replace('<div id="__SIG_PANEL__"></div>', signaturePanelHTML(contract));
  legalHTML = injectTrustedHtmlPlaceholders(legalHTML, contract);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><style>
    @page { size: A4; margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    body { font-family: "Times New Roman", Times, serif; color: #000; font-size: 10.5pt; line-height: 1.35; }
    h1,h2,h3 { font-weight:700;color:#000;margin:10pt 0 6pt; }
    h1 { font-size:13pt;text-align:center;text-transform:uppercase; }
    h2 { font-size:11pt; } h3 { font-size:10.5pt; }
    p { margin:0 0 5pt;text-align:justify; }
    img,table { max-width:100%; }
    table { width:100%;border-collapse:collapse;table-layout:fixed;font-size:9.5pt;margin:6pt 0; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th,td { border:1px solid #000;padding:3pt 4pt;vertical-align:top;word-break:break-word;overflow-wrap:anywhere; }
    th { text-align:left;background:#fff;font-weight:700; }
    tr:nth-child(even) td { background:#fafafa; }
  </style></head><body><main>${legalHTML}</main></body></html>`;
}

async function launchBrowserOnce() {
  const baseOptions = {
    headless: true,
    dumpio: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions"],
    timeout: 60000,
  };
  const execPath = process.env.CHROME_EXECUTABLE_PATH;
  if (execPath && fs.existsSync(execPath)) {
    try {
      return await puppeteer.launch({ ...baseOptions, executablePath: execPath });
    } catch (err) {
      console.error("[PDF] Launch with CHROME_EXECUTABLE_PATH failed:", err?.message || err);
    }
  }
  return puppeteer.launch(baseOptions);
}

async function getSharedBrowser() {
  if (sharedBrowserPromise) {
    try {
      const b = await sharedBrowserPromise;
      if (b && b.isConnected && b.isConnected()) return b;
    } catch (_e) {
      sharedBrowserPromise = null;
    }
  }
  sharedBrowserPromise = (async () => {
    const browser = await launchBrowserOnce();
    browser.on("disconnected", () => { sharedBrowserPromise = null; });
    return browser;
  })();
  return sharedBrowserPromise;
}

async function renderPDFWithPuppeteer({ html, res, filename = "Contract.pdf", headerTitle, headerDate }) {
  let page;
  const headerTemplate = `<style>.pdf-h{font-family:"Times New Roman",Times,serif;font-size:9pt;width:100%;padding:4mm 10mm;text-align:center}.title{font-weight:bold}.effdate{margin-top:1mm}</style><div class="pdf-h"><div class="title">${esc(headerTitle || "")}</div><div class="effdate">Effective Date &amp; Time: ${esc(headerDate || "")}</div></div>`;
  try {
    const browser = await getSharedBrowser();
    page = await browser.newPage();
    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({ preferCSSPageSize: true, format: "A4", printBackground: true, displayHeaderFooter: true, headerTemplate, footerTemplate: "<div></div>", margin: { top: "18mm", bottom: "14mm", left: "16mm", right: "16mm" }, scale: 1 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=${filename}`);
    return res.end(pdf);
  } catch (e) {
    console.error("[PDF] Puppeteer render failed, using PDFKit fallback:", e?.message || e);
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=${filename}`);
    doc.pipe(res);
    doc.fontSize(18).text(headerTitle || CONTRACT_PDF_TITLE, { align: "center" }).moveDown();
    String(html || "").replace(/<[^>]+>/g, " ").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).forEach((p) => doc.text(p, { align: "justify" }).moveDown());
    doc.end();
  } finally {
    if (page) await page.close().catch(() => null);
  }
}

process.on("SIGTERM", async () => {
  try {
    const b = sharedBrowserPromise && (await sharedBrowserPromise);
    if (b?.close) await b.close();
  } catch (_e) { }
});

function campaignQuery(campaignId) {
  return { _id: campaignId };
}

function findContractQuery(contractId) {
  const or = [{ contractId: String(contractId) }];
  if (mongoose.Types.ObjectId.isValid(contractId)) or.push({ _id: contractId });
  return { $or: or };
}

async function findContract(contractId) {
  return Contract.findOne(findContractQuery(contractId));
}

function roleFromReq(req, explicitRole) {
  return explicitRole || req.user?.role || (req.user?.isAdmin ? "admin" : req.user?.brandId ? "brand" : req.user?.influencerId ? "influencer" : "system");
}

function requiredSigners(contract) {
  if (Array.isArray(contract?.requiredSigners) && contract.requiredSigners.length) {
    return contract.requiredSigners.map((x) => String(x).toLowerCase());
  }
  return ["brand", "influencer"];
}

function hasAcceptedCurrent(contract, role) {
  const v = Number(contract.version || 0);
  const a = contract.acceptances?.[role];
  return Boolean(a?.accepted && Number(a?.acceptedVersion) === v);
}

function markAccepted(contract, role, byUserId) {
  const v = Number(contract.version || 0);
  contract.acceptances = contract.acceptances || {};
  contract.acceptances[role] = { ...(contract.acceptances[role] || {}), accepted: true, acceptedVersion: v, at: new Date(), byUserId: byUserId || "" };
}

async function resetSignaturesForNewVersion(contract) {
  await ContractSignature.updateMany({ contractId: contract.contractId }, { $set: { signed: false, revokedAt: new Date(), revokeReason: "new_version" } });
}

function resetAcceptancesForNewVersion(contract) {
  contract.acceptances = contract.acceptances || {};
  contract.acceptances.brand = { ...(contract.acceptances.brand || {}), accepted: false };
  contract.acceptances.influencer = { ...(contract.acceptances.influencer || {}), accepted: false };
  contract.editsLockedAt = null;
  contract.awaitingRole = "influencer";
  contract.statusFlags = contract.statusFlags || {};
  contract.statusFlags.awaitingCollabglam = false;
}

function normalizeStatus(contract) {
  return Contract.normalizeStatus ? Contract.normalizeStatus(contract.status) : normalizeContractStatus(contract.status);
}

function isLockedContract(contract) {
  const st = normalizeStatus(contract);
  return Boolean(contract.lockedAt || st === CONTRACT_STATUS.CONTRACT_SIGNED || st === CONTRACT_STATUS.MILESTONES_CREATED);
}

function requireNotLocked(contract) {
  if (isLockedContract(contract)) {
    const e = new Error("Contract is locked and cannot be edited");
    e.status = 400;
    throw e;
  }
}

function requireInfluencerAcceptedCurrent(contract) {
  if (!hasAcceptedCurrent(contract, "influencer")) {
    const e = new Error("Influencer must accept the current version first");
    e.status = 400;
    throw e;
  }
}

function requireBrandAcceptedCurrent(contract) {
  if (!hasAcceptedCurrent(contract, "brand")) {
    const e = new Error("Brand must accept the current version first");
    e.status = 400;
    throw e;
  }
}

function requireReadyToSign(contract) {
  const st = normalizeStatus(contract);
  if (st !== CONTRACT_STATUS.READY_TO_SIGN || !contract.editsLockedAt) {
    const e = new Error("Contract is not ready to sign yet");
    e.status = 400;
    throw e;
  }
  if (!hasAcceptedCurrent(contract, "brand") || !hasAcceptedCurrent(contract, "influencer")) {
    const e = new Error("Both parties must accept the current version before signing");
    e.status = 400;
    throw e;
  }
}

async function nextUnsignedRole(contract) {
  const signatures = await ContractSignature.find({ contractId: contract.contractId }).lean();
  const signedByRole = signatures.reduce((acc, s) => ({ ...acc, [s.role]: Boolean(s.signed) }), {});
  for (const role of requiredSigners(contract)) {
    if (!signedByRole[role]) return role;
  }
  return null;
}

async function allRequiredSigned(contract) {
  return !(await nextUnsignedRole(contract));
}

async function syncStatusFromAcceptances(contract) {
  const prev = normalizeStatus(contract);
  const brandOk = hasAcceptedCurrent(contract, "brand");
  const infOk = hasAcceptedCurrent(contract, "influencer");
  contract.statusFlags = contract.statusFlags || {};

  if (brandOk && infOk) {
    contract.status = CONTRACT_STATUS.READY_TO_SIGN;
    contract.editsLockedAt = contract.editsLockedAt || new Date();
    const nextRole = (await nextUnsignedRole(contract)) || "brand";
    contract.awaitingRole = nextRole;
    contract.statusFlags.awaitingCollabglam = nextRole === "collabglam";
    return { movedToReady: prev !== CONTRACT_STATUS.READY_TO_SIGN, nextRole };
  }
  if (infOk && !brandOk) {
    contract.status = CONTRACT_STATUS.INFLUENCER_ACCEPTED;
    contract.awaitingRole = "brand";
    contract.statusFlags.awaitingCollabglam = false;
    return { movedToReady: false, nextRole: "brand" };
  }
  if (brandOk && !infOk) {
    contract.status = CONTRACT_STATUS.BRAND_ACCEPTED;
    contract.awaitingRole = "influencer";
    contract.statusFlags.awaitingCollabglam = false;
    return { movedToReady: false, nextRole: "influencer" };
  }
  return { movedToReady: false, nextRole: contract.awaitingRole || "influencer" };
}

function parseSignatureImage({ signatureImageDataUrl, signatureImageBase64, signatureImageMime }) {
  if (!signatureImageDataUrl && !signatureImageBase64) return "";
  if (signatureImageDataUrl) {
    const m = String(signatureImageDataUrl).match(/^data:(image\/(png|jpeg|jpg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/i);
    if (!m) {
      const e = new Error("Invalid signatureImageDataUrl. Must be image data URL with base64.");
      e.status = 400;
      throw e;
    }
    const bytes = Buffer.from(m[3], "base64").length;
    if (bytes > MAX_SIG_BYTES) {
      const e = new Error(`Signature image must be ≤ ${MAX_SIG_BYTES / 1024} KB.`);
      e.status = 400;
      throw e;
    }
    return String(signatureImageDataUrl).trim();
  }
  const mime = (signatureImageMime || "image/png").toLowerCase();
  if (!/^image\/(png|jpeg|jpg|webp|svg\+xml)$/.test(mime)) {
    const e = new Error("Unsupported signatureImageMime.");
    e.status = 400;
    throw e;
  }
  const base64 = String(signatureImageBase64 || "");
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) {
    const e = new Error("Invalid base64 payload for signature image.");
    e.status = 400;
    throw e;
  }
  return `data:${mime};base64,${base64}`;
}

function getEmailForRole({ contract, role, brandDoc, influencerDoc }) {
  if (role === "brand") return contract?.content?.brand?.noticeEmail?.trim() || contract?.other?.brandProfile?.email?.trim() || brandDoc?.email?.trim() || "";
  if (role === "influencer") return contract?.content?.influencer?.contactEmail?.trim() || contract?.content?.influencer?.email?.trim() || contract?.other?.influencerProfile?.email?.trim() || influencerDoc?.email?.trim() || "";
  if (role === "collabglam") return contract?.admin?.collabglamSignatoryEmail?.trim() || process.env.COLLABGLAM_SIGNATORY_EMAIL?.trim() || "";
  return "";
}

function getNameForRole({ contract, role, brandDoc, influencerDoc }) {
  if (role === "brand") return contract?.content?.brand?.contactPersonName || contract?.brandName || brandDoc?.name || brandDoc?.legalName || "Brand";
  if (role === "influencer") return contract?.content?.influencer?.contactName || contract?.influencerName || influencerDoc?.name || influencerDoc?.legalName || "Influencer";
  if (role === "collabglam") return contract?.content?.collabglam?.signatoryName || "CollabGlam";
  return "User";
}

async function safeSendEmail({ contract, templateKey, to, recipientRole, recipientName }) {
  if (!sendContractEmail || !to) return;
  try {
    await sendContractEmail({ contract, templateKey, to, recipientRole, recipientName });
  } catch (e) {
    console.error("[Email] send failed:", templateKey, to, e?.message || e);
  }
}

async function safeStartReminder(contract, role) {
  if (!startReminder) return;
  try { await startReminder({ contract, role }); } catch (e) { console.error("[Reminder] start failed:", role, e?.message || e); }
}
async function safeClearReminder(contractId, role) {
  if (!clearReminder) return;
  try { await clearReminder({ contractId, role }); } catch (e) { console.error("[Reminder] clear failed:", role, e?.message || e); }
}
async function safeResetReminderOnView(contract, role) {
  if (!resetReminderOnEngagement) return;
  try { await resetReminderOnEngagement({ contract, role }); } catch (e) { console.error("[Reminder] reset-on-view failed:", role, e?.message || e); }
}

function getCampaignPaymentType(_campaign, contentInput = {}) {
  return normalizePaymentType(contentInput?.campaign?.paymentType);
}

function getCampaignFee(campaign, paymentType) {
  if (paymentType === PAYMENT_TYPE.GIFTING) return 0;
  return Number(campaign?.influencerBudget || campaign?.campaignBudget || campaign?.budget || 0);
}

function buildDefaultDeliverables(campaign, inputDeliverables) {
  if (Array.isArray(inputDeliverables) && inputDeliverables.length) return inputDeliverables;
  return [{ srNo: 1, platformHandle: Array.isArray(campaign?.platformSelection) ? campaign.platformSelection.join(", ") : "", deliverableFormat: "", qty: 1, draftDue: "", liveDate: "" }];
}

function getMandatoryTags(campaign) {
  return Array.isArray(campaign?.hashtags) && campaign.hashtags.length ? campaign.hashtags.join(", ") : "";
}

function createDefaultContent({ campaign, brandDoc, influencerDoc, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, contentInput = {} }) {
  const effectiveDate = requestedEffectiveDate ? buildRequestedEffectiveDate(requestedEffectiveDate, requestedEffectiveDateTimezone || admin?.timezone || DEFAULT_TZ) : undefined;
  const paymentType = getCampaignPaymentType(campaign, contentInput);
  const totalCampaignFee = contentInput?.scheduleA?.commercial?.totalCampaignFee ?? getCampaignFee(campaign, paymentType);
  const defaultPaymentStructure = paymentType === PAYMENT_TYPE.MILESTONE ? "50% advance / 50% balance" : paymentType === PAYMENT_TYPE.GIFTING ? "-" : "";

  const base = {
    brand: {
      legalName: brandDoc?.legalName || brandDoc?.name || "",
      contactPersonName: brandDoc?.contactName || brandDoc?.ownerName || "",
      noticeEmail: brandDoc?.email || "",
      noticePhone: brandDoc?.phone || "",
      billingAddress: brandDoc?.address || "",
    },
    influencer: {
      legalName: influencerDoc?.legalName || influencerDoc?.name || "",
      contactName: influencerDoc?.contactName || influencerDoc?.name || "",
      postingHandleUrl: influencerDoc?.handle || influencerDoc?.profileUrl || "",
      contactEmail: influencerDoc?.email || "",
      email: influencerDoc?.email || "",
      contactPhone: influencerDoc?.phone || "",
      phone: influencerDoc?.phone || "",
      whatsApp: influencerDoc?.whatsapp || "",
      address: influencerDoc?.address || "",
    },
    collabglam: {
      legalName: "CollabGlam LLC",
      address: "CollabGlam LLC, 732 S 6th STE N, Las Vegas, Nevada 89101, USA",
      email: "help@collabglam.com",
      signatoryName: admin?.collabglamSignatoryName || "",
    },
    campaign: {
      productsServicesCovered: contentInput?.campaign?.productsServicesCovered || campaign?.productOrServiceName || "",
      territoryTargetCountry: contentInput?.campaign?.territoryTargetCountry || "Worldwide",
      effectiveDate: effectiveDate || contentInput?.campaign?.effectiveDate || null,
      campaignTitleOrId: contentInput?.campaign?.campaignTitleOrId || campaign?.campaignTitle || campaign?.productOrServiceName || String(campaign?._id || ""),
      paymentType,
    },
    scheduleA: {
      deliverables: buildDefaultDeliverables(campaign, contentInput?.scheduleA?.deliverables),
      minimumVideoSpecs: contentInput?.scheduleA?.minimumVideoSpecs || "",
      preShootScriptRequired: Boolean(contentInput?.scheduleA?.preShootScriptRequired),
      preShootScriptDue: contentInput?.scheduleA?.preShootScriptDue || "",
      preShootScriptReviewBusinessDays: contentInput?.scheduleA?.preShootScriptReviewBusinessDays || 2,
      mandatoryTagsMentionsLinksCodes: contentInput?.scheduleA?.mandatoryTagsMentionsLinksCodes || getMandatoryTags(campaign),
      review: {
        needRevisionRounds:
          contentInput?.scheduleA?.review?.needRevisionRounds === "yes" ||
          contentInput?.scheduleA?.review?.needRevisionRounds === true
            ? "yes"
            : "no",
        includedRevisionRounds:
          contentInput?.scheduleA?.review?.needRevisionRounds === "yes" ||
          contentInput?.scheduleA?.review?.needRevisionRounds === true
            ? Number(contentInput?.scheduleA?.review?.includedRevisionRounds || 1)
            : 0,
        additionalRevisionFee:
          contentInput?.scheduleA?.review?.needRevisionRounds === "yes" ||
          contentInput?.scheduleA?.review?.needRevisionRounds === true
            ? String(contentInput?.scheduleA?.review?.additionalRevisionFee || "0")
            : "",
        reshootObligation:
          contentInput?.scheduleA?.review?.reshootObligation ||
          "No reshoot required except for material failure to follow approved brief",
        reshootFee: contentInput?.scheduleA?.review?.reshootFee || "",
        minimumLivePeriod: contentInput?.scheduleA?.review?.minimumLivePeriod || "",
      },
      commercial: {
        totalCampaignFee: paymentType === PAYMENT_TYPE.GIFTING ? 0 : Number(totalCampaignFee || 0),
        currency: contentInput?.scheduleA?.commercial?.currency || "USD",
        wantAdvancePayment: Boolean(contentInput?.scheduleA?.commercial?.wantAdvancePayment),
        advancePaymentAmount: Number(contentInput?.scheduleA?.commercial?.advancePaymentAmount || 0),
        advancePaymentType: contentInput?.scheduleA?.commercial?.advancePaymentType || "",
        paymentStructure: contentInput?.scheduleA?.commercial?.paymentStructure || contentInput?.scheduleA?.commercial?.platformMilestonePaymentStructure || defaultPaymentStructure,
        customSplit: contentInput?.scheduleA?.commercial?.customSplit || "",
        advancePaymentTrigger: contentInput?.scheduleA?.commercial?.advancePaymentTrigger || "",
        remainingPaymentTrigger: contentInput?.scheduleA?.commercial?.remainingPaymentTrigger || "",
        paymentProcessorFeesBorneBy: contentInput?.scheduleA?.commercial?.paymentProcessorFeesBorneBy || "",
        paymentProcessorFeesNotes: contentInput?.scheduleA?.commercial?.paymentProcessorFeesNotes || "",
        laneAMarketplaceFeeNote: contentInput?.scheduleA?.commercial?.laneAMarketplaceFeeNote || "Unless expressly stated otherwise, 10% of the applicable Influencer compensation funded through the Platform is deducted from the Influencer payout and retained by CollabGlam; the Brand-funded campaign amount remains fixed.",
        payoutMethod: contentInput?.scheduleA?.commercial?.payoutMethod || "",
        payoutAccountId: contentInput?.scheduleA?.commercial?.payoutAccountId || "",
        taxId: contentInput?.scheduleA?.commercial?.taxId || "",
        milestones: Array.isArray(contentInput?.scheduleA?.commercial?.milestones) ? contentInput.scheduleA.commercial.milestones : paymentType === PAYMENT_TYPE.MILESTONE ? [{ milestoneName: "Milestone 1", paymentAmount: 0, triggerEvent: "", dueDate: "" }] : [],
      },
      rawFiles: {
        rawSourceFileDelivery: contentInput?.scheduleA?.rawFiles?.rawSourceFileDelivery || "Not included",
        deliveryDue: contentInput?.scheduleA?.rawFiles?.deliveryDue || "",
        format: contentInput?.scheduleA?.rawFiles?.format || "",
        analyticsReportingDeadline: contentInput?.scheduleA?.rawFiles?.analyticsReportingDeadline || "",
        analyticsReportingItems: contentInput?.scheduleA?.rawFiles?.analyticsReportingItems || "",
      },
      shipping: {
        productShippingApplicable: contentInput?.scheduleA?.shipping?.productShippingApplicable || (paymentType === PAYMENT_TYPE.GIFTING ? "Yes" : "No"),
        shipToName: contentInput?.scheduleA?.shipping?.shipToName || "",
        shipToAddress: contentInput?.scheduleA?.shipping?.shipToAddress || "",
        shipToPhone: contentInput?.scheduleA?.shipping?.shipToPhone || "",
        productReceiptConfirmationDeadline: contentInput?.scheduleA?.shipping?.productReceiptConfirmationDeadline || "",
        productReturnable: contentInput?.scheduleA?.shipping?.productReturnable || (paymentType === PAYMENT_TYPE.GIFTING ? "Gift / keep product" : ""),
        returnWindowMethod: contentInput?.scheduleA?.shipping?.returnWindowMethod || "",
        riskOfLossNotes: contentInput?.scheduleA?.shipping?.riskOfLossNotes || "",
      },
      usageRights: {
        rows: Array.isArray(contentInput?.scheduleA?.usageRights?.rows) ? contentInput.scheduleA.usageRights.rows : [
          { usageRight: "Organic repost on Brand-owned social channels", selected: false, duration: "", territoryNotes: "" },
          { usageRight: "Brand website / blog / PDP / retailer listing", selected: false, duration: "", territoryNotes: "" },
          { usageRight: "Email / CRM / deck / internal presentation use", selected: false, duration: "", territoryNotes: "" },
          { usageRight: "Paid social / boosting / ads", selected: false, duration: "", territoryNotes: "" },
          { usageRight: "Whitelisting / Spark Ads / dark posting / creator handle", selected: false, duration: "", territoryNotes: "" },
          { usageRight: "Perpetual rights / buyout / work-made-for-hire", selected: false, duration: "", territoryNotes: "" },
        ],
        attributionRequirement: contentInput?.scheduleA?.usageRights?.attributionRequirement || "No attribution required",
        attributionText: contentInput?.scheduleA?.usageRights?.attributionText || "",
        editingRights: contentInput?.scheduleA?.usageRights?.editingRights || "Cropping / resizing only",
        musicStockAssetResponsibility: contentInput?.scheduleA?.usageRights?.musicStockAssetResponsibility || "Brand responsible for separate commercial licensing",
      },
      compliance: {
        creativeBriefMandatoryTalkingPoints: contentInput?.scheduleA?.compliance?.creativeBriefMandatoryTalkingPoints || "",
        restrictedStatements: contentInput?.scheduleA?.compliance?.restrictedStatements || "",
      },
      exclusivity: {
        competitorBlackout: contentInput?.scheduleA?.exclusivity?.competitorBlackout || "None",
        categoryCompetitorList: contentInput?.scheduleA?.exclusivity?.categoryCompetitorList || "",
        blackoutPeriod: contentInput?.scheduleA?.exclusivity?.blackoutPeriod || "",
        optionalMoralsClause: contentInput?.scheduleA?.exclusivity?.optionalMoralsClause || "Not included",
      },
      cancellation: {
        killFeeOrProrata: contentInput?.scheduleA?.cancellation?.killFeeOrProrata || "None",
        refundOfUnearnedAdvance: contentInput?.scheduleA?.cancellation?.refundOfUnearnedAdvance || "Yes — on material non-performance / uncured breach",
      },
      dispute: {
        governingLaw: contentInput?.scheduleA?.dispute?.governingLaw || "Nevada, USA",
        disputeResolutionMethod: contentInput?.scheduleA?.dispute?.disputeResolutionMethod || "AAA arbitration",
        disputeVenue: contentInput?.scheduleA?.dispute?.disputeVenue || "",
        arbitrationSeat: contentInput?.scheduleA?.dispute?.arbitrationSeat || "Las Vegas, Nevada, USA",
        attorneysFees: contentInput?.scheduleA?.dispute?.attorneysFees || "Each Party bears own fees",
      },
    },
  };
  const merged = mergeDeep(base, contentInput || {});
  merged.campaign.paymentType = paymentType;
  merged.scheduleA.commercial.totalCampaignFee = paymentType === PAYMENT_TYPE.GIFTING ? 0 : Number(merged.scheduleA.commercial.totalCampaignFee || 0);
  if (paymentType !== PAYMENT_TYPE.MILESTONE) merged.scheduleA.commercial.milestones = [];
  return merged;
}

function buildOtherProfile({ brandDoc, influencerDoc, resolvedHandle = "" }) {
  return {
    brandProfile: {
      legalName: brandDoc?.legalName || brandDoc?.name || "",
      address: brandDoc?.address || "",
      contactName: brandDoc?.contactName || brandDoc?.ownerName || "",
      email: brandDoc?.email || "",
      country: brandDoc?.country || "",
    },
    influencerProfile: {
      legalName: influencerDoc?.legalName || influencerDoc?.name || "",
      address: influencerDoc?.address || "",
      contactName: influencerDoc?.contactName || influencerDoc?.name || "",
      email: influencerDoc?.email || "",
      country: influencerDoc?.country || "",
      handle: resolvedHandle || influencerDoc?.handle || "",
    },
    autoCalcs: {},
  };
}

function buildAdmin({ campaign, requestedEffectiveDateTimezone, req }) {
  const timezone = campaign?.campaignTimezone || requestedEffectiveDateTimezone || DEFAULT_TZ;
  return {
    timezone,
    jurisdiction: "USA",
    arbitrationSeat: "San Francisco, CA",
    fxSource: "ECB",
    extraRevisionFee: 0,
    escrowAMLFlags: "",
    collabglamSignatoryName: "",
    collabglamSignatoryEmail: process.env.COLLABGLAM_SIGNATORY_EMAIL || "",
    legalTemplateVersion: 1,
    legalTemplateText: MASTER_TEMPLATE,
    legalTemplateHistory: [{ version: 1, text: MASTER_TEMPLATE, updatedAt: new Date(), updatedBy: req.user?.email || "system" }],
  };
}

async function syncApplyCampaignAfterSend(contract, first = false) {
  await ApplyCampaign.updateOne(
    { campaignId: String(contract.campaignId), "applicants.influencerId": String(contract.influencerId) },
    {
      $set: {
        "applicants.$.contractId": first ? String(contract.contractId) : String(contract._id),
        "applicants.$.statusInfluencer": first ? "contract-send" : "under-influencer-review",
        "applicants.$.statusBrand": first ? "under-influencer-review" : "contract-send",
      },
    }
  );
}

async function createContractRecord({ req, brandId, influencerId, campaignId, campaign, brandDoc, influencerDoc, content, other, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand = "", signatureId = "", resendOf = null, resendIteration = 0 }) {
  const requestedDateBuilt = requestedEffectiveDate ? buildRequestedEffectiveDate(requestedEffectiveDate, requestedEffectiveDateTimezone || admin.timezone || DEFAULT_TZ) : undefined;
  const paymentType = normalizePaymentType(content?.campaign?.paymentType);
  const contract = new Contract({
    brandId,
    influencerId,
    campaignId,
    paymentType,
    status: CONTRACT_STATUS.BRAND_SENT_DRAFT,
    awaitingRole: "influencer",
    version: 0,
    editsLockedAt: null,
    requiredSigners: ["brand", "influencer"],
    requestedEffectiveDate: requestedDateBuilt,
    requestedEffectiveDateTimezone: requestedEffectiveDateTimezone || admin.timezone || DEFAULT_TZ,
    brandName: content?.brand?.legalName || "",
    brandAddress: content?.brand?.billingAddress || "",
    brandPoc: content?.brand?.brandPoc || "",
    brandPocDesignation: content?.brand?.brandPocDesignation || "",
    influencerName: content?.influencer?.legalName || "",
    influencerAddress: content?.influencer?.address || "",
    influencerHandle: content?.influencer?.postingHandleUrl || "",
    feeAmount: Number(content?.scheduleA?.commercial?.totalCampaignFee || 0),
    currency: content?.scheduleA?.commercial?.currency || "USD",
    lastSentAt: new Date(),
    isAssigned: 1,
    isAccepted: 0,
    resendOf,
    resendIteration,
  });

  await contract.save();
  await createOrUpdateContent({ contract, content, other });
  await createOrUpdateDocument({ contract, admin, templateText: MASTER_TEMPLATE });

  if (signatureBrand) {
    await ContractSignature.upsertSigned({
      contractId: contract.contractId,
      role: "brand",
      byUserId: req.user?.id || "",
      name: brandDoc?.contactName || brandDoc?.ownerName || brandDoc?.legalName || brandDoc?.name || "",
      email: brandDoc?.email || "",
      signatureDataUrl: signatureBrand,
      savedSignatureId: signatureId || content?.brand?.brandSignature || "",
      ipAddress: req.ip || "",
      userAgent: req.get?.("user-agent") || "",
    });
    await addActivity(contract, "brand", "SIGNED_ON_INITIATE", { role: "brand", email: brandDoc?.email || "" });
  }

  await addActivity(contract, "system", resendOf ? "RESENT_CHILD_CREATED" : "INITIATED", { campaignId, status: contract.status, resendOf });
  await contract.save();
  return contract;
}

async function renderHydratedContractPdf({ contract, res, filename }) {
  const hydrated = await hydrateContract(contract);
  const tokens = hydrated.lockedAt && hydrated.renderedTextSnapshot ? hydrated.templateTokensSnapshot || buildTokenMap(hydrated) : buildTokenMap(hydrated);
  const text = hydrated.lockedAt && hydrated.renderedTextSnapshot ? hydrated.renderedTextSnapshot : renderTemplate(hydrated.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
  const html = renderContractHTML({ contract: hydrated, templateText: text });
  return renderPDFWithPuppeteer({
    html,
    res,
    filename,
    headerTitle: CONTRACT_PDF_TITLE,
    headerDate: tokens["Agreement.EffectiveDateTime"] || tokens["Agreement.EffectiveDateLong"] || tokens["Agreement.EffectiveDate"] || "Pending",
  });
}

exports.initiate = async (req, res) => {
  try {
    const { brandId, influencerId, campaignId, content: contentInput = {}, requestedEffectiveDate, requestedEffectiveDateTimezone, preview = false, isResend = false, resendOf, signatureBrand = "", signatureId = "" } = req.body;
    assertRequired(req.body, ["brandId", "influencerId", "campaignId"]);

    if (!mongoose.Types.ObjectId.isValid(campaignId)) return respondError(res, "Invalid campaignId", 400);
    if (!mongoose.Types.ObjectId.isValid(brandId)) return respondError(res, "Invalid brandId", 400);
    if (!mongoose.Types.ObjectId.isValid(influencerId)) return respondError(res, "Invalid influencerId", 400);

    const [campaign, brandDoc, influencerDoc] = await Promise.all([Campaign.findById(campaignId), Brand.findById(brandId), Influencer.findById(influencerId)]);
    if (!campaign) return respondError(res, "Campaign not found", 404);
    if (!brandDoc) return respondError(res, "Brand not found", 404);
    if (!influencerDoc) return respondError(res, "Influencer not found", 404);

    const cleanSignatureBrand = String(signatureBrand || "").trim();
    if (!cleanSignatureBrand && !preview) return respondError(res, "Brand signature is required to initiate contract.", 400);

    const admin = buildAdmin({ campaign, requestedEffectiveDateTimezone, req });
    const other = buildOtherProfile({ brandDoc, influencerDoc });
    const content = createDefaultContent({ campaign, brandDoc, influencerDoc, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, contentInput });

    if (preview && !isResend) {
      const tmp = {
        brandId,
        influencerId,
        campaignId,
        content,
        other,
        admin,
        requestedEffectiveDate: requestedEffectiveDate ? buildRequestedEffectiveDate(requestedEffectiveDate, requestedEffectiveDateTimezone || admin.timezone || DEFAULT_TZ) : null,
        requestedEffectiveDateTimezone: requestedEffectiveDateTimezone || admin.timezone || DEFAULT_TZ,
        brandName: content.brand.legalName,
        influencerName: content.influencer.legalName,
        signatures: { brand: { signed: Boolean(cleanSignatureBrand), sigImageDataUrl: cleanSignatureBrand }, influencer: {}, collabglam: {} },
      };
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(admin.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      return renderPDFWithPuppeteer({ html, res, filename: `Contract-Preview-${campaignId}.pdf`, headerTitle: CONTRACT_PDF_TITLE, headerDate: tokens["Agreement.EffectiveDateTime"] || tokens["Agreement.EffectiveDateLong"] || "Pending" });
    }

    if (isResend && resendOf) {
      const parent = await Contract.findOne({ contractId: resendOf });
      if (!parent) return respondError(res, "resendOf contract not found", 404);
      if (String(parent.brandId) !== String(brandId) || String(parent.influencerId) !== String(influencerId) || String(parent.campaignId) !== String(campaignId)) return respondError(res, "resendOf must belong to the same brand, influencer, and campaign", 400);
      if (isLockedContract(parent)) return respondError(res, "Cannot resend a signed/locked contract", 400);

      const child = await createContractRecord({ req, brandId, influencerId, campaignId, campaign, brandDoc, influencerDoc, content, other, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand: cleanSignatureBrand, signatureId, resendOf: parent.contractId, resendIteration: Number(parent.resendIteration || 0) + 1 });
      parent.supersededBy = child.contractId;
      parent.resentAt = new Date();
      parent.status = CONTRACT_STATUS.SUPERSEDED;
      parent.statusFlags = parent.statusFlags || {};
      parent.statusFlags.isSuperseded = true;
      await addActivity(parent, "system", "RESENT", { to: child.contractId, by: req.user?.email || "system" });
      await parent.save();

      await Campaign.updateOne(campaignQuery(campaignId), { $set: { isContracted: 1, contractId: child.contractId, isAccepted: 0 } });
      await safeStartReminder(child, "influencer");
      await safeClearReminder(child.contractId, "brand");
      const hydratedChild = await hydrateContract(child);
      return respondOK(res, { message: "Resent contract created", contract: hydratedChild }, 201);
    }

    const contract = await createContractRecord({ req, brandId, influencerId, campaignId, campaign, brandDoc, influencerDoc, content, other, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand: cleanSignatureBrand, signatureId });
    await syncApplyCampaignAfterSend(contract, true);
    await syncApplyCampaignAfterSend(contract, false);
    await Campaign.updateOne(campaignQuery(campaignId), { $set: { isContracted: 1 } });

    await createAndEmit({ recipientType: "influencer", influencerId: String(influencerId), type: "contract.initiated", title: `Contract initiated by ${brandDoc.name || "Brand"}`, message: `Contract created for "${campaign.productOrServiceName || "Campaign"}".`, entityType: "contract", entityId: String(contract.contractId), actionPath: "/influencer/my-campaign", meta: { campaignId, brandId, influencerId } });
    await createAndEmit({ recipientType: "brand", brandId: String(brandId), type: "contract.initiated.self", title: "Contract sent", message: `You sent a contract to ${influencerDoc.name || "Influencer"}.`, entityType: "contract", entityId: String(contract.contractId), actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`, meta: { campaignId, influencerId } });

    const hydrated = await hydrateContract(contract);
    await safeSendEmail({ contract: hydrated, templateKey: "contract_new_received_influencer", to: getEmailForRole({ contract: hydrated, role: "influencer", influencerDoc }), recipientRole: "influencer", recipientName: getNameForRole({ contract: hydrated, role: "influencer", influencerDoc }) });
    await safeStartReminder(contract, "influencer");
    await safeClearReminder(contract.contractId, "brand");

    return respondOK(res, { message: "Contract initialized successfully", contract: hydrated }, 201);
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INITIATE_ERROR");
    return respondError(res, err.message || "initiate error", err.status || 500, err);
  }
};

exports.viewed = async (req, res) => {
  try {
    const { contractId, role } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    const who = roleFromReq(req, role);
    if (who === "brand") contract.lastViewedByBrandAt = new Date();
    if (who === "influencer") contract.lastViewedByInfluencerAt = new Date();
    await addActivity(contract, who, "VIEWED");
    await contract.save();
    if (who === "brand" || who === "influencer") await safeResetReminderOnView(contract, who);
    return respondOK(res, { message: "Marked viewed", contract: await hydrateContract(contract) });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "VIEWED_ERROR");
    return respondError(res, err.message || "viewed error", err.status || 500, err);
  }
};

exports.influencerConfirm = async (req, res) => {
  try {
    const { contractId, influencer: influencerData = {}, creatorUpdates = {}, signatureInfluencer = "", preview = false } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);
    if (contract.editsLockedAt) return respondError(res, "Contract is locked for signing; edits/accept changes are disabled", 400);

    const hydrated = await hydrateContract(contract);
    const creatorContentUpdates = creatorUpdates?.content || {};
    const content = mergeDeep(
      hydrated.content || {},
      mergeDeep(creatorContentUpdates, {
        influencer: { ...(hydrated.content?.influencer || {}), ...influencerData },
      })
    );

    if (preview) {
      const tmp = { ...hydrated, content, signatures: { ...(hydrated.signatures || {}) } };
      if (signatureInfluencer) tmp.signatures.influencer = { signed: true, sigImageDataUrl: signatureInfluencer };
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      return renderPDFWithPuppeteer({ html, res, filename: `Contract-Influencer-Preview-${contractId}.pdf`, headerTitle: CONTRACT_PDF_TITLE, headerDate: tokens["Agreement.EffectiveDateTime"] || tokens["Agreement.EffectiveDateLong"] || "Pending" });
    }

    const before = { influencer: hydrated.content?.influencer || {}, signatureInfluencer: hydrated.signatureInfluencer || "" };
    await createOrUpdateContent({ contract, content, other: hydrated.other || {} });

    if (signatureInfluencer) {
      await ContractSignature.upsertSigned({ contractId: contract.contractId, role: "influencer", byUserId: req.user?.id || "", name: content.influencer?.legalName || contract.influencerName || "", email: content.influencer?.email || "", signatureDataUrl: signatureInfluencer, ipAddress: req.ip || "", userAgent: req.get?.("user-agent") || "" });
    }

    contract.influencerName = content.influencer?.legalName || contract.influencerName || "";
    contract.influencerAddress = content.influencer?.address || compactJoin([content.influencer?.addressLine1, content.influencer?.addressLine2, content.influencer?.city, content.influencer?.state, content.influencer?.zipPostalCode, content.influencer?.country]);
    contract.feeAmount = Number(content?.scheduleA?.commercial?.totalCampaignFee || contract.feeAmount || 0);
    contract.currency = content?.scheduleA?.commercial?.currency || contract.currency || "USD";

    const after = { influencer: content.influencer, scheduleA: content.scheduleA, campaign: content.campaign, signatureInfluencer };
    const editedFields = computeEditedFields(before, after, ["influencer", "signatureInfluencer"]);
    if (editedFields.length) {
      contract.version += 1;
      resetAcceptancesForNewVersion(contract);
      await resetSignaturesForNewVersion(contract);
      contract.status = CONTRACT_STATUS.INFLUENCER_EDITED;
      contract.awaitingRole = "brand";
      await addActivity(contract, "influencer", "INFLUENCER_EDITED", { editedFields, byUserId: req.user?.id || "" }, before);
    }

    markAccepted(contract, "influencer", req.user?.id);
    const sync = await syncStatusFromAcceptances(contract);
    contract.isAccepted = 1;
    await addActivity(contract, "influencer", "INFLUENCER_ACCEPTED", { editedFields, version: contract.version, nextRole: sync.nextRole, hasSignature: Boolean(signatureInfluencer) });
    await contract.save();

    await ApplyCampaign.updateOne({ campaignId: String(contract.campaignId), "applicants.influencerId": String(contract.influencerId) }, { $set: { "applicants.$.isShortlisted": 0 } });
    await Campaign.updateOne(campaignQuery(contract.campaignId), { $set: { isAccepted: 1, isContracted: 1, contractId: contract.contractId } });

    const out = await hydrateContract(contract);
    await safeSendEmail({ contract: out, templateKey: "contract_accepted_by_influencer_brand_notify", to: getEmailForRole({ contract: out, role: "brand" }), recipientRole: "brand", recipientName: getNameForRole({ contract: out, role: "brand" }) });
    if (contract.awaitingRole === "brand") await safeStartReminder(contract, "brand");
    await safeClearReminder(contract.contractId, "influencer");

    return respondOK(res, { message: "Influencer acceptance saved", contract: out });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INFLUENCER_CONFIRM_ERROR");
    return respondError(res, err.message || "influencerConfirm error", err.status || 500, err);
  }
};

exports.brandConfirm = async (req, res) => {
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);
    if (contract.editsLockedAt) return respondError(res, "Contract is already locked for signing", 400);
    requireInfluencerAcceptedCurrent(contract);

    markAccepted(contract, "brand", req.user?.id);
    const sync = await syncStatusFromAcceptances(contract);
    if (sync.movedToReady) await addActivity(contract, "system", "READY_TO_SIGN", { version: contract.version, nextRole: sync.nextRole });
    await addActivity(contract, "brand", "BRAND_ACCEPTED", { version: contract.version, byUserId: req.user?.id || "" });
    await contract.save();
    await ApplyCampaign.updateOne({ campaignId: String(contract.campaignId), "applicants.influencerId": String(contract.influencerId) }, { $set: { "applicants.$.statusBrand": "contractAccept" } });

    const out = await hydrateContract(contract);
    await safeSendEmail({ contract: out, templateKey: "contract_accepted_by_brand_influencer_notify", to: getEmailForRole({ contract: out, role: "influencer" }), recipientRole: "influencer", recipientName: getNameForRole({ contract: out, role: "influencer" }) });
    return respondOK(res, { message: "Brand acceptance saved", contract: out });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "BRAND_CONFIRM_ERROR");
    return respondError(res, err.message || "brandConfirm error", err.status || 500, err);
  }
};

exports.adminUpdate = async (req, res) => {
  try {
    const { contractId, adminUpdates = {}, newLegalText } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    if (!req.user?.isAdmin) return respondError(res, "Forbidden: admin only", 403);
    requireNotLocked(contract);

    const doc = (await ContractDocument.findOne({ contractId: contract.contractId })) || new ContractDocument({ contractId: contract.contractId });
    const before = doc.toObject();
    Object.assign(doc, adminUpdates);
    if (typeof newLegalText === "string" && newLegalText.trim()) {
      doc.legalTemplateVersion = Number(doc.legalTemplateVersion || 1) + 1;
      doc.legalTemplateText = newLegalText;
      doc.legalTemplateHistory = doc.legalTemplateHistory || [];
      doc.legalTemplateHistory.push({ version: doc.legalTemplateVersion, text: newLegalText, updatedAt: new Date(), updatedBy: req.user?.email || "admin" });
    }
    await doc.save();
    const editedFields = computeEditedFields(before, doc.toObject(), null);
    if (editedFields.length) {
      contract.version += 1;
      resetAcceptancesForNewVersion(contract);
      await resetSignaturesForNewVersion(contract);
      contract.status = CONTRACT_STATUS.BRAND_SENT_DRAFT;
      contract.awaitingRole = "influencer";
      await addActivity(contract, "admin", "ADMIN_UPDATED", { adminUpdates: Object.keys(adminUpdates), newLegalVersion: doc.legalTemplateVersion, editedFields });
      await contract.save();
      await safeStartReminder(contract, "influencer");
      await safeClearReminder(contract.contractId, "brand");
    }
    return respondOK(res, { message: "Admin settings updated", contract: await hydrateContract(contract) });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "ADMIN_UPDATE_ERROR");
    return respondError(res, err.message || "adminUpdate error", err.status || 500, err);
  }
};

exports.finalize = async (req, res) => {
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);
    requireInfluencerAcceptedCurrent(contract);
    requireBrandAcceptedCurrent(contract);
    if (contract.status === CONTRACT_STATUS.READY_TO_SIGN && contract.editsLockedAt) return respondOK(res, { message: "Already ready to sign", contract: await hydrateContract(contract) });
    const prev = normalizeStatus(contract);
    contract.status = CONTRACT_STATUS.READY_TO_SIGN;
    contract.editsLockedAt = new Date();
    contract.awaitingRole = (await nextUnsignedRole(contract)) || "brand";
    contract.statusFlags.awaitingCollabglam = contract.awaitingRole === "collabglam";
    await addActivity(contract, "system", "READY_TO_SIGN", { version: contract.version, prevStatus: prev, awaitingRole: contract.awaitingRole });
    await contract.save();
    const out = await hydrateContract(contract);
    await safeSendEmail({ contract: out, templateKey: "contract_ready_to_sign_both", to: getEmailForRole({ contract: out, role: "brand" }), recipientRole: "brand", recipientName: getNameForRole({ contract: out, role: "brand" }) });
    await safeSendEmail({ contract: out, templateKey: "contract_ready_to_sign_both", to: getEmailForRole({ contract: out, role: "influencer" }), recipientRole: "influencer", recipientName: getNameForRole({ contract: out, role: "influencer" }) });
    await safeClearReminder(contract.contractId, "brand");
    await safeClearReminder(contract.contractId, "influencer");
    return respondOK(res, { message: "Contract finalized for signatures", contract: out });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "FINALIZE_ERROR");
    return respondError(res, err.message || "finalize error", err.status || 500, err);
  }
};

exports.preview = async (req, res) => {
  try {
    const { contractId } = req.query;
    assertRequired(req.query, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    return renderHydratedContractPdf({ contract, res, filename: `Contract-Preview-${contractId}.pdf` });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "PREVIEW_ERROR");
    return respondError(res, err.message || "preview error", err.status || 500, err);
  }
};

exports.sign = async (req, res) => {
  try {
    const { contractId, role, name, email, effectiveDateOverride, signatureImageDataUrl, signatureImageBase64, signatureImageMime } = req.body;
    assertRequired(req.body, ["contractId", "role"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);
    const signerRole = String(role).toLowerCase();
    const allowed = requiredSigners(contract);
    if (!allowed.includes(signerRole)) return respondError(res, `Invalid role. Allowed signers: ${allowed.join(", ")}`, 400);
    requireReadyToSign(contract);
    const existing = await ContractSignature.findOne({ contractId: contract.contractId, role: signerRole, signed: true });
    if (existing) return respondError(res, "Already signed for this role", 400);
    const signatureDataUrl = parseSignatureImage({ signatureImageDataUrl, signatureImageBase64, signatureImageMime });
    await ContractSignature.upsertSigned({ contractId: contract.contractId, role: signerRole, byUserId: req.user?.id || "", name, email, signatureDataUrl, ipAddress: req.ip || "", userAgent: req.get?.("user-agent") || "" });
    if (effectiveDateOverride && req.user?.isAdmin) contract.effectiveDateOverride = new Date(effectiveDateOverride);
    await addActivity(contract, signerRole, "SIGNED", { role: signerRole, name, email });
    const nextRole = await nextUnsignedRole(contract);
    contract.awaitingRole = nextRole;
    contract.statusFlags.awaitingCollabglam = nextRole === "collabglam";
    const locked = await allRequiredSigned(contract);
    if (locked) {
      const hydrated = await hydrateContract(contract);
      const tokens = buildTokenMap(hydrated);
      const rendered = renderTemplate(hydrated.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: hydrated, templateText: rendered });
      contract.effectiveDate = contract.effectiveDateOverride || hydrated?.content?.campaign?.effectiveDate || contract.requestedEffectiveDate || nowInContractTz(hydrated);
      contract.effectiveDateTimezone = tzOr(hydrated);
      contract.lockedAt = new Date();
      contract.status = CONTRACT_STATUS.CONTRACT_SIGNED;
      contract.awaitingRole = null;
      await ContractDocument.findOneAndUpdate({ contractId: contract.contractId }, { $set: { templateTokensSnapshot: tokens, renderedTextSnapshot: rendered, renderedHtmlSnapshot: html, frozenAt: new Date(), frozenByRole: signerRole } }, { upsert: true });
      await addActivity(contract, "system", "LOCKED", { allSigned: true });
    }
    await contract.save();
    await Campaign.updateOne(campaignQuery(contract.campaignId), { $set: { isContracted: 1, contractId: contract.contractId, ...(locked ? { contractLockedAt: contract.lockedAt || new Date() } : {}) } });
    await safeClearReminder(contract.contractId, signerRole);
    if (!locked && nextRole) await safeStartReminder(contract, nextRole);
    if (locked) {
      await safeClearReminder(contract.contractId, "brand");
      await safeClearReminder(contract.contractId, "influencer");
      await safeClearReminder(contract.contractId, "collabglam");
    }
    return respondOK(res, { message: locked ? "Signed & locked" : "Signature recorded", contract: await hydrateContract(contract) });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "SIGN_ERROR");
    return respondError(res, err.message || "sign error", err.status || 500, err);
  }
};

async function updateContractFields({ req, res, actorRole, allowedPaths, updates, requestedEffectiveDate, requestedEffectiveDateTimezone }) {
  const { contractId } = req.body;
  assertRequired(req.body, ["contractId"]);
  const contract = await findContract(contractId);
  if (!contract) return respondError(res, "Contract not found", 404);
  requireNotLocked(contract);
  if (contract.isFinalUpdate) return respondError(res, "Contract has been finalized; further edits are not allowed.", 400);
  if (contract.editsLockedAt) return respondError(res, "Contract is locked for signing; edits are disabled", 400);

  const hydrated = await hydrateContract(contract);
  const before = { content: hydrated.content || {} };
  const working = { content: JSON.parse(JSON.stringify(hydrated.content || {})) };
  const changedPaths = applyAllowedDeepUpdates(working, updates, allowedPaths);

  if (requestedEffectiveDate) {
    const builtDate = buildRequestedEffectiveDate(requestedEffectiveDate, requestedEffectiveDateTimezone || contract.requestedEffectiveDateTimezone || DEFAULT_TZ);
    contract.requestedEffectiveDate = builtDate;
    contract.requestedEffectiveDateTimezone = requestedEffectiveDateTimezone || contract.requestedEffectiveDateTimezone || DEFAULT_TZ;
    working.content.campaign = working.content.campaign || {};
    working.content.campaign.effectiveDate = builtDate;
  }

  const editedFields = computeEditedFields(before, { content: working.content }, ["content"]);
  if (editedFields.length || changedPaths.length) {
    contract.version += 1;
    resetAcceptancesForNewVersion(contract);
    await resetSignaturesForNewVersion(contract);
    contract.status = actorRole === "brand" ? CONTRACT_STATUS.BRAND_EDITED : CONTRACT_STATUS.INFLUENCER_EDITED;
    contract.awaitingRole = actorRole === "brand" ? "influencer" : "brand";
    contract.lastSentAt = new Date();
    await addActivity(contract, actorRole, actorRole === "brand" ? "BRAND_EDITED" : "INFLUENCER_EDITED", { editedFields: editedFields.length ? editedFields : changedPaths, byUserId: req.user?.id || "" }, before);
  }

  contract.paymentType = normalizePaymentType(working.content?.campaign?.paymentType);
  contract.feeAmount = Number(working.content?.scheduleA?.commercial?.totalCampaignFee || 0);
  contract.currency = working.content?.scheduleA?.commercial?.currency || "USD";
  contract.brandName = working.content?.brand?.legalName || contract.brandName;
  contract.brandAddress = working.content?.brand?.billingAddress || contract.brandAddress;
  contract.influencerName = working.content?.influencer?.legalName || contract.influencerName;
  contract.influencerAddress = working.content?.influencer?.address || contract.influencerAddress;
  contract.influencerHandle = working.content?.influencer?.postingHandleUrl || contract.influencerHandle;

  await createOrUpdateContent({ contract, content: working.content, other: hydrated.other || {} });
  await contract.save();
  return { contract, changedPaths, editedFields };
}

exports.brandUpdateFields = async (req, res) => {
  try {
    const { brandUpdates = {}, preview = false, requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand = "", signatureId = "" } = req.body;
    if (preview) {
      const contract = await findContract(req.body.contractId);
      if (!contract) return respondError(res, "Contract not found", 404);
      const hydrated = await hydrateContract(contract);
      const tmp = JSON.parse(JSON.stringify(hydrated));
      applyAllowedDeepUpdates(tmp, brandUpdates, ALLOWED_BRAND_PATHS);
      if (requestedEffectiveDate) {
        const builtDate = buildRequestedEffectiveDate(requestedEffectiveDate, requestedEffectiveDateTimezone || tmp.requestedEffectiveDateTimezone || DEFAULT_TZ);
        tmp.requestedEffectiveDate = builtDate;
        tmp.content.campaign.effectiveDate = builtDate;
      }
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      return renderPDFWithPuppeteer({ html, res, filename: `Contract-Brand-Preview-${req.body.contractId}.pdf`, headerTitle: CONTRACT_PDF_TITLE, headerDate: tokens["Agreement.EffectiveDateTime"] || tokens["Agreement.EffectiveDateLong"] || "Pending" });
    }
    const result = await updateContractFields({ req, res, actorRole: "brand", allowedPaths: ALLOWED_BRAND_PATHS, updates: brandUpdates, requestedEffectiveDate, requestedEffectiveDateTimezone });
    if (!result) return;
    const { contract, editedFields, changedPaths } = result;
    const cleanSignatureBrand = String(signatureBrand || "").trim();
    if (cleanSignatureBrand) {
      const hydratedForSignature = await hydrateContract(contract);
      await ContractSignature.upsertSigned({
        contractId: contract.contractId,
        role: "brand",
        byUserId: req.user?.id || "",
        name:
          hydratedForSignature?.content?.brand?.brandPoc ||
          hydratedForSignature?.content?.brand?.contactPersonName ||
          hydratedForSignature?.brandName ||
          "",
        email: hydratedForSignature?.content?.brand?.noticeEmail || "",
        signatureDataUrl: cleanSignatureBrand,
        savedSignatureId: signatureId || hydratedForSignature?.content?.brand?.brandSignature || "",
        ipAddress: req.ip || "",
        userAgent: req.get?.("user-agent") || "",
      });
      await addActivity(contract, "brand", "BRAND_SIGNATURE_UPDATED", {
        savedSignatureId: signatureId || "",
      });
      await contract.save();
    }
    await safeStartReminder(contract, "influencer");
    await safeClearReminder(contract.contractId, "brand");
    return respondOK(res, { message: "Brand fields updated", contract: await hydrateContract(contract), editedFields: editedFields.length ? editedFields : changedPaths });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "BRAND_UPDATE_FIELDS_ERROR");
    return respondError(res, err.message || "brandUpdateFields error", err.status || 500, err);
  }
};

exports.influencerUpdateFields = async (req, res) => {
  try {
    const result = await updateContractFields({ req, res, actorRole: "influencer", allowedPaths: ALLOWED_INFLUENCER_PATHS, updates: req.body.influencerUpdates || {} });
    if (!result) return;
    const { contract, editedFields, changedPaths } = result;
    await safeStartReminder(contract, "brand");
    await safeClearReminder(contract.contractId, "influencer");
    return respondOK(res, { message: "Influencer fields updated", contract: await hydrateContract(contract), editedFields: editedFields.length ? editedFields : changedPaths });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INFLUENCER_UPDATE_FIELDS_ERROR");
    return respondError(res, err.message || "influencerUpdateFields error", err.status || 500, err);
  }
};

exports.getContract = async (req, res) => {
  try {
    const { brandId, influencerId, campaignId } = req.body;
    assertRequired(req.body, ["brandId", "influencerId", "campaignId"]);
    const contracts = await Contract.find({ brandId, influencerId, campaignId }).sort({ createdAt: -1 });
    return respondOK(res, { contracts: await hydrateContracts(contracts) });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "GET_CONTRACT_ERROR");
    return respondError(res, "Error fetching contracts", 500, err);
  }
};

exports.reject = async (req, res) => {
  try {
    const { contractId, influencerId, reason } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);
    if (influencerId && String(influencerId) !== String(contract.influencerId)) return respondError(res, "Forbidden", 403);
    contract.isAccepted = 0;
    contract.isRejected = 1;
    contract.status = CONTRACT_STATUS.REJECTED;
    contract.awaitingRole = null;
    contract.editsLockedAt = null;
    contract.statusFlags.isRejected = true;
    await addActivity(contract, "influencer", "REJECTED", { reason });
    await contract.save();
    await ApplyCampaign.updateOne({ campaignId: String(contract.campaignId), "applicants.influencerId": String(contract.influencerId) }, { $set: { "applicants.$.statusInfluencer": "rejected", "applicants.$.isShortlisted": 0 } });
    await Campaign.updateOne(campaignQuery(contract.campaignId), { $set: { isContracted: 0, contractId: null, isAccepted: 0 } });
    await safeClearReminder(contract.contractId, "brand");
    await safeClearReminder(contract.contractId, "influencer");
    return respondOK(res, { message: "Contract rejected", contract: await hydrateContract(contract) });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "REJECT_ERROR");
    return respondError(res, err.message || "reject error", err.status || 500, err);
  }
};

exports.resend = async (req, res) => {
  try {
    const { contractId, content: contentUpdates = {}, requestedEffectiveDate, requestedEffectiveDateTimezone, preview = false } = req.body;
    assertRequired(req.body, ["contractId"]);
    const parent = await findContract(contractId);
    if (!parent) return respondError(res, "Contract not found", 404);
    if (isLockedContract(parent)) return respondError(res, "Cannot resend a signed/locked contract", 400);
    const parentHydrated = await hydrateContract(parent);
    const campaignDoc = await Campaign.findById(parent.campaignId);
    if (!campaignDoc) return respondError(res, "Campaign not found", 404);

    const mergedContent = mergeDeep(parentHydrated.content || {}, contentUpdates || {});
    if (requestedEffectiveDate) mergedContent.campaign.effectiveDate = buildRequestedEffectiveDate(requestedEffectiveDate, requestedEffectiveDateTimezone || parent.requestedEffectiveDateTimezone || DEFAULT_TZ);

    if (preview) {
      const tmp = { ...parentHydrated, content: mergedContent, requestedEffectiveDate: mergedContent.campaign.effectiveDate || parent.requestedEffectiveDate };
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      return renderPDFWithPuppeteer({ html, res, filename: `Contract-Resend-Preview-${contractId}.pdf`, headerTitle: CONTRACT_PDF_TITLE, headerDate: tokens["Agreement.EffectiveDateTime"] || tokens["Agreement.EffectiveDateLong"] || "Pending" });
    }

    const child = await createContractRecord({ req, brandId: parent.brandId, influencerId: parent.influencerId, campaignId: parent.campaignId, campaign: campaignDoc, brandDoc: {}, influencerDoc: {}, content: mergedContent, other: parentHydrated.other || {}, admin: parentHydrated.admin || buildAdmin({ campaign: campaignDoc, requestedEffectiveDateTimezone, req }), requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand: "", resendOf: parent.contractId, resendIteration: Number(parent.resendIteration || 0) + 1 });
    parent.supersededBy = child.contractId;
    parent.resentAt = new Date();
    parent.status = CONTRACT_STATUS.SUPERSEDED;
    parent.statusFlags.isSuperseded = true;
    await addActivity(parent, "system", "RESENT", { to: child.contractId, by: req.user?.email || "system" });
    await parent.save();
    await Campaign.updateOne(campaignQuery(parent.campaignId), { $set: { isContracted: 1, contractId: child.contractId, isAccepted: 0 } });
    await safeStartReminder(child, "influencer");
    await safeClearReminder(child.contractId, "brand");
    return respondOK(res, { message: "Resent contract created", contract: await hydrateContract(child) }, 201);
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "RESEND_ERROR");
    return respondError(res, err.message || "resend error", err.status || 500, err);
  }
};

exports.initiateBulk = async (req, res) => {
  try {
    const { brandId, campaignId, influencerIds = [], content: contentInput = {}, requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand = "", signatureId = "" } = req.body;
    assertRequired(req.body, ["brandId", "campaignId"]);
    if (!Array.isArray(influencerIds) || !influencerIds.length) return respondError(res, "influencerIds is required", 400);
    const [campaign, brandDoc] = await Promise.all([Campaign.findById(campaignId), Brand.findById(brandId)]);
    if (!campaign) return respondError(res, "Campaign not found", 404);
    if (!brandDoc) return respondError(res, "Brand not found", 404);
    const admin = buildAdmin({ campaign, requestedEffectiveDateTimezone, req });
    const results = await Promise.allSettled(influencerIds.map(async (influencerId) => {
      const [influencerDoc, modashDoc] = await Promise.all([Influencer.findById(influencerId), Modash.findOne({ influencerId: String(influencerId) })]);
      if (!influencerDoc) throw new Error(`Influencer not found: ${influencerId}`);
      const resolvedHandle = modashDoc?.handle || modashDoc?.username || modashDoc?.instagramHandle || modashDoc?.instagram?.username || influencerDoc?.handle || influencerDoc?.profileUrl || "";
      const safeContentInput = JSON.parse(JSON.stringify(contentInput || {}));
      delete safeContentInput.influencer;
      if (safeContentInput?.scheduleA?.deliverables) safeContentInput.scheduleA.deliverables = safeContentInput.scheduleA.deliverables.map((row, index) => ({ ...row, srNo: Number(row?.srNo ?? index + 1), platformHandle: resolvedHandle || row?.platformHandle || "" }));
      const content = createDefaultContent({ campaign, brandDoc, influencerDoc: { ...(influencerDoc.toObject ? influencerDoc.toObject() : influencerDoc), handle: resolvedHandle }, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, contentInput: safeContentInput });
      content.influencer.postingHandleUrl = resolvedHandle;
      const other = buildOtherProfile({ brandDoc, influencerDoc, resolvedHandle });
      const contract = await createContractRecord({ req, brandId, influencerId, campaignId, campaign, brandDoc, influencerDoc, content, other, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand, signatureId });
      await syncApplyCampaignAfterSend(contract, false);
      return await hydrateContract(contract);
    }));
    const created = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const failed = results.filter((r) => r.status === "rejected").map((r) => r.reason?.message || "Unknown error");
    await Campaign.updateOne(campaignQuery(campaignId), { $set: { isContracted: created.length ? 1 : 0 } });
    return respondOK(res, { message: "Bulk initiate completed", created, failed }, created.length ? 201 : 400);
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INITIATE_BULK_ERROR");
    return respondError(res, err.message || "initiateBulk error", err.status || 500, err);
  }
};

exports.listTimezones = async (_req, res) => respondOK(res, { timezones: loadTimezones() });
exports.getTimezone = async (req, res) => {
  const tz = findTimezoneByValueOrUTC(req.params?.key || req.query?.key || req.body?.key);
  return tz ? respondOK(res, { timezone: tz }) : respondError(res, "Timezone not found", 404);
};
exports.listCurrencies = async (_req, res) => respondOK(res, { currencies: loadCurrencies() });
exports.getCurrency = async (req, res) => {
  const key = String(req.params?.key || req.query?.key || req.body?.key || "").toUpperCase();
  const currencies = loadCurrencies();
  const currency = currencies[key] || (Array.isArray(currencies) ? currencies.find((c) => String(c.code || c.value || "").toUpperCase() === key) : null);
  return currency ? respondOK(res, { currency }) : respondError(res, "Currency not found", 404);
};

async function uploadSavedSignature({ req, res, role }) {
  const ownerField = role === "brand" ? "brandId" : "influencerId";
  const Model = role === "brand" ? BrandSignature : InfluencerSignature;
  const ownerId = req.body[ownerField];
  let signature = String(req.body.signature || req.body.signatureDataUrl || "").trim();
  if (!signature && req.file?.buffer) {
    const mime = req.file.mimetype || "image/png";
    signature = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
  }
  assertRequired({ [ownerField]: ownerId, signature }, [ownerField, "signature"]);
  await Model.deactivateForOwner(ownerId);
  const row = await Model.create({ [ownerField]: ownerId, signature, originalName: req.body.originalName || "", createdBy: req.user?.id || "", updatedBy: req.user?.id || "" });
  return respondOK(res, { message: `${role} signature saved`, signature: row }, 201);
}

exports.uploadBrandSignature = async (req, res) => {
  try { return await uploadSavedSignature({ req, res, role: "brand" }); }
  catch (err) { await saveErrorLog(req, err, err?.status || 500, "UPLOAD_BRAND_SIGNATURE_ERROR"); return respondError(res, err.message, err.status || 500, err); }
};
exports.getBrandSignature = async (req, res) => {
  try {
    const brandId = req.params?.brandId || req.query?.brandId || req.body?.brandId;
    assertRequired({ brandId }, ["brandId"]);
    const signature = await BrandSignature.findActive(brandId);
    if (!signature) return respondError(res, "Active brand signature not found", 404);
    return respondOK(res, signature.toObject ? signature.toObject() : signature);
  } catch (err) { await saveErrorLog(req, err, err?.status || 500, "GET_BRAND_SIGNATURE_ERROR"); return respondError(res, err.message, err.status || 500, err); }
};
exports.uploadInfluencerSignature = async (req, res) => {
  try { return await uploadSavedSignature({ req, res, role: "influencer" }); }
  catch (err) { await saveErrorLog(req, err, err?.status || 500, "UPLOAD_INFLUENCER_SIGNATURE_ERROR"); return respondError(res, err.message, err.status || 500, err); }
};
exports.getInfluencerSignature = async (req, res) => {
  try {
    const influencerId = req.params?.influencerId || req.query?.influencerId || req.body?.influencerId;
    assertRequired({ influencerId }, ["influencerId"]);
    const signature = await InfluencerSignature.findActive(influencerId);
    if (!signature) return respondError(res, "Active influencer signature not found", 404);
    return respondOK(res, signature.toObject ? signature.toObject() : signature);
  } catch (err) { await saveErrorLog(req, err, err?.status || 500, "GET_INFLUENCER_SIGNATURE_ERROR"); return respondError(res, err.message, err.status || 500, err); }
};

exports.viewContractPdf = async (req, res) => {
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    return renderHydratedContractPdf({ contract, res, filename: `Contract-${contract.contractId}.pdf` });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "VIEW_CONTRACT_PDF_ERROR");
    return respondError(res, err.message || "viewContractPdf error", err.status || 500, err);
  }
};

async function getLatestContractByInfluencerAndCampaign(req) {
  const influencerId = req.params?.influencerId || req.query?.influencerId || req.body?.influencerId;
  const campaignId = req.params?.campaignId || req.query?.campaignId || req.body?.campaignId;
  assertRequired({ influencerId, campaignId }, ["influencerId", "campaignId"]);
  return Contract.findOne({ influencerId: String(influencerId), campaignId: String(campaignId) }).sort({ createdAt: -1 });
}

exports.getDeliverablesByInfluencerAndCampaign = async (req, res) => {
  try {
    const contract = await getLatestContractByInfluencerAndCampaign(req);
    if (!contract) return respondError(res, "Contract not found", 404);
    const hydrated = await hydrateContract(contract);
    return respondOK(res, { deliverables: hydrated.content?.scheduleA?.deliverables || [], contract: hydrated });
  } catch (err) { await saveErrorLog(req, err, err?.status || 500, "GET_DELIVERABLES_ERROR"); return respondError(res, err.message || "Error fetching deliverables", err.status || 500, err); }
};

exports.getMilestonesByInfluencerAndCampaign = async (req, res) => {
  try {
    const contract = await getLatestContractByInfluencerAndCampaign(req);
    if (!contract) return respondError(res, "Contract not found", 404);
    const hydrated = await hydrateContract(contract);
    return respondOK(res, { milestones: hydrated.content?.scheduleA?.commercial?.milestones || [], contract: hydrated });
  } catch (err) { await saveErrorLog(req, err, err?.status || 500, "GET_MILESTONES_ERROR"); return respondError(res, err.message || "Error fetching milestones", err.status || 500, err); }
};

exports.getScheduleADataByInfluencerAndCampaign = async (req, res) => {
  try {
    const contract = await getLatestContractByInfluencerAndCampaign(req);
    if (!contract) return respondError(res, "Contract not found", 404);
    const hydrated = await hydrateContract(contract);
    return respondOK(res, { scheduleA: hydrated.content?.scheduleA || {}, contract: hydrated });
  } catch (err) { await saveErrorLog(req, err, err?.status || 500, "GET_SCHEDULE_A_ERROR"); return respondError(res, err.message || "Error fetching Schedule A", err.status || 500, err); }
};

exports.influencerManage = async (req, res) => {
  try {
    const { contractId } = req.params;
    if (!contractId) return respondError(res, "contractId is required", 400);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    const modashData = await Modash.findOne({ influencerId: contract.influencerId });
    if (!modashData) return respondError(res, "Matching influencer not found in Modash", 404);
    return respondOK(res, { message: "Influencer data fetched successfully", contract: await hydrateContract(contract), modashData });
  } catch (error) {
    await saveErrorLog(req, error, error?.status || error?.statusCode || 500, "INFLUENCER_MANAGE_ERROR");
    return respondError(res, "Failed to fetch influencer data", 500, error);
  }
};

exports.getContractDetails = async (req, res) => {
  try {
    const contractId = req.params.contractId || req.query.contractId || req.body.contractId;
    if (!contractId) return respondError(res, "contractId is required", 400);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    return respondOK(res, { message: "Contract details fetched successfully", contract: await hydrateContract(contract) });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "GET_CONTRACT_DETAILS_ERROR");
    return respondError(res, "Error fetching contract details", 500, err);
  }
};