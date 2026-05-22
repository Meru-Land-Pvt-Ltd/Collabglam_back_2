'use strict';

const express = require('express');
const {
  analyzeYoutubeVideo,
  getYoutubeInsightReports,
  getYoutubeInsightReportById,
  getYoutubeInsightSummary,
  deleteYoutubeInsightReport,
  createYoutubeInsightPublicLink,
  getYoutubeInsightPublicShare
} = require('../controllers/youtubeInsightController');

const router = express.Router();

router.post('/analyze', analyzeYoutubeVideo);

router.post('/share', createYoutubeInsightPublicLink);

router.get('/public/:token', getYoutubeInsightPublicShare);
router.get('/', getYoutubeInsightReports);
router.get('/summary', getYoutubeInsightSummary);
router.get('/:id', getYoutubeInsightReportById);
router.delete('/:id', deleteYoutubeInsightReport);

module.exports = router;