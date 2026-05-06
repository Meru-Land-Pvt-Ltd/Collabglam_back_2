'use strict';

const express = require('express');
const router = express.Router();

const controller = require('../controllers/pitchFolderController');
const { adminAuth } = require('../middlewares/adminAuth');
const { brandAuth } = require('../auth/brandAuth');

// public shared routes
router.get('/shared/:token', controller.getSharedFolder);
router.post('/shared/:token/good-fit/:itemId', controller.updateSharedFolderGoodFit);

// generic brand request route
router.post('/shared/:token/media-kit-request/:itemId', controller.requestSharedFolderMediaKit);

// backward-compatible alias
router.post('/shared/:token/media-kit-link-request/:itemId', controller.requestSharedFolderMediaKit);

// brand routes
// Used by Creator Hub filter dropdown. Returns only this brand's fully-managed
// campaign folders that are assigned to a campaign and have at least one good fit creator.
router.get('/folder/list', brandAuth, controller.getFolderList);

// Used after selecting a campaign/folder option from Creator Hub.
// This checks the selected campaign belongs to the logged-in brand, then returns
// only goodFit === true creators from the pitch folder assigned to that campaign.
router.get('/campaign/:campaignId/good-fit', brandAuth, controller.getCampaignGoodFitList);

// Keep this existing route as-is for any create-folder usage.
router.post('/folder/create', brandAuth, controller.createFolder);

// admin routes
router.get('/list', adminAuth, controller.listFolders);
router.post('/create', adminAuth, controller.createFolder);
router.get('/campaign/:campaignId', controller.getFolderByAssignedCampaign);
router.get('/:id', adminAuth, controller.getFolderById);
router.post('/update', adminAuth, controller.updateFolder);
router.post('/duplicate', adminAuth, controller.duplicateFolder);
router.post('/:id/duplicate', adminAuth, controller.duplicateFolder);
router.post('/archive', adminAuth, controller.archiveFolder);

router.post('/selection-reason/generate', adminAuth, controller.generateSelectionReason);

router.post('/:id/item', adminAuth, controller.addFolderItem);
router.post('/:id/item/:itemId/activate-campaign', adminAuth, controller.activateFolderItemOnAssignedCampaign);
router.post('/item/update', adminAuth, controller.updateFolderItem);
router.post('/item/delete', adminAuth, controller.deleteFolderItem);
router.post('/items/move', adminAuth, controller.moveFolderItems);

router.post('/item/media-kit/presign', adminAuth, controller.getFolderItemMediaKitUploadUrl);
router.post('/item/media-kit/visibility', adminAuth, controller.updateFolderItemMediaKitVisibility);
router.post('/item/media-kit/approval', adminAuth, controller.updateFolderItemMediaKitApproval);

router.post('/item/media-kit-link/visibility', adminAuth, controller.updateFolderItemMediaKitLinkVisibility);
router.post('/item/media-kit-link/approval', adminAuth, controller.updateFolderItemMediaKitLinkApproval);

router.post('/:id/share-link', adminAuth, controller.generateShareLink);
router.post('/:id/import-youtube', adminAuth, controller.bulkImportYoutubeToFolder);

router.post('/assign-campaign', adminAuth, controller.assignCampaignToFolder);

module.exports = router;
