const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const socketIO = require('socket.io');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimit');

const SOCKET_CORS_ORIGINS = [
  'https://aurora-frontend-git-main-aiofileflow-bits-projects.vercel.app',
  'https://aurora-frontend-sable-xi.vercel.app',
  'http://localhost:5173',
];

const HTTP_CORS_ORIGINS = [
  ...SOCKET_CORS_ORIGINS,
  'https://auroratest.in',
  'https://www.auroratest.in',
];

/**
 * Build the Express app + HTTP server + Socket.IO without listening or starting
 * background workers. Side-effectful startup stays in `index.js`.
 */
async function createApp() {
  const app = express();
  const server = http.createServer(app);
  app.set('trust proxy', 1);

  const io = socketIO(server, {
    cors: {
      origin(origin, callback) {
        if (!origin || SOCKET_CORS_ORIGINS.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
    },
  });

  const { attachSocketIoAdapter } = require('./config/socketIo');
  const socketAdapter = await attachSocketIoAdapter(io);
  if (process.env.NODE_ENV === 'production' && socketAdapter?.mode === 'memory') {
    console.error(
      `[Socket.IO] Running in-memory adapter in production (${socketAdapter.reason || 'disabled'}). Real-time sync updates will NOT reach clients on other instances — use SOCKET_IO_ADAPTER=mongo with a replica-set MongoDB.`,
    );
  }

  global.io = io;

  const { socketAuthMiddleware } = require('./middleware/socketAuth');
  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    const room = `user_${socket.userId}`;
    socket.join(room);

    socket.on('joinUser', (userId) => {
      if (String(userId) === socket.userId) {
        socket.join(`user_${userId}`);
      }
    });

    socket.on('leaveUser', (userId) => {
      if (String(userId) === socket.userId) {
        socket.leave(`user_${userId}`);
      }
    });
  });

  app.use(helmet());

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || HTTP_CORS_ORIGINS.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
    }),
  );

  app.options('*', cors());

  if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
  }

  const { handleAmazonNotification } = require('./controllers/notificationsController');

  // Amazon notification webhook must keep the raw body for signature verification.
  app.post(
    '/api/notifications/webhook/amazon',
    apiLimiter,
    express.raw({ type: 'application/json', limit: '1mb' }),
    handleAmazonNotification,
  );

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  app.use('/api/auth', apiLimiter, require('./routes/authRoutes'));
  app.use('/api/admin/seller-applications', apiLimiter, require('./routes/sellerApplicationRoutes'));
  app.use('/api/products', apiLimiter, require('./routes/productRoutes'));
  app.use('/api/orders', apiLimiter, require('./routes/orderRoutes'));
  app.use('/api/shipments', apiLimiter, require('./routes/shipmentRoutes'));
  app.use('/api/ads', apiLimiter, require('./routes/adRoutes'));
  app.use('/api/sp-api', apiLimiter, require('./routes/spApiRoutes'));
  app.use('/api/notifications', apiLimiter, require('./routes/notificationRoutes'));
  app.use('/api/user-notifications', apiLimiter, require('./routes/appNotificationRoutes'));

  app.get('/api/health', (req, res) => {
    res.status(200).json({
      success: true,
      message: 'Aurora Backend API is running',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
    });
  });

  app.all('*', (req, res) => {
    res.status(404).json({
      success: false,
      error: `Route ${req.originalUrl} not found`,
    });
  });

  app.use(errorHandler);

  return { app, server, io };
}

module.exports = {
  createApp,
  SOCKET_CORS_ORIGINS,
  HTTP_CORS_ORIGINS,
};
