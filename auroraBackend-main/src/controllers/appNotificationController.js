const appNotificationService = require('../services/appNotificationService');

exports.getNotifications = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const unreadOnly = req.query.unreadOnly === 'true';
    const category = req.query.category || null;
    const entityId = req.query.productId || req.query.orderId || null;

    const data = await appNotificationService.listNotifications(req.user._id, {
      limit,
      unreadOnly,
      category,
      entityId,
    });

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const updated = await appNotificationService.markAsRead(req.user._id, req.params.id);

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    const { unreadCount } = await appNotificationService.listNotifications(req.user._id, {
      limit: 1,
    });

    res.json({ success: true, unreadCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/** Dev helper — verify bell UI loads notifications (development only). */
exports.seedTestNotification = async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, message: 'Not available' });
  }

  try {
    const doc = await appNotificationService.createNotification(req.user._id, {
      type: 'info',
      title: 'Test notification',
      message: 'If you see this, the notification inbox is working.',
      link: '/dashboard',
      metadata: { source: 'seed' },
    });

    res.status(201).json({
      success: true,
      message: 'Test notification created',
      notification: {
        _id: doc._id,
        title: doc.title,
        message: doc.message,
        createdAt: doc.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.markAllAsRead = async (req, res) => {
  try {
    const category = req.query.category || null;
    const entityId = req.query.productId || req.query.orderId || null;

    const modifiedCount = await appNotificationService.markAllAsRead(req.user._id, {
      category,
      entityId,
    });

    const { unreadCount } = await appNotificationService.listNotifications(req.user._id, {
      limit: 1,
    });

    res.json({ success: true, modifiedCount, unreadCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
