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

  const withSpaces = local
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ");

  return cleanName(withSpaces);
}

async function getMailboxDisplayName(email = "", fallback = "") {
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedEmail) {
    return cleanName(fallback) || "";
  }

  const assignment = await OutreachMailboxAssignment.findOne({
    email: normalizedEmail,
    isActive: true,
  })
    .populate("adminId", "name email")
    .lean();

  /*
    Priority:
    1. mailbox displayName if you add it later
    2. assigned admin name
    3. fallback
    4. email local part
  */
  return (
    cleanName(assignment?.displayName) ||
    cleanName(assignment?.adminId?.name) ||
    cleanName(fallback) ||
    nameFromEmail(normalizedEmail)
  );
}

module.exports = {
  cleanName,
  nameFromEmail,
  getMailboxDisplayName,
};