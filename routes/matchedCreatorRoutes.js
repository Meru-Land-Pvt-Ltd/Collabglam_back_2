const express = require('express');
const router = express.Router();

const {
  createMatchedCreator,
  getMatchedCreatorList,
} = require('../controllers/matchedCreatorController');

router.post('/create', createMatchedCreator);
router.get('/list', getMatchedCreatorList);
module.exports = router;