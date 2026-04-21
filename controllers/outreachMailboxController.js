const OutreachMailboxAssignment = require("../models/outreachMailboxAssignment");
const instantlyService = require("../services/instantlyService");
const { OWNER_ROLE } = require("../constants/outreach");
const { ensureRole } = require("../utils/outreachGuards");

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function getInstantlyItems(payload) {
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function inferProvider(account) {
  const providerCode = Number(account?.provider_code);

  if (providerCode === 1) return "google";
  if (providerCode === 2) return "microsoft";

  return "unknown";
}

async function findInstantlyAccountByEmail(email) {
  try {
    const account = await instantlyService.getAccount(email);
    if (account) return account;
  } catch (error) {}

  const listPayload = await instantlyService.listAccounts({});
  const items = getInstantlyItems(listPayload);

  return (
    items.find(
      (item) => normalizeEmail(item.email) === normalizeEmail(email)
    ) || null
  );
}

exports.listMailboxAssignments = async (req, res) => {
  try {
    ensureRole(req.admin, ["super_admin", "revenue_head", "sdr", "bme", "ime"]);

    const filter = {};

    if (req.query.role) {
      filter.role = normalizeRole(req.query.role);
    }

    if (req.query.adminId) {
      filter.adminId = req.query.adminId;
    }

    if (req.query.activeOnly === "true") {
      filter.isActive = true;
    }

    const rows = await OutreachMailboxAssignment.find(filter)
      .populate("adminId", "name email role")
      .populate("assignedBy", "name email")
      .sort({ updatedAt: -1 });

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};

exports.assignMailbox = async (req, res) => {
  try {
    ensureRole(req.admin, ["super_admin", "revenue_head"]);

    const email = normalizeEmail(req.body.email);
    const role = normalizeRole(req.body.role);
    const adminId = String(req.body.adminId || "").trim();
    const isPrimary = Boolean(req.body.isPrimary);

    if (!email || !role || !adminId) {
      return res.status(400).json({
        success: false,
        message: "email, role and adminId are required",
      });
    }

    if (!Object.values(OWNER_ROLE).includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role",
      });
    }

    const instantlyAccount = await findInstantlyAccountByEmail(email);
    if (!instantlyAccount) {
      return res.status(404).json({
        success: false,
        message: "Instantly account not found for this email",
      });
    }

    if ([OWNER_ROLE.REVENUE_HEAD, OWNER_ROLE.BME, OWNER_ROLE.IME].includes(role)) {
      await OutreachMailboxAssignment.updateMany(
        {
          adminId,
          role,
          isActive: true,
        },
        {
          $set: {
            isActive: false,
            isPrimary: false,
            unassignedAt: new Date(),
          },
        }
      );
    }

    if (role === OWNER_ROLE.SDR && isPrimary) {
      await OutreachMailboxAssignment.updateMany(
        {
          adminId,
          role,
          isActive: true,
          isPrimary: true,
          email: { $ne: email },
        },
        {
          $set: {
            isPrimary: false,
          },
        }
      );
    }

    const doc = await OutreachMailboxAssignment.findOneAndUpdate(
      { email },
      {
        $set: {
          email,
          role,
          adminId,
          provider: inferProvider(instantlyAccount),
          isActive: true,
          isPrimary: role === OWNER_ROLE.SDR ? isPrimary : true,
          unassignedAt: null,
          assignedAt: new Date(),
          assignedBy: req.admin.adminId,
          instantlyMeta: {
            status:
              typeof instantlyAccount?.status === "number"
                ? instantlyAccount.status
                : null,
            warmupStatus:
              typeof instantlyAccount?.warmup_status === "number"
                ? instantlyAccount.warmup_status
                : null,
            dailyLimit:
              typeof instantlyAccount?.daily_limit === "number"
                ? instantlyAccount.daily_limit
                : null,
            warmupScore:
              typeof instantlyAccount?.stat_warmup_score === "number"
                ? instantlyAccount.stat_warmup_score
                : null,
          },
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    )
      .populate("adminId", "name email role")
      .populate("assignedBy", "name email");

    return res.status(200).json({
      success: true,
      message:
        role === OWNER_ROLE.SDR
          ? "Sender mailbox assigned to SDR successfully"
          : "Mailbox assigned successfully",
      data: doc,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message:
        error.code === 11000
          ? "This mailbox or role assignment already exists"
          : error.message || "Internal error",
    });
  }
};

exports.unassignMailbox = async (req, res) => {
  try {
    ensureRole(req.admin, ["super_admin", "revenue_head"]);

    const email = normalizeEmail(req.params.email);

    const row = await OutreachMailboxAssignment.findOneAndUpdate(
      { email, isActive: true },
      {
        $set: {
          isActive: false,
          isPrimary: false,
          unassignedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Active mailbox assignment not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Mailbox unassigned successfully",
      data: row,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};