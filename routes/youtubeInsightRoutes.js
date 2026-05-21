'use strict';

const express = require('express');
const {
  analyzeYoutubeVideo,
  getYoutubeInsightReports,
  getYoutubeInsightReportById,
  getYoutubeInsightSummary,
  deleteYoutubeInsightReport
} = require('../controllers/youtubeInsightController');

const router = express.Router();

router.post('/analyze', analyzeYoutubeVideo);

router.get('/', getYoutubeInsightReports);
router.get('/summary', getYoutubeInsightSummary);
router.get('/:id', getYoutubeInsightReportById);
router.delete('/:id', deleteYoutubeInsightReport);

module.exports = router;