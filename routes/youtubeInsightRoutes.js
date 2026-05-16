'use strict';

const express = require('express');
const router = express.Router();
const youtubeInsightController = require('../controllers/youtubeInsightController');
const { adminAuth } = require('../middlewares/adminAuth');

router.post('/analyze', youtubeInsightController.analyzeYoutubeVideo);
router.get('/summary', youtubeInsightController.getYoutubeInsightSummary);
router.get('/', youtubeInsightController.getYoutubeInsightReports);
router.post('/getlist', youtubeInsightController.getYoutubeInsightReports);
router.get('/:id', youtubeInsightController.getYoutubeInsightReportById);
router.delete('/:id', youtubeInsightController.deleteYoutubeInsightReport);

module.exports = router;
