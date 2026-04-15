const ProspectBrand = require("../models/prospectBrand");
const OutreachCampaign = require("../models/outreachCampaign");
const {
  PROSPECT_STAGE,
  OUTREACH_CAMPAIGN_STATUS,
  OWNER_ROLE,
} = require("../constants/outreach");
const { validateOutreachTeam, ensureRole } = require("../utils/outreachGuards");
const instantlyService = require("../services/instantlyService");

exports.createProspect = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "revenue_head", "super_admin"]);

    const {
      companyName,
      domain,
      website,
      primaryContact,
      notes,
      RHId,
      preAssignedBmeId,
      campaignId,
    } = req.body;

    const sdrId = req.admin.adminId;

    await validateOutreachTeam({
      sdrId,
      RHId,
      bmeId: preAssignedBmeId,
    });

    const doc = await ProspectBrand.create({
      companyName,
      domain,
      website,
      primaryContact,
      notes,
      sdrId,
      RHId,
      preAssignedBmeId,
      currentOwnerRole: OWNER_ROLE.SDR,
      currentOwnerId: sdrId,
      stage: PROSPECT_STAGE.NEW,
    });

    if (campaignId) {
      await OutreachCampaign.findByIdAndUpdate(campaignId, {
        $addToSet: { prospectIds: doc._id },
        $inc: { "stats.totalProspects": 1 },
      });
    }

    return res.status(201).json({ success: true, data: doc });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};

exports.createOutreachCampaign = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr"]);

    const {
      name,
      description,
      RHId,
      assignedBmeId,
      prospectIds = [],
      sequenceMeta = {},
      instantly = {},
    } = req.body;

    const sdrId = req.admin.adminId;

    await validateOutreachTeam({
      sdrId,
      RHId,
      bmeId: assignedBmeId,
    });

    const campaign = await OutreachCampaign.create({
      name,
      description,
      sdrId,
      RHId,
      assignedBmeId,
      prospectIds,
      sequenceMeta,
      instantly: {
        workspaceId: instantly.workspaceId || "",
        accountEmails: Array.isArray(instantly.accountEmails) ? instantly.accountEmails : [],
      },
      status: OUTREACH_CAMPAIGN_STATUS.DRAFT,
      stats: {
        totalProspects: prospectIds.length,
      },
    });

    await ProspectBrand.updateMany(
      { _id: { $in: prospectIds } },
      {
        $set: {
          sdrId,
          RHId,
          preAssignedBmeId: assignedBmeId,
          currentOwnerRole: OWNER_ROLE.SDR,
          currentOwnerId: sdrId,
          stage: PROSPECT_STAGE.QUEUED,
        },
      }
    );

    return res.status(201).json({ success: true, data: campaign });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};

exports.launchOutreachCampaign = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr"]);

    const campaignId = req.params.id;
    const actorId = String(req.admin.adminId);

    const campaign = await OutreachCampaign.findById(campaignId);
    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found" });
    }

    if (String(campaign.sdrId) !== actorId) {
      return res.status(403).json({ success: false, message: "You do not own this campaign" });
    }

    await validateOutreachTeam({
      sdrId: campaign.sdrId,
      RHId: campaign.RHId,
      bmeId: campaign.assignedBmeId,
    });

    const prospects = await ProspectBrand.find({
      _id: { $in: campaign.prospectIds },
      stage: { $in: [PROSPECT_STAGE.NEW, PROSPECT_STAGE.QUEUED] },
    }).lean();

    if (!prospects.length) {
      return res.status(400).json({
        success: false,
        message: "No launchable prospects found",
      });
    }

    // 1) create Instantly lead list
    const leadListPayload = {
      name: campaign.name,
    };
    const leadList = await instantlyService.createLeadList(leadListPayload);

    // 2) add leads to Instantly
    const leadsPayload = {
      list_id: leadList.id || leadList._id || leadList.data?.id,
      leads: prospects.map((item) => ({
        email: item.primaryContact.email,
        first_name: item.primaryContact.name || "",
        company_name: item.companyName || "",
        website: item.website || "",
      })),
    };
    const addLeadsResult = await instantlyService.addLeads(leadsPayload);

    // 3) create Instantly campaign
    const campaignPayload = {
      name: campaign.name,
      lead_list_id: leadList.id || leadList._id || leadList.data?.id,
      account_emails: campaign.instantly.accountEmails || [],
      ...campaign.instantly.rawCampaignPayload,
    };
    const instantlyCampaign = await instantlyService.createCampaign(campaignPayload);

    // 4) activate Instantly campaign
    await instantlyService.activateCampaign(instantlyCampaign.id || instantlyCampaign._id);

    campaign.instantly.leadListId = String(leadList.id || leadList._id || "");
    campaign.instantly.campaignId = String(instantlyCampaign.id || instantlyCampaign._id || "");
    campaign.status = OUTREACH_CAMPAIGN_STATUS.LAUNCHED;
    campaign.launchValidatedAt = new Date();
    campaign.launchedAt = new Date();
    await campaign.save();

    await ProspectBrand.updateMany(
      { _id: { $in: campaign.prospectIds } },
      {
        $set: {
          stage: PROSPECT_STAGE.IN_SEQUENCE,
          sdrWriteLocked: false,
          launchedAt: new Date(),
          RHId: campaign.RHId,
          preAssignedBmeId: campaign.assignedBmeId,
          currentOwnerRole: OWNER_ROLE.SDR,
          currentOwnerId: campaign.sdrId,
          "instantly.campaignId": campaign.instantly.campaignId,
          "instantly.leadListId": campaign.instantly.leadListId,
        },
      }
    );

    return res.status(200).json({
      success: true,
      message: "Campaign launched successfully",
      data: {
        campaignId: campaign._id,
        instantlyCampaignId: campaign.instantly.campaignId,
        instantlyLeadListId: campaign.instantly.leadListId,
        addLeadsResult,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};

exports.pauseOutreachCampaign = async (req, res) => {
  try {
    ensureRole(req.admin, ["sdr", "revenue_head", "super_admin"]);

    const campaign = await OutreachCampaign.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found" });
    }

    if (!campaign.instantly.campaignId) {
      return res.status(400).json({ success: false, message: "Instantly campaign not linked" });
    }

    await instantlyService.pauseCampaign(campaign.instantly.campaignId);
    campaign.status = OUTREACH_CAMPAIGN_STATUS.PAUSED;
    campaign.pausedAt = new Date();
    await campaign.save();

    return res.status(200).json({ success: true, message: "Campaign paused successfully" });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};