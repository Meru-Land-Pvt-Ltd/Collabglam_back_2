function normalizeInstantlyWebhook(body = {}) {
  const event =
    body.event ||
    body.type ||
    body.event_type ||
    "";

  const email =
    body.email ||
    body.lead_email ||
    body.contact_email ||
    body.data?.email ||
    body.data?.lead_email ||
    "";

  const threadId =
    body.thread_id ||
    body.data?.thread_id ||
    body.email_thread_id ||
    "";

  const emailId =
    body.email_id ||
    body.id ||
    body.data?.email_id ||
    "";

  const subject =
    body.subject ||
    body.data?.subject ||
    "";

  const snippet =
    body.snippet ||
    body.preview ||
    body.data?.snippet ||
    body.data?.preview ||
    "";

  const bodyText =
    body.body_text ||
    body.text ||
    body.data?.body_text ||
    body.data?.text ||
    "";

  const campaignId =
    body.campaign_id ||
    body.data?.campaign_id ||
    "";

  return {
    event: String(event).toLowerCase(),
    email: String(email).toLowerCase().trim(),
    threadId: String(threadId).trim(),
    emailId: String(emailId).trim(),
    subject: String(subject).trim(),
    snippet: String(snippet).trim(),
    bodyText: String(bodyText).trim(),
    campaignId: String(campaignId).trim(),
    raw: body,
  };
}

module.exports = {
  normalizeInstantlyWebhook,
};