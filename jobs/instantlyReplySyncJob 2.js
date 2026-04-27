const ProspectBrand = require("../models/prospectBrand");
const instantlyService = require("../services/instantlyService");

async function syncRecentReplies() {
  const activeProspects = await ProspectBrand.find({
    stage: { $in: ["in_sequence", "replied_pending_review"] },
    "instantly.campaignId": { $ne: "" },
  })
    .select("_id primaryContact.email instantly reply")
    .lean();

  for (const prospect of activeProspects) {
    try {
      const emails = await instantlyService.listEmails({
        email: prospect.primaryContact.email,
      });

    } catch (err) {
      console.error("syncRecentReplies error:", prospect._id, err.message);
    }
  }
}

module.exports = {
  syncRecentReplies,
};