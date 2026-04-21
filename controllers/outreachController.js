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
const instantlyService = require("../services/instantlyService");

const SDR_ROLE = ROLES?.SDR || "sdr";
const RH_ROLE = ROLES?.REVENUE_HEAD || "revenue_head";
const IME_ROLE = ROLES?.IME || "ime";

function readExternalId(value) {
  return String(value?.id || value?._id || value?.data?.id || "").trim();
}

function uniqueIds(values = []) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
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

function buildDefaultSequence() {
  return [
    {
      stepOrder: 1,
      type: "email",
      delay: 1,
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
      .map((variant) => ({
        subject: String(variant?.subject || "").trim(),
        body: String(variant?.body || variant?.bodyText || "").trim(),
      }))
      .filter((variant) => variant.subject || variant.body),
  };
}

function normalizeCampaignSequences(sequences = [], fallback = buildDefaultSequence()) {
  const input =
    Array.isArray(sequences) && sequences.length
      ? sequences
      : Array.isArray(sequences?.[0]?.steps)
        ? sequences[0].steps
        : fallback;

  const normalized = input
    .map((step, index) => normalizeSequenceStep(step, index))
    .filter((step) => step.variants.length);

  return normalized.length ? normalized : fallback;
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

function buildInstantlySequences(sequences = []) {
  const normalized = normalizeCampaignSequences(sequences);

  return [
    {
      steps: normalized.map((step) => ({
        type: step.type,
        delay: step.delay,
        delay_unit: step.delayUnit,
        pre_delay: step.preDelay,
        pre_delay_unit: step.preDelayUnit,
        variants: step.variants.map((variant) => ({
          subject: variant.subject,
          body: variant.body,
        })),
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
}) {
  const normalizedConfiguration = normalizeCampaignConfiguration(configuration || {});
  const sendingOptions = normalizeSendingOptions(normalizedConfiguration.sendingOptions);
  const rawPayload = { ...(rawCampaignPayload || {}) };

  delete rawPayload.name;
  delete rawPayload.email_list;
  delete rawPayload.campaign_schedule;
  delete rawPayload.sequences;

  return {
    ...rawPayload,
    name: campaignName,
    campaign_schedule: buildInstantlyCampaignSchedule(normalizedConfiguration.schedule),
    sequences: buildInstantlySequences(normalizedConfiguration.sequences),
    email_list: Array.isArray(senderEmails) ? senderEmails : [],
    daily_limit: sendingOptions.dailyLimit,
    daily_max_leads: sendingOptions.dailyMaxLeads,
    email_gap: sendingOptions.emailGap,
    random_wait_max: sendingOptions.randomWaitMax,
    stop_on_reply: sendingOptions.stopOnReply,
    stop_on_auto_reply: sendingOptions.stopOnAutoReply,
    link_tracking: sendingOptions.linkTracking,
    open_tracking: sendingOptions.openTracking,
    text_only: sendingOptions.textOnly,
    first_email_text_only: sendingOptions.firstEmailTextOnly,
    is_evergreen: sendingOptions.isEvergreen,
    prioritize_new_leads: sendingOptions.prioritizeNewLeads,
    match_lead_esp: sendingOptions.matchLeadEsp,
    stop_for_company: sendingOptions.stopForCompany,
    insert_unsubscribe_header: sendingOptions.insertUnsubscribeHeader,
    allow_risky_contacts: sendingOptions.allowRiskyContacts,
    disable_bounce_protect: sendingOptions.disableBounceProtect,
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

async function getActiveImeMailbox(imeId) {
  if (!imeId) return null;

  return OutreachMailboxAssignment.findOne({
    adminId: imeId,
    role: OWNER_ROLE.IME,
    isActive: true,
  }).lean();
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

  if (req.admin.role === "super_admin") return campaign;

  if (
    req.admin.role === "sdr" &&
    String(campaign.sdrId) === String(req.admin.adminId)
  ) {
    return campaign;
  }

  if (
    req.admin.role === "ime" &&
    String(campaign.IMEId) === String(req.admin.adminId)
  ) {
    return campaign;
  }

  const error = new Error("You do not own this campaign");
  error.statusCode = 403;
  throw error;
}

async function getAccessibleCampaign(req, campaignId) {
  const campaign = await OutreachCampaign.findById(campaignId)
    .populate("sdrId", "name email role")
    .populate("RHId", "name email role")
    .populate("IMEId", "name email role");

  if (!campaign) {
    const error = new Error("Campaign not found");
    error.statusCode = 404;
    throw error;
  }

  if (req.admin.role === "super_admin") return campaign;

  if (
    req.admin.role === "sdr" &&
    String(campaign.sdrId?._id || campaign.sdrId) === String(req.admin.adminId)
  ) {
    return campaign;
  }

  if (
    req.admin.role === "revenue_head" &&
    String(campaign.RHId?._id || campaign.RHId) === String(req.admin.adminId)
  ) {
    return campaign;
  }

  if (
    req.admin.role === "ime" &&
    String(campaign.IMEId?._id || campaign.IMEId) === String(req.admin.adminId)
  ) {
    return campaign;
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

async function upsertProspectsFromRows(rows = []) {
  const normalizedRows = rows
    .map(normalizeContactRow)
    .filter((row) => row.companyName && row.contactEmail);

  if (!normalizedRows.length) {
    const error = new Error("No valid contacts found");
    error.statusCode = 400;
    throw error;
  }

  const docs = [];

  for (const row of normalizedRows) {
    const doc = await ProspectBrand.findOneAndUpdate(
      { "primaryContact.email": row.contactEmail },
      {
        $setOnInsert: {
          companyName: row.companyName,
          website: row.website || "",
          source: "csv",
          primaryContact: {
            name: row.contactName || "",
            email: row.contactEmail,
          },
        },
      },
      {
        new: true,
        upsert: true,
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
      leads: newDocs.map((item) => ({
        email: item.primaryContact.email,
        first_name: item.primaryContact.name || "",
        company_name: item.companyName || "",
        website: item.website || "",
      })),
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
      const imeMailbox = await getActiveImeMailbox(ime._id);

      campaign = await OutreachCampaign.create({
        name,
        flowType,
        IMEId: ime._id,
        createdByAdminId: req.admin.adminId,
        configuration,
        instantly: {
          accountEmails: imeMailbox?.email ? [imeMailbox.email] : [],
          senderAccountEmail: imeMailbox?.email || "",
          leadListId: "",
          campaignId: "",
          rawCampaignPayload: req.body?.instantlyRawCampaignPayload || null,
        },
        teamMailboxes: {
          IMEEmail: imeMailbox?.email || "",
        },
        status: OUTREACH_CAMPAIGN_STATUS.DRAFT,
        stats: {
          totalProspects: 0,
          totalReplies: 0,
          totalQualified: 0,
          totalAssigned: 0,
        },
      });
    } else {
      const { sdr, rh } = await getStandardCreateContext(req);
      const activeSenders = await getActiveSdrSenders(sdr._id);
      const primarySender =
        activeSenders.find((item) => item.isPrimary) || activeSenders[0] || null;
      const rhMailbox = await getActiveRhMailbox(rh._id);

      campaign = await OutreachCampaign.create({
        name,
        flowType,
        sdrId: sdr._id,
        RHId: rh._id,
        createdByAdminId: req.admin.adminId,
        configuration,
        instantly: {
          accountEmails: activeSenders.map((item) => item.email),
          senderAccountEmail: primarySender?.email || "",
          leadListId: "",
          campaignId: "",
          rawCampaignPayload: req.body?.instantlyRawCampaignPayload || null,
        },
        teamMailboxes: {
          RHEmail: rhMailbox?.email || "",
        },
        status: OUTREACH_CAMPAIGN_STATUS.DRAFT,
        stats: {
          totalProspects: 0,
          totalReplies: 0,
          totalQualified: 0,
          totalAssigned: 0,
        },
      });
    }

    const populated = await OutreachCampaign.findById(campaign._id)
      .populate("sdrId", "name email role")
      .populate("RHId", "name email role")
      .populate("IMEId", "name email role");

    return res.status(201).json({
      success: true,
      message: "Campaign created successfully",
      data: populated,
    });
  } catch (error) {
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

    const filter = {};
    const status = String(req.query?.status || "").trim().toLowerCase();

    if (status) {
      filter.status = status;
    }

    if (req.admin.role === "sdr") {
      filter.sdrId = req.admin.adminId;
    } else if (req.admin.role === "revenue_head") {
      filter.RHId = req.admin.adminId;
    } else if (req.admin.role === "ime") {
      filter.IMEId = req.admin.adminId;
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
    const payload = getAxiosErrorPayload(error, "Internal error");
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

    return res.status(200).json({
      success: true,
      data: campaign,
    });
  } catch (error) {
    const payload = getAxiosErrorPayload(error, "Internal error");
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

    return res.status(200).json({
      success: true,
      data: {
        configuration: getCampaignConfigurationFromDocument(campaign),
        instantly: campaign.instantly || {},
        status: campaign.status,
        flowType: campaign.flowType || "standard_brand",
      },
    });
  } catch (error) {
    const payload = getAxiosErrorPayload(error, "Internal error");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.updateOutreachCampaignConfiguration = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);
    const campaign = await getManagedCampaign(req, req.params.id);

    const nextConfiguration = normalizeCampaignConfiguration(
      req.body?.configuration || req.body || {},
      getCampaignConfigurationFromDocument(campaign)
    );

    campaign.configuration = nextConfiguration;

    if (req.body?.instantlyRawCampaignPayload !== undefined) {
      campaign.instantly.rawCampaignPayload = req.body.instantlyRawCampaignPayload || null;
    }

    await campaign.save();

    if (req.body?.syncNow && campaign.instantly?.campaignId) {
      let senderEmails = [];
      let primarySenderEmail = campaign.instantly?.senderAccountEmail || "";

      if (isImeFlow(campaign)) {
        const imeMailbox = await getActiveImeMailbox(campaign.IMEId);
        if (imeMailbox?.email) {
          senderEmails = [imeMailbox.email];
          primarySenderEmail = imeMailbox.email;
          campaign.teamMailboxes.IMEEmail = imeMailbox.email;
        }
      } else {
        const senderAssignments = await getActiveSdrSenders(campaign.sdrId);
        const primarySender =
          senderAssignments.find((item) => item.isPrimary) || senderAssignments[0] || null;
        const rhMailbox = await getActiveRhMailbox(campaign.RHId);

        senderEmails = senderAssignments.map((item) => item.email);
        primarySenderEmail = primarySender?.email || primarySenderEmail;
        campaign.teamMailboxes.RHEmail = rhMailbox?.email || campaign.teamMailboxes?.RHEmail || "";
      }

      const updatePayload = buildCampaignCreatePayload({
        campaignName: campaign.name,
        senderEmails,
        configuration: campaign.configuration,
        rawCampaignPayload: campaign.instantly?.rawCampaignPayload || null,
      });

      await instantlyService.updateCampaign(campaign.instantly.campaignId, updatePayload);

      campaign.instantly.accountEmails = senderEmails;
      campaign.instantly.senderAccountEmail = primarySenderEmail;
      campaign.configuration.lastSyncedAt = new Date();
      campaign.configuration.lastSyncedBy = req.admin.adminId;
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

    let senderEmails = [];
    let primarySenderEmail = campaign.instantly?.senderAccountEmail || "";

    if (isImeFlow(campaign)) {
      const imeMailbox = await getActiveImeMailbox(campaign.IMEId);
      if (!imeMailbox?.email) {
        return res.status(400).json({
          success: false,
          message: "No mailbox is assigned to this IME",
        });
      }

      senderEmails = [imeMailbox.email];
      primarySenderEmail = imeMailbox.email;
      campaign.teamMailboxes.IMEEmail = imeMailbox.email;
    } else {
      const senderAssignments = await getActiveSdrSenders(campaign.sdrId);
      if (!senderAssignments.length) {
        return res.status(400).json({
          success: false,
          message: "No sender mailboxes are assigned to this SDR",
        });
      }

      const primarySender =
        senderAssignments.find((item) => item.isPrimary) || senderAssignments[0] || null;
      const rhMailbox = await getActiveRhMailbox(campaign.RHId);

      senderEmails = senderAssignments.map((item) => item.email);
      primarySenderEmail = primarySender?.email || primarySenderEmail;
      campaign.teamMailboxes.RHEmail = rhMailbox?.email || campaign.teamMailboxes?.RHEmail || "";
    }

    const updatePayload = buildCampaignCreatePayload({
      campaignName: campaign.name,
      senderEmails,
      configuration: getCampaignConfigurationFromDocument(campaign),
      rawCampaignPayload: campaign.instantly?.rawCampaignPayload || null,
    });

    const syncResult = await instantlyService.updateCampaign(
      campaign.instantly.campaignId,
      updatePayload
    );

    campaign.instantly.accountEmails = senderEmails;
    campaign.instantly.senderAccountEmail = primarySenderEmail;
    campaign.configuration.lastSyncedAt = new Date();
    campaign.configuration.lastSyncedBy = req.admin.adminId;
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
    const payload = getAxiosErrorPayload(error, "Failed to sync campaign with Instantly");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

function renderTemplate(template = "", variables = {}) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = variables[key];
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

exports.sendCampaignTestEmail = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "revenue_head", "super_admin"]);

    const campaign = await getAccessibleCampaign(req, req.params.id);
    const configuration = getCampaignConfigurationFromDocument(campaign);
    const firstVariant = configuration.sequences?.[0]?.variants?.[0] || {};

    const senderEmail = String(
      req.body?.accountEmail ||
      req.body?.eaccount ||
      campaign.instantly?.senderAccountEmail ||
      campaign.instantly?.accountEmails?.[0] ||
      ""
    ).trim();

    const toEmail = String(
      req.body?.toEmail ||
      req.body?.to_address_email_list ||
      ""
    ).trim();

    if (!senderEmail || !toEmail) {
      return res.status(400).json({
        success: false,
        message: "accountEmail and toEmail are required",
      });
    }

    const previewVars = {
      firstName: req.body?.variables?.firstName || "Devansh",
      companyName: req.body?.variables?.companyName || "CollabGlam",
      ...req.body?.variables,
    };

    const rawSubject = String(
      req.body?.subject ||
      firstVariant.subject ||
      `${campaign.name} test`
    );

    const rawBodyText = String(
      req.body?.bodyText ||
      firstVariant.body ||
      ""
    );

    const renderedSubject = renderTemplate(rawSubject, previewVars);
    const renderedBodyText = renderTemplate(rawBodyText, previewVars);

    const payload = {
      eaccount: senderEmail,
      to_address_email_list: toEmail,
      subject: renderedSubject,
      body: {
        html: `
          <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #111111;">
            ${textToHtml(renderedBodyText)}
          </div>
        `,
      },
    };

    const testResult = await instantlyService.sendTestEmail(payload);

    return res.status(200).json({
      success: true,
      message: "Test email request sent to Instantly",
      data: {
        sentPayload: payload,
        testResult,
      },
    });
  } catch (error) {
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
    });
  } catch (error) {
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

    const prospectDocs = await upsertProspectsFromRows(rows);
    const result = await attachProspectsToCampaign(campaign, prospectDocs);

    return res.status(200).json({
      success: true,
      message: result.instantlySynced
        ? "CSV uploaded and contacts synced to Instantly"
        : "CSV uploaded successfully",
      data: {
        campaignId: campaign._id,
        addedCount: result.addedCount,
        totalProspects: result.totalProspects,
        instantlySynced: result.instantlySynced,
        addLeadsResult: result.addLeadsResult,
      },
    });
  } catch (error) {
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
    const payload = getAxiosErrorPayload(error, "Failed to import Google Sheet");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.launchOutreachCampaign = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "ime", "super_admin"]);

    const campaign = await getManagedCampaign(req, req.params.id);
    const configuration = getCampaignConfigurationFromDocument(campaign);

    if (campaign.status === OUTREACH_CAMPAIGN_STATUS.LAUNCHED) {
      return res.status(400).json({
        success: false,
        message: "Campaign is already launched",
      });
    }

    const imeFlow = isImeFlow(campaign);

    let senderEmails = [];
    let primarySenderEmail = "";
    let createCampaignPayload = null;

    if (imeFlow) {
      const imeMailbox = await getActiveImeMailbox(campaign.IMEId);
      if (!imeMailbox?.email) {
        return res.status(400).json({
          success: false,
          message: "Selected IME must have one connected mailbox",
        });
      }

      senderEmails = [imeMailbox.email];
      primarySenderEmail = imeMailbox.email;
      campaign.teamMailboxes.IMEEmail = imeMailbox.email;
    } else {
      const senderAssignments = await getActiveSdrSenders(campaign.sdrId);
      if (!senderAssignments.length) {
        return res.status(400).json({
          success: false,
          message: "No sender mailboxes are assigned to this SDR",
        });
      }

      const primarySender =
        senderAssignments.find((item) => item.isPrimary) || senderAssignments[0];
      const rhMailbox = await getActiveRhMailbox(campaign.RHId);

      if (!rhMailbox) {
        return res.status(400).json({
          success: false,
          message: "Parent Revenue Head mailbox is not connected",
        });
      }

      senderEmails = senderAssignments.map((item) => item.email);
      primarySenderEmail = primarySender?.email || "";
      campaign.teamMailboxes.RHEmail = rhMailbox.email || "";
    }

    createCampaignPayload = buildCampaignCreatePayload({
      campaignName: campaign.name,
      senderEmails,
      configuration,
      rawCampaignPayload: campaign.instantly?.rawCampaignPayload || null,
    });

    if (
      campaign.status === OUTREACH_CAMPAIGN_STATUS.PAUSED &&
      campaign.instantly?.campaignId
    ) {
      try {
        await instantlyService.updateCampaign(campaign.instantly.campaignId, createCampaignPayload);
        await instantlyService.activateCampaign(campaign.instantly.campaignId);
      } catch (error) {
        const payload = getAxiosErrorPayload(error, "Failed to resume campaign in Instantly");
        return res.status(payload.statusCode).json({
          success: false,
          step: "activate_paused_campaign",
          ...payload,
        });
      }

      campaign.instantly.accountEmails = senderEmails;
      campaign.instantly.senderAccountEmail = primarySenderEmail;
      campaign.configuration.lastSyncedAt = new Date();
      campaign.configuration.lastSyncedBy = req.admin.adminId;
      campaign.status = OUTREACH_CAMPAIGN_STATUS.LAUNCHED;
      campaign.pausedAt = null;
      await campaign.save();

      return res.status(200).json({
        success: true,
        message: "Campaign resumed successfully",
        data: {
          campaignId: campaign._id,
          instantlyCampaignId: campaign.instantly.campaignId,
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

    let instantlyCampaign;
    try {
      instantlyCampaign = await instantlyService.createCampaign(createCampaignPayload);
    } catch (error) {
      const payload = getAxiosErrorPayload(error, "Failed to create campaign in Instantly");
      return res.status(payload.statusCode).json({
        success: false,
        step: "create_campaign",
        debug: {
          campaignName: campaign.name,
          senderEmails,
          createCampaignPayload,
        },
        ...payload,
      });
    }

    const instantlyCampaignId = readExternalId(instantlyCampaign);
    if (!instantlyCampaignId) {
      return res.status(400).json({
        success: false,
        step: "create_campaign",
        message: "Instantly campaign created but no campaignId was returned",
        details: instantlyCampaign || null,
      });
    }

    let addLeadsResult;
    try {
      addLeadsResult = await instantlyService.addLeads({
        campaign_id: instantlyCampaignId,
        leads: prospects.map((item) => ({
          email: item.primaryContact.email,
          first_name: item.primaryContact.name || "",
          company_name: item.companyName || "",
          website: item.website || "",
        })),
      });
    } catch (error) {
      const payload = getAxiosErrorPayload(error, "Failed to add leads to Instantly campaign");
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
      await instantlyService.activateCampaign(instantlyCampaignId);
    } catch (error) {
      const payload = getAxiosErrorPayload(error, "Failed to activate campaign in Instantly");
      return res.status(payload.statusCode).json({
        success: false,
        step: "activate_campaign",
        debug: {
          instantlyCampaignId,
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
    campaign.status = OUTREACH_CAMPAIGN_STATUS.LAUNCHED;
    campaign.launchValidatedAt = new Date();
    campaign.launchedAt = new Date();
    campaign.pausedAt = null;
    await campaign.save();

    await ProspectBrand.updateMany(
      { _id: { $in: campaign.prospectIds } },
      {
        $set: getProspectPatchForLiveCampaign(campaign),
      }
    );

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

    return res.status(200).json({
      success: true,
      message: "Campaign paused successfully",
    });
  } catch (error) {
    const payload = getAxiosErrorPayload(error, "Internal error");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};