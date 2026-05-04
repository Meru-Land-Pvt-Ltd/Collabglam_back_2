// controllers/NewInvitationsController.js
'use strict';

const mongoose = require('mongoose');
const Invitation = require('../models/NewInvitations');
const MissingEmail = require('../models/MissingEmail');
const Campaign = require('../models/campaign');
const { InfluencerModel } = require('../models/influencer');
const { EmailThread, EmailMessage } = require('../models/email');
const Brand = require('../models/brand');
const { sendEmail, cleanEmail, cleanStr } = require('../services/email/invitationEmailService');

const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;

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
const EMAIL_RX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

function normalizeHandle(h) {
  if (!h) return '';
  const t = String(h).trim().toLowerCase();
  return t.startsWith('@') ? t : `@${t}`;
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
  return match ? match[0].toLowerCase() : null;
}

function getFirstDirectEmail(...values) {
  for (const value of values) {
    const email = cleanEmail(value);
    if (email) return email;
  }

  return null;
}

function getEmailFromContacts(contacts) {
  if (!Array.isArray(contacts)) return null;

  for (const item of contacts) {
    if (!item || typeof item !== 'object') continue;

    const email = getFirstDirectEmail(
      item.email,
      item.value,
      item.contactEmail,
      item.businessEmail,
      item.emailAddress
    );

    if (email) return email;
  }

  return null;
}

function collectBioText(source, platform) {
  if (!source || typeof source !== 'object') return '';

  const platformRoot = source[platform] || {};
  const profileRoot = source.profile || {};
  const platformProfileRoot = profileRoot[platform] || {};

  const socialProfileText = Array.isArray(source.socialProfiles)
    ? source.socialProfiles
        .filter((item) => {
          const provider = String(item?.provider || item?.platform || '').toLowerCase();
          return !provider || provider === platform;
        })
        .map((item) => [item?.bio, item?.description, item?.about].filter(Boolean).join('\n'))
        .filter(Boolean)
        .join('\n')
    : '';

  return [
    source.bio,
    source.description,
    source.about,
    source.notes,
    source.contactInfo,
    source.contact,

    profileRoot.bio,
    profileRoot.description,
    profileRoot.about,

    platformRoot.bio,
    platformRoot.description,
    platformRoot.about,

    platformProfileRoot.bio,
    platformProfileRoot.description,

    socialProfileText,
  ]
    .filter((item) => typeof item === 'string' && item.trim())
    .join('\n');
}

function getDirectEmailFromProfile(source, platform) {
  if (!source || typeof source !== 'object') return null;

  const platformRoot = source[platform] || {};
  const profileRoot = source.profile || {};
  const platformProfileRoot = profileRoot[platform] || {};

  const directEmail = getFirstDirectEmail(
    source.email,
    source.contactEmail,
    source.businessEmail,
    source.emailAddress,
    source.publicEmail,
    source.creatorEmail,

    profileRoot.email,
    profileRoot.contactEmail,
    profileRoot.businessEmail,
    profileRoot.emailAddress,
    profileRoot.publicEmail,

    platformRoot.email,
    platformRoot.contactEmail,
    platformRoot.businessEmail,
    platformRoot.emailAddress,
    platformRoot.publicEmail,

    platformProfileRoot.email,
    platformProfileRoot.contactEmail,
    platformProfileRoot.businessEmail,
    platformProfileRoot.emailAddress,
    platformProfileRoot.publicEmail
  );

  if (directEmail) return directEmail;

  return getEmailFromContacts(
    source.contacts ||
      source.contact ||
      profileRoot.contacts ||
      profileRoot.contact ||
      platformRoot.contacts ||
      platformRoot.contact ||
      platformProfileRoot.contacts ||
      platformProfileRoot.contact
  );
}

async function findEmailInMissingEmail({ handle, platform, brandId }) {
  const handleWithAt = String(handle || '').trim().toLowerCase();
  const handleWithoutAt = handleWithAt.replace(/^@/, '');

  const andQuery = [
    {
      $or: [
        { handle: handleWithAt },
        { handle: handleWithoutAt },
        { username: handleWithoutAt },
      ],
    },
    {
      $or: [
        { platform },
        { provider: platform },
        { [`${platform}.handle`]: { $exists: true } },
      ],
    },
  ];

  if (brandId) {
    andQuery.push({
      $or: [
        { brandId },
        { brandId: String(brandId) },
        { brandId: { $exists: false } },
        { brandId: null },
      ],
    });
  }

  const missing = await MissingEmail.findOne({ $and: andQuery }).lean();

  if (!missing) {
    return {
      email: null,
      source: 'missing_email_not_found',
      doc: null,
    };
  }

  const directEmail = getDirectEmailFromProfile(missing, platform);

  if (directEmail) {
    return {
      email: directEmail,
      source: 'missing_email_direct',
      doc: missing,
    };
  }

  const bioEmail = extractEmailFromText(collectBioText(missing, platform));

  if (bioEmail) {
    return {
      email: bioEmail,
      source: 'missing_email_bio',
      doc: missing,
    };
  }

  return {
    email: null,
    source: 'missing_email_no_email',
    doc: missing,
  };
}

async function findEmailInModash({ handle, platform }) {
  const handleWithAt = String(handle || '').trim();
  const handleWithoutAt = handleWithAt.replace(/^@/, '');

  const handleRegex = new RegExp(`^@?${escapeRegExp(handleWithoutAt)}$`, 'i');
  const platformRegex = new RegExp(`^${escapeRegExp(platform)}$`, 'i');

  const modash = await mongoose.connection.collection('modashes').findOne({
    $and: [
      {
        $or: [
          { handle: handleRegex },
          { username: handleRegex },
          { userId: handleRegex },
        ],
      },
      {
        $or: [
          { provider: platformRegex },
          { platform: platformRegex },
        ],
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

  const directEmail = getDirectEmailFromProfile(modash, platform);

  if (directEmail) {
    return {
      email: directEmail,
      source: 'modash_direct',
      doc: modash,
    };
  }

  const bioEmail = extractEmailFromText(
    [
      modash.bio,
      modash.description,
      modash.about,
      modash.contactInfo,
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

async function findEmailInInfluencer({ handle, platform }) {
  const handleWithAt = String(handle || '').trim().toLowerCase();
  const handleWithoutAt = handleWithAt.replace(/^@/, '');

  const handleQuery = {
    $or: [
      { handle: handleWithAt },
      { handle: handleWithoutAt },
      { username: handleWithoutAt },

      { 'profile.handle': handleWithAt },
      { 'profile.handle': handleWithoutAt },
      { 'profile.username': handleWithoutAt },

      { 'socialProfiles.handle': handleWithAt },
      { 'socialProfiles.handle': handleWithoutAt },
      { 'socialProfiles.username': handleWithoutAt },

      { [`${platform}.handle`]: handleWithAt },
      { [`${platform}.handle`]: handleWithoutAt },
      { [`${platform}.username`]: handleWithoutAt },
    ],
  };

  const platformQuery = {
    $or: [
      { platform },
      { provider: platform },

      { 'profile.platform': platform },
      { 'profile.provider': platform },

      { 'socialProfiles.platform': platform },
      { 'socialProfiles.provider': platform },

      { [`${platform}.handle`]: { $exists: true } },
      { [`${platform}.username`]: { $exists: true } },
    ],
  };

  let influencer = await InfluencerModel.findOne({
    $and: [handleQuery, platformQuery],
  }).lean();

  if (!influencer) {
    influencer = await InfluencerModel.findOne(handleQuery).lean();
  }

  if (!influencer) {
    return {
      email: null,
      source: 'influencer_not_found',
      doc: null,
    };
  }

  const directEmail = getDirectEmailFromProfile(influencer, platform);

  if (directEmail) {
    return {
      email: directEmail,
      source: 'influencer_direct',
      doc: influencer,
    };
  }

  const bioEmail = extractEmailFromText(collectBioText(influencer, platform));

  if (bioEmail) {
    return {
      email: bioEmail,
      source: 'influencer_bio',
      doc: influencer,
    };
  }

  return {
    email: null,
    source: 'influencer_no_email',
    doc: influencer,
  };
}

async function resolveCreatorEmail({ handle, platform, brandId }) {
  const fromMissing = await findEmailInMissingEmail({
    handle,
    platform,
    brandId,
  });

  if (fromMissing.email) return fromMissing;

  const fromModash = await findEmailInModash({
    handle,
    platform,
  });

  if (fromModash.email) return fromModash;

  const fromInfluencer = await findEmailInInfluencer({
    handle,
    platform,
  });

  if (fromInfluencer.email) return fromInfluencer;

  return {
    email: null,
    source:
      fromModash.source !== 'modash_not_found'
        ? fromModash.source
        : fromInfluencer.source !== 'influencer_not_found'
          ? fromInfluencer.source
          : fromMissing.source,
  };
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

  const html = String(
    template.htmlBody ||
      body.htmlBody ||
      ''
  ).trim();

  const from =
    cleanEmail(template.fromEmail || body.fromEmail) ||
    cleanEmail(process.env.SES_FROM_EMAIL) ||
    cleanEmail(process.env.SES_FROM) ||
    'confirm@collabglam.com';

  const cc = template.cc || body.cc || [];
  const bcc = template.bcc || body.bcc || [];
  const replyTo = template.replyTo || body.replyTo || [];

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
    from,
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
    {
      Name: 'type',
      Value: 'creator-invitation',
    },
    {
      Name: 'platform',
      Value: platform,
    },
    {
      Name: 'handle',
      Value: handle.replace(/^@/, ''),
    },
    {
      Name: 'brandId',
      Value: brandId,
    },
    ...(campaignId
      ? [
          {
            Name: 'campaignId',
            Value: campaignId,
          },
        ]
      : []),
  ];
}

exports.createInvitation = async (req, res) => {
  try {
    const rawHandle = (req.body?.handle || '').trim();
    const rawBrandId = (req.body?.brandId || '').trim();
    const rawPlatform = (req.body?.platform || '').trim();
    const rawStatus = (req.body?.status || '').trim().toLowerCase();
    const rawCampaignId = (req.body?.campaignId || '').trim();

    if (!rawHandle) {
      return res.status(400).json({
        status: 'error',
        message: 'handle is required',
      });
    }

    if (!rawBrandId) {
      return res.status(400).json({
        status: 'error',
        message: 'brandId is required',
      });
    }

    if (!rawPlatform) {
      return res.status(400).json({
        status: 'error',
        message: 'platform is required',
      });
    }

    const handle = normalizeHandle(rawHandle);

    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: 'error',
        message:
          'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-"',
      });
    }

    const platform = PLATFORM_MAP.get(rawPlatform.toLowerCase());

    if (!platform) {
      return res.status(400).json({
        status: 'error',
        message:
          'Invalid platform. Use: youtube|instagram|tiktok (aliases: yt, ig, tt)',
      });
    }

    const status = STATUS_ENUM.has(rawStatus) ? rawStatus : 'invited';

    let doc = await Invitation.findOne({
      brandId: rawBrandId,
      handle,
      platform,
    });

    let responseStatus = 'saved';
    let httpStatus = 201;

    if (doc) {
      responseStatus = 'exists';
      httpStatus = 200;

      let changed = false;

      if (rawCampaignId && doc.campaignId !== rawCampaignId) {
        doc.campaignId = rawCampaignId;
        changed = true;
      }

      if (status === 'available' && doc.status !== 'available') {
        doc.status = 'available';
        changed = true;
      }

      if (changed) {
        await doc.save();
      }
    } else {
      const payload = {
        handle,
        platform,
        brandId: rawBrandId,
        status,
      };

      if (rawCampaignId) {
        payload.campaignId = rawCampaignId;
      }

      doc = await Invitation.create(payload);
    }

    let emailSent = false;
    let emailMeta = null;
    let emailSkippedReason = null;

    const emailTemplate = normalizeEmailTemplate(req.body);

    if (!emailTemplate) {
      emailSkippedReason =
        'Invitation saved, but emailTemplate was not provided or is missing subject/body.';
    } else {
      const emailLookup = await resolveCreatorEmail({
        handle,
        platform,
        brandId: rawBrandId,
      });

      if (!emailLookup.email) {
        emailSkippedReason =
          emailLookup.source === 'missing_email_not_found' ||
          emailLookup.source === 'modash_not_found' ||
          emailLookup.source === 'influencer_not_found'
            ? 'Creator profile not found for this handle/platform.'
            : 'No email found in creator profile fields or bio.';
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
              brandId: rawBrandId,
              campaignId: rawCampaignId || null,
              platform,
              handle,
            }),
          });

          emailSent = true;

          emailMeta = {
            recipientEmail: emailLookup.email,
            emailSource: emailLookup.source,
            messageId: sent?.messageId || null,
            subject: emailTemplate.subject,
            campaignId: rawCampaignId || null,
          };
        } catch (mailErr) {
          console.error('Invitation AWS email send failed:', mailErr);

          emailSkippedReason =
            mailErr?.message ||
            'Invitation saved, but AWS email sending failed.';
        }
      }
    }

    return res.status(httpStatus).json({
      status: responseStatus,
      message:
        responseStatus === 'exists'
          ? 'Invitation already exists for this handle & brand.'
          : 'Invitation created successfully.',
      emailSent,
      emailMeta,
      emailSkippedReason,
      data: {
        invitationId: doc.invitationId,
        handle: doc.handle,
        platform: doc.platform,
        brandId: doc.brandId,
        campaignId: doc.campaignId || null,
        status: doc.status,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      },
    });
  } catch (err) {
    console.error('createInvitation error:', err);

    return res.status(500).json({
      status: 'error',
      message: err?.message || 'Failed to create invitation',
    });
  }
};

exports.updateInvitationStatus = async (req, res) => {
  try {
    const rawHandle = (req.body?.handle || '').trim();
    const rawPlatformInput = (req.body?.platform || '').trim().toLowerCase();
    const rawStatus = (req.body?.status || '').trim().toLowerCase();
    const rawMissingEmailId = (req.body?.missingEmailId || '').trim();
    const rawBrandId = (req.body?.brandId || '').trim();

    if (!rawHandle) {
      return res.status(400).json({
        status: 'error',
        message: 'handle is required',
      });
    }

    const handle = normalizeHandle(rawHandle);

    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: 'error',
        message:
          'Invalid handle format. It must start with "@" and contain letters, numbers, ".", "_" or "-"',
      });
    }

    const platform = PLATFORM_MAP.get(rawPlatformInput);

    if (!platform || !PLATFORM_ENUM.has(platform)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid platform. Use "youtube", "instagram" or "tiktok".',
      });
    }

    if (!STATUS_ENUM.has(rawStatus)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid status. Use "invited" or "available".',
      });
    }

    const query = {
      handle,
      platform,
    };

    if (rawBrandId) {
      query.brandId = rawBrandId;
    }

    const doc = await Invitation.findOne(query);

    if (!doc) {
      return res.status(404).json({
        status: 'error',
        message: 'Invitation not found for given handle & platform.',
      });
    }

    if (rawMissingEmailId) {
      const me = await MissingEmail.findOne(
        {
          missingEmailId: rawMissingEmailId,
        },
        'missingEmailId handle platform'
      ).lean();

      if (!me) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid missingEmailId. No MissingEmail record found.',
        });
      }

      doc.missingEmailId = me.missingEmailId;
    }

    doc.status = rawStatus;
    await doc.save();

    return res.json({
      status: 'success',
      message: 'Invitation status updated.',
      data: {
        invitationId: doc.invitationId,
        handle: doc.handle,
        platform: doc.platform,
        brandId: doc.brandId,
        campaignId: doc.campaignId || null,
        status: doc.status,
        missingEmailId: doc.missingEmailId || null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      },
    });
  } catch (err) {
    console.error('Error in updateInvitationStatus:', err);

    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
    });
  }
};

exports.listInvitations = async (req, res) => {
  const body = req.body || {};

  const page = Math.max(1, parseInt(body.page ?? '1', 10));
  const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '50', 10)));

  const rawBrandId = typeof body.brandId === 'string' ? body.brandId.trim() : '';
  const rawHandle = typeof body.handle === 'string' ? body.handle.trim() : '';
  const rawPlatform = typeof body.platform === 'string' ? body.platform.trim() : '';
  const rawStatus =
    typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';
  const rawCampaignId =
    typeof body.campaignId === 'string' ? body.campaignId.trim() : '';

  const query = {};

  if (rawBrandId) {
    query.brandId = rawBrandId;
  }

  if (rawCampaignId) {
    query.campaignId = rawCampaignId;
  }

  if (rawHandle) {
    const handle = normalizeHandle(rawHandle);

    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid handle format in filter',
      });
    }

    query.handle = handle;
  }

  if (rawPlatform) {
    const p = PLATFORM_MAP.get(rawPlatform.toLowerCase());

    if (!p) {
      return res.status(400).json({
        status: 'error',
        message:
          'Invalid platform filter. Use: youtube|instagram|tiktok (aliases: yt, ig, tt)',
      });
    }

    query.platform = p;
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
      .sort({
        createdAt: -1,
      })
      .skip((page - 1) * limit)
      .limit(limit)
      .select({
        _id: 0,
        invitationId: 1,
        handle: 1,
        platform: 1,
        brandId: 1,
        campaignId: 1,
        missingEmailId: 1,
        status: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .lean(),
  ]);

  const campaignIds = [
    ...new Set(
      docs
        .map((inv) => inv.campaignId)
        .filter((id) => typeof id === 'string' && id.trim().length > 0)
    ),
  ];

  let data = docs.map((inv) => ({
    ...inv,
    campaignName: null,
  }));

  if (campaignIds.length > 0) {
    const campaigns = await Campaign.find({
      campaignsId: {
        $in: campaignIds,
      },
    })
      .select({
        _id: 0,
        campaignsId: 1,
        productOrServiceName: 1,
      })
      .lean();

    const campaignMap = new Map(
      campaigns.map((c) => [c.campaignsId, c.productOrServiceName])
    );

    data = docs.map((inv) => ({
      ...inv,
      campaignName: inv.campaignId
        ? campaignMap.get(inv.campaignId) || null
        : null,
    }));
  }

  return res.json({
    page,
    limit,
    total,
    hasNext: page * limit < total,
    data,
  });
};

exports.getInvitationList = async (req, res) => {
  try {
    const rawBrandId =
      (typeof req.body?.brandId === 'string' && req.body.brandId.trim()) ||
      (typeof req.query?.brandId === 'string' && req.query.brandId.trim()) ||
      '';

    if (!rawBrandId) {
      return res.status(400).json({
        status: 'error',
        message: 'brandId is required',
      });
    }

    const invitations = await Invitation.find({
      brandId: rawBrandId,
      missingEmailId: {
        $ne: null,
      },
    })
      .select({
        _id: 0,
        invitationId: 1,
        brandId: 1,
        campaignId: 1,
        missingEmailId: 1,
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
      ...new Set(invitations.map((inv) => inv.missingEmailId).filter(Boolean)),
    ];

    const missingDocs = await MissingEmail.find({
      missingEmailId: {
        $in: missingIds,
      },
    })
      .select({
        _id: 0,
        missingEmailId: 1,
        handle: 1,
        youtube: 1,
      })
      .lean();

    const missingMap = new Map();

    for (const me of missingDocs) {
      missingMap.set(me.missingEmailId, me);
    }

    const data = invitations.map((inv) => {
      const me = missingMap.get(inv.missingEmailId);

      const title =
        (me && me.youtube && me.youtube.title) ||
        (me && me.handle) ||
        '';

      return {
        invitationId: inv.invitationId,
        missingEmailId: inv.missingEmailId,
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
      message: 'Internal server error',
    });
  }
};

const COOLDOWN_MS = 48 * 60 * 60 * 1000;

async function computeBrandEligibilityForThread(threadId) {
  const messages = await EmailMessage.find({
    thread: threadId,
  })
    .select('direction createdAt sentAt')
    .sort({
      createdAt: 1,
    })
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
      reason: 'Wait 48 hours before sending a follow-up (no reply yet).',
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
}

exports.getInvitationSendEligibility = async (req, res) => {
  try {
    const brandId = String(req.body?.brandId || '').trim();
    const invitationId = String(req.body?.invitationId || '').trim();

    if (!brandId || !invitationId) {
      return res.status(400).json({
        canSend: false,
        state: 'missing_email',
        reason: 'brandId and invitationId are required.',
        nextAllowedAt: null,
      });
    }

    const brand = await Brand.findOne({
      brandId,
    }).lean();

    if (!brand) {
      return res.status(404).json({
        canSend: false,
        state: 'missing_email',
        reason: 'Brand not found.',
        nextAllowedAt: null,
      });
    }

    const invitation = await Invitation.findOne({
      invitationId,
    }).lean();

    if (!invitation) {
      return res.status(404).json({
        canSend: false,
        state: 'missing_email',
        reason: 'Invitation not found.',
        nextAllowedAt: null,
      });
    }

    if (invitation.brandId && invitation.brandId !== (brand.brandId || String(brand._id))) {
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
        reason: 'No email resolved yet for this invitation.',
        nextAllowedAt: null,
        threadId: null,
      });
    }

    const missing = await MissingEmail.findOne({
      missingEmailId: invitation.missingEmailId,
    }).lean();

    const recipientEmail = (missing?.email || '').toLowerCase().trim();

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