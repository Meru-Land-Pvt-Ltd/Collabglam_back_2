const MatchedCreator = require('../models/machedCreators');
const saveErrorLog = require('../services/errorLog.service');

const createMatchedCreator = async (req, res) => {
  try {
    const { productType, budget, market, email } = req.body;

    if (!productType || !budget || !market || !email) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required.',
      });
    }

    const newMatchedCreator = new MatchedCreator({
      productType,
      budget,
      market,
      email,
    });

    const savedData = await newMatchedCreator.save();

    return res.status(201).json({
      success: true,
      message: 'Matched creator form submitted successfully.',
      data: savedData,
    });
  } catch (error) {
    console.error('Error creating matched creator:', error);
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, 'CREATE_MATCHED_CREATOR_ERROR');

    return res.status(500).json({
      success: false,
      message: 'Server error while saving matched creator data.',
      error: error.message,
    });
  }
};

const getMatchedCreatorList = async (req, res) => {
  try {
    const matchedCreators = await MatchedCreator.find().sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: 'Matched creator list fetched successfully.',
      data: matchedCreators,
    });
  } catch (error) {
    console.error('Error fetching matched creator list:', error);
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, 'GET_MATCHED_CREATOR_LIST_ERROR');

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