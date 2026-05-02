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
    body.data?.contact_email ||
    body.data?.lead?.email ||
    body.lead?.email ||
    "";

  const threadId =
    body.thread_id ||
    body.email_thread_id ||
    body.threadId ||
    body.reply_thread_id ||
    body.message_thread_id ||
    body.data?.thread_id ||
    body.data?.email_thread_id ||
    body.data?.threadId ||
    body.data?.reply_thread_id ||
    body.data?.message_thread_id ||
    "";

  const emailId =
    body.email_id ||
    body.id ||
    body.data?.email_id ||
    "";

  const subject =
    body.reply_subject ||
    body.email_subject ||
    body.subject ||
    body.data?.reply_subject ||
    body.data?.subject ||
    "";

  const snippet =
    body.reply_text_snippet ||
    body.snippet ||
    body.preview ||
    body.data?.reply_text_snippet ||
    body.data?.snippet ||
    "";

  const bodyText =
    body.reply_text ||
    body.email_text ||
    body.body_text ||
    body.text ||
    body.data?.reply_text ||
    body.data?.email_text ||
    body.data?.body_text ||
    body.data?.text ||
    body.data?.email?.body_text ||
    body.email?.body_text ||
    "";

  const campaignId =
    body.campaign_id ||
    body.data?.campaign_id ||
    "";

  const accountEmail =
    body.email_account ||
    body.account_email ||
    body.sender_account_email ||
    body.sender_email ||
    body.from_email ||
    body.data?.email_account ||
    body.data?.account_email ||
    body.data?.sender_account_email ||
    "";

  return {
    event: String(event).toLowerCase().trim(),
    email: String(email).toLowerCase().trim(),
    threadId: String(threadId).trim(),
    emailId: String(emailId).trim(),
    subject: String(subject).trim(),
    snippet: String(snippet).trim(),
    bodyText: String(bodyText).trim(),
    campaignId: String(campaignId).trim(),
    accountEmail: String(accountEmail).toLowerCase().trim(),
    raw: body,
  };
}

module.exports = {
  normalizeInstantlyWebhook,
};