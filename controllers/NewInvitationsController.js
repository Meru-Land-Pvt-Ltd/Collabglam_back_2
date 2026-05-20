'use strict';

const mongoose = require('mongoose');
const Invitation = require('../models/NewInvitations');
const MissingEmail = require('../models/MissingEmail');
const Campaign = require('../models/campaign');
const { InfluencerModel } = require('../models/influencer');
const { EmailThread, EmailMessage } = require('../models/email');
const Brand = require('../models/brand');
const {
  sendEmail,
  cleanEmail,
  cleanStr,
} = require('../services/email/invitationEmailService');

const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;
const EMAIL_RX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

const PLATFORM_MAP = new Map([
  ['youtube', 'youtube'],
  ['yt', 'youtube'],
  ['instagram', 'instagram'],
  ['ig', 'instagram'],
  ['tiktok', 'tiktok'],
  ['tt', 'tiktok'],
]);

const PLATFORM_ENUM = new Set(['youtube', 'instagram', 'tiktok']);
const STATUS_ENUM = new Set(['invited', 'available']);

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

function normalizeObjectId(value) {
  const id = String(value || '').trim();
  return isObjectId(id) ? id : '';
}

function toObjectId(value) {
  return new mongoose.Types.ObjectId(String(value));
}

function normalizeHandle(h) {
  if (!h) return '';
  const t = String(h).trim().toLowerCase();
  return t.startsWith('@') ? t : `@${t}`;
}

function normalizePlatform(value) {
  return PLATFORM_MAP.get(String(value || '').trim().toLowerCase()) || '';
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeEmailText(value = '') {
  return String(value || '')
    .replace(/\s*(\[|\()?at(\]|\))?\s*/gi, '@')
    .replace(/\s*(\[|\()?dot(\]|\))?\s*/gi, '.');
}

function extractEmailFromText(value = '') {
  const normalized = normalizeEmailText(value);
  const match = normalized.match(EMAIL_RX);
  return match ? cleanEmail(match[0]) : null;
}

function getFirstDirectEmail(...values) {
  for (const value of values) {
    const email = cleanEmail(value);
    if (email) return email;
  }

  return null;
}

function getEmailFromContactsTypeEmail(contacts) {
  if (!Array.isArray(contacts)) return null;

  const emailContact = contacts.find((item) => {
    if (!item || typeof item !== 'object') return false;

    const type = String(item.type || '').trim().toLowerCase();
    const email = getFirstDirectEmail(
      item.value,
      item.email,
      item.contactEmail,
      item.businessEmail,
      item.emailAddress
    );

    return type === 'email' && email;
  });

  if (!emailContact) return null;

  return getFirstDirectEmail(
    emailContact.value,
    emailContact.email,
    emailContact.contactEmail,
    emailContact.businessEmail,
    emailContact.emailAddress
  );
}

function buildMissingYouTubePayload(source, handle) {
  if (!source || typeof source !== 'object') return undefined;

  return {
    channelId: source.channelId || source.userId || source.id || source.modashId || undefined,
    title:
      source.title ||
      source.fullname ||
      source.fullName ||
      source.name ||
      source.username ||
      handle,
    handle,
    urlByHandle:
      source.urlByHandle ||
      source.url ||
      source.profileUrl ||
      source.youtube?.urlByHandle ||
      undefined,
    urlById:
      source.urlById ||
      source.channelUrl ||
      source.youtube?.urlById ||
      undefined,
    description: source.description || source.bio || source.about || undefined,
    country: source.country || source.location?.country || undefined,
    subscriberCount:
      typeof source.subscriberCount === 'number'
        ? source.subscriberCount
        : typeof source.followers === 'number'
          ? source.followers
          : undefined,
    videoCount:
      typeof source.videoCount === 'number'
        ? source.videoCount
        : typeof source.postsCount === 'number'
          ? source.postsCount
          : undefined,
    viewCount:
      typeof source.viewCount === 'number'
        ? source.viewCount
        : typeof source.averageViews === 'number'
          ? source.averageViews
          : undefined,
    topicCategories: Array.isArray(source.topicCategories)
      ? source.topicCategories
      : undefined,
    topicCategoryLabels: Array.isArray(source.topicCategoryLabels)
      ? source.topicCategoryLabels
      : undefined,
    fetchedAt: new Date(),
  };
}

async function ensurePendingMissingEmailRecord({ handle, platform, sourceDoc }) {
  const normalizedHandle = normalizeHandle(handle);

  if (!HANDLE_RX.test(normalizedHandle)) return null;
  if (platform !== 'youtube') return null;

  const update = {
    email: null,
    handle: normalizedHandle,
    platform,
    status: 'pending',
    youtube: buildMissingYouTubePayload(sourceDoc, normalizedHandle),
  };

  return MissingEmail.findOneAndUpdate(
    {
      handle: normalizedHandle,
      platform,
    },
    {
      $set: update,
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    }
  ).lean();
}

async function getBrandByMongoId(brandId) {
  if (!isObjectId(brandId)) return null;

  return Brand.findById(brandId).lean();
}

async function getCampaignByMongoId({ campaignId, brandId }) {
  if (!isObjectId(campaignId) || !isObjectId(brandId)) return null;

  return Campaign.findOne({
    _id: toObjectId(campaignId),
    $or: [
      { brandId: toObjectId(brandId) },
      { brandId: String(brandId) },
    ],
  }).lean();
}

async function findEmailInModash({ handle, platform, modashUserId }) {
  const handleWithAt = String(handle || '').trim();
  const handleWithoutAt = handleWithAt.replace(/^@/, '');

  const platformRegex = new RegExp(`^${escapeRegExp(platform)}$`, 'i');

  const identityOr = [];

  if (handleWithoutAt) {
    const handleRegex = new RegExp(`^@?${escapeRegExp(handleWithoutAt)}$`, 'i');

    identityOr.push({ handle: handleRegex });
    identityOr.push({ username: handleRegex });
    identityOr.push({ userId: handleRegex });
  }

  if (modashUserId) {
    const modashRegex = new RegExp(`^${escapeRegExp(modashUserId)}$`, 'i');

    identityOr.push({ userId: modashRegex });
    identityOr.push({ id: modashRegex });
    identityOr.push({ channelId: modashRegex });
  }

  if (!identityOr.length) {
    return {
      email: null,
      source: 'missing_identity',
      doc: null,
    };
  }

  const modash = await mongoose.connection.collection('modashes').findOne({
    $and: [
      {
        $or: [
          { provider: platformRegex },
          { platform: platformRegex },
        ],
      },
      {
        $or: identityOr,
      },
    ],
  });

  if (!modash) {
    return {
      email: null,
      source: 'modash_not_found',
      doc: null,
    };
  }

  const directEmail = getFirstDirectEmail(
    modash.email,
    modash.businessEmail,
    modash.contactEmail,
    modash.emailTo,
    modash.proxyEmail
  );

  if (directEmail) {
    return {
      email: directEmail,
      source: 'modash_direct',
      doc: modash,
    };
  }

  const contactEmail = getEmailFromContactsTypeEmail(modash.contacts);

  if (contactEmail) {
    return {
      email: contactEmail,
      source: 'modash_contact',
      doc: modash,
    };
  }

  const bioEmail = extractEmailFromText(
    [
      modash.bio,
      modash.description,
      modash.about,
      modash.contactInfo,
      modash.profileDescription,
    ]
      .filter(Boolean)
      .join('\n')
  );

  if (bioEmail) {
    return {
      email: bioEmail,
      source: 'modash_bio',
      doc: modash,
    };
  }

  return {
    email: null,
    source: 'modash_no_email',
    doc: modash,
  };
}

async function resolveCreatorEmail({ handle, platform, modashUserId }) {
  return findEmailInModash({ handle, platform, modashUserId });
}

function toEmailArray(input) {
  if (Array.isArray(input)) {
    return input.map((item) => cleanEmail(item)).filter(Boolean);
  }

  if (typeof input === 'string') {
    return input.split(',').map((item) => cleanEmail(item)).filter(Boolean);
  }

  const email = cleanEmail(input);
  return email ? [email] : [];
}

function uniqueEmails(values) {
  return [...new Set(values.map((item) => cleanEmail(item)).filter(Boolean))];
}

function normalizeEmailTemplate(body = {}) {
  const template = body.emailTemplate || {};

  const subject = cleanStr(template.subject || body.subject || '');

  const text = String(
    template.textBody ||
      template.body ||
      body.textBody ||
      body.body ||
      ''
  ).trim();

  const html = String(template.htmlBody || body.htmlBody || '').trim();

  const proxyFromEmail =
    cleanEmail(template.fromEmail || body.fromEmail) ||
    cleanEmail(process.env.SES_FROM_EMAIL) ||
    cleanEmail(process.env.SES_FROM) ||
    'confirm@collabglam.com';

  const replyTo = uniqueEmails([
    ...toEmailArray(template.replyTo || body.replyTo),
    proxyFromEmail,
  ]);

  const cc = toEmailArray(template.cc || body.cc);
  const bcc = toEmailArray(template.bcc || body.bcc);

  const attachments = Array.isArray(template.attachments)
    ? template.attachments
        .filter((file) => file?.filename && file?.contentBase64)
        .map((file) => ({
          filename: cleanStr(file.filename),
          contentType: file.contentType || 'application/octet-stream',
          content: String(file.contentBase64).replace(/^data:.*;base64,/, ''),
          encoding: 'base64',
        }))
    : [];

  if (!subject || (!text && !html)) return null;

  return {
    from: proxyFromEmail,
    subject,
    text,
    html,
    cc,
    bcc,
    replyTo,
    attachments,
  };
}

function buildEmailTags({ brandId, campaignId, platform, handle }) {
  return [
    { Name: 'type', Value: 'creator-invitation' },
    { Name: 'platform', Value: platform },
    { Name: 'handle', Value: handle.replace(/^@/, '') },
    { Name: 'brandId', Value: brandId },
    { Name: 'campaignId', Value: campaignId },
  ];
}

function normalizeAiScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function invitationResponse(doc) {
  return {
    _id: String(doc._id),
    handle: doc.handle,
    platform: doc.platform,
    brandId: doc.brandId,
    campaignId: doc.campaignId || null,
    modashUserId: doc.modashUserId || null,
    missingEmailId: doc.missingEmailId || null,
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * POST /newinvitations/create
 *
 * Uses Mongo _id only:
 * body: {
 *   brandId: brand._id,
 *   campaignId: campaign._id,
 *   handle,
 *   platform,
 *   status?: "invited" | "available",
 *   modashUserId?,
 *   emailTemplate?
 * }
 */
exports.createInvitation = async (req, res) => {
  try {
    const brandId = normalizeObjectId(req.body?.brandId);
    const campaignId = normalizeObjectId(req.body?.campaignId);

    const rawHandle = String(req.body?.handle || '').trim();
    const rawPlatform = String(req.body?.platform || '').trim();
    const rawStatus = String(req.body?.status || '').trim().toLowerCase();

    const modashUserId = String(req.body?.modashUserId || '').trim() || null;
    const aiScore = normalizeAiScore(req.body?.aiScore);
    const rawAiScore = Number.isFinite(Number(req.body?.rawAiScore))
      ? Number(req.body.rawAiScore)
      : null;
    const recommendationReason = cleanStr(req.body?.recommendationReason || '');

    if (!brandId) {
      return res.status(400).json({
        status: 'error',
        message: 'Valid brand _id is required.',
      });
    }

    if (!campaignId) {
      return res.status(400).json({
        status: 'error',
        message: 'Valid campaign _id is required.',
      });
    }

    if (!rawHandle) {
      return res.status(400).json({
        status: 'error',
        message: 'handle is required.',
      });
    }

    if (!rawPlatform) {
      return res.status(400).json({
        status: 'error',
        message: 'platform is required.',
      });
    }

    const handle = normalizeHandle(rawHandle);

    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: 'error',
        message:
          'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-".',
      });
    }

    const platform = normalizePlatform(rawPlatform);

    if (!platform || !PLATFORM_ENUM.has(platform)) {
      return res.status(400).json({
        status: 'error',
        message:
          'Invalid platform. Use: youtube|instagram|tiktok. Aliases: yt, ig, tt.',
      });
    }

    const status = STATUS_ENUM.has(rawStatus) ? rawStatus : 'invited';

    const [brand, campaign] = await Promise.all([
      getBrandByMongoId(brandId),
      getCampaignByMongoId({ campaignId, brandId }),
    ]);

    if (!brand) {
      return res.status(404).json({
        status: 'error',
        message: 'Brand not found for provided brand _id.',
      });
    }

    if (!campaign) {
      return res.status(404).json({
        status: 'error',
        message: 'Campaign not found for provided campaign _id and brand _id.',
      });
    }

    let doc = await Invitation.findOne({
      brandId,
      campaignId,
      handle,
      platform,
    });

    let responseStatus = 'saved';
    let httpStatus = 201;

    if (doc) {
      responseStatus = 'exists';
      httpStatus = 200;

      if (doc.status !== status) {
        doc.status = status;
        await doc.save();
      }

      return res.status(httpStatus).json({
        status: responseStatus,
        message: 'Invitation already exists for this campaign and creator.',
        emailSent: false,
        emailMeta: null,
        emailSkippedReason: 'Duplicate invitation skipped.',
        data: invitationResponse(doc),
      });
    }

    const payload = {
      handle,
      platform,
      brandId,
      campaignId,
      status,
    };

    if (modashUserId) payload.modashUserId = modashUserId;
    if (aiScore !== null) payload.aiScore = aiScore;
    if (rawAiScore !== null) payload.rawAiScore = rawAiScore;
    if (recommendationReason) payload.recommendationReason = recommendationReason;

    doc = await Invitation.create(payload);

    let emailSent = false;
    let emailMeta = null;
    let emailSkippedReason = null;
    let pendingMissingEmailRecord = null;

    const emailTemplate = normalizeEmailTemplate(req.body);

    const emailLookup = await resolveCreatorEmail({
      handle,
      platform,
      modashUserId,
    });

    if (!emailLookup.email) {
      try {
        pendingMissingEmailRecord = await ensurePendingMissingEmailRecord({
          handle,
          platform,
          sourceDoc: emailLookup.doc,
        });

        if (pendingMissingEmailRecord?._id) {
          doc.missingEmailId = String(pendingMissingEmailRecord._id);
          await doc.save();
        }
      } catch (missingErr) {
        console.error('Failed to create pending MissingEmail:', missingErr);
      }

      emailSkippedReason =
        'Invitation saved. No email found in Modash contacts, direct fields, or bio.';
    } else if (!emailTemplate) {
      emailSkippedReason =
        'Invitation saved and email resolved, but emailTemplate was not provided or is missing subject/body.';
    } else {
      try {
        const sent = await sendEmail({
          to: emailLookup.email,
          from: emailTemplate.from,
          subject: emailTemplate.subject,
          text: emailTemplate.text,
          html: emailTemplate.html,
          cc: emailTemplate.cc,
          bcc: emailTemplate.bcc,
          replyTo: emailTemplate.replyTo,
          attachments: emailTemplate.attachments,
          emailTags: buildEmailTags({
            brandId,
            campaignId,
            platform,
            handle,
          }),
        });

        emailSent = Boolean(sent?.messageId);

        emailMeta = {
          recipientEmail: emailLookup.email,
          emailSource: emailLookup.source,
          missingEmailId: null,
          messageId: sent?.messageId || null,
          subject: emailTemplate.subject,
          campaignId,
        };
      } catch (mailErr) {
        console.error('Invitation AWS email send failed:', mailErr);

        emailSkippedReason =
          mailErr?.message || 'Invitation saved, but AWS email sending failed.';
      }
    }

    return res.status(httpStatus).json({
      status: responseStatus,
      message: 'Invitation created successfully.',
      emailSent,
      emailMeta,
      emailSkippedReason,
      data: invitationResponse(doc),
    });
  } catch (err) {
    console.error('createInvitation error:', err);

    if (err?.code === 11000) {
      return res.status(409).json({
        status: 'error',
        message: 'Invitation already exists for this campaign and creator.',
      });
    }

    return res.status(500).json({
      status: 'error',
      message: err?.message || 'Failed to create invitation.',
    });
  }
};

exports.updateInvitationStatus = async (req, res) => {
  try {
    const invitationId = normalizeObjectId(req.body?._id || req.body?.invitationId);
    const rawStatus = String(req.body?.status || '').trim().toLowerCase();

    if (!invitationId) {
      return res.status(400).json({
        status: 'error',
        message: 'Valid invitation _id is required.',
      });
    }

    if (!STATUS_ENUM.has(rawStatus)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid status. Use "invited" or "available".',
      });
    }

    const doc = await Invitation.findById(invitationId);

    if (!doc) {
      return res.status(404).json({
        status: 'error',
        message: 'Invitation not found for provided _id.',
      });
    }

    doc.status = rawStatus;

    if (req.body?.missingEmailId) {
      const missingEmailId = normalizeObjectId(req.body.missingEmailId);

      if (!missingEmailId) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid missingEmailId. Use MissingEmail _id.',
        });
      }

      const missing = await MissingEmail.findById(missingEmailId)
        .select('_id handle platform')
        .lean();

      if (!missing) {
        return res.status(400).json({
          status: 'error',
          message: 'MissingEmail record not found for provided _id.',
        });
      }

      doc.missingEmailId = String(missing._id);
    }

    await doc.save();

    return res.json({
      status: 'success',
      message: 'Invitation status updated.',
      data: invitationResponse(doc),
    });
  } catch (err) {
    console.error('Error in updateInvitationStatus:', err);

    return res.status(500).json({
      status: 'error',
      message: 'Internal server error.',
    });
  }
};

exports.listInvitations = async (req, res) => {
  try {
    const body = req.body || {};

    const page = Math.max(1, parseInt(body.page ?? '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '50', 10)));

    const brandId = body.brandId ? normalizeObjectId(body.brandId) : '';
    const campaignId = body.campaignId ? normalizeObjectId(body.campaignId) : '';

    const rawHandle = typeof body.handle === 'string' ? body.handle.trim() : '';
    const rawPlatform = typeof body.platform === 'string' ? body.platform.trim() : '';
    const rawStatus =
      typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';

    const query = {};

    if (body.brandId) {
      if (!brandId) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid brandId. Use brand _id.',
        });
      }

      query.brandId = brandId;
    }

    if (body.campaignId) {
      if (!campaignId) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid campaignId. Use campaign _id.',
        });
      }

      query.campaignId = campaignId;
    }

    if (rawHandle) {
      const handle = normalizeHandle(rawHandle);

      if (!HANDLE_RX.test(handle)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid handle format in filter.',
        });
      }

      query.handle = handle;
    }

    if (rawPlatform) {
      const platform = normalizePlatform(rawPlatform);

      if (!platform) {
        return res.status(400).json({
          status: 'error',
          message:
            'Invalid platform filter. Use: youtube|instagram|tiktok. Aliases: yt, ig, tt.',
        });
      }

      query.platform = platform;
    }

    if (rawStatus && rawStatus !== 'all') {
      if (!STATUS_ENUM.has(rawStatus)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid status filter. Use "invited", "available" or "all".',
        });
      }

      query.status = rawStatus;
    }

    const [total, docs] = await Promise.all([
      Invitation.countDocuments(query),
      Invitation.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    return res.json({
      status: 'success',
      page,
      limit,
      total,
      hasNext: page * limit < total,
      data: docs.map(invitationResponse),
    });
  } catch (err) {
    console.error('listInvitations error:', err);

    return res.status(500).json({
      status: 'error',
      message: 'Internal server error.',
    });
  }
};

exports.getInvitationList = async (req, res) => {
  try {
    const brandId =
      normalizeObjectId(req.body?.brandId) ||
      normalizeObjectId(req.query?.brandId);

    if (!brandId) {
      return res.status(400).json({
        status: 'error',
        message: 'Valid brand _id is required.',
      });
    }

    const invitations = await Invitation.find({
      brandId,
      missingEmailId: { $ne: null },
    })
      .lean();

    if (!invitations.length) {
      return res.json({
        status: 'success',
        message: 'No invitations found for this brand with missingEmailId.',
        data: [],
      });
    }

    const missingIds = [
      ...new Set(
        invitations
          .map((inv) => normalizeObjectId(inv.missingEmailId))
          .filter(Boolean)
      ),
    ];

    const missingDocs = missingIds.length
      ? await MissingEmail.find({
          _id: {
            $in: missingIds.map((id) => toObjectId(id)),
          },
        }).lean()
      : [];

    const missingMap = new Map();

    for (const me of missingDocs) {
      missingMap.set(String(me._id), me);
    }

    const data = invitations.map((inv) => {
      const me = missingMap.get(String(inv.missingEmailId || ''));

      const title =
        (me && me.youtube && me.youtube.title) ||
        (me && me.handle) ||
        '';

      return {
        _id: String(inv._id),
        missingEmailId: inv.missingEmailId || null,
        campaignId: inv.campaignId || null,
        title,
      };
    });

    return res.json({
      status: 'success',
      message: 'Invitation list fetched successfully.',
      data,
    });
  } catch (err) {
    console.error('Error in getInvitationList:', err);

    return res.status(500).json({
      status: 'error',
      message: 'Internal server error.',
    });
  }
};

const COOLDOWN_MS = 48 * 60 * 60 * 1000;

async function computeBrandEligibilityForThread(threadId) {
  const messages = await EmailMessage.find({ thread: threadId })
    .select('direction createdAt sentAt')
    .sort({ createdAt: 1 })
    .lean();

  const hasIncoming = messages.some((m) => m.direction === 'influencer_to_brand');

  if (hasIncoming) {
    return {
      canSend: true,
      state: 'allowed',
      reason: 'Influencer replied — messaging is unlocked.',
      nextAllowedAt: null,
      outgoingCount: messages.filter((m) => m.direction === 'brand_to_influencer').length,
    };
  }

  const outgoing = messages.filter((m) => m.direction === 'brand_to_influencer');
  const outgoingCount = outgoing.length;

  if (outgoingCount === 0) {
    return {
      canSend: true,
      state: 'allowed',
      reason: 'First email allowed.',
      nextAllowedAt: null,
      outgoingCount,
    };
  }

  if (outgoingCount === 1) {
    const firstAt = new Date(outgoing[0].sentAt || outgoing[0].createdAt).getTime();
    const nextAllowedAt = new Date(firstAt + COOLDOWN_MS);

    if (Date.now() >= nextAllowedAt.getTime()) {
      return {
        canSend: true,
        state: 'allowed',
        reason: '48 hours passed — follow-up allowed.',
        nextAllowedAt: null,
        outgoingCount,
      };
    }

    return {
      canSend: false,
      state: 'cooldown',
      reason: 'Wait 48 hours before sending a follow-up. No reply yet.',
      nextAllowedAt: nextAllowedAt.toISOString(),
      outgoingCount,
    };
  }

  return {
    canSend: false,
    state: 'blocked',
    reason:
      'You already sent 2 emails without a reply. You can message again only after the influencer replies.',
    nextAllowedAt: null,
    outgoingCount,
  };
};

exports.getInvitationSendEligibility = async (req, res) => {
  try {
    const brandId = normalizeObjectId(req.body?.brandId);
    const invitationId = normalizeObjectId(req.body?._id || req.body?.invitationId);

    if (!brandId || !invitationId) {
      return res.status(400).json({
        canSend: false,
        state: 'missing_email',
        reason: 'brandId and invitation _id are required.',
        nextAllowedAt: null,
      });
    }

    const brand = await Brand.findById(brandId).lean();

    if (!brand) {
      return res.status(404).json({
        canSend: false,
        state: 'missing_email',
        reason: 'Brand not found.',
        nextAllowedAt: null,
      });
    }

    const invitation = await Invitation.findById(invitationId).lean();

    if (!invitation) {
      return res.status(404).json({
        canSend: false,
        state: 'missing_email',
        reason: 'Invitation not found.',
        nextAllowedAt: null,
      });
    }

    if (invitation.brandId && invitation.brandId !== String(brand._id)) {
      return res.status(403).json({
        canSend: false,
        state: 'missing_email',
        reason: 'Invitation does not belong to this brand.',
        nextAllowedAt: null,
      });
    }

    if (!invitation.missingEmailId) {
      return res.status(200).json({
        canSend: false,
        state: 'missing_email',
        reason: 'No missing email record exists for this invitation.',
        nextAllowedAt: null,
        threadId: null,
      });
    }

    const missing = await MissingEmail.findById(invitation.missingEmailId).lean();

    const recipientEmail = cleanEmail(missing?.email);

    if (!recipientEmail) {
      return res.status(200).json({
        canSend: false,
        state: 'missing_email',
        reason: 'Recipient email not found yet for this invitation.',
        nextAllowedAt: null,
        threadId: null,
      });
    }

    const influencer = await InfluencerModel.findOne({
      email: recipientEmail,
    })
      .select('_id')
      .lean();

    if (!influencer) {
      return res.status(200).json({
        canSend: true,
        state: 'allowed',
        reason: 'First email allowed.',
        nextAllowedAt: null,
        threadId: null,
        outgoingCount: 0,
      });
    }

    const thread = await EmailThread.findOne({
      brand: brand._id,
      influencer: influencer._id,
    })
      .select('_id')
      .lean();

    if (!thread) {
      return res.status(200).json({
        canSend: true,
        state: 'allowed',
        reason: 'First email allowed.',
        nextAllowedAt: null,
        threadId: null,
        outgoingCount: 0,
      });
    }

    const eligibility = await computeBrandEligibilityForThread(thread._id);

    return res.status(200).json({
      ...eligibility,
      threadId: String(thread._id),
    });
  } catch (err) {
    console.error('getInvitationSendEligibility error:', err);

    return res.status(500).json({
      canSend: false,
      state: 'missing_email',
      reason: 'Internal server error.',
      nextAllowedAt: null,
    });
  }
};