const fs = require("fs");
const path = require("path");
const { SESClient, SendRawEmailCommand } = require("@aws-sdk/client-ses");

const ses = new SESClient({
  region: process.env.AWS_REGION || process.env.SES_REGION || "us-east-1",
});

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanStr(value) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function cleanEmail(value) {
  const normalized = cleanStr(value).toLowerCase();
  return emailRegex.test(normalized) ? normalized : "";
}

function normalizeEmailList(input) {
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : input
        ? [input]
        : [];

  return [...new Set(values.map((item) => cleanEmail(item)).filter(Boolean))];
}

function encodeHeader(value) {
  const text = cleanStr(value);
  if (!text) return "";

  return /[^\x00-\x7F]/.test(text)
    ? `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`
    : text;
}

function readAttachmentContent(attachment = {}) {
  if (Buffer.isBuffer(attachment.content)) {
    return attachment.content;
  }

  if (typeof attachment.content === "string") {
    return Buffer.from(
      attachment.content,
      attachment.encoding === "base64" ? "base64" : "utf8"
    );
  }

  if (attachment.path) {
    const absolutePath = path.resolve(String(attachment.path));
    return fs.readFileSync(absolutePath);
  }

  return Buffer.alloc(0);
}

function chunkBase64(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/(.{76})/g, "$1\r\n");
}

function buildMixedMimeMessage({
  from,
  to,
  cc,
  bcc,
  replyTo,
  subject,
  text,
  html,
  attachments = [],
  inReplyTo = null,
  references = [],
  configurationSetName,
  emailTags = [],
}) {
  const mixedBoundary = `mixed_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const altBoundary = `alt_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const headers = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    cc.length ? `Cc: ${cc.join(", ")}` : null,
    replyTo.length ? `Reply-To: ${replyTo.join(", ")}` : null,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    inReplyTo ? `In-Reply-To: ${cleanStr(inReplyTo)}` : null,
    references.length
      ? `References: ${references.map(cleanStr).filter(Boolean).join(" ")}`
      : null,
    configurationSetName
      ? `X-SES-CONFIGURATION-SET: ${cleanStr(configurationSetName)}`
      : null,
    ...emailTags.map((tag) => {
      if (!tag || typeof tag !== "object") return null;
      const name = cleanStr(tag.Name || tag.name);
      const value = cleanStr(tag.Value || tag.value);
      return name && value ? `X-SES-MESSAGE-TAGS: ${name}=${value}` : null;
    }),
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
  ].filter(Boolean);

  const parts = [];

  parts.push(`--${mixedBoundary}`);
  parts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n`);

  if (text) {
    parts.push(`--${altBoundary}`);
    parts.push('Content-Type: text/plain; charset="UTF-8"');
    parts.push("Content-Transfer-Encoding: 7bit\r\n");
    parts.push(String(text));
    parts.push("");
  }

  if (html) {
    parts.push(`--${altBoundary}`);
    parts.push('Content-Type: text/html; charset="UTF-8"');
    parts.push("Content-Transfer-Encoding: 7bit\r\n");
    parts.push(String(html));
    parts.push("");
  }

  parts.push(`--${altBoundary}--`);

  for (const attachment of attachments) {
    const filename = cleanStr(attachment.filename || attachment.name || "attachment");
    const contentType = cleanStr(
      attachment.contentType || attachment.mimeType || "application/octet-stream"
    );
    const disposition = cleanStr(attachment.contentDisposition || "attachment");
    const cid = cleanStr(attachment.cid || "");
    const content = readAttachmentContent(attachment);

    parts.push(`--${mixedBoundary}`);
    parts.push(`Content-Type: ${contentType}; name="${filename}"`);
    parts.push("Content-Transfer-Encoding: base64");
    parts.push(`Content-Disposition: ${disposition}; filename="${filename}"`);
    if (cid) parts.push(`Content-ID: <${cid}>`);
    parts.push("");
    parts.push(chunkBase64(content));
    parts.push("");
  }

  parts.push(`--${mixedBoundary}--`);

  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
}

async function sendEmail({
  to,
  subject,
  text,
  html,
  from,
  cc = [],
  bcc = [],
  replyTo = [],
  attachments = [],
  inReplyTo = null,
  references = [],
  configurationSetName,
  emailTags = [],
}) {
  const fixedFrom = cleanEmail(
    from || process.env.SES_FROM_EMAIL || "confirm@collabglam.com"
  );

  const toAddresses = normalizeEmailList(to);
  const ccAddresses = normalizeEmailList(cc);
  const bccAddresses = normalizeEmailList(bcc);
  const replyToAddresses = normalizeEmailList(replyTo);
  const finalSubject = cleanStr(subject);

  if (!fixedFrom) throw new Error("Sender email missing");
  if (!toAddresses.length) throw new Error("Recipient email (to) is required");
  if (!finalSubject) throw new Error("Email subject is required");
  if (!text && !html) throw new Error("Either text or html body is required");

  const rawMessage = buildMixedMimeMessage({
    from: fixedFrom,
    to: toAddresses,
    cc: ccAddresses,
    bcc: bccAddresses,
    replyTo: replyToAddresses,
    subject: finalSubject,
    text,
    html,
    attachments,
    inReplyTo,
    references,
    configurationSetName,
    emailTags,
  });

  const command = new SendRawEmailCommand({
    RawMessage: {
      Data: Buffer.from(rawMessage),
    },
    Source: fixedFrom,
    Destinations: [...toAddresses, ...ccAddresses, ...bccAddresses],
  });

  const resp = await ses.send(command);

  return {
    messageId: resp.MessageId || null,
    from: fixedFrom,
    to: toAddresses,
    cc: ccAddresses,
    bcc: bccAddresses,
    replyTo: replyToAddresses,
  };
}

module.exports = {
  sendEmail,
  cleanEmail,
  normalizeEmailList,
  cleanStr,
  buildMixedMimeMessage,
};