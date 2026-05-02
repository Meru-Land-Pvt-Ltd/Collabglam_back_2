require("dotenv").config();
const mongoose = require("mongoose");

const {
  ConversationThread,
  ConversationMessage,
} = require("../models/conversationThread");

const {
  getMailboxDisplayName,
  nameFromEmail,
} = require("../utils/mailboxDisplayName");

async function resolveMailboxName(email = "") {
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedEmail) return "";

  return (
    (await getMailboxDisplayName(normalizedEmail)) ||
    nameFromEmail(normalizedEmail) ||
    ""
  );
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  let threadsUpdated = 0;
  let messagesUpdated = 0;

  const threads = await ConversationThread.find({});

  for (const thread of threads) {
    const mailboxes = thread.mailboxes || {};
    let changed = false;

    if (mailboxes.campaignSenderEmail) {
      const name = await resolveMailboxName(mailboxes.campaignSenderEmail);
      if (name && mailboxes.campaignSenderName !== name) {
        thread.mailboxes.campaignSenderName = name;
        changed = true;
      }
    }

    if (mailboxes.currentReplyFromEmail) {
      const name = await resolveMailboxName(mailboxes.currentReplyFromEmail);
      if (name && mailboxes.currentReplyFromName !== name) {
        thread.mailboxes.currentReplyFromName = name;
        changed = true;
      }
    }

    if (mailboxes.RHEmail) {
      const name = await resolveMailboxName(mailboxes.RHEmail);
      if (name && mailboxes.RHName !== name) {
        thread.mailboxes.RHName = name;
        changed = true;
      }
    }

    if (mailboxes.bmeEmail) {
      const name = await resolveMailboxName(mailboxes.bmeEmail);
      if (name && mailboxes.bmeName !== name) {
        thread.mailboxes.bmeName = name;
        changed = true;
      }
    }

    if (mailboxes.imeEmail) {
      const name = await resolveMailboxName(mailboxes.imeEmail);
      if (name && mailboxes.imeName !== name) {
        thread.mailboxes.imeName = name;
        changed = true;
      }
    }

    if (changed) {
      await thread.save();
      threadsUpdated += 1;
    }
  }

  const messages = await ConversationMessage.find({});

  for (const message of messages) {
    const direction = String(message.direction || "").toLowerCase();
    const isInbound = direction === "inbound";
    const isOutbound = direction === "outbound";

    let changed = false;

    if (isOutbound && message.from) {
      const fromName = await resolveMailboxName(message.from);

      if (fromName && message.fromName !== fromName) {
        message.fromName = fromName;
        changed = true;
      }
    }

    if (isInbound && Array.isArray(message.to) && message.to[0]) {
      const toName = await resolveMailboxName(message.to[0]);

      if (toName) {
        const currentFirstToName = Array.isArray(message.toNames)
          ? message.toNames[0]
          : "";

        if (currentFirstToName !== toName) {
          message.toNames = [toName];
          changed = true;
        }
      }
    }

    if (changed) {
      await message.save();
      messagesUpdated += 1;
    }
  }

  console.log({
    threadsUpdated,
    messagesUpdated,
  });

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});