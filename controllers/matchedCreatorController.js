const MatchedCreator = require('../models/matchedCreators');
const saveErrorLog = require('../services/errorLog.service');

const REQUIRED_FIELDS = [
  'productType',
  'budget',
  'platform',
  'market',
  'brandName',
  'email',
  'managedPlan',
];

const trimString = (value) => {
  if (typeof value !== 'string') return value;
  return value.trim();
};

const normalizePayload = (body) => {
  return {
    productType: trimString(body.productType),
    budget: trimString(body.budget),
    platform: trimString(body.platform),
    market: trimString(body.market),
    brandName: trimString(body.brandName),
    email: trimString(body.email)?.toLowerCase(),
    managedPlan: trimString(body.managedPlan),
  };
};

const getMissingFields = (payload) => {
  return REQUIRED_FIELDS.filter((field) => !payload[field]);
};

const logControllerError = async (req, error, code) => {
  try {
    await saveErrorLog(
      req,
      error,
      error?.statusCode || error?.status || 500,
      code
    );
  } catch (logError) {
    console.error('Error while saving error log:', logError);
  }
};

const createMatchedCreator = async (req, res) => {
  try {
    const payload = normalizePayload(req.body);

    const missingFields = getMissingFields(payload);

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required.',
        missingFields,
      });
    }

    const matchedCreator = await MatchedCreator.create(payload);

    return res.status(201).json({
      success: true,
      message: 'Creator shortlist request submitted successfully.',
      data: matchedCreator,
    });
  } catch (error) {
    console.error('Error creating matched creator:', error);

    await logControllerError(req, error, 'CREATE_MATCHED_CREATOR_ERROR');

    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(
        (item) => item.message
      );

      return res.status(400).json({
        success: false,
        message: validationErrors[0] || 'Invalid matched creator data.',
        errors: validationErrors,
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Server error while saving matched creator data.',
      error: error.message,
    });
  }
};

const getMatchedCreatorList = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const search = trimString(req.query.search || '');

    const filter = search
      ? {
          $or: [
            { brandName: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
            { productType: { $regex: search, $options: 'i' } },
            { platform: { $regex: search, $options: 'i' } },
            { market: { $regex: search, $options: 'i' } },
          ],
        }
      : {};

    const [matchedCreators, total] = await Promise.all([
      MatchedCreator.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MatchedCreator.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      message: 'Matched creator list fetched successfully.',
      data: matchedCreators,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching matched creator list:', error);

    await logControllerError(req, error, 'GET_MATCHED_CREATOR_LIST_ERROR');

    return res.status(500).json({
      success: false,
      message: 'Server error while fetching matched creator list.',
      error: error.message,
    });
  }
};

module.exports = {
  createMatchedCreator,
  getMatchedCreatorList,
};