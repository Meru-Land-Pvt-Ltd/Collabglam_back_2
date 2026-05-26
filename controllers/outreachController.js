const axios = require("axios");
const { parse } = require("csv-parse/sync");

const ProspectBrand = require("../models/prospectBrand");
const OutreachCampaign = require("../models/outreachCampaign");
const OutreachMailboxAssignment = require("../models/outreachMailboxAssignment");
const { AdminModel, ROLES } = require("../models/master");
const {
  PROSPECT_STAGE,
  OUTREACH_CAMPAIGN_STATUS,
  OWNER_ROLE,
} = require("../constants/outreach");
const { ensureRole } = require("../utils/outreachGuards");
const OutreachTemplate = require("../models/OutreachTemplate");
const OutreachSubsequence = require("../models/OutreachSubsequence");
const instantlyService = require("../services/instantlyService");
const { createAndEmit } = require("../utils/notifier");
const saveErrorLog = require("../services/errorLog.service");

const SDR_ROLE = ROLES?.SDR || "sdr";
const RH_ROLE = ROLES?.REVENUE_HEAD || "revenue_head";
const IME_ROLE = ROLES?.IME || "ime";

function readExternalId(value) {
  return String(value?.id || value?._id || value?.data?.id || "").trim();
}

function uniqueIds(values = []) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}


function getActorPayloadFromReq(req = {}) {
  const admin = req?.admin || req?.user || {};
  const actorAdminId = String(admin.adminId || admin._id || "").trim();

  return {
    actorAdminId: actorAdminId || null,
    actorName: String(admin.name || "").trim(),
    actorEmail: String(admin.email || "").trim().toLowerCase(),
    actorRole: String(admin.role || "").trim().toLowerCase(),
  };
}

async function notifySafely(context, req, payload) {
  try {
    return await createAndEmit({
      ...getActorPayloadFromReq(req),
      ...(payload || {}),
    });
  } catch (error) {
    console.warn(`${context} notification failed:`, error?.message || error);
    return null;
  }
}

function getOutreachCampaignAdminPath(campaignId = "") {
  const id = String(campaignId || "").trim();
  return id ? `/admin/crm/campaigns/${encodeURIComponent(id)}` : "/admin/crm/campaigns";
}

function getOutreachCampaignNotificationRecipients(campaign = {}) {
  return uniqueIds([
    campaign?.createdByAdminId,
    campaign?.sdrId?._id || campaign?.sdrId,
    campaign?.RHId?._id || campaign?.RHId,
    campaign?.IMEId?._id || campaign?.IMEId,
  ]);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeFlowType(value) {
  return String(value || "").trim().toLowerCase() === "ime_influencer"
    ? "ime_influencer"
    : "standard_brand";
}

function isImeFlow(campaignOrFlowType) {
  const flowType =
    typeof campaignOrFlowType === "string"
      ? campaignOrFlowType
      : campaignOrFlowType?.flowType;
  return normalizeFlowType(flowType) === "ime_influencer";
}

function getAxiosErrorPayload(error, fallbackMessage = "Internal error") {
  return {
    statusCode: error?.response?.status || error?.statusCode || 500,
    message:
      error?.response?.data?.message ||
      error?.response?.data?.error ||
      error?.message ||
      fallbackMessage,
    details: error?.response?.data || null,
  };
}

function formatDateOnly(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function buildDefaultCampaignSchedule() {
  const timezone = process.env.INSTANTLY_DEFAULT_TIMEZONE || "Asia/Kolkata";
  const today = new Date();

  return {
    timezone,
    startDate: formatDateOnly(today),
    endDate: formatDateOnly(addDays(today, 365)),
    windows: [
      {
        name: "Default Weekday Schedule",
        from: "10:00",
        to: "18:00",
        days: {
          0: false,
          1: true,
          2: true,
          3: true,
          4: true,
          5: true,
          6: false,
        },
      },
    ],
  };
}

function buildDefaultSendingOptions() {
  return {
    dailyLimit: 100,
    dailyMaxLeads: 100,
    emailGap: 10,
    randomWaitMax: 10,
    stopOnReply: true,
    stopOnAutoReply: false,
    linkTracking: true,
    openTracking: true,
    textOnly: false,
    firstEmailTextOnly: false,
    isEvergreen: false,
    prioritizeNewLeads: false,
    matchLeadEsp: false,
    stopForCompany: true,
    insertUnsubscribeHeader: false,
    allowRiskyContacts: false,
    disableBounceProtect: false,
    ccList: [],
    bccList: [],
  };
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeNumber(value, fallback, min = 0) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= min) return parsed;
  return fallback;
}

function normalizeCampaignSchedule(schedule = {}, fallback = buildDefaultCampaignSchedule()) {
  const base = fallback || buildDefaultCampaignSchedule();
  const windowsInput = Array.isArray(schedule.windows) && schedule.windows.length
    ? schedule.windows
    : Array.isArray(schedule.schedules) && schedule.schedules.length
      ? schedule.schedules.map((item) => ({
        name: item?.name,
        from: item?.from || item?.timing?.from,
        to: item?.to || item?.timing?.to,
        days: item?.days,
      }))
      : base.windows;

  const windows = windowsInput
    .map((item, index) => ({
      name: String(item?.name || `Schedule ${index + 1}`).trim(),
      from: String(item?.from || item?.timing?.from || "10:00").trim(),
      to: String(item?.to || item?.timing?.to || "18:00").trim(),
      days: {
        0: normalizeBoolean(item?.days?.[0], false),
        1: normalizeBoolean(item?.days?.[1], true),
        2: normalizeBoolean(item?.days?.[2], true),
        3: normalizeBoolean(item?.days?.[3], true),
        4: normalizeBoolean(item?.days?.[4], true),
        5: normalizeBoolean(item?.days?.[5], true),
        6: normalizeBoolean(item?.days?.[6], false),
      },
    }))
    .filter((item) => item.from && item.to);

  return {
    timezone: String(
      schedule.timezone ||
      base.timezone ||
      process.env.INSTANTLY_DEFAULT_TIMEZONE ||
      "Asia/Kolkata"
    ).trim(),
    startDate: String(
      schedule.startDate ||
      schedule.start_date ||
      base.startDate ||
      formatDateOnly(new Date())
    ).trim(),
    endDate: String(
      schedule.endDate ||
      schedule.end_date ||
      base.endDate ||
      formatDateOnly(addDays(new Date(), 365))
    ).trim(),
    windows: windows.length ? windows : base.windows,
  };
}

function normalizeSequenceStep(step = {}, index = 0) {
  const fallback = buildDefaultSequence()[0];
  const variantsInput =
    Array.isArray(step.variants) && step.variants.length
      ? step.variants
      : [
        {
          subject: step.subject || fallback.variants[0].subject,
          body: step.body || fallback.variants[0].body,
        },
      ];

  return {
    stepOrder: normalizeNumber(step.stepOrder, index + 1, 1),
    type: String(step.type || "email").trim().toLowerCase(),
    delay: normalizeNumber(step.delay, fallback.delay, 0),
    delayUnit: String(
      step.delayUnit ||
      step.delay_unit ||
      fallback.delayUnit ||
      fallback.delay_unit ||
      "days"
    )
      .trim()
      .toLowerCase(),
    preDelay: normalizeNumber(step.preDelay, fallback.preDelay, 0),
    preDelayUnit: String(
      step.preDelayUnit ||
      step.pre_delay_unit ||
      fallback.preDelayUnit ||
      fallback.pre_delay_unit ||
      "days"
    )
      .trim()
      .toLowerCase(),
    variants: variantsInput
      .map((variant) => {
        const body = String(
          variant?.body ||
          variant?.bodyHtml ||
          variant?.body_html ||
          variant?.bodyText ||
          variant?.body_text ||
          ""
        ).trim();

        return {
          subject: String(variant?.subject || "").trim(),
          body,
          preheaderText: String(variant?.preheaderText || variant?.preheader_text || "").trim(),
          signatureHtml: String(variant?.signatureHtml || variant?.signature_html || "").trim(),
        };
      })
      .filter((variant) => variant.subject || variant.body),
  };
}

function normalizeSendingOptions(options = {}, fallback = buildDefaultSendingOptions()) {
  const base = fallback || buildDefaultSendingOptions();

  return {
    dailyLimit: normalizeNumber(options.dailyLimit ?? options.daily_limit, base.dailyLimit, 1),
    dailyMaxLeads: normalizeNumber(options.dailyMaxLeads ?? options.daily_max_leads, base.dailyMaxLeads, 1),
    emailGap: normalizeNumber(options.emailGap ?? options.email_gap, base.emailGap, 0),
    randomWaitMax: normalizeNumber(options.randomWaitMax ?? options.random_wait_max, base.randomWaitMax, 0),
    stopOnReply: normalizeBoolean(options.stopOnReply ?? options.stop_on_reply, base.stopOnReply),
    stopOnAutoReply: normalizeBoolean(options.stopOnAutoReply ?? options.stop_on_auto_reply, base.stopOnAutoReply),
    linkTracking: normalizeBoolean(options.linkTracking ?? options.link_tracking, base.linkTracking),
    openTracking: normalizeBoolean(options.openTracking ?? options.open_tracking, base.openTracking),
    textOnly: normalizeBoolean(options.textOnly ?? options.text_only, base.textOnly),
    firstEmailTextOnly: normalizeBoolean(
      options.firstEmailTextOnly ?? options.first_email_text_only,
      base.firstEmailTextOnly
    ),
    isEvergreen: normalizeBoolean(options.isEvergreen ?? options.is_evergreen, base.isEvergreen),
    prioritizeNewLeads: normalizeBoolean(
      options.prioritizeNewLeads ?? options.prioritize_new_leads,
      base.prioritizeNewLeads
    ),
    matchLeadEsp: normalizeBoolean(options.matchLeadEsp ?? options.match_lead_esp, base.matchLeadEsp),
    stopForCompany: normalizeBoolean(options.stopForCompany ?? options.stop_for_company, base.stopForCompany),
    insertUnsubscribeHeader: normalizeBoolean(
      options.insertUnsubscribeHeader ?? options.insert_unsubscribe_header,
      base.insertUnsubscribeHeader
    ),
    allowRiskyContacts: normalizeBoolean(
      options.allowRiskyContacts ?? options.allow_risky_contacts,
      base.allowRiskyContacts
    ),
    disableBounceProtect: normalizeBoolean(
      options.disableBounceProtect ?? options.disable_bounce_protect,
      base.disableBounceProtect
    ),
    ccList: Array.isArray(options.ccList ?? options.cc_list)
      ? [...new Set((options.ccList ?? options.cc_list).map((item) => normalizeEmail(item)).filter(Boolean))]
      : base.ccList || [],
    bccList: Array.isArray(options.bccList ?? options.bcc_list)
      ? [...new Set((options.bccList ?? options.bcc_list).map((item) => normalizeEmail(item)).filter(Boolean))]
      : base.bccList || [],
  };
}

function normalizeCampaignConfiguration(input = {}, fallback = {}) {
  const base = fallback || {};
  const baseSchedule = normalizeCampaignSchedule(base.schedule || base.campaign_schedule || {});
  const baseSequences = normalizeCampaignSequences(base.sequences || []);
  const baseSendingOptions = normalizeSendingOptions(base.sendingOptions || base.sending_options || {});

  return {
    schedule: normalizeCampaignSchedule(
      input.schedule || input.campaignSchedule || input.campaign_schedule || {},
      baseSchedule
    ),
    sequences: normalizeCampaignSequences(input.sequences || [], baseSequences),
    sendingOptions: normalizeSendingOptions(
      input.sendingOptions || input.sending_options || {},
      baseSendingOptions
    ),
  };
}

function buildInstantlyCampaignSchedule(schedule = {}) {
  const normalized = normalizeCampaignSchedule(schedule);

  return {
    start_date: normalized.startDate,
    end_date: normalized.endDate,
    schedules: normalized.windows.map((windowItem) => ({
      name: windowItem.name,
      timing: {
        from: windowItem.from,
        to: windowItem.to,
      },
      days: windowItem.days,
      timezone: normalized.timezone,
    })),
  };
}

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToSequencePlainText(value = "") {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|tr|h1|h2|h3|h4|h5|h6)>/gi, "\n")
      .replace(
        /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gi,
        (_, href, text) => {
          const label = String(text || "").replace(/<[^>]*>/g, "").trim();
          const url = String(href || "").trim();

          if (!url) return label;
          if (!label || label === url) return url;

          return `${label}: ${url}`;
        }
      )
      .replace(/<[^>]*>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeSequenceHtml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sequenceTextToHtml(value = "") {
  return htmlToSequencePlainText(value)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeSequenceHtml(paragraph).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

function normalizeSequenceBodyForInstantly(value = "") {
  const plainText = htmlToSequencePlainText(value);

  if (!plainText) return "";

  /*
    Keep campaign sequence payload plain text by default.
    Some Instantly workspaces save subject but blank the body when rich HTML is sent in
    sequences[].steps[].variants[].body.
  */
  return plainText;
}

function buildInstantlySequences(sequences = [], templateVariables = []) {
  const normalized = normalizeCampaignSequences(sequences);

  return [
    {
      steps: normalized.map((step, stepIndex) => ({
        type: "email",
        delay: Number(step.delay || 0),
        delay_unit: String(step.delayUnit || step.delay_unit || "days")
          .trim()
          .toLowerCase(),
        pre_delay: Number(step.preDelay || step.pre_delay || 0),
        pre_delay_unit: String(step.preDelayUnit || step.pre_delay_unit || "days")
          .trim()
          .toLowerCase(),

        variants: step.variants.map((variant, variantIndex) => {
          const subject = normalizeTemplateVariablesInContent(String(variant.subject || "").trim(), templateVariables);

          const rawBodySource = String(
            variant.body ||
              variant.bodyHtml ||
              variant.body_html ||
              variant.bodyText ||
              variant.body_text ||
              ""
          ).trim();

          const rawBody = normalizeTemplateVariablesInContent(rawBodySource, templateVariables).trim();

          const body = normalizeSequenceBodyForInstantly(rawBody);
          const bodyText = htmlToSequencePlainText(body);

          console.log("Instantly sequence payload debug", {
            step: stepIndex + 1,
            variant: variantIndex + 1,
            subject,
            rawBodyLength: rawBodySource.length,
            bodyLength: body.length,
            bodyTextLength: bodyText.length,
            bodyPreview: bodyText.slice(0, 160),
            bodyContainsHtml: /<\/?[a-z][\s\S]*>/i.test(body),
          });

          if (!bodyText) {
            const error = new Error(
              `Step ${stepIndex + 1}, Variant ${variantIndex + 1}: email body is empty before Instantly sync`
            );
            error.statusCode = 400;
            throw error;
          }

          return {
            subject,
            body,
            v_disabled: false,
          };
        }),
      })),
    },
  ];
}

function getCampaignConfigurationFromDocument(campaign) {
  return normalizeCampaignConfiguration(campaign?.configuration || {});
}

function buildCampaignCreatePayload({
  campaignName,
  senderEmails,
  configuration,
  rawCampaignPayload,
  templateVariables = [],
}) {
  const normalizedConfiguration = normalizeCampaignConfiguration(configuration || {});
  const sendingOptions = normalizeSendingOptions(normalizedConfiguration.sendingOptions);
  const rawPayload = { ...(rawCampaignPayload || {}) };

  delete rawPayload.id;
  delete rawPayload._id;
  delete rawPayload.status;
  delete rawPayload.timestamp_created;
  delete rawPayload.timestamp_updated;
  delete rawPayload.name;
  delete rawPayload.email_list;
  delete rawPayload.campaign_schedule;
  delete rawPayload.sequences;

  return {
    ...rawPayload,
    name: campaignName,
    campaign_schedule: buildInstantlyCampaignSchedule(normalizedConfiguration.schedule),
    sequences: buildInstantlySequences(normalizedConfiguration.sequences, templateVariables),
    email_list: Array.isArray(senderEmails) ? senderEmails : [],
    daily_limit: sendingOptions.dailyLimit,
    daily_max_leads: sendingOptions.dailyMaxLeads,
    email_gap: sendingOptions.emailGap,
    random_wait_max: sendingOptions.randomWaitMax,
    stop_on_reply: sendingOptions.stopOnReply,
    stop_on_auto_reply: sendingOptions.stopOnAutoReply,
    link_tracking: sendingOptions.linkTracking,
    open_tracking: sendingOptions.openTracking,

    // Force rich-text related flags off while sequence body delivery is being stabilized.
    // The body is already normalized above.
    text_only: false,
    first_email_text_only: false,

    is_evergreen: sendingOptions.isEvergreen,
    prioritize_new_leads: sendingOptions.prioritizeNewLeads,
    match_lead_esp: sendingOptions.matchLeadEsp,
    stop_for_company: sendingOptions.stopForCompany,
    insert_unsubscribe_header: sendingOptions.insertUnsubscribeHeader,
    allow_risky_contacts: sendingOptions.allowRiskyContacts,
    disable_bounce_protect: sendingOptions.disableBounceProtect,
    cc_list: Array.isArray(sendingOptions.ccList) ? sendingOptions.ccList : [],
    bcc_list: Array.isArray(sendingOptions.bccList) ? sendingOptions.bccList : [],
  };
}

async function getActiveSdrSenders(sdrId) {
  return OutreachMailboxAssignment.find({
    adminId: sdrId,
    role: OWNER_ROLE.SDR,
    isActive: true,
  })
    .sort({ isPrimary: -1, assignedAt: 1, createdAt: 1 })
    .lean();
}

async function getActiveRhMailbox(rhId) {
  if (!rhId) return null;

  return OutreachMailboxAssignment.findOne({
    adminId: rhId,
    role: OWNER_ROLE.REVENUE_HEAD,
    isActive: true,
  }).lean();
}

function resolveSelectedAccountEmails(
  senderAssignments = [],
  requestedEmails = [],
  fallbackEmails = []
) {
  const availableEmails = senderAssignments
    .map((item) => String(item?.email || "").trim().toLowerCase())
    .filter(Boolean);

  const normalizedRequested = Array.isArray(requestedEmails)
    ? [...new Set(requestedEmails.map((item) => normalizeEmail(item)).filter(Boolean))]
    : [];

  const normalizedFallback = Array.isArray(fallbackEmails)
    ? [...new Set(fallbackEmails.map((item) => normalizeEmail(item)).filter(Boolean))]
    : [];

  const requestedSubset = normalizedRequested.filter((email) => availableEmails.includes(email));
  if (requestedSubset.length) return requestedSubset;

  const fallbackSubset = normalizedFallback.filter((email) => availableEmails.includes(email));
  if (fallbackSubset.length) return fallbackSubset;

  return availableEmails;
}

function resolveSelectedSenderEmail(
  senderAssignments = [],
  requestedEmail = "",
  fallbackEmail = "",
  selectedEmails = []
) {
  const allowedEmails = Array.isArray(selectedEmails) && selectedEmails.length
    ? selectedEmails.map((item) => normalizeEmail(item)).filter(Boolean)
    : resolveSelectedAccountEmails(senderAssignments);

  const requested = normalizeEmail(requestedEmail);
  const fallback = normalizeEmail(fallbackEmail);

  if (requested && allowedEmails.includes(requested)) return requested;
  if (fallback && allowedEmails.includes(fallback)) return fallback;

  const primary = senderAssignments.find(
    (item) =>
      item?.isPrimary &&
      allowedEmails.includes(normalizeEmail(item?.email))
  );

  if (primary?.email) return normalizeEmail(primary.email);

  return allowedEmails[0] || "";
}

async function getActiveImeSenders(imeId) {
  if (!imeId) return [];

  return OutreachMailboxAssignment.find({
    adminId: imeId,
    role: OWNER_ROLE.IME,
    isActive: true,
  })
    .sort({ isPrimary: -1, assignedAt: 1, createdAt: 1 })
    .lean();
}

async function getAvailableSenderEmailsForCampaign(campaign) {
  if (!campaign) return [];

  if (isImeFlow(campaign)) {
    const imeAssignments = await getActiveImeSenders(campaign.IMEId);
    return imeAssignments.map((item) => normalizeEmail(item.email));
  }

  const sdrAssignments = await getActiveSdrSenders(campaign.sdrId);
  return sdrAssignments.map((item) => normalizeEmail(item.email));
}

async function getStandardCreateContext(req) {
  if (req.admin.role === "sdr") {
    const sdr = await AdminModel.findOne({
      _id: req.admin.adminId,
      role: SDR_ROLE,
      status: "active",
    }).select("_id parentAdmin name email");

    if (!sdr) {
      const error = new Error("SDR account not found or inactive");
      error.statusCode = 404;
      throw error;
    }

    if (!sdr.parentAdmin) {
      const error = new Error("This SDR is not linked to any Revenue Head");
      error.statusCode = 400;
      throw error;
    }

    const rh = await AdminModel.findOne({
      _id: sdr.parentAdmin,
      role: RH_ROLE,
      status: "active",
    }).select("_id name email");

    if (!rh) {
      const error = new Error("Parent Revenue Head not found or inactive");
      error.statusCode = 400;
      throw error;
    }

    return { sdr, rh };
  }

  const requestedSdrId = String(req.body?.sdrId || "").trim();

  if (!requestedSdrId) {
    const error = new Error("sdrId is required when creating a standard campaign");
    error.statusCode = 400;
    throw error;
  }

  const sdr = await AdminModel.findOne({
    _id: requestedSdrId,
    role: SDR_ROLE,
    status: "active",
  }).select("_id parentAdmin name email");

  if (!sdr) {
    const error = new Error("Selected SDR not found or inactive");
    error.statusCode = 404;
    throw error;
  }

  if (!sdr.parentAdmin) {
    const error = new Error("Selected SDR is not linked to any Revenue Head");
    error.statusCode = 400;
    throw error;
  }

  const rh = await AdminModel.findOne({
    _id: sdr.parentAdmin,
    role: RH_ROLE,
    status: "active",
  }).select("_id name email");

  if (!rh) {
    const error = new Error("Parent Revenue Head not found or inactive");
    error.statusCode = 400;
    throw error;
  }

  return { sdr, rh };
}

async function getImeCreateContext(req) {
  if (req.admin.role === "ime") {
    const ime = await AdminModel.findOne({
      _id: req.admin.adminId,
      role: IME_ROLE,
      status: "active",
    }).select("_id name email");

    if (!ime) {
      const error = new Error("IME account not found or inactive");
      error.statusCode = 404;
      throw error;
    }

    return { ime };
  }

  const requestedImeId = String(req.body?.imeId || "").trim();

  if (!requestedImeId) {
    const error = new Error("imeId is required when creating an IME campaign");
    error.statusCode = 400;
    throw error;
  }

  const ime = await AdminModel.findOne({
    _id: requestedImeId,
    role: IME_ROLE,
    status: "active",
  }).select("_id name email");

  if (!ime) {
    const error = new Error("Selected IME not found or inactive");
    error.statusCode = 404;
    throw error;
  }

  return { ime };
}

async function getManagedCampaign(req, campaignId) {
  const campaign = await OutreachCampaign.findById(campaignId);

  if (!campaign) {
    const error = new Error("Campaign not found");
    error.statusCode = 404;
    throw error;
  }

  const adminId = String(req.admin?.adminId || req.admin?._id || "");
  const role = String(req.admin?.role || "").trim().toLowerCase();

  if (role === "super_admin") return campaign;

  if (role === "sdr" && String(campaign.sdrId) === adminId) {
    return campaign;
  }

  if (role === "ime" && String(campaign.IMEId) === adminId) {
    return campaign;
  }

  if (role === "revenue_head" || role === "rh") {
    const isOwnedRh = String(campaign.RHId) === adminId;
    const isImeCampaign =
      String(campaign.flowType || "").trim().toLowerCase() === "ime_influencer";

    if (isOwnedRh || isImeCampaign) {
      return campaign;
    }
  }

  const error = new Error("You do not own this campaign");
  error.statusCode = 403;
  throw error;
}

function idsEqual(a, b) {
  return String(a || "") === String(b || "");
}

function getAdminIdFromDoc(value) {
  return String(value?._id || value || "");
}

async function getAccessibleCampaign(req, campaignId) {
  const campaign = await OutreachCampaign.findById(campaignId)
    .populate("sdrId", "name email role parentAdmin rootAdmin")
    .populate("RHId", "name email role parentAdmin rootAdmin")
    .populate("IMEId", "name email role parentAdmin rootAdmin");

  if (!campaign) {
    const error = new Error("Campaign not found");
    error.statusCode = 404;
    throw error;
  }

  const adminId = String(
    req.admin?.adminId ||
    req.admin?._id ||
    req.admin?.id ||
    ""
  ).trim();

  const role = String(req.admin?.role || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (!adminId) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }

  if (role === "super_admin" || role === "superadmin") {
    return campaign;
  }

  const campaignSdrId = getAdminIdFromDoc(campaign.sdrId);
  const campaignRhId = getAdminIdFromDoc(campaign.RHId);
  const campaignImeId = getAdminIdFromDoc(campaign.IMEId);

  const sdrParentAdmin = getAdminIdFromDoc(campaign.sdrId?.parentAdmin);
  const sdrRootAdmin = getAdminIdFromDoc(campaign.sdrId?.rootAdmin);

  const imeParentAdmin = getAdminIdFromDoc(campaign.IMEId?.parentAdmin);
  const imeRootAdmin = getAdminIdFromDoc(campaign.IMEId?.rootAdmin);

  if (role === "sdr" && idsEqual(campaignSdrId, adminId)) {
    return campaign;
  }

  if (role === "ime" && idsEqual(campaignImeId, adminId)) {
    return campaign;
  }

  if (role === "revenue_head" || role === "rh") {
    const isDirectRh = idsEqual(campaignRhId, adminId);

    const isParentOfSdr =
      idsEqual(sdrParentAdmin, adminId) ||
      idsEqual(sdrRootAdmin, adminId);

    const isParentOfIme =
      idsEqual(imeParentAdmin, adminId) ||
      idsEqual(imeRootAdmin, adminId);

    const isImeCampaign =
      String(campaign.flowType || "").trim().toLowerCase() === "ime_influencer";

    if (isDirectRh || isParentOfSdr || isParentOfIme || isImeCampaign) {
      return campaign;
    }
  }

  if (role === "bme") {
    const bme = await AdminModel.findById(adminId)
      .select("_id parentAdmin rootAdmin")
      .lean();

    const bmeParentAdmin = getAdminIdFromDoc(bme?.parentAdmin);
    const bmeRootAdmin = getAdminIdFromDoc(bme?.rootAdmin);

    const sameRhAsCampaign =
      idsEqual(campaignRhId, bmeParentAdmin) ||
      idsEqual(campaignRhId, bmeRootAdmin);

    const sameRhAsCampaignSdr =
      idsEqual(sdrParentAdmin, bmeParentAdmin) ||
      idsEqual(sdrParentAdmin, bmeRootAdmin) ||
      idsEqual(sdrRootAdmin, bmeParentAdmin) ||
      idsEqual(sdrRootAdmin, bmeRootAdmin);

    if (sameRhAsCampaign || sameRhAsCampaignSdr) {
      return campaign;
    }
  }

  const error = new Error("Forbidden");
  error.statusCode = 403;
  throw error;
}

function normalizeHeaderKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function normalizeContactRow(row = {}) {
  const normalized = {};

  Object.keys(row || {}).forEach((key) => {
    normalized[normalizeHeaderKey(key)] = row[key];
  });

  const companyName = String(
    normalized.companyname ||
    normalized.company ||
    ""
  ).trim();

  const contactEmail = normalizeEmail(
    normalized.contactemail ||
    normalized.email ||
    normalized.emailaddress ||
    ""
  );

  const contactName = String(
    normalized.contactname ||
    normalized.name ||
    ""
  ).trim();

  const website = String(normalized.website || "").trim();

  return {
    companyName,
    contactEmail,
    contactName,
    website,
  };
}

function fallbackNameFromEmail(email = "") {
  const local = String(email || "").split("@")[0] || "";
  return local.replace(/[._-]+/g, " ").trim();
}

async function upsertProspectsFromRows(rows = []) {
  const normalizedRows = rows
    .map(normalizeContactRow)
    .filter((row) => row.contactEmail);

  if (!normalizedRows.length) {
    const error = new Error("No valid contacts found");
    error.statusCode = 400;
    throw error;
  }

  const docs = [];

  for (const row of normalizedRows) {
    const nameParts = splitFullName(row.contactName || "");
    const fallbackName = fallbackNameFromEmail(row.contactEmail);

    const companyName =
      row.companyName ||
      row.contactName ||
      fallbackName ||
      "Lead";

    const templateVariables = {
      email: row.contactEmail,
      firstName: nameParts.firstName || row.contactName || fallbackName,
      lastName: nameParts.lastName,
      fullName: row.contactName || fallbackName,
      companyName,
      website: row.website || "",
    };

    const doc = await ProspectBrand.findOneAndUpdate(
      { "primaryContact.email": row.contactEmail },
      {
        $set: {
          companyName,
          website: row.website || "",
          source: "csv",
          primaryContact: {
            name: row.contactName || fallbackName || companyName,
            email: row.contactEmail,
          },
          customFields: row,
          templateVariables,
          csvMeta: {
            headers: Object.keys(row || {}),
            mappedAt: new Date(),
            sourceFileName: "google-sheet",
          },
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    docs.push(doc);
  }

  return docs;
}

function getProspectPatchForQueuedCampaign(campaign) {
  if (isImeFlow(campaign)) {
    return {
      flowType: "ime_influencer",
      contactType: "influencer",
      IMEId: campaign.IMEId,
      assignedImeId: campaign.IMEId,
      currentOwnerRole: OWNER_ROLE.IME,
      currentOwnerId: campaign.IMEId,
      stage: PROSPECT_STAGE.QUEUED,
      sdrWriteLocked: false,
    };
  }

  return {
    flowType: "standard_brand",
    contactType: "brand",
    sdrId: campaign.sdrId,
    RHId: campaign.RHId,
    currentOwnerRole: OWNER_ROLE.SDR,
    currentOwnerId: campaign.sdrId,
    stage: PROSPECT_STAGE.QUEUED,
    sdrWriteLocked: false,
  };
}

function getProspectPatchForLiveCampaign(campaign) {
  if (isImeFlow(campaign)) {
    return {
      flowType: "ime_influencer",
      contactType: "influencer",
      IMEId: campaign.IMEId,
      assignedImeId: campaign.IMEId,
      currentOwnerRole: OWNER_ROLE.IME,
      currentOwnerId: campaign.IMEId,
      stage: PROSPECT_STAGE.IN_SEQUENCE,
      launchedAt: campaign.launchedAt || new Date(),
      "instantly.campaignId": campaign.instantly.campaignId,
      "instantly.leadListId": "",
      "instantly.senderAccountEmail": campaign.instantly.senderAccountEmail,
    };
  }

  return {
    flowType: "standard_brand",
    contactType: "brand",
    sdrId: campaign.sdrId,
    RHId: campaign.RHId,
    currentOwnerRole: OWNER_ROLE.SDR,
    currentOwnerId: campaign.sdrId,
    stage: PROSPECT_STAGE.IN_SEQUENCE,
    sdrWriteLocked: false,
    launchedAt: campaign.launchedAt || new Date(),
    "instantly.campaignId": campaign.instantly.campaignId,
    "instantly.leadListId": "",
    "instantly.senderAccountEmail": campaign.instantly.senderAccountEmail,
  };
}

async function attachProspectsToCampaign(campaign, prospectDocs = []) {
  const existingIds = new Set((campaign.prospectIds || []).map((item) => String(item)));
  const newDocs = prospectDocs.filter((doc) => !existingIds.has(String(doc._id)));
  const newIds = newDocs.map((doc) => String(doc._id));

  if (!newIds.length) {
    return {
      campaign,
      addedCount: 0,
      totalProspects: campaign.stats?.totalProspects || 0,
      instantlySynced: false,
      addLeadsResult: null,
    };
  }

  campaign.prospectIds = [...existingIds, ...newIds];
  campaign.stats.totalProspects = campaign.prospectIds.length;

  const isLiveCampaign =
    campaign.status === OUTREACH_CAMPAIGN_STATUS.LAUNCHED ||
    campaign.status === OUTREACH_CAMPAIGN_STATUS.PAUSED;

  let instantlySynced = false;
  let addLeadsResult = null;

  if (isLiveCampaign) {
    if (!campaign.instantly?.campaignId) {
      const error = new Error("Campaign is live but Instantly campaign id is missing");
      error.statusCode = 400;
      throw error;
    }

    addLeadsResult = await instantlyService.addLeads({
      campaign_id: campaign.instantly.campaignId,
      leads: newDocs.map((doc) => buildInstantlyLeadFromProspect(doc, getCampaignMappedTemplateVariables(campaign))),
    });

    instantlySynced = true;

    await ProspectBrand.updateMany(
      { _id: { $in: newIds } },
      {
        $set: getProspectPatchForLiveCampaign(campaign),
      }
    );
  } else {
    await ProspectBrand.updateMany(
      { _id: { $in: newIds } },
      {
        $set: getProspectPatchForQueuedCampaign(campaign),
      }
    );

    if (campaign.status === OUTREACH_CAMPAIGN_STATUS.DRAFT) {
      campaign.status = OUTREACH_CAMPAIGN_STATUS.READY;
    }
  }

  await campaign.save();

  return {
    campaign,
    addedCount: newIds.length,
    totalProspects: campaign.stats.totalProspects,
    instantlySynced,
    addLeadsResult,
  };
}

function buildGoogleSheetCsvUrl(sheetUrl) {
  const url = new URL(sheetUrl);

  const spreadsheetMatch = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!spreadsheetMatch?.[1]) {
    throw new Error("Invalid Google Sheets URL");
  }

  const spreadsheetId = spreadsheetMatch[1];
  const gidFromQuery = url.searchParams.get("gid");
  const gidFromHash = url.hash.match(/gid=(\d+)/)?.[1];
  const gid = gidFromQuery || gidFromHash || "0";

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
}

function flattenCsvRow(value, prefix = "", target = {}) {
  if (Array.isArray(value)) {
    if (!value.length) {
      if (prefix) target[prefix] = "";
      return target;
    }

    const arePrimitive = value.every(
      (item) => item == null || ["string", "number", "boolean"].includes(typeof item)
    );

    if (arePrimitive) {
      if (prefix) target[prefix] = value.join(" | ");
      return target;
    }

    value.forEach((item, index) => {
      flattenCsvRow(item, prefix ? `${prefix}.${index}` : String(index), target);
    });

    return target;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, nestedValue]) => {
      flattenCsvRow(nestedValue, prefix ? `${prefix}.${key}` : key, target);
    });
    return target;
  }

  if (prefix) {
    target[prefix] = value == null ? "" : value;
  }

  return target;
}

function toCsv(rows = []) {
  const flatRows = rows.map((row) => flattenCsvRow(row));
  const headers = Array.from(
    flatRows.reduce((acc, row) => {
      Object.keys(row).forEach((key) => acc.add(key));
      return acc;
    }, new Set())
  );

  const escape = (value) => {
    const stringValue = String(value == null ? "" : value);
    if (/[,"]|\n/.test(stringValue)) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  };

  const lines = [headers.join(",")];

  flatRows.forEach((row) => {
    lines.push(headers.map((header) => escape(row[header])).join(","));
  });

  return lines.join("\n");
}

function extractAnalyticsRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return payload ? [payload] : [];
}

function getAnalyticsDateRange(range = "last_4_weeks") {
  const end = new Date();
  const start = new Date(end);

  const value = String(range || "").trim();

  if (value === "last_7_days") {
    start.setDate(end.getDate() - 6);
  } else if (value === "last_3_months") {
    start.setMonth(end.getMonth() - 3);
  } else {
    // default: last_4_weeks
    start.setDate(end.getDate() - 27);
  }

  return {
    start_date: formatDateOnly(start),
    end_date: formatDateOnly(end),
  };
}

function buildAnalyticsParams(query = {}, campaignId = "", mode = "overview") {
  const {
    range,
    _ts,
    campaign_id,
    id,
    ids,
    ...rest
  } = query || {};

  const dateRange = getAnalyticsDateRange(range);

  const params = {
    ...rest,
    ...dateRange,
  };

  if (mode === "overview") {
    params.id = campaignId;
  } else {
    params.campaign_id = campaignId;
  }

  if (mode === "steps") {
    params.include_opportunities_count = true;
  }

  return params;
}

exports.createOutreachCampaign = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);

    const name = String(req.body?.name || "").trim();
    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Campaign name is required",
      });
    }

    const flowType =
      req.admin.role === "ime"
        ? "ime_influencer"
        : req.admin.role === "sdr"
          ? "standard_brand"
          : normalizeFlowType(req.body?.flowType);

    const configuration = normalizeCampaignConfiguration(req.body?.configuration || req.body || {});

    let campaign;

    if (flowType === "ime_influencer") {
      const { ime } = await getImeCreateContext(req);
      const imeAssignments = await getActiveImeSenders(ime._id);
      const primaryIme =
        imeAssignments.find((item) => item.isPrimary) || imeAssignments[0] || null;

      const defaultImeAccounts = primaryIme?.email
        ? [normalizeEmail(primaryIme.email)]
        : [];

      const selectedAccountEmails = resolveSelectedAccountEmails(
        imeAssignments,
        req.body?.accountEmails,
        defaultImeAccounts
      );

      const selectedSenderEmail = resolveSelectedSenderEmail(
        imeAssignments,
        req.body?.senderAccountEmail,
        primaryIme?.email || "",
        selectedAccountEmails
      );

      campaign = await OutreachCampaign.create({
        name,
        flowType,
        IMEId: ime._id,
        createdByAdminId: req.admin.adminId,
        configuration,
        instantly: {
          accountEmails: selectedAccountEmails,
          senderAccountEmail: selectedSenderEmail,
          leadListId: "",
          campaignId: "",
          rawCampaignPayload: req.body?.instantlyRawCampaignPayload || null,
          shareLink: "",
        },
        teamMailboxes: {
          IMEEmail: selectedSenderEmail,
        },
      });
    } else {
      const { sdr, rh } = await getStandardCreateContext(req);
      const activeSenders = await getActiveSdrSenders(sdr._id);
      const primarySender =
        activeSenders.find((item) => item.isPrimary) || activeSenders[0] || null;
      const rhMailbox = await getActiveRhMailbox(rh._id);

      const defaultSelectedAccounts = primarySender?.email
        ? [normalizeEmail(primarySender.email)]
        : [];

      const selectedAccountEmails = resolveSelectedAccountEmails(
        activeSenders,
        req.body?.accountEmails,
        defaultSelectedAccounts
      );

      const selectedSenderEmail = resolveSelectedSenderEmail(
        activeSenders,
        req.body?.senderAccountEmail,
        primarySender?.email || "",
        selectedAccountEmails
      );

      campaign = await OutreachCampaign.create({
        name,
        flowType,
        sdrId: sdr._id,
        RHId: rh._id,
        createdByAdminId: req.admin.adminId,
        configuration,
        instantly: {
          accountEmails: selectedAccountEmails,
          senderAccountEmail: selectedSenderEmail,
          leadListId: "",
          campaignId: "",
          rawCampaignPayload: req.body?.instantlyRawCampaignPayload || null,
          shareLink: "",
        },
        teamMailboxes: {
          RHEmail: rhMailbox?.email || "",
        },
        status: OUTREACH_CAMPAIGN_STATUS.DRAFT,
        stats: {
          totalProspects: 0,
          totalSent: 0,
          totalClicked: 0,
          totalReplies: 0,
          totalOpportunities: 0,
          totalQualified: 0,
          totalAssigned: 0,
          progressPercent: 0,
        },
        sync: {
          providerStatus: "idle",
          lastErrorCode: "",
          lastErrorMessage: "",
          lastSyncedAt: null,
          lastAnalyticsSyncedAt: null,
        },
      });
    }

    const populated = await OutreachCampaign.findById(campaign._id)
      .populate("sdrId", "name email role")
      .populate("RHId", "name email role")
      .populate("IMEId", "name email role");

    await notifySafely("createOutreachCampaign", req, {
      adminIds: getOutreachCampaignNotificationRecipients(populated || campaign),
      type: "outreach.campaign_created",
      title: "Outreach campaign created",
      message: `${populated?.name || campaign?.name || "Outreach campaign"} was created.`,
      entityType: "outreach_campaign",
      entityId: String(campaign._id),
      actionPath: {
        admin: getOutreachCampaignAdminPath(campaign._id),
      },
    });

    return res.status(201).json({
      success: true,
      message: "Campaign created successfully",
      data: populated,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "CREATE_OUTREACH_CAMPAIGN_ERROR");
    const payload = getAxiosErrorPayload(error, "Internal error");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.listOutreachCampaigns = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "revenue_head", "super_admin"]);

    const adminId = String(req.admin?.adminId || req.admin?._id || "");
    const role = String(req.admin?.role || "").trim().toLowerCase();
    const filter = {};

    const status = String(req.query?.status || "").trim().toLowerCase();
    if (status) {
      filter.status = status;
    }

    if (role === "sdr") {
      filter.sdrId = adminId;
    } else if (role === "ime") {
      filter.IMEId = adminId;
    } else if (role === "revenue_head" || role === "rh") {
      filter.$or = [
        { RHId: adminId },
        { flowType: "ime_influencer" },
      ];
    } else if (role !== "super_admin") {
      filter._id = null;
    }

    const rows = await OutreachCampaign.find(filter)
      .populate("sdrId", "name email role")
      .populate("RHId", "name email role")
      .populate("IMEId", "name email role")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "LIST_OUTREACH_CAMPAIGNS_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to list campaigns");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.getOutreachCampaignById = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "revenue_head", "super_admin"]);
    const campaign = await getAccessibleCampaign(req, req.params.id);

    if (!campaign.configuration) {
      campaign.configuration = normalizeCampaignConfiguration({});
    }

    const templateVariables = getCampaignMappedTemplateVariables(campaign);

    const availableAccountEmails = await getAvailableSenderEmailsForCampaign(campaign);

    return res.status(200).json({
      success: true,
      data: {
        ...campaign.toObject(),
        instantly: {
          ...(campaign.instantly || {}),
          senderAccountEmail: campaign.instantly?.senderAccountEmail || "",
          accountEmails: Array.isArray(campaign.instantly?.accountEmails)
            ? campaign.instantly.accountEmails
            : [],
          availableAccountEmails,
        },
        templateVariables,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "GET_OUTREACH_CAMPAIGN_BY_ID_ERROR");
    const payload = getAxiosErrorPayload(error, "Internal error");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.updateOutreachCampaign = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);

    const campaign = await getManagedCampaign(req, req.params.id);
    const nextName = String(req.body?.name || "").trim();

    if (!nextName) {
      return res.status(400).json({
        success: false,
        message: "Campaign name is required",
      });
    }

    campaign.name = nextName;
    await campaign.save();

    await notifySafely("updateOutreachCampaign", req, {
      adminIds: getOutreachCampaignNotificationRecipients(campaign),
      type: "outreach.campaign_updated",
      title: "Outreach campaign updated",
      message: `${campaign.name || "Outreach campaign"} was updated.`,
      entityType: "outreach_campaign",
      entityId: String(campaign._id),
      actionPath: {
        admin: getOutreachCampaignAdminPath(campaign._id),
      },
    });

    return res.status(200).json({
      success: true,
      message: "Campaign updated successfully",
      data: campaign,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "UPDATE_OUTREACH_CAMPAIGN_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to update campaign");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.deleteOutreachCampaign = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);

    const campaign = await getManagedCampaign(req, req.params.id);

    if (campaign.instantly?.campaignId) {
      try {
        await instantlyService.deleteCampaign(campaign.instantly.campaignId);
      } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "DELETE_OUTREACH_CAMPAIGN_ERROR");
        if (error?.response?.status !== 404) {
          const payload = getAxiosErrorPayload(error, "Failed to delete Instantly campaign");
          return res.status(payload.statusCode).json({
            success: false,
            step: "delete_instantly_campaign",
            ...payload,
          });
        }
      }
    }

    const campaignNotificationRecipients = getOutreachCampaignNotificationRecipients(campaign);

    await campaign.deleteOne();

    await notifySafely("deleteOutreachCampaign", req, {
      adminIds: campaignNotificationRecipients,
      type: "outreach.campaign_deleted",
      title: "Outreach campaign deleted",
      message: `${campaign.name || "Outreach campaign"} was deleted.`,
      entityType: "outreach_campaign",
      entityId: String(campaign._id),
      actionPath: {
        admin: "/admin/crm/campaigns",
      },
    });

    return res.status(200).json({
      success: true,
      message: "Campaign deleted successfully",
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "DELETE_OUTREACH_CAMPAIGN_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to delete campaign");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.getOutreachCampaignConfiguration = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "revenue_head", "super_admin"]);
    const campaign = await getAccessibleCampaign(req, req.params.id);

    let availableAccountEmails = [];

    if (isImeFlow(campaign)) {
      const imeAssignments = await getActiveImeSenders(campaign.IMEId);
      availableAccountEmails = imeAssignments.map((item) => normalizeEmail(item.email)).filter(Boolean);
    } else {
      const senderAssignments = await getActiveSdrSenders(campaign.sdrId);
      availableAccountEmails = senderAssignments.map((item) => normalizeEmail(item.email)).filter(Boolean);
    }

    return res.status(200).json({
      success: true,
      data: {
        configuration: getCampaignConfigurationFromDocument(campaign),
        instantly: {
          ...(campaign.instantly || {}),
          availableAccountEmails,
        },
        status: campaign.status,
        flowType: campaign.flowType || "standard_brand",
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "GET_OUTREACH_CAMPAIGN_CONFIGURATION_ERROR");
    const payload = getAxiosErrorPayload(error, "Internal error");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

function splitFullName(value = "") {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);

  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
  };
}

function cleanVariableValue(value) {
  return String(value ?? "").trim();
}

function buildInstantlyLeadFromProspect(prospect = {}, templateVariablesForCampaign = []) {
  const storedTemplateVariables = prospect.templateVariables || {};
  const primaryContact = prospect.primaryContact || {};
  const allowedVariables = getTemplateVariableKeySet(templateVariablesForCampaign);
  const exactTemplateVariables = filterVariablesToAllowed(
    storedTemplateVariables,
    templateVariablesForCampaign
  );

  const email = normalizeEmail(
    primaryContact.email ||
    storedTemplateVariables.email ||
    exactTemplateVariables.email ||
    ''
  );

  const fullName = cleanVariableValue(exactTemplateVariables.fullName || '');
  const nameParts = splitFullName(fullName);

  const firstName = allowedVariables.has('firstName')
    ? cleanVariableValue(exactTemplateVariables.firstName || '')
    : '';

  const lastName = allowedVariables.has('lastName')
    ? cleanVariableValue(exactTemplateVariables.lastName || '')
    : '';

  const companyName = allowedVariables.has('companyName')
    ? cleanVariableValue(exactTemplateVariables.companyName || '')
    : '';

  const customVariables = {};

  allowedVariables.forEach((key) => {
    const value = cleanVariableValue(exactTemplateVariables[key]);
    if (!value) return;
    customVariables[key] = value;
  });

  Object.keys(customVariables).forEach((key) => {
    if (!cleanVariableValue(customVariables[key])) {
      delete customVariables[key];
    }
  });

  return {
    email,

    // Native Instantly fields are also strict: only filled if that exact CSV mapping exists.
    first_name: firstName,
    last_name: lastName || nameParts.lastName || '',
    company_name: companyName,

    // Only CSV-mapped variables are sent. Unmapped tokens in templates are blanked earlier.
    custom_variables: customVariables,

    personalization: null,
  };
}

function htmlToPlainText(value = "") {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function assertCampaignSequencesAreSendable(configuration = {}) {
  const sequences = Array.isArray(configuration.sequences)
    ? configuration.sequences
    : [];

  if (!sequences.length) {
    const error = new Error("At least one sequence step is required");
    error.statusCode = 400;
    throw error;
  }

  sequences.forEach((step, stepIndex) => {
    const variants = Array.isArray(step.variants) ? step.variants : [];

    if (!variants.length) {
      const error = new Error(`Step ${stepIndex + 1} must have at least one email variant`);
      error.statusCode = 400;
      throw error;
    }

    variants.forEach((variant, variantIndex) => {
      const bodyText = htmlToPlainText(variant.body);

      if (!bodyText) {
        const error = new Error(
          `Step ${stepIndex + 1}, Variant ${variantIndex + 1}: email body is required`
        );
        error.statusCode = 400;
        throw error;
      }
    });
  });
}

exports.updateOutreachCampaignConfiguration = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);
    const campaign = await getManagedCampaign(req, req.params.id);

    const nextConfiguration = normalizeCampaignConfiguration(
      req.body?.configuration || req.body || {},
      getCampaignConfigurationFromDocument(campaign)
    );

    assertCampaignSequencesAreSendable(nextConfiguration);

    campaign.configuration = nextConfiguration;

    if (req.body?.instantlyRawCampaignPayload !== undefined) {
      campaign.instantly.rawCampaignPayload = req.body.instantlyRawCampaignPayload || null;
    }

    let senderAssignments = [];
    let senderEmails = [];
    let primarySenderEmail = normalizeEmail(
      req.body?.senderAccountEmail || campaign.instantly?.senderAccountEmail || ""
    );

    if (isImeFlow(campaign)) {
      senderAssignments = await getActiveImeSenders(campaign.IMEId);

      if (senderAssignments.length) {
        senderEmails = resolveSelectedAccountEmails(
          senderAssignments,
          req.body?.accountEmails,
          campaign.instantly?.accountEmails
        );

        primarySenderEmail = resolveSelectedSenderEmail(
          senderAssignments,
          req.body?.senderAccountEmail,
          campaign.instantly?.senderAccountEmail,
          senderEmails
        );

        campaign.teamMailboxes.IMEEmail = primarySenderEmail;
      }
    } else {
      senderAssignments = await getActiveSdrSenders(campaign.sdrId);

      if (senderAssignments.length) {
        const rhMailbox = await getActiveRhMailbox(campaign.RHId);

        senderEmails = resolveSelectedAccountEmails(
          senderAssignments,
          req.body?.accountEmails,
          campaign.instantly?.accountEmails
        );

        primarySenderEmail = resolveSelectedSenderEmail(
          senderAssignments,
          req.body?.senderAccountEmail,
          campaign.instantly?.senderAccountEmail,
          senderEmails
        );

        campaign.teamMailboxes.RHEmail =
          rhMailbox?.email || campaign.teamMailboxes?.RHEmail || "";
      }
    }

    if (senderEmails.length) {
      campaign.instantly.accountEmails = senderEmails;
      campaign.instantly.senderAccountEmail = primarySenderEmail;
    }

    await campaign.save();

    if (req.body?.syncNow && campaign.instantly?.campaignId) {
      const updatePayload = buildCampaignCreatePayload({
        campaignName: campaign.name,
        senderEmails: campaign.instantly.accountEmails || [],
        configuration: campaign.configuration,
        rawCampaignPayload: campaign.instantly?.rawCampaignPayload || null,
        templateVariables: getCampaignMappedTemplateVariables(campaign),
      });

      await forceSyncInstantlyCampaignBeforeActivation({
        instantlyCampaignId: campaign.instantly.campaignId,
        createCampaignPayload: updatePayload,
      });

      campaign.configuration.lastSyncedAt = new Date();
      campaign.configuration.lastSyncedBy = req.admin.adminId;
      campaign.sync.providerStatus = "synced";
      campaign.sync.lastErrorCode = "";
      campaign.sync.lastErrorMessage = "";
      campaign.sync.lastSyncedAt = new Date();
      await campaign.save();
    }

    return res.status(200).json({
      success: true,
      message:
        req.body?.syncNow && campaign.instantly?.campaignId
          ? "Campaign configuration saved and synced to Instantly"
          : "Campaign configuration saved successfully",
      data: campaign,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "UPDATE_OUTREACH_CAMPAIGN_CONFIGURATION_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to update campaign configuration");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.syncOutreachCampaignConfiguration = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);
    const campaign = await getManagedCampaign(req, req.params.id);

    if (!campaign.instantly?.campaignId) {
      return res.status(400).json({
        success: false,
        message: "Launch the campaign first so an Instantly campaign exists",
      });
    }

    let senderAssignments = [];
    let senderEmails = [];
    let primarySenderEmail = normalizeEmail(
      req.body?.senderAccountEmail || campaign.instantly?.senderAccountEmail || ""
    );

    if (isImeFlow(campaign)) {
      senderAssignments = await getActiveImeSenders(campaign.IMEId);

      if (!senderAssignments.length) {
        return res.status(400).json({
          success: false,
          message: "No mailbox is assigned to this IME",
        });
      }

      senderEmails = resolveSelectedAccountEmails(
        senderAssignments,
        req.body?.accountEmails,
        campaign.instantly?.accountEmails
      );

      primarySenderEmail = resolveSelectedSenderEmail(
        senderAssignments,
        req.body?.senderAccountEmail,
        campaign.instantly?.senderAccountEmail,
        senderEmails
      );

      campaign.teamMailboxes.IMEEmail = primarySenderEmail;
    } else {
      senderAssignments = await getActiveSdrSenders(campaign.sdrId);

      if (!senderAssignments.length) {
        return res.status(400).json({
          success: false,
          message: "No sender mailboxes are assigned to this SDR",
        });
      }

      const rhMailbox = await getActiveRhMailbox(campaign.RHId);

      senderEmails = resolveSelectedAccountEmails(
        senderAssignments,
        req.body?.accountEmails,
        campaign.instantly?.accountEmails
      );

      primarySenderEmail = resolveSelectedSenderEmail(
        senderAssignments,
        req.body?.senderAccountEmail,
        campaign.instantly?.senderAccountEmail,
        senderEmails
      );

      campaign.teamMailboxes.RHEmail =
        rhMailbox?.email || campaign.teamMailboxes?.RHEmail || "";
    }

    const updatePayload = buildCampaignCreatePayload({
      campaignName: campaign.name,
      senderEmails,
      configuration: getCampaignConfigurationFromDocument(campaign),
      rawCampaignPayload: campaign.instantly?.rawCampaignPayload || null,
      templateVariables: getCampaignMappedTemplateVariables(campaign),
    });

    const syncResult = await forceSyncInstantlyCampaignBeforeActivation({
      instantlyCampaignId: campaign.instantly.campaignId,
      createCampaignPayload: updatePayload,
    });

    campaign.instantly.accountEmails = senderEmails;
    campaign.instantly.senderAccountEmail = primarySenderEmail;
    campaign.configuration.lastSyncedAt = new Date();
    campaign.configuration.lastSyncedBy = req.admin.adminId;
    campaign.sync.providerStatus = "synced";
    campaign.sync.lastErrorCode = "";
    campaign.sync.lastErrorMessage = "";
    campaign.sync.lastSyncedAt = new Date();
    await campaign.save();

    return res.status(200).json({
      success: true,
      message: "Campaign synced to Instantly successfully",
      data: {
        campaignId: campaign._id,
        instantlyCampaignId: campaign.instantly.campaignId,
        syncResult,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "SYNC_OUTREACH_CAMPAIGN_CONFIGURATION_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to sync campaign with Instantly");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

function renderTemplate(template = "", variables = {}) {
  const lookup = new Map();

  Object.entries(variables || {}).forEach(([key, value]) => {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return;

    lookup.set(normalizedKey, value);
    lookup.set(normalizedKey.toLowerCase(), value);
  });

  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const cleanKey = String(key || "").trim();
    const value = lookup.has(cleanKey)
      ? lookup.get(cleanKey)
      : lookup.get(cleanKey.toLowerCase());

    return value === undefined || value === null ? "" : String(value);
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textToHtml(value = "") {
  return escapeHtml(value).replace(/\n/g, "<br/>");
}

function buildPreviewVariablesFromProspect(prospect = {}, extra = {}, templateVariables = []) {
  return filterVariablesToAllowed(
    {
      ...(prospect?.templateVariables || {}),
      ...(extra || {}),
    },
    templateVariables
  );
}

function stripHtmlToText(value = "") {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderSequencePreviewContent(variant = {}, previewVars = {}) {
  const renderedSubject = renderTemplate(String(variant.subject || ""), previewVars);

  const renderedBodySource = renderTemplate(String(variant.body || ""), previewVars);
  const renderedPreheader = renderTemplate(
    String(variant.preheaderText || ""),
    previewVars
  );
  const renderedSignatureHtml = renderTemplate(
    String(variant.signatureHtml || ""),
    previewVars
  );

  const bodyHasHtml = /<\/?[a-z][\s\S]*>/i.test(renderedBodySource);

  const bodyHtml = bodyHasHtml
    ? renderedBodySource
    : textToHtml(renderedBodySource);

  const bodyText = bodyHasHtml
    ? stripHtmlToText(renderedBodySource)
    : String(renderedBodySource || "").trim();

  const preheaderHtml = renderedPreheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(
      renderedPreheader
    )}</div>`
    : "";

  const signatureHtml = renderedSignatureHtml
    ? `<div style="margin-top:16px;">${renderedSignatureHtml}</div>`
    : "";

  return {
    subject: renderedSubject,
    bodyText,
    bodyHtml: `${preheaderHtml}${bodyHtml}${signatureHtml}`,
    preheaderText: renderedPreheader,
    signatureHtml: renderedSignatureHtml,
  };
}

exports.previewCampaignSequence = async (req, res) => {
  try {

    ensureRole(req.admin, ["sdr", "ime", "bme", "revenue_head", "rh", "super_admin"]);

    const campaign = await getAccessibleCampaign(req, req.params.id);

    const stepOrder = Number(req.body?.stepOrder || 1);
    const variantIndex = Math.max(0, Number(req.body?.variantIndex || 0));

    const steps = Array.isArray(campaign?.configuration?.sequences)
      ? campaign.configuration.sequences
      : [];

    const step =
      steps.find((item) => Number(item?.stepOrder) === stepOrder) || steps[0];

    if (!step) {
      return res.status(400).json({
        success: false,
        message: "No sequence step found",
      });
    }

    const selectedVariant =
      step?.variants?.[variantIndex] ||
      step?.variants?.[0] || {
        subject: "",
        body: "",
        preheaderText: "",
        signatureHtml: "",
      };

    const variantOverride = req.body?.variantOverride || {};

    const variant = {
      subject:
        variantOverride.subject !== undefined
          ? variantOverride.subject
          : selectedVariant.subject,
      body:
        variantOverride.body !== undefined
          ? variantOverride.body
          : selectedVariant.body,
      preheaderText:
        variantOverride.preheaderText !== undefined
          ? variantOverride.preheaderText
          : selectedVariant.preheaderText,
      signatureHtml:
        variantOverride.signatureHtml !== undefined
          ? variantOverride.signatureHtml
          : selectedVariant.signatureHtml,
    };

    let previewProspect = null;

    if (req.body?.prospectId) {
      const allowedProspectIds = new Set(
        (campaign.prospectIds || []).map((item) => String(item))
      );

      if (!allowedProspectIds.has(String(req.body.prospectId))) {
        return res.status(403).json({
          success: false,
          message: "This lead does not belong to this campaign",
          details: null,
        });
      }

      previewProspect = await ProspectBrand.findById(req.body.prospectId).lean();
    }

    if (
      !previewProspect &&
      Array.isArray(campaign?.prospectIds) &&
      campaign.prospectIds.length
    ) {
      previewProspect = await ProspectBrand.findById(campaign.prospectIds[0]).lean();
    }

    const allowedTemplateVariables = getCampaignMappedTemplateVariables(campaign);

    const previewVars = buildPreviewVariablesFromProspect(
      previewProspect || {},
      req.body?.previewVars || {},
      allowedTemplateVariables
    );

    const rendered = renderSequencePreviewContent(variant, previewVars);

    const leadName =
      previewProspect?.companyName ||
      previewVars.companyName ||
      "Lead Unknown";

    const contactName =
      previewProspect?.primaryContact?.name ||
      previewVars.fullName ||
      previewVars.firstName ||
      "Contact Unknown";

    const contactEmail =
      previewProspect?.primaryContact?.email ||
      previewVars.email ||
      "";

    return res.status(200).json({
      success: true,
      message: "Sequence preview generated successfully",
      data: {
        stepOrder,
        variantIndex,
        lead: previewProspect
          ? {
            _id: String(previewProspect._id),
            leadName,
            contactName,
            email: contactEmail,
          }
          : null,
        subject: rendered.subject,
        bodyText: rendered.bodyText,
        bodyHtml: rendered.bodyHtml,
        preheaderText: rendered.preheaderText,
        signatureHtml: rendered.signatureHtml,
        previewVars,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "PREVIEW_CAMPAIGN_SEQUENCE_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to preview sequence");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.sendCampaignTestEmail = async (req, res) => {
  try {
    const campaign = await getManagedCampaign(req, req.params.id);

    const toEmail = String(req.body?.toEmail || "").trim();
    const accountEmail =
      String(req.body?.accountEmail || "").trim() ||
      String(campaign?.instantly?.senderAccountEmail || "").trim();

    const stepOrder = Number(req.body?.stepOrder || 1);
    const variantIndex = Math.max(0, Number(req.body?.variantIndex || 0));

    if (!toEmail) {
      return res.status(400).json({
        success: false,
        message: "toEmail is required",
      });
    }

    if (!accountEmail) {
      return res.status(400).json({
        success: false,
        message: "accountEmail is required",
      });
    }

    const steps = Array.isArray(campaign?.configuration?.sequences)
      ? campaign.configuration.sequences
      : [];

    const step =
      steps.find((item) => Number(item?.stepOrder) === stepOrder) || steps[0];

    if (!step) {
      return res.status(400).json({
        success: false,
        message: "No sequence step found",
      });
    }

    const variant =
      step?.variants?.[variantIndex] ||
      step?.variants?.[0] || {
        subject: "",
        body: "",
        preheaderText: "",
        signatureHtml: "",
      };

    let previewProspect = null;

    if (req.body?.prospectId) {
      previewProspect = await ProspectBrand.findById(req.body.prospectId).lean();
    }

    if (!previewProspect && Array.isArray(campaign?.prospectIds) && campaign.prospectIds.length) {
      previewProspect = await ProspectBrand.findById(campaign.prospectIds[0]).lean();
    }

    const allowedTemplateVariables = getCampaignMappedTemplateVariables(campaign);

    const previewVars = buildPreviewVariablesFromProspect(
      previewProspect || {},
      req.body?.previewVars || {},
      allowedTemplateVariables
    );

    const rendered = renderSequencePreviewContent(variant, previewVars);

    const result = await instantlyService.sendTestEmail({
      eaccount: accountEmail,
      to_address_email_list: toEmail,
      subject: rendered.subject,
      body: {
        text: rendered.bodyText,
        html: rendered.bodyHtml,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Test email sent successfully",
      data: result,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "SEND_CAMPAIGN_TEST_EMAIL_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to send test email");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.listCampaignContacts = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "revenue_head", "super_admin"]);
    const campaign = await getAccessibleCampaign(req, req.params.id);

    const rows = await ProspectBrand.find({
      _id: { $in: campaign.prospectIds || [] },
    }).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
      meta: {
        columns: Array.isArray(campaign.csvSchema?.columns) ? campaign.csvSchema.columns : [],
        templateVariables: Array.isArray(campaign.templateVariables) ? campaign.templateVariables : [],
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "LIST_CAMPAIGN_CONTACTS_ERROR");
    const payload = getAxiosErrorPayload(error, "Internal error");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.addProspectsToCampaign = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);

    const campaign = await getManagedCampaign(req, req.params.id);
    const incomingProspectIds = uniqueIds(req.body?.prospectIds || []);

    if (!incomingProspectIds.length) {
      return res.status(400).json({
        success: false,
        message: "prospectIds is required",
      });
    }

    const prospectDocs = await ProspectBrand.find({
      _id: { $in: incomingProspectIds },
    });

    if (!prospectDocs.length) {
      return res.status(400).json({
        success: false,
        message: "No valid contacts found for the provided ids",
      });
    }

    const result = await attachProspectsToCampaign(campaign, prospectDocs);

    return res.status(200).json({
      success: true,
      message: result.instantlySynced
        ? "Contacts added to campaign and synced to Instantly"
        : "Contacts added to campaign successfully",
      data: {
        campaignId: campaign._id,
        addedCount: result.addedCount,
        totalProspects: result.totalProspects,
        instantlySynced: result.instantlySynced,
        addLeadsResult: result.addLeadsResult,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "ADD_PROSPECTS_TO_CAMPAIGN_ERROR");
    const payload = getAxiosErrorPayload(error, "Internal error");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.uploadCampaignContactsCsv = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);

    const campaign = await getManagedCampaign(req, req.params.id);

    if (!req.file?.buffer) {
      return res.status(400).json({
        success: false,
        message: "CSV file is required",
      });
    }

    const csvText = req.file.buffer.toString("utf-8");

    const rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      delimiter: [",", "\t", ";"],
    });

    const incomingColumns = req.body?.columns ? JSON.parse(req.body.columns) : [];
    const columns = normalizeIncomingColumnMappings(incomingColumns, rows);
    const templateVariables = buildTemplateVariableList(columns);

    const prospectDocs = await upsertProspectsFromMappedRows(
      rows,
      columns,
      req.file.originalname || "contacts.csv"
    );

    campaign.csvSchema = {
      fileName: req.file.originalname || "contacts.csv",
      totalRows: rows.length,
      columns,
      updatedAt: new Date(),
    };

    campaign.templateVariables = templateVariables;
    await campaign.save();

    const result = await attachProspectsToCampaign(campaign, prospectDocs);

    return res.status(200).json({
      success: true,
      message: result.instantlySynced
        ? "CSV uploaded, mapped, and synced to Instantly"
        : "CSV uploaded successfully",
      data: {
        campaignId: campaign._id,
        addedCount: result.addedCount,
        totalProspects: result.totalProspects,
        instantlySynced: result.instantlySynced,
        templateVariables,
        columns,
        addLeadsResult: result.addLeadsResult,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "UPLOAD_CAMPAIGN_CONTACTS_CSV_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to upload campaign contacts CSV");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.addCampaignContactsManual = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);

    const campaign = await getManagedCampaign(req, req.params.id);

    const contacts = Array.isArray(req.body?.contacts)
      ? req.body.contacts
      : [
        {
          companyName: req.body?.companyName,
          contactName: req.body?.contactName,
          contactEmail: req.body?.contactEmail,
          website: req.body?.website,
        },
      ];

    const prospectDocs = await upsertProspectsFromRows(contacts);
    const result = await attachProspectsToCampaign(campaign, prospectDocs);

    return res.status(200).json({
      success: true,
      message: result.instantlySynced
        ? "Manual contact added and synced to Instantly"
        : "Manual contact added successfully",
      data: {
        campaignId: campaign._id,
        addedCount: result.addedCount,
        totalProspects: result.totalProspects,
        instantlySynced: result.instantlySynced,
        addLeadsResult: result.addLeadsResult,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "ADD_CAMPAIGN_CONTACTS_MANUAL_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to add manual contact");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.importCampaignContactsFromGoogleSheet = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);

    const campaign = await getManagedCampaign(req, req.params.id);
    const sheetUrl = String(req.body?.sheetUrl || "").trim();

    if (!sheetUrl) {
      return res.status(400).json({
        success: false,
        message: "sheetUrl is required",
      });
    }

    const exportUrl = buildGoogleSheetCsvUrl(sheetUrl);

    let csvText = "";
    try {
      const response = await axios.get(exportUrl, {
        timeout: 30000,
        responseType: "text",
      });
      csvText = String(response.data || "");
    } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "IMPORT_CAMPAIGN_CONTACTS_FROM_GOOGLE_SHEET_ERROR");
      return res.status(400).json({
        success: false,
        message:
          "Failed to fetch Google Sheet. Make sure the sheet is publicly accessible or published.",
      });
    }

    const rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      delimiter: [",", "\t", ";"],
    });

    const prospectDocs = await upsertProspectsFromRows(rows);
    const result = await attachProspectsToCampaign(campaign, prospectDocs);

    return res.status(200).json({
      success: true,
      message: result.instantlySynced
        ? "Google Sheet imported and contacts synced to Instantly"
        : "Google Sheet imported successfully",
      data: {
        campaignId: campaign._id,
        addedCount: result.addedCount,
        totalProspects: result.totalProspects,
        instantlySynced: result.instantlySynced,
        addLeadsResult: result.addLeadsResult,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "IMPORT_CAMPAIGN_CONTACTS_FROM_GOOGLE_SHEET_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to import Google Sheet");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.duplicateOutreachCampaign = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);

    const campaign = await getManagedCampaign(req, req.params.id);

    const duplicate = await OutreachCampaign.create({
      name: `${campaign.name} Copy`,
      flowType: campaign.flowType,
      sdrId: campaign.sdrId || null,
      RHId: campaign.RHId || null,
      IMEId: campaign.IMEId || null,
      createdByAdminId: req.admin.adminId,
      configuration: getCampaignConfigurationFromDocument(campaign),
      instantly: {
        accountEmails: [...(campaign.instantly?.accountEmails || [])],
        senderAccountEmail: campaign.instantly?.senderAccountEmail || "",
        leadListId: "",
        campaignId: "",
        rawCampaignPayload: campaign.instantly?.rawCampaignPayload || null,
        shareLink: "",
      },
      teamMailboxes: {
        RHEmail: campaign.teamMailboxes?.RHEmail || "",
        IMEEmail: campaign.teamMailboxes?.IMEEmail || "",
      },
      prospectIds: [...(campaign.prospectIds || [])],
      status:
        (campaign.prospectIds || []).length > 0
          ? OUTREACH_CAMPAIGN_STATUS.READY
          : OUTREACH_CAMPAIGN_STATUS.DRAFT,
      stats: {
        totalProspects: (campaign.prospectIds || []).length,
        totalSent: 0,
        totalClicked: 0,
        totalReplies: 0,
        totalOpportunities: 0,
        totalQualified: 0,
        totalAssigned: 0,
        progressPercent: 0,
      },
      sync: {
        providerStatus: "idle",
        lastErrorCode: "",
        lastErrorMessage: "",
        lastSyncedAt: null,
        lastAnalyticsSyncedAt: null,
      },
    });

    const populated = await OutreachCampaign.findById(duplicate._id)
      .populate("sdrId", "name email role")
      .populate("RHId", "name email role")
      .populate("IMEId", "name email role");

    return res.status(200).json({
      success: true,
      message: "Campaign duplicated successfully",
      data: populated,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "DUPLICATE_OUTREACH_CAMPAIGN_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to duplicate campaign");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.shareOutreachCampaign = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);

    const campaign = await getManagedCampaign(req, req.params.id);

    if (!campaign.instantly?.campaignId) {
      return res.status(400).json({
        success: false,
        message: "Launch the campaign first before sharing it",
      });
    }

    const shareResult = await instantlyService.shareCampaign(
      campaign.instantly.campaignId,
      req.body || {}
    );

    const isHttpUrl = (value) =>
      typeof value === "string" && /^https?:\/\//i.test(value.trim());

    const pickUrl = (...values) => {
      for (const value of values) {
        if (isHttpUrl(value)) return value.trim();
      }
      return "";
    };

    const shareLink =
      typeof shareResult === "string"
        ? (isHttpUrl(shareResult) ? shareResult.trim() : "")
        : pickUrl(
          shareResult?.shareLink,
          shareResult?.share_link,
          shareResult?.shareUrl,
          shareResult?.share_url,
          shareResult?.url,
          shareResult?.data?.shareLink,
          shareResult?.data?.share_link,
          shareResult?.data?.shareUrl,
          shareResult?.data?.share_url,
          shareResult?.data?.url,
          campaign.instantly?.shareLink
        );

    if (shareLink) {
      campaign.instantly.shareLink = shareLink;
      await campaign.save();
    }

    return res.status(200).json({
      success: true,
      message: shareLink
        ? "Campaign shared successfully"
        : "Campaign shared, but no share URL was returned by Instantly",
      data: {
        shareLink,
        raw: shareResult,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "SHARE_OUTREACH_CAMPAIGN_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to share campaign");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.downloadOutreachCampaignAnalyticsCsv = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "revenue_head", "super_admin"]);

    const campaign = await getAccessibleCampaign(req, req.params.id);

    if (!campaign.instantly?.campaignId) {
      return res.status(400).json({
        success: false,
        message: "Launch the campaign first to fetch analytics",
      });
    }

    const analytics = await instantlyService.getCampaignAnalyticsDaily({
      campaign_id: campaign.instantly.campaignId,
    });

    const rows = extractAnalyticsRows(analytics);
    const csv = toCsv(rows);

    await OutreachCampaign.findByIdAndUpdate(campaign._id, {
      $set: {
        "sync.lastAnalyticsSyncedAt": new Date(),
      },
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="campaign-analytics-${campaign._id}.csv"`
    );

    return res.status(200).send(csv);
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "DOWNLOAD_OUTREACH_CAMPAIGN_ANALYTICS_CSV_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to download analytics CSV");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

function sleep(ms = 500) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getInstantlyCampaignObject(payload = {}) {
  return payload?.data || payload?.campaign || payload;
}

function getInstantlySequencesFromPayload(payload = {}) {
  const campaign = getInstantlyCampaignObject(payload);
  return Array.isArray(campaign?.sequences) ? campaign.sequences : [];
}

function getInstantlyVariantBody(variant = {}) {
  return String(
    variant.body ||
      variant.bodyText ||
      variant.body_text ||
      variant.bodyHtml ||
      variant.body_html ||
      variant.email_body ||
      variant.emailBody ||
      variant.content ||
      ""
  );
}

function getInstantlySequenceBodyDebug(payload = {}) {
  const sequences = getInstantlySequencesFromPayload(payload);

  return sequences.map((sequence, sequenceIndex) => ({
    sequence: sequenceIndex + 1,
    steps: (sequence.steps || []).map((step, stepIndex) => ({
      step: stepIndex + 1,
      variants: (step.variants || []).map((variant, variantIndex) => {
        const body = getInstantlyVariantBody(variant);
        const bodyText = htmlToSequencePlainText(body);

        return {
          variant: variantIndex + 1,
          subject: variant.subject || "",
          bodyTextLength: bodyText.length,
          bodyPreview: bodyText.slice(0, 160),
          rawBodyLength: String(body || "").length,
          variantKeys: Object.keys(variant || {}),
        };
      }),
    })),
  }));
}

function getFirstInstantlySequenceBodyLength(payload = {}) {
  const sequences = getInstantlySequencesFromPayload(payload);
  const variant = sequences?.[0]?.steps?.[0]?.variants?.[0] || {};
  const body = getInstantlyVariantBody(variant);

  return htmlToSequencePlainText(body).length;
}

function getLocalSequenceBodyDebug(createCampaignPayload = {}) {
  return createCampaignPayload?.sequences?.[0]?.steps?.map((step, stepIndex) => ({
    step: stepIndex + 1,
    variants: (step.variants || []).map((variant, variantIndex) => {
      const bodyText = htmlToSequencePlainText(variant.body || "");

      return {
        variant: variantIndex + 1,
        subject: variant.subject || "",
        bodyTextLength: bodyText.length,
        bodyPreview: bodyText.slice(0, 160),
        rawBodyLength: String(variant.body || "").length,
        bodyContainsHtml: /<\/?[a-z][\s\S]*>/i.test(variant.body || ""),
      };
    }),
  }));
}

function buildSequenceStepsForSync(createCampaignPayload = {}, mode = "plain") {
  return (createCampaignPayload?.sequences?.[0]?.steps || []).map((step) => ({
    type: "email",
    delay: Number(step.delay || 0),
    delay_unit: String(step.delay_unit || "days").trim().toLowerCase(),
    pre_delay: Number(step.pre_delay || 0),
    pre_delay_unit: String(step.pre_delay_unit || "days").trim().toLowerCase(),
    variants: (step.variants || []).map((variant) => {
      const plainBody = htmlToSequencePlainText(variant.body || "");
      const finalBody = mode === "html" ? sequenceTextToHtml(plainBody) : plainBody;

      return {
        subject: String(variant.subject || "").trim(),
        body: finalBody,
        v_disabled: Boolean(variant.v_disabled),
      };
    }),
  }));
}

function cloneCampaignPayloadWithSequenceMode(createCampaignPayload = {}, mode = "plain") {
  return {
    ...createCampaignPayload,
    sequences: [
      {
        steps: buildSequenceStepsForSync(createCampaignPayload, mode),
      },
    ],
  };
}

function buildSequenceOnlyPayload(createCampaignPayload = {}, mode = "plain") {
  return {
    sequences: [
      {
        steps: buildSequenceStepsForSync(createCampaignPayload, mode),
      },
    ],
  };
}

function buildInstantlySequenceSyncCandidates(createCampaignPayload = {}) {
  return [
    {
      name: "full_payload_plain_body",
      payload: cloneCampaignPayloadWithSequenceMode(createCampaignPayload, "plain"),
    },
    {
      name: "sequence_only_plain_body",
      payload: buildSequenceOnlyPayload(createCampaignPayload, "plain"),
    },
    {
      name: "full_payload_html_body",
      payload: cloneCampaignPayloadWithSequenceMode(createCampaignPayload, "html"),
    },
    {
      name: "sequence_only_html_body",
      payload: buildSequenceOnlyPayload(createCampaignPayload, "html"),
    },
  ];
}

async function exportInstantlyCampaignForSequenceVerification(instantlyCampaignId) {
  if (typeof instantlyService.exportCampaign === "function") {
    return instantlyService.exportCampaign(instantlyCampaignId);
  }

  if (typeof instantlyService.getCampaign === "function") {
    return instantlyService.getCampaign(instantlyCampaignId);
  }

  const error = new Error(
    "Neither instantlyService.exportCampaign nor instantlyService.getCampaign is defined."
  );
  error.statusCode = 500;
  throw error;
}

async function forceSyncInstantlyCampaignBeforeActivation({
  instantlyCampaignId,
  createCampaignPayload,
}) {
  const candidates = buildInstantlySequenceSyncCandidates(createCampaignPayload);
  const attempts = [];

  for (const candidate of candidates) {
    try {
      await instantlyService.updateCampaign(instantlyCampaignId, candidate.payload);
      await sleep(1200);

      const exportedCampaign = await exportInstantlyCampaignForSequenceVerification(
        instantlyCampaignId
      );

      const remoteDebug = getInstantlySequenceBodyDebug(exportedCampaign);
      const remoteBodyLength = getFirstInstantlySequenceBodyLength(exportedCampaign);

      const attempt = {
        name: candidate.name,
        remoteBodyLength,
        remoteDebug,
        localDebug: getLocalSequenceBodyDebug(candidate.payload),
      };

      attempts.push(attempt);

      console.log(
        `Instantly exported campaign sequence debug (${candidate.name})`,
        JSON.stringify(remoteDebug, null, 2)
      );

      if (remoteBodyLength > 0) {
        return {
          verified: true,
          bodyTextLength: remoteBodyLength,
          debug: remoteDebug,
          successfulPayloadMode: candidate.name,
          attempts,
        };
      }
    } catch (error) {
      attempts.push({
        name: candidate.name,
        error: error?.response?.data || error?.message || String(error),
      });
    }
  }

  const error = new Error(
    "Instantly campaign was created/updated, but exported campaign sequence body is still empty after trying all supported payload formats. Campaign was not activated."
  );

  error.statusCode = 500;
  error.details = {
    attempts,
    localSequenceDebug: getLocalSequenceBodyDebug(createCampaignPayload),
  };

  throw error;
}

exports.launchOutreachCampaign = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);

    const campaign = await getManagedCampaign(req, req.params.id);
    const configuration = getCampaignConfigurationFromDocument(campaign);

    assertCampaignSequencesAreSendable(configuration);

    let senderAssignments = [];
    let senderEmails = [];
    let primarySenderEmail = campaign.instantly?.senderAccountEmail || "";

    if (isImeFlow(campaign)) {
      senderAssignments = await getActiveImeSenders(campaign.IMEId);

      if (!senderAssignments.length) {
        return res.status(400).json({
          success: false,
          message: "No mailbox is assigned to this IME",
        });
      }

      senderEmails = resolveSelectedAccountEmails(
        senderAssignments,
        req.body?.accountEmails,
        campaign.instantly?.accountEmails
      );

      primarySenderEmail = resolveSelectedSenderEmail(
        senderAssignments,
        req.body?.senderAccountEmail,
        campaign.instantly?.senderAccountEmail,
        senderEmails
      );

      campaign.teamMailboxes.IMEEmail = primarySenderEmail;
    } else {
      senderAssignments = await getActiveSdrSenders(campaign.sdrId);

      if (!senderAssignments.length) {
        return res.status(400).json({
          success: false,
          message: "No sender mailboxes are assigned to this SDR",
        });
      }

      const rhMailbox = await getActiveRhMailbox(campaign.RHId);

      senderEmails = resolveSelectedAccountEmails(
        senderAssignments,
        req.body?.accountEmails,
        campaign.instantly?.accountEmails
      );

      primarySenderEmail = resolveSelectedSenderEmail(
        senderAssignments,
        req.body?.senderAccountEmail,
        campaign.instantly?.senderAccountEmail,
        senderEmails
      );

      campaign.teamMailboxes.RHEmail =
        rhMailbox?.email || campaign.teamMailboxes?.RHEmail || "";
    }

    const createCampaignPayload = buildCampaignCreatePayload({
      campaignName: campaign.name,
      senderEmails,
      configuration,
      rawCampaignPayload: campaign.instantly?.rawCampaignPayload || null,
      templateVariables: getCampaignMappedTemplateVariables(campaign),
    });

    const localSequenceDebug = getLocalSequenceBodyDebug(createCampaignPayload);
    const firstLocalBodyLength =
      localSequenceDebug?.[0]?.variants?.[0]?.bodyTextLength || 0;

    console.log(
      "Instantly create/update campaign payload final",
      JSON.stringify(
        {
          campaignId: String(campaign._id),
          instantlyCampaignId: campaign.instantly?.campaignId || "",
          name: createCampaignPayload.name,
          email_list: createCampaignPayload.email_list,
          sequenceBodies: localSequenceDebug,
        },
        null,
        2
      )
    );

    if (!firstLocalBodyLength) {
      return res.status(400).json({
        success: false,
        step: "validate_sequence_payload",
        message: "Sequence body is empty before sending to Instantly",
        debug: {
          sequenceBodies: localSequenceDebug,
        },
      });
    }

    if (
      campaign.status === OUTREACH_CAMPAIGN_STATUS.PAUSED &&
      campaign.instantly?.campaignId
    ) {
      try {
        await forceSyncInstantlyCampaignBeforeActivation({
          instantlyCampaignId: campaign.instantly.campaignId,
          createCampaignPayload,
        });

        await instantlyService.activateCampaign(campaign.instantly.campaignId);
      } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "LAUNCH_OUTREACH_CAMPAIGN_ERROR");
        campaign.status = OUTREACH_CAMPAIGN_STATUS.ERROR;
        campaign.sync.providerStatus = "error";
        campaign.sync.lastErrorCode = String(
          error?.response?.status || error?.statusCode || ""
        );
        campaign.sync.lastErrorMessage =
          error?.response?.data?.message ||
          error?.response?.data?.error ||
          error?.message ||
          "Failed to resume campaign in Instantly";

        await campaign.save();

        const payload = getAxiosErrorPayload(
          error,
          "Failed to resume campaign in Instantly"
        );

        return res.status(payload.statusCode).json({
          success: false,
          step: "activate_paused_campaign",
          debug: {
            instantlyCampaignId: campaign.instantly.campaignId,
            sequenceBodies: localSequenceDebug,
            errorDetails: error?.details || null,
          },
          ...payload,
        });
      }

      campaign.instantly.accountEmails = senderEmails;
      campaign.instantly.senderAccountEmail = primarySenderEmail;
      campaign.configuration.lastSyncedAt = new Date();
      campaign.configuration.lastSyncedBy = req.admin.adminId;
      campaign.sync.providerStatus = "synced";
      campaign.sync.lastErrorCode = "";
      campaign.sync.lastErrorMessage = "";
      campaign.sync.lastSyncedAt = new Date();
      campaign.status = OUTREACH_CAMPAIGN_STATUS.LAUNCHED;
      campaign.pausedAt = null;

      await campaign.save();

      return res.status(200).json({
        success: true,
        message: "Campaign resumed successfully",
        data: {
          campaignId: campaign._id,
          instantlyCampaignId: campaign.instantly.campaignId,
          senderAccountEmail: campaign.instantly.senderAccountEmail,
          accountEmails: senderEmails,
        },
      });
    }

    const prospects = await ProspectBrand.find({
      _id: { $in: campaign.prospectIds },
      stage: { $in: [PROSPECT_STAGE.NEW, PROSPECT_STAGE.QUEUED] },
    }).lean();

    if (!prospects.length) {
      return res.status(400).json({
        success: false,
        message: "No launchable contacts found in this campaign",
      });
    }

    let instantlyCampaign = null;
    let instantlyCampaignId = "";

    try {
      instantlyCampaign = await instantlyService.createCampaign(createCampaignPayload);
      instantlyCampaignId = readExternalId(instantlyCampaign);

      if (!instantlyCampaignId) {
        const error = new Error("Instantly campaign created but no campaignId was returned");
        error.statusCode = 400;
        error.details = instantlyCampaign || null;
        throw error;
      }

      await forceSyncInstantlyCampaignBeforeActivation({
        instantlyCampaignId,
        createCampaignPayload,
      });
    } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "LAUNCH_OUTREACH_CAMPAIGN_ERROR");
      campaign.status = OUTREACH_CAMPAIGN_STATUS.ERROR;
      campaign.sync.providerStatus = "error";
      campaign.sync.lastErrorCode = String(
        error?.response?.status || error?.statusCode || ""
      );
      campaign.sync.lastErrorMessage =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        "Failed to create or verify campaign in Instantly";

      if (instantlyCampaignId) {
        campaign.instantly.campaignId = instantlyCampaignId;
      }

      await campaign.save();

      const payload = getAxiosErrorPayload(
        error,
        "Failed to create or verify campaign in Instantly"
      );

      return res.status(payload.statusCode).json({
        success: false,
        step: "create_or_verify_instantly_campaign",
        debug: {
          campaignName: campaign.name,
          senderEmails,
          instantlyCampaignId,
          sequenceBodies: localSequenceDebug,
          errorDetails: error?.details || null,
        },
        ...payload,
      });
    }

    let addLeadsResult = null;

    try {
      addLeadsResult = await instantlyService.addLeads({
        campaign_id: instantlyCampaignId,
        leads: prospects.map((prospect) => buildInstantlyLeadFromProspect(prospect, getCampaignMappedTemplateVariables(campaign))),
      });
    } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "LAUNCH_OUTREACH_CAMPAIGN_ERROR");
      campaign.status = OUTREACH_CAMPAIGN_STATUS.ERROR;
      campaign.sync.providerStatus = "error";
      campaign.sync.lastErrorCode = String(error?.response?.status || "");
      campaign.sync.lastErrorMessage =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        "Failed to add leads to Instantly campaign";
      campaign.instantly.campaignId = instantlyCampaignId;

      await campaign.save();

      const payload = getAxiosErrorPayload(
        error,
        "Failed to add leads to Instantly campaign"
      );

      return res.status(payload.statusCode).json({
        success: false,
        step: "add_leads",
        debug: {
          instantlyCampaignId,
          leadCount: prospects.length,
        },
        ...payload,
      });
    }

    try {
      await forceSyncInstantlyCampaignBeforeActivation({
        instantlyCampaignId,
        createCampaignPayload,
      });

      await instantlyService.activateCampaign(instantlyCampaignId);
    } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "LAUNCH_OUTREACH_CAMPAIGN_ERROR");
      campaign.status = OUTREACH_CAMPAIGN_STATUS.ERROR;
      campaign.sync.providerStatus = "error";
      campaign.sync.lastErrorCode = String(
        error?.response?.status || error?.statusCode || ""
      );
      campaign.sync.lastErrorMessage =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        "Failed to activate campaign in Instantly";
      campaign.instantly.campaignId = instantlyCampaignId;

      await campaign.save();

      const payload = getAxiosErrorPayload(
        error,
        "Failed to activate campaign in Instantly"
      );

      return res.status(payload.statusCode).json({
        success: false,
        step: "activate_campaign",
        debug: {
          instantlyCampaignId,
          sequenceBodies: localSequenceDebug,
          errorDetails: error?.details || null,
        },
        ...payload,
      });
    }

    campaign.instantly.leadListId = "";
    campaign.instantly.campaignId = instantlyCampaignId;
    campaign.instantly.accountEmails = senderEmails;
    campaign.instantly.senderAccountEmail = primarySenderEmail;
    campaign.configuration.lastSyncedAt = new Date();
    campaign.configuration.lastSyncedBy = req.admin.adminId;
    campaign.sync.providerStatus = "synced";
    campaign.sync.lastErrorCode = "";
    campaign.sync.lastErrorMessage = "";
    campaign.sync.lastSyncedAt = new Date();
    campaign.status = OUTREACH_CAMPAIGN_STATUS.LAUNCHED;
    campaign.launchValidatedAt = new Date();
    campaign.launchedAt = new Date();
    campaign.pausedAt = null;
    campaign.stats.progressPercent = 0;

    await campaign.save();

    await ProspectBrand.updateMany(
      { _id: { $in: campaign.prospectIds } },
      {
        $set: getProspectPatchForLiveCampaign(campaign),
      }
    );

    await notifySafely("launchOutreachCampaign", req, {
      adminIds: getOutreachCampaignNotificationRecipients(campaign),
      type: "outreach.campaign_launched",
      title: "Outreach campaign launched",
      message: `${campaign.name || "Outreach campaign"} was launched.`,
      entityType: "outreach_campaign",
      entityId: String(campaign._id),
      actionPath: {
        admin: getOutreachCampaignAdminPath(campaign._id),
      },
    });

    return res.status(200).json({
      success: true,
      message: "Campaign launched successfully",
      data: {
        campaignId: campaign._id,
        instantlyCampaignId,
        senderAccountEmail: campaign.instantly.senderAccountEmail,
        accountEmails: senderEmails,
        addLeadsResult,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "LAUNCH_OUTREACH_CAMPAIGN_ERROR");
    const payload = getAxiosErrorPayload(error, "Internal error");

    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.pauseOutreachCampaign = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);

    const campaign = await getManagedCampaign(req, req.params.id);

    if (!campaign.instantly.campaignId) {
      return res.status(400).json({
        success: false,
        message: "Instantly campaign not linked",
      });
    }

    if (campaign.status !== OUTREACH_CAMPAIGN_STATUS.LAUNCHED) {
      return res.status(400).json({
        success: false,
        message: "Only launched campaigns can be paused",
      });
    }

    try {
      await instantlyService.pauseCampaign(campaign.instantly.campaignId);
    } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "PAUSE_OUTREACH_CAMPAIGN_ERROR");
      campaign.status = OUTREACH_CAMPAIGN_STATUS.ERROR;
      campaign.sync.providerStatus = "error";
      campaign.sync.lastErrorCode = String(error?.response?.status || "");
      campaign.sync.lastErrorMessage =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        "Failed to pause campaign in Instantly";
      await campaign.save();

      const payload = getAxiosErrorPayload(error, "Failed to pause campaign in Instantly");
      return res.status(payload.statusCode).json({
        success: false,
        step: "pause_campaign",
        ...payload,
      });
    }

    campaign.status = OUTREACH_CAMPAIGN_STATUS.PAUSED;
    campaign.pausedAt = new Date();
    await campaign.save();

    await notifySafely("pauseOutreachCampaign", req, {
      adminIds: getOutreachCampaignNotificationRecipients(campaign),
      type: "outreach.campaign_paused",
      title: "Outreach campaign paused",
      message: `${campaign.name || "Outreach campaign"} was paused.`,
      entityType: "outreach_campaign",
      entityId: String(campaign._id),
      actionPath: {
        admin: getOutreachCampaignAdminPath(campaign._id),
      },
    });

    return res.status(200).json({
      success: true,
      message: "Campaign paused successfully",
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "PAUSE_OUTREACH_CAMPAIGN_ERROR");
    const payload = getAxiosErrorPayload(error, "Internal error");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

function toSafeNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function pickFirstObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return {};
}

function safeRate(numerator, denominator) {
  const top = toSafeNumber(numerator);
  const bottom = toSafeNumber(denominator);

  if (!bottom || bottom <= 0) return 0;

  const rate = (top / bottom) * 100;
  return Number(Math.max(0, Math.min(100, rate)).toFixed(2));
}

function normalizeDailyAnalyticsRowsForCampaign(payload = {}) {
  return extractAnalyticsRows(payload)
    .map((row) => {
      const sent = toSafeNumber(row?.sent, row?.emails_sent_count, row?.total_sent);
      const opened = toSafeNumber(row?.opened, row?.open_count);
      const uniqueOpened = toSafeNumber(row?.unique_opened, row?.open_count_unique, opened);
      const clicks = toSafeNumber(row?.clicks, row?.link_click_count);
      const uniqueClicks = toSafeNumber(row?.unique_clicks, row?.link_click_count_unique, clicks);
      const replies = toSafeNumber(row?.replies, row?.reply_count);
      const uniqueReplies = toSafeNumber(row?.unique_replies, row?.reply_count_unique, replies);
      const automaticReplies = toSafeNumber(row?.replies_automatic, row?.reply_count_automatic);
      const opportunities = toSafeNumber(row?.opportunities, row?.unique_opportunities, row?.total_opportunities);

      return {
        date: String(row?.date || row?.day || row?.label || ""),
        sent,
        contacted: toSafeNumber(row?.contacted, row?.contacted_count),
        newLeadsContacted: toSafeNumber(row?.new_leads_contacted, row?.new_leads_contacted_count),
        opened,
        uniqueOpened,
        replies,
        uniqueReplies,
        automaticReplies,
        clicks,
        uniqueClicks,
        opportunities,
        openRate: safeRate(uniqueOpened || opened, sent),
        clickRate: safeRate(uniqueClicks || clicks, sent),
        replyRate: safeRate(uniqueReplies || replies, sent),
        raw: row,
      };
    })
    .filter((row) => row.date)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

function normalizeOverviewAnalyticsPayload(payload = {}, campaign = null) {
  const root = pickFirstObject(payload, payload?.data, payload?.stats, payload?.result);

  const totalProspects = toSafeNumber(
    root.leads_count,
    root.total_leads,
    root.totalProspects,
    root.leads,
    campaign?.stats?.totalProspects,
    Array.isArray(campaign?.prospectIds) ? campaign.prospectIds.length : 0
  );

  const totalSent = toSafeNumber(
    root.emails_sent_count,
    root.total_sent,
    root.totalSent,
    root.sent,
    root.emails_sent,
    campaign?.stats?.totalSent
  );

  const totalOpened = toSafeNumber(
    root.open_count_unique,
    root.open_count_unique_by_step,
    root.unique_opened,
    root.total_opened,
    root.totalOpened,
    root.opened,
    root.open_count,
    campaign?.stats?.totalOpened
  );

  const totalClicked = toSafeNumber(
    root.link_click_count_unique,
    root.link_click_count_unique_by_step,
    root.unique_clicks,
    root.total_clicked,
    root.totalClicked,
    root.clicked,
    root.link_click_count,
    campaign?.stats?.totalClicked
  );

  const totalReplies = toSafeNumber(
    root.reply_count,
    root.reply_count_unique,
    root.total_replies,
    root.total_replied,
    root.totalReplies,
    root.replied,
    campaign?.stats?.totalReplies
  );

  const totalOpportunities = toSafeNumber(
    root.total_opportunities,
    root.totalOpportunities,
    root.opportunities,
    campaign?.stats?.totalOpportunities
  );

  const totalQualified = toSafeNumber(
    root.total_closed,
    root.total_conversions,
    root.totalQualified,
    root.qualified,
    campaign?.stats?.totalQualified
  );

  const totalAssigned = toSafeNumber(campaign?.stats?.totalAssigned);

  const progressPercent =
    totalProspects > 0
      ? Math.min(100, Math.round((totalSent / totalProspects) * 100))
      : 0;

  return {
    totalProspects,
    totalSent,
    totalOpened,
    totalClicked,
    totalReplies,
    totalOpportunities,
    totalQualified,
    totalAssigned,
    progressPercent,
    sequenceStartedAt: campaign?.launchedAt || null,
    openRate: safeRate(totalOpened, totalSent),
    clickRate: safeRate(totalClicked, totalSent),
    replyRate: safeRate(totalReplies, totalSent),
    raw: payload,
  };
}

function buildOverviewFallback(campaign) {
  const totalProspects = toSafeNumber(
    campaign?.stats?.totalProspects,
    Array.isArray(campaign?.prospectIds) ? campaign.prospectIds.length : 0
  );
  const totalSent = toSafeNumber(campaign?.stats?.totalSent);
  const totalOpened = toSafeNumber(campaign?.stats?.totalOpened);
  const totalClicked = toSafeNumber(campaign?.stats?.totalClicked);
  const totalReplies = toSafeNumber(campaign?.stats?.totalReplies);
  const totalOpportunities = toSafeNumber(campaign?.stats?.totalOpportunities);
  const totalQualified = toSafeNumber(campaign?.stats?.totalQualified);

  return {
    totalProspects,
    totalSent,
    totalOpened,
    totalClicked,
    totalReplies,
    totalOpportunities,
    totalQualified,
    totalAssigned: toSafeNumber(campaign?.stats?.totalAssigned),
    progressPercent:
      totalProspects > 0 ? Math.min(100, Math.round((totalSent / totalProspects) * 100)) : 0,
    openRate: safeRate(totalOpened, totalSent),
    clickRate: safeRate(totalClicked, totalSent),
    replyRate: safeRate(totalReplies, totalSent),
    provider: "local",
    raw: null,
  };
}

function buildStepsFallback(campaign) {
  const steps = normalizeCampaignSequences(campaign?.configuration?.sequences || []);
  const totalSent = toSafeNumber(campaign?.stats?.totalSent);
  const totalReplies = toSafeNumber(campaign?.stats?.totalReplies);
  const totalClicked = toSafeNumber(campaign?.stats?.totalClicked);
  const totalOpportunities = toSafeNumber(campaign?.stats?.totalOpportunities);

  return steps.map((step, index) => ({
    stepOrder: step.stepOrder || index + 1,
    label: `Step ${step.stepOrder || index + 1}`,
    type: step.type || "email",
    sent: index === 0 ? totalSent : 0,
    opened: null,
    replied: index === 0 ? totalReplies : 0,
    clicked: index === 0 ? totalClicked : 0,
    opportunities: index === 0 ? totalOpportunities : 0,
    subject: step?.variants?.[0]?.subject || "",
  }));
}

async function persistOverviewStats(campaign, overview) {
  campaign.stats.totalProspects = toSafeNumber(
    overview?.totalProspects,
    campaign.stats?.totalProspects
  );
  campaign.stats.totalSent = toSafeNumber(
    overview?.totalSent,
    campaign.stats?.totalSent
  );
  campaign.stats.totalOpened = toSafeNumber(
    overview?.totalOpened,
    campaign.stats?.totalOpened
  );
  campaign.stats.totalClicked = toSafeNumber(
    overview?.totalClicked,
    campaign.stats?.totalClicked
  );
  campaign.stats.totalReplies = toSafeNumber(
    overview?.totalReplies,
    campaign.stats?.totalReplies
  );
  campaign.stats.totalOpportunities = toSafeNumber(
    overview?.totalOpportunities,
    campaign.stats?.totalOpportunities
  );
  campaign.stats.totalQualified = toSafeNumber(
    overview?.totalQualified,
    campaign.stats?.totalQualified
  );
  campaign.stats.progressPercent = toSafeNumber(
    overview?.progressPercent,
    campaign.stats?.progressPercent
  );

  campaign.sync.lastAnalyticsSyncedAt = new Date();
  await campaign.save();
}

function normalizeStepAnalyticsRows(payload = {}, campaign = null) {
  const rows = extractAnalyticsRows(payload);

  if (!rows.length) {
    return buildStepsFallback(campaign);
  }

  const sequences = normalizeCampaignSequences(campaign?.configuration?.sequences || []);

  return rows.map((row, index) => {
    const stepOrder = toSafeNumber(
      row.stepOrder,
      row.step_order,
      row.step,
      index + 1
    );

    const variantIndex = Math.max(
      0,
      toSafeNumber(row.variant, row.variant_index, 0)
    );

    const sequenceStep = sequences[Math.max(0, stepOrder - 1)];
    const variant =
      sequenceStep?.variants?.[variantIndex] ||
      sequenceStep?.variants?.[0] ||
      null;

    return {
      stepOrder,
      label: `Step ${stepOrder}`,
      type: "email",
      subject: row.subject || row.email_subject || variant?.subject || "",
      sent: toSafeNumber(row.sent, row.total_sent),
      opened: toSafeNumber(row.unique_opened, row.opened, row.total_opened),
      replied: toSafeNumber(row.unique_replies, row.replies, row.replied, row.total_replied),
      clicked: toSafeNumber(row.unique_clicks, row.clicks, row.clicked, row.total_clicked),
      clickRate: safeRate(
        toSafeNumber(row.unique_clicks, row.clicks, row.clicked, row.total_clicked),
        toSafeNumber(row.sent, row.total_sent)
      ),
      openRate: safeRate(
        toSafeNumber(row.unique_opened, row.opened, row.total_opened),
        toSafeNumber(row.sent, row.total_sent)
      ),
      replyRate: safeRate(
        toSafeNumber(row.unique_replies, row.replies, row.replied, row.total_replied),
        toSafeNumber(row.sent, row.total_sent)
      ),
      opportunities: toSafeNumber(
        row.opportunities,
        row.unique_opportunities,
        row.total_opportunities
      ),
      variant: variantIndex,
      raw: row,
    };
  });
}

exports.getOutreachCampaignAnalyticsOverview = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "revenue_head", "super_admin"]);
    const campaign = await getAccessibleCampaign(req, req.params.id);

    if (!campaign.instantly?.campaignId) {
      return res.status(200).json({
        success: true,
        data: buildOverviewFallback(campaign),
      });
    }

    const providerPayload = await instantlyService.getCampaignAnalyticsOverview(
      buildAnalyticsParams(req.query, campaign.instantly.campaignId, "overview")
    );

    const normalized = normalizeOverviewAnalyticsPayload(providerPayload, campaign);
    await persistOverviewStats(campaign, normalized);

    return res.status(200).json({
      success: true,
      data: normalized,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "GET_OUTREACH_CAMPAIGN_ANALYTICS_OVERVIEW_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to load campaign analytics overview");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.getOutreachCampaignAnalyticsDaily = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "revenue_head", "super_admin"]);
    const campaign = await getAccessibleCampaign(req, req.params.id);

    if (!campaign.instantly?.campaignId) {
      return res.status(200).json({
        success: true,
        data: [],
      });
    }

    const providerPayload = await instantlyService.getCampaignAnalyticsDaily(
      buildAnalyticsParams(req.query, campaign.instantly.campaignId, "daily")
    );

    await OutreachCampaign.findByIdAndUpdate(campaign._id, {
      $set: {
        "sync.lastAnalyticsSyncedAt": new Date(),
      },
    });

    return res.status(200).json({
      success: true,
      data: normalizeDailyAnalyticsRowsForCampaign(providerPayload),
      raw: providerPayload,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "GET_OUTREACH_CAMPAIGN_ANALYTICS_DAILY_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to load campaign analytics daily");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.getOutreachCampaignAnalyticsSteps = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "revenue_head", "super_admin"]);
    const campaign = await getAccessibleCampaign(req, req.params.id);

    if (!campaign.instantly?.campaignId) {
      return res.status(200).json({
        success: true,
        data: buildStepsFallback(campaign),
      });
    }

    const providerPayload = await instantlyService.getCampaignAnalyticsSteps(
      buildAnalyticsParams(req.query, campaign.instantly.campaignId, "steps")
    );

    await OutreachCampaign.findByIdAndUpdate(campaign._id, {
      $set: {
        "sync.lastAnalyticsSyncedAt": new Date(),
      },
    });

    return res.status(200).json({
      success: true,
      data: normalizeStepAnalyticsRows(providerPayload, campaign),
      raw: providerPayload,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "GET_OUTREACH_CAMPAIGN_ANALYTICS_STEPS_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to load campaign analytics steps");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.getOutreachCampaignSendingStatus = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "revenue_head", "super_admin"]);
    const campaign = await getAccessibleCampaign(req, req.params.id);

    if (!campaign.instantly?.campaignId) {
      return res.status(200).json({
        success: true,
        data: {
          status: campaign.status,
          providerStatus: campaign.sync?.providerStatus || "idle",
          instantlyCampaignId: "",
        },
      });
    }

    const providerPayload = await instantlyService.getCampaignSendingStatus(
      campaign.instantly.campaignId,
      req.query || {}
    );

    return res.status(200).json({
      success: true,
      data: providerPayload,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "GET_OUTREACH_CAMPAIGN_SENDING_STATUS_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to load campaign sending status");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.diagnoseOutreachCampaign = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "revenue_head", "super_admin"]);
    const campaign = await getAccessibleCampaign(req, req.params.id);

    const diagnostics = {
      campaignId: campaign._id,
      name: campaign.name,
      status: campaign.status,
      providerStatus: campaign.sync?.providerStatus || "idle",
      instantlyCampaignId: campaign.instantly?.campaignId || "",
      senderAccountEmail: campaign.instantly?.senderAccountEmail || "",
      senderAccounts: campaign.instantly?.accountEmails || [],
      prospectCount: Array.isArray(campaign.prospectIds) ? campaign.prospectIds.length : 0,
      scheduleWindows: campaign.configuration?.schedule?.windows?.length || 0,
      sequenceSteps: campaign.configuration?.sequences?.length || 0,
      issues: [],
      warnings: [],
    };

    if (!campaign.instantly?.accountEmails?.length) {
      diagnostics.issues.push("No sender mailboxes are assigned");
    }

    if (!campaign.instantly?.senderAccountEmail) {
      diagnostics.issues.push("Primary sender mailbox is missing");
    }

    if (!campaign.configuration?.sequences?.length) {
      diagnostics.issues.push("No sequence steps configured");
    }

    if (!campaign.configuration?.schedule?.windows?.length) {
      diagnostics.issues.push("No sending schedule configured");
    }

    if (!campaign.prospectIds?.length) {
      diagnostics.warnings.push("No leads are attached to this campaign");
    }

    if (campaign.status === OUTREACH_CAMPAIGN_STATUS.ERROR && campaign.sync?.lastErrorMessage) {
      diagnostics.issues.push(campaign.sync.lastErrorMessage);
    }

    if (campaign.instantly?.campaignId) {
      try {
        const sendingStatus = await instantlyService.getCampaignSendingStatus(
          campaign.instantly.campaignId,
          {}
        );
        diagnostics.sendingStatus = sendingStatus;
      } catch (error) {
        diagnostics.warnings.push(
          error?.response?.data?.message ||
          error?.message ||
          "Unable to fetch provider sending status"
        );
      }
    } else {
      diagnostics.warnings.push("Campaign has not been launched to Instantly yet");
    }

    return res.status(200).json({
      success: true,
      message: diagnostics.issues.length
        ? "Campaign has configuration issues"
        : "Campaign looks healthy",
      data: diagnostics,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "DIAGNOSE_OUTREACH_CAMPAIGN_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to diagnose campaign");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.updateCampaignContactStage = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "revenue_head", "super_admin"]);
    const campaign = await getAccessibleCampaign(req, req.params.id);
    const { prospectId } = req.params;
    const stage = String(req.body?.stage || "").trim();

    if (!stage) {
      return res.status(400).json({
        success: false,
        message: "stage is required",
      });
    }

    const isAttached = (campaign.prospectIds || []).some(
      (id) => String(id) === String(prospectId)
    );

    if (!isAttached) {
      return res.status(404).json({
        success: false,
        message: "Lead is not attached to this campaign",
      });
    }

    const updated = await ProspectBrand.findByIdAndUpdate(
      prospectId,
      { $set: { stage } },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Lead stage updated successfully",
      data: updated,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "UPDATE_CAMPAIGN_CONTACT_STAGE_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to update lead stage");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.removeCampaignContact = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);
    const campaign = await getManagedCampaign(req, req.params.id);
    const { prospectId } = req.params;

    campaign.prospectIds = (campaign.prospectIds || []).filter(
      (id) => String(id) !== String(prospectId)
    );
    campaign.stats.totalProspects = campaign.prospectIds.length;
    await campaign.save();

    return res.status(200).json({
      success: true,
      message: "Lead removed from campaign successfully",
      data: {
        campaignId: campaign._id,
        prospectId,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "REMOVE_CAMPAIGN_CONTACT_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to remove lead from campaign");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

const CSV_COLUMN_TYPE = {
  IGNORE: "ignore",
  FIRST_NAME: "first_name",
  LAST_NAME: "last_name",
  FULL_NAME: "full_name",
  EMAIL: "email",
  COMPANY_NAME: "company_name",
  JOB_TITLE: "job_title",
  WEBSITE: "website",
  PHONE: "phone",
  LINKEDIN_URL: "linkedin_url",
  CUSTOM: "custom",
};

function normalizeTemplateVariableKey(value = "") {
  const cleaned = String(value || "")
    .replace(/[{}]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim();

  if (!cleaned) return "field";

  return cleaned.split(/\s+/).filter(Boolean).join("");
}

const CSV_STANDARD_VARIABLE_BY_TYPE = {
  [CSV_COLUMN_TYPE.FIRST_NAME]: "firstName",
  [CSV_COLUMN_TYPE.LAST_NAME]: "lastName",
  [CSV_COLUMN_TYPE.FULL_NAME]: "fullName",
  [CSV_COLUMN_TYPE.EMAIL]: "email",
  [CSV_COLUMN_TYPE.COMPANY_NAME]: "companyName",
  [CSV_COLUMN_TYPE.JOB_TITLE]: "jobTitle",
  [CSV_COLUMN_TYPE.WEBSITE]: "website",
  [CSV_COLUMN_TYPE.PHONE]: "phone",
  [CSV_COLUMN_TYPE.LINKEDIN_URL]: "linkedinUrl",
};

function normalizeTemplateVariableToken(value = "") {
  return String(value || "")
    .replace(/[{}]/g, "")
    .trim();
}

function getTemplateVariableKeyForColumn(column = {}) {
  const selectedType = String(column?.selectedType || "").trim().toLowerCase();

  if (!selectedType || selectedType === CSV_COLUMN_TYPE.IGNORE) {
    return "";
  }

  if (selectedType === CSV_COLUMN_TYPE.CUSTOM) {
    return normalizeTemplateVariableKey(column?.variableKey || column?.header || "");
  }

  return CSV_STANDARD_VARIABLE_BY_TYPE[selectedType] || "";
}

function toTemplateVariableToken(key = "") {
  const normalized = normalizeTemplateVariableToken(key);
  return normalized ? `{{${normalized}}}` : "";
}

function buildAllowedVariableLookup(templateVariables = []) {
  const lookup = new Map();

  (Array.isArray(templateVariables) ? templateVariables : []).forEach((item) => {
    const key = normalizeTemplateVariableToken(item);
    if (!key) return;
    lookup.set(key.toLowerCase(), key);
  });

  return lookup;
}

function normalizeTemplateVariablesInContent(content = "", templateVariables = []) {
  const allowedLookup = buildAllowedVariableLookup(templateVariables);

  return String(content || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const canonicalKey = allowedLookup.get(String(key || "").trim().toLowerCase());
    return canonicalKey ? `{{${canonicalKey}}}` : "";
  });
}

function inferCsvColumnType(header = "", samples = []) {
  const key = normalizeHeaderKey(header);
  const joinedSamples = samples.join(" ").toLowerCase();

  if (key.includes("email")) return CSV_COLUMN_TYPE.EMAIL;
  if (key.includes("brand") || key.includes("company")) return CSV_COLUMN_TYPE.COMPANY_NAME;
  if (key.includes("website") || key.includes("site") || key.includes("domain")) {
    return CSV_COLUMN_TYPE.WEBSITE;
  }
  if (key.includes("jobtitle") || key.includes("designation") || key.includes("title")) {
    return CSV_COLUMN_TYPE.JOB_TITLE;
  }
  if (key.includes("phone") || key.includes("mobile") || key.includes("whatsapp")) {
    return CSV_COLUMN_TYPE.PHONE;
  }
  if (key.includes("linkedin")) return CSV_COLUMN_TYPE.LINKEDIN_URL;
  if (key === "name" || key.includes("fullname") || key.includes("contactname")) {
    return CSV_COLUMN_TYPE.FULL_NAME;
  }
  if (key.includes("firstname") || key === "fname" || key === "poc") {
    return CSV_COLUMN_TYPE.FIRST_NAME;
  }
  if (key.includes("lastname") || key === "lname") {
    return CSV_COLUMN_TYPE.LAST_NAME;
  }

  if (joinedSamples.includes("@")) return CSV_COLUMN_TYPE.EMAIL;
  if (joinedSamples.includes("http")) return CSV_COLUMN_TYPE.WEBSITE;

  return CSV_COLUMN_TYPE.CUSTOM;
}

function collectSampleValues(rows = [], header = "", limit = 4) {
  const values = [];

  for (const row of rows) {
    const value = row?.[header];
    const stringValue = String(value ?? "").trim();
    if (!stringValue) continue;
    values.push(stringValue);
    if (values.length >= limit) break;
  }

  return values;
}

function buildCsvPreviewColumns(rows = []) {
  const headers = rows.length ? Object.keys(rows[0]) : [];

  return headers.map((header) => {
    const samples = collectSampleValues(rows, header, 4);
    const inferredType = inferCsvColumnType(header, samples);

    return {
      header,
      variableKey: normalizeTemplateVariableKey(header),
      inferredType,
      selectedType: inferredType,
      samples,
    };
  });
}

function normalizeIncomingColumnMappings(inputColumns = [], rows = []) {
  const fallbackColumns = buildCsvPreviewColumns(rows);
  const fallbackMap = new Map(fallbackColumns.map((item) => [item.header, item]));

  return (Array.isArray(inputColumns) ? inputColumns : [])
    .map((item) => {
      const base = fallbackMap.get(item?.header) || {
        header: item?.header || "",
        variableKey: normalizeTemplateVariableKey(item?.header || ""),
        inferredType: CSV_COLUMN_TYPE.CUSTOM,
        selectedType: CSV_COLUMN_TYPE.CUSTOM,
        samples: [],
      };

      return {
        header: String(item?.header || base.header || "").trim(),
        variableKey: normalizeTemplateVariableKey(item?.variableKey || base.variableKey || item?.header || ""),
        inferredType: String(item?.inferredType || base.inferredType || CSV_COLUMN_TYPE.CUSTOM),
        selectedType: String(item?.selectedType || base.selectedType || CSV_COLUMN_TYPE.CUSTOM),
        samples: Array.isArray(item?.samples) && item.samples.length ? item.samples : base.samples,
      };
    })
    .filter((item) => item.header);
}

function buildTemplateVariableList(columns = []) {
  const vars = new Set();

  (Array.isArray(columns) ? columns : []).forEach((column) => {
    const variableKey = getTemplateVariableKeyForColumn(column);
    const variable = toTemplateVariableToken(variableKey);

    if (variable) vars.add(variable);
  });

  return [...vars];
}

function getCampaignMappedTemplateVariables(campaign = {}) {
  const columns = Array.isArray(campaign?.csvSchema?.columns)
    ? campaign.csvSchema.columns
    : [];

  const csvVariables = buildTemplateVariableList(columns);

  if (columns.length) {
    return csvVariables;
  }

  return Array.isArray(campaign?.templateVariables) ? campaign.templateVariables : [];
}

function getTemplateVariableKeySet(templateVariables = []) {
  const keys = new Set();

  (Array.isArray(templateVariables) ? templateVariables : []).forEach((item) => {
    const key = normalizeTemplateVariableToken(item);
    if (!key) return;
    keys.add(key);
  });

  return keys;
}

function filterVariablesToAllowed(input = {}, templateVariables = []) {
  const allowedKeys = getTemplateVariableKeySet(templateVariables);
  const output = {};

  allowedKeys.forEach((key) => {
    const exactValue = input?.[key];

    if (exactValue !== undefined && exactValue !== null) {
      output[key] = String(exactValue);
      return;
    }

    const matchedKey = Object.keys(input || {}).find(
      (candidate) => String(candidate || '').toLowerCase() === key.toLowerCase()
    );

    output[key] = matchedKey ? String(input[matchedKey] ?? '') : '';
  });

  return output;
}

function getMappedCellValue(row = {}, columns = [], type) {
  const match = columns.find((column) => column.selectedType === type);
  if (!match) return "";
  return String(row?.[match.header] ?? "").trim();
}

function buildTemplateVariableMapFromRow(row = {}, columns = []) {
  const variables = {};

  (Array.isArray(columns) ? columns : []).forEach((column) => {
    const selectedType = String(column?.selectedType || "").trim().toLowerCase();
    if (!selectedType || selectedType === CSV_COLUMN_TYPE.IGNORE) return;

    const variableKey = getTemplateVariableKeyForColumn(column);
    if (!variableKey) return;

    const rawValue = row?.[column.header];
    const stringValue = String(rawValue ?? "").trim();

    variables[variableKey] = stringValue;
  });

  return variables;
}

async function upsertProspectsFromMappedRows(rows = [], columns = [], sourceFileName = "") {
  const docs = [];

  for (const row of rows) {
    const email = getMappedCellValue(row, columns, CSV_COLUMN_TYPE.EMAIL).toLowerCase();
    if (!email) continue;

    const companyName =
      getMappedCellValue(row, columns, CSV_COLUMN_TYPE.COMPANY_NAME) ||
      String(row?.brand || row?.company || row?.Company || "").trim();

    const firstName = getMappedCellValue(row, columns, CSV_COLUMN_TYPE.FIRST_NAME);
    const lastName = getMappedCellValue(row, columns, CSV_COLUMN_TYPE.LAST_NAME);

    const fullName =
      getMappedCellValue(row, columns, CSV_COLUMN_TYPE.FULL_NAME) ||
      [firstName, lastName].filter(Boolean).join(" ").trim();

    const title = getMappedCellValue(row, columns, CSV_COLUMN_TYPE.JOB_TITLE);
    const website = getMappedCellValue(row, columns, CSV_COLUMN_TYPE.WEBSITE);
    const linkedinUrl = getMappedCellValue(row, columns, CSV_COLUMN_TYPE.LINKEDIN_URL);
    const phone = getMappedCellValue(row, columns, CSV_COLUMN_TYPE.PHONE);

    const templateVariables = buildTemplateVariableMapFromRow(row, columns);
    const emailFallbackName = fallbackNameFromEmail(email);

    const resolvedCompanyName =
      companyName ||
      templateVariables.companyName ||
      fullName ||
      firstName ||
      emailFallbackName ||
      "Lead";

    const resolvedContactName =
      fullName ||
      firstName ||
      templateVariables.fullName ||
      templateVariables.firstName ||
      emailFallbackName ||
      resolvedCompanyName;

    const nextTemplateVariables = { ...templateVariables };

    const doc = await ProspectBrand.findOneAndUpdate(
      { "primaryContact.email": email },
      {
        $set: {
          companyName: resolvedCompanyName,
          website: website || nextTemplateVariables.website || "",
          source: "csv",
          primaryContact: {
            name: resolvedContactName,
            email,
            title: title || "",
            linkedinUrl: linkedinUrl || "",
            phone: phone || "",
          },
          customFields: row,
          templateVariables: nextTemplateVariables,
          csvMeta: {
            headers: Object.keys(row || {}),
            mappedAt: new Date(),
            sourceFileName,
          },
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    docs.push(doc);
  }

  if (!docs.length) {
    const error = new Error("No valid contacts found");
    error.statusCode = 400;
    throw error;
  }

  return docs;
}

function buildDefaultSequence() {
  return [
    {
      stepOrder: 1,
      type: "email",
      delay: 0,
      delayUnit: "days",
      preDelay: 0,
      preDelayUnit: "days",
      variants: [
        {
          subject: "Collab opportunity with {{companyName}}",
          body: [
            "Hi {{firstName}},",
            "",
            "We’d love to explore a collaboration opportunity with {{companyName}}.",
            "",
            "Would you be open to a quick conversation?",
            "",
            "Best,",
            "CollabGlam",
          ].join("\n"),
        },
      ],
    },
  ];
}

function buildPreviewRows(rows = [], limit = 10) {
  return rows.slice(0, limit).map((row) => {
    const normalized = {};
    Object.keys(row || {}).forEach((key) => {
      normalized[key] = String(row[key] ?? "").trim();
    });
    return normalized;
  });
}

exports.previewCampaignContactsCsv = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);

    await getManagedCampaign(req, req.params.id);

    if (!req.file?.buffer) {
      return res.status(400).json({
        success: false,
        message: "CSV file is required",
      });
    }

    const csvText = req.file.buffer.toString("utf-8");

    const rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      delimiter: [",", "\t", ";"],
    });

    const columns = buildCsvPreviewColumns(rows);
    const templateVariables = buildTemplateVariableList(columns);
    const previewRows = buildPreviewRows(rows, 10);

    return res.status(200).json({
      success: true,
      data: {
        fileName: req.file.originalname || "contacts.csv",
        totalRows: rows.length,
        columns,
        previewRows,
        templateVariables,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "PREVIEW_CAMPAIGN_CONTACTS_CSV_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to preview CSV");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.getCampaignTemplateVariables = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "revenue_head", "super_admin"]);
    const campaign = await getAccessibleCampaign(req, req.params.id);

    const columns = Array.isArray(campaign.csvSchema?.columns) ? campaign.csvSchema.columns : [];
    const templateVariables = getCampaignMappedTemplateVariables(campaign);

    return res.status(200).json({
      success: true,
      data: {
        templateVariables,
        columns,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "GET_CAMPAIGN_TEMPLATE_VARIABLES_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to load template variables");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

function normalizeSequenceVariants(variants = []) {
  const rows = Array.isArray(variants) ? variants : [];
  if (!rows.length) return [{ subject: "", body: "" }];

  return rows.map((variant) => ({
    subject: String(variant?.subject || "").trim(),
    body: String(variant?.body || ""),
  }));
}

function normalizeCampaignSequences(input = []) {
  const rows = Array.isArray(input) ? input : [];

  if (!rows.length) {
    return [
      {
        stepOrder: 1,
        type: "email",
        delay: 0,
        delayUnit: "days",
        preDelay: 0,
        preDelayUnit: "days",
        variants: [{ subject: "", body: "" }],
      },
    ];
  }

  return rows.map((step, index) => {
    const isFirstStep = index === 0;

    return {
      stepOrder: index + 1,
      type: "email",
      delay: isFirstStep ? 0 : Math.max(1, Number(step?.delay || 1)),
      delayUnit: isFirstStep
        ? "days"
        : ["minutes", "hours", "days"].includes(step?.delayUnit)
          ? step.delayUnit
          : "days",
      preDelay: 0,
      preDelayUnit: "days",
      variants: normalizeSequenceVariants(step?.variants),
    };
  });
}

function normalizeSubsequenceSteps(input = []) {
  const rows = Array.isArray(input) ? input : [];

  if (!rows.length) {
    return [
      {
        stepOrder: 1,
        type: "email",
        delay: 1,
        delayUnit: "days",
        variants: [{ subject: "", body: "" }],
      },
    ];
  }

  return rows.map((step, index) => ({
    stepOrder: index + 1,
    type: "email",
    delay: Math.max(0, Number(step?.delay || (index === 0 ? 0 : 1))),
    delayUnit: ["minutes", "hours", "days"].includes(step?.delayUnit)
      ? step.delayUnit
      : "days",
    variants: normalizeSequenceVariants(step?.variants),
  }));
}

function buildSystemTemplates() {
  return [
    {
      _id: "system_lead_generation_quick_question",
      isSystem: true,
      category: "lead_generation",
      name: "Quick question",
      subject: "{{firstName}} - quick question",
      body: `Hey {{firstName}},

Your LinkedIn was impressive and I wanted to reach out directly :)

So we’re helping {{companyName}} from {{location}} to fill their cal with 5-12 calls with their ideal customer daily. If you let me have a call with you about how we can do the same for you, I will send you a burger with UberEats :D

Are you free any time this week for a quick chat?

Cheers,
NAME

Reply “No thanks” if you wish to no longer receive messages from me.`,
    },
    {
      _id: "system_follow_up_gentle",
      isSystem: true,
      category: "follow_ups",
      name: "Gentle follow-up",
      subject: "",
      body: `Hey {{firstName}},

Just wanted to follow up on my previous note in case it got buried.

Would love to know if this is relevant for {{companyName}}.

Best,
NAME`,
    },
  ];
}

function buildSubsequencePhraseList(phrases = []) {
  return (Array.isArray(phrases) ? phrases : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

exports.listCampaignTemplates = async (req, res) => {
  try {
    const campaign = await getAccessibleCampaign(req, req.params.id);

    const customTemplates = await OutreachTemplate.find({
      workspaceId: String(campaign._id),
    }).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: {
        systemTemplates: buildSystemTemplates(),
        customTemplates,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "LIST_CAMPAIGN_TEMPLATES_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to load templates");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};

exports.createCampaignTemplate = async (req, res) => {
  try {
    const campaign = await getManagedCampaign(req, req.params.id);

    const template = await OutreachTemplate.create({
      workspaceId: String(campaign._id),
      createdBy: req.admin?.adminId || req.admin?._id || null,
      category: String(req.body?.category || "custom_templates"),
      name: String(req.body?.name || "").trim(),
      subject: String(req.body?.subject || ""),
      body: String(req.body?.body || ""),
      isSystem: false,
    });

    return res.status(201).json({
      success: true,
      message: "Template created successfully",
      data: template,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "CREATE_CAMPAIGN_TEMPLATE_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to create template");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};

exports.updateCampaignTemplate = async (req, res) => {
  try {
    await getManagedCampaign(req, req.params.id);

    const template = await OutreachTemplate.findByIdAndUpdate(
      req.params.templateId,
      {
        $set: {
          name: String(req.body?.name || "").trim(),
          category: String(req.body?.category || "custom_templates"),
          subject: String(req.body?.subject || ""),
          body: String(req.body?.body || ""),
        },
      },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Template updated successfully",
      data: template,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "UPDATE_CAMPAIGN_TEMPLATE_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to update template");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};

exports.deleteCampaignTemplate = async (req, res) => {
  try {
    await getManagedCampaign(req, req.params.id);
    await OutreachTemplate.findByIdAndDelete(req.params.templateId);

    return res.status(200).json({
      success: true,
      message: "Template deleted successfully",
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "DELETE_CAMPAIGN_TEMPLATE_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to delete template");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};

exports.listCampaignSubsequences = async (req, res) => {
  try {
    const campaign = await getAccessibleCampaign(req, req.params.id);

    if (campaign.status !== "launched") {
      return res.status(200).json({
        success: true,
        data: [],
        meta: { launchRequired: true },
      });
    }

    const subsequences = await OutreachSubsequence.find({
      campaignId: campaign._id,
    }).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: subsequences,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "LIST_CAMPAIGN_SUBSEQUENCES_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to load subsequences");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};

exports.createCampaignSubsequence = async (req, res) => {
  try {
    const campaign = await getManagedCampaign(req, req.params.id);

    if (campaign.status !== "launched") {
      return res.status(400).json({
        success: false,
        message: "Subsequences are available only after the campaign is launched",
      });
    }

    const subsequence = await OutreachSubsequence.create({
      campaignId: campaign._id,
      name: String(req.body?.name || "New subsequence").trim(),
      trigger: {
        statuses: Array.isArray(req.body?.trigger?.statuses) ? req.body.trigger.statuses : [],
        activities: Array.isArray(req.body?.trigger?.activities) ? req.body.trigger.activities : [],
        phrases: buildSubsequencePhraseList(req.body?.trigger?.phrases),
      },
      scheduleMode: req.body?.scheduleMode || "inherit",
      schedule: req.body?.schedule || campaign.configuration?.schedule || {},
      dailyLimitMode: req.body?.dailyLimitMode || "inherit",
      dailyLimit: Number(req.body?.dailyLimit || 0),
      ignoreAccountDailyLimits: Boolean(req.body?.ignoreAccountDailyLimits),
      sequences: normalizeSubsequenceSteps(req.body?.sequences),
    });

    return res.status(201).json({
      success: true,
      message: "Subsequence created successfully",
      data: subsequence,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "CREATE_CAMPAIGN_SUBSEQUENCE_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to create subsequence");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};

exports.getCampaignSubsequenceById = async (req, res) => {
  try {
    await getAccessibleCampaign(req, req.params.id);

    const subsequence = await OutreachSubsequence.findOne({
      _id: req.params.subsequenceId,
      campaignId: req.params.id,
    });

    return res.status(200).json({
      success: true,
      data: subsequence,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "GET_CAMPAIGN_SUBSEQUENCE_BY_ID_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to load subsequence");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};

exports.updateCampaignSubsequence = async (req, res) => {
  try {
    await getManagedCampaign(req, req.params.id);

    const subsequence = await OutreachSubsequence.findOneAndUpdate(
      { _id: req.params.subsequenceId, campaignId: req.params.id },
      {
        $set: {
          name: String(req.body?.name || "").trim(),
          trigger: {
            statuses: Array.isArray(req.body?.trigger?.statuses) ? req.body.trigger.statuses : [],
            activities: Array.isArray(req.body?.trigger?.activities) ? req.body.trigger.activities : [],
            phrases: buildSubsequencePhraseList(req.body?.trigger?.phrases),
          },
          scheduleMode: req.body?.scheduleMode || "inherit",
          schedule: req.body?.schedule || {},
          dailyLimitMode: req.body?.dailyLimitMode || "inherit",
          dailyLimit: Number(req.body?.dailyLimit || 0),
          ignoreAccountDailyLimits: Boolean(req.body?.ignoreAccountDailyLimits),
          sequences: normalizeSubsequenceSteps(req.body?.sequences),
        },
      },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Subsequence updated successfully",
      data: subsequence,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "UPDATE_CAMPAIGN_SUBSEQUENCE_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to update subsequence");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};

exports.deleteCampaignSubsequence = async (req, res) => {
  try {
    await getManagedCampaign(req, req.params.id);

    await OutreachSubsequence.deleteOne({
      _id: req.params.subsequenceId,
      campaignId: req.params.id,
    });

    return res.status(200).json({
      success: true,
      message: "Subsequence deleted successfully",
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "DELETE_CAMPAIGN_SUBSEQUENCE_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to delete subsequence");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};

exports.launchCampaignSubsequence = async (req, res) => {
  try {
    await getManagedCampaign(req, req.params.id);

    const subsequence = await OutreachSubsequence.findOneAndUpdate(
      { _id: req.params.subsequenceId, campaignId: req.params.id },
      { $set: { status: "launched" } },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Subsequence launched successfully",
      data: subsequence,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "LAUNCH_CAMPAIGN_SUBSEQUENCE_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to launch subsequence");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};

exports.pauseCampaignSubsequence = async (req, res) => {
  try {
    await getManagedCampaign(req, req.params.id);

    const subsequence = await OutreachSubsequence.findOneAndUpdate(
      { _id: req.params.subsequenceId, campaignId: req.params.id },
      { $set: { status: "paused" } },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Subsequence paused successfully",
      data: subsequence,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "PAUSE_CAMPAIGN_SUBSEQUENCE_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to pause subsequence");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};

exports.duplicateCampaignSubsequence = async (req, res) => {
  try {
    await getManagedCampaign(req, req.params.id);

    const source = await OutreachSubsequence.findOne({
      _id: req.params.subsequenceId,
      campaignId: req.params.id,
    }).lean();

    if (!source) {
      return res.status(404).json({
        success: false,
        message: "Subsequence not found",
      });
    }

    delete source._id;
    delete source.createdAt;
    delete source.updatedAt;

    const duplicated = await OutreachSubsequence.create({
      ...source,
      name: `${source.name} (Copy)`,
      status: "draft",
    });

    return res.status(201).json({
      success: true,
      message: "Subsequence duplicated successfully",
      data: duplicated,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "DUPLICATE_CAMPAIGN_SUBSEQUENCE_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to duplicate subsequence");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};

exports.moveLeadsToSubsequence = async (req, res) => {
  try {
    await getManagedCampaign(req, req.params.id);

    const leadIds = Array.isArray(req.body?.leadIds) ? req.body.leadIds : [];
    const subsequence = await OutreachSubsequence.findById(req.params.subsequenceId);

    if (!subsequence) {
      return res.status(404).json({
        success: false,
        message: "Subsequence not found",
      });
    }

    const prospects = await ProspectBrand.find({
      _id: { $in: leadIds },
    });

    const providerLeadIds = prospects
      .map((item) => item?.instantly?.leadId)
      .filter(Boolean);

    let providerResult = null;
    if (providerLeadIds.length && subsequence?.instantly?.subsequenceId) {
      providerResult = await instantlyService.moveLeadsToSubsequence({
        lead_ids: providerLeadIds,
        subsequence_id: subsequence.instantly.subsequenceId,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Leads moved to subsequence successfully",
      data: {
        movedCount: leadIds.length,
        providerResult,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "MOVE_LEADS_TO_SUBSEQUENCE_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to move leads to subsequence");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};

exports.removeLeadFromSubsequence = async (req, res) => {
  try {
    await getManagedCampaign(req, req.params.id);

    const subsequence = await OutreachSubsequence.findById(req.params.subsequenceId);
    const prospect = await ProspectBrand.findById(req.body?.leadId);

    if (!subsequence || !prospect) {
      return res.status(404).json({
        success: false,
        message: "Subsequence or lead not found",
      });
    }

    let providerResult = null;
    if (prospect?.instantly?.leadId && subsequence?.instantly?.subsequenceId) {
      providerResult = await instantlyService.removeLeadFromSubsequence({
        lead_id: prospect.instantly.leadId,
        subsequence_id: subsequence.instantly.subsequenceId,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Lead removed from subsequence successfully",
      data: providerResult,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.response?.status || error?.statusCode || error?.status || 500, "REMOVE_LEAD_FROM_SUBSEQUENCE_ERROR");
    const payload = getAxiosErrorPayload(error, "Failed to remove lead from subsequence");
    return res.status(payload.statusCode).json({ success: false, ...payload });
  }
};