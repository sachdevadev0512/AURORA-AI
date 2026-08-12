const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const appNotificationController = require('../controllers/appNotificationController');

router.use(protect);

router.get('/', appNotificationController.getNotifications);
router.post('/seed', appNotificationController.seedTestNotification);
router.patch('/read-all', appNotificationController.markAllAsRead);
router.patch('/:id/read', appNotificationController.markAsRead);

module.exports = router;
