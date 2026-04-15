const OUTREACH_CAMPAIGN_STATUS = {
  DRAFT: "draft",
  READY: "ready",
  LAUNCHED: "launched",
  PAUSED: "paused",
  COMPLETED: "completed",
};

const PROSPECT_STAGE = {
  NEW: "new",
  QUEUED: "queued",
  IN_SEQUENCE: "in_sequence",
  REPLIED_PENDING_REVIEW: "replied_pending_review",
  QUALIFIED: "qualified",
  ASSIGNED_TO_BME: "assigned_to_bme",
  UNQUALIFIED: "unqualified",
  BLOCKED: "blocked",
  CLOSED: "closed",
};

const OWNER_ROLE = {
  SDR: "sdr",
  REVENUE_HEAD: "revenue_head",
  BME: "bme",
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

module.exports = {
  OUTREACH_CAMPAIGN_STATUS,
  PROSPECT_STAGE,
  OWNER_ROLE,
  REVIEW_STATUS,
  THREAD_STATUS,
  MESSAGE_DIRECTION,
};