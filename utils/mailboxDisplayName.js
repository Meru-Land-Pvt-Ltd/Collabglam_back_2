const OutreachMailboxAssignment = require("../models/outreachMailboxAssignment");

function cleanName(value = "") {
  return String(value || "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function nameFromEmail(email = "") {
  const local = String(email || "")
    .split("@")[0]
    .replace(/\+.*/, "")
    .trim();

  if (!local) return "";

  return cleanName(local);
}

async function getMailboxAssignment(email = "") {
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedEmail) return null;

  /*
    No populate here.

    We only want the mailbox assignment record itself:
    - displayName
    - mailboxName
    - senderName
    - email

    We do NOT want adminId.name, because that can show Priyanshu
    for adityakumar@collabglam.com.
  */
  return OutreachMailboxAssignment.findOne({
    email: normalizedEmail,
    isActive: true,
  }).lean();
}

function getAssignmentMailboxName(assignment = null) {
  return (
    cleanName(assignment?.displayName) ||
    cleanName(assignment?.mailboxName) ||
    cleanName(assignment?.senderName) ||
    cleanName(assignment?.fromName) ||
    cleanName(assignment?.accountName) ||
    ""
  );
}

async function getMailboxDisplayName(email = "", fallback = "") {
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedEmail) {
    return cleanName(fallback) || "";
  }

  const assignment = await getMailboxAssignment(normalizedEmail);
  const assignmentMailboxName = getAssignmentMailboxName(assignment);

  /*
    Priority:
    1. Name stored on exact mailbox assignment.
    2. Email local-part fallback.
    3. Manual fallback.

    Never use assigned admin name here.
  */
  return (
    assignmentMailboxName ||
    nameFromEmail(normalizedEmail) ||
    cleanName(fallback) ||
    ""
  );
}

module.exports = {
  cleanName,
  nameFromEmail,
  getMailboxDisplayName,
  getMailboxAssignment,
  getAssignmentMailboxName,
};