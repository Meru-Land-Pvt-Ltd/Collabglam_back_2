const OUTREACH_CAMPAIGN_STATUS = {
  DRAFT: "draft",
  READY: "ready",
  LAUNCHED: "launched",
  PAUSED: "paused",
  COMPLETED: "completed",
  ERROR: "error",
};

const PROSPECT_STAGE = {
  NEW: "new",
  QUEUED: "queued",
  IN_SEQUENCE: "in_sequence",
  REPLIED_PENDING_REVIEW: "replied_pending_review",
  ASSIGNED_TO_BME: "assigned_to_bme",
  ASSIGNED_TO_IME: "assigned_to_ime",
  UNQUALIFIED: "unqualified",
  BLOCKED: "blocked",
  CLOSED: "closed",
};

const OWNER_ROLE = {
  SDR: "sdr",
  REVENUE_HEAD: "revenue_head",
  BME: "bme",
  IME: "ime",
};

const REVIEW_STATUS = {
  PENDING: "pending",
  QUALIFIED: "qualified",
  UNQUALIFIED: "unqualified",
  ASSIGNED: "assigned",
};

const THREAD_STATUS = {
  OPEN: "open",
  WAITING_ON_BRAND: "waiting_on_brand",
  WAITING_ON_US: "waiting_on_us",
  CLOSED: "closed",
};

const MESSAGE_DIRECTION = {
  INBOUND: "inbound",
  OUTBOUND: "outbound",
};

const SINGLE_MAILBOX_ROLES = [
  OWNER_ROLE.REVENUE_HEAD,
  OWNER_ROLE.BME,
  OWNER_ROLE.IME,
];

module.exports = {
  OUTREACH_CAMPAIGN_STATUS,
  PROSPECT_STAGE,
  OWNER_ROLE,
  REVIEW_STATUS,
  THREAD_STATUS,
  MESSAGE_DIRECTION,
  SINGLE_MAILBOX_ROLES,
};