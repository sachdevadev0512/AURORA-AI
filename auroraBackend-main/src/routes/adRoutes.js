const express = require('express');
const router = express.Router();
const adController = require('../controllers/adController');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/sync', adController.syncAds);
router.get('/sync/status', adController.getSyncStatus);
router.get('/export', adController.exportAdsReport);
router.get('/stats', adController.getAdStats);
router.get('/profiles', adController.getAdsProfiles);
router.get('/portfolios', adController.getAdsPortfolios);
router.post('/campaigns/create', adController.createAmazonCampaign);
router.get('/', adController.getAds);
router.get('/:id', adController.getAd);
router.post('/', adController.createAd);
router.put('/:id', adController.updateAd);
router.delete('/:id', adController.deleteAd);

module.exports = router;
