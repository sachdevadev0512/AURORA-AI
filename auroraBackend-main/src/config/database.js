const mongoose = require('mongoose');
const { isMongoConnectivityError } = require('../utils/mongoErrors');

const MONGO_OPTIONS = {
  serverSelectionTimeoutMS: 3000,
  socketTimeoutMS: 45000,
  heartbeatFrequencyMS: 10000,
  maxPoolSize: Math.max(10, Number(process.env.MONGO_MAX_POOL_SIZE || 50)),
  minPoolSize: Math.max(0, Number(process.env.MONGO_MIN_POOL_SIZE || 2)),
  maxIdleTimeMS: Math.max(0, Number(process.env.MONGO_MAX_IDLE_TIME_MS || 60000)),
  waitQueueTimeoutMS: Math.max(0, Number(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS || 30000)),
  retryWrites: true,
  retryReads: true,
};

let handlersRegistered = false;
let reconnectTimer = null;
let isReconnecting = false;

function scheduleReconnect(reason) {
  if (reconnectTimer || isReconnecting) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectMongo(reason);
  }, 3000);
}

async function reconnectMongo(reason) {
  if (isReconnecting) return;

  isReconnecting = true;
  try {
    console.warn(`[MongoDB] Reconnecting (${reason})...`);
    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    } catch (_) {
      // Ignore disconnect errors during Atlas failover.
    }
    const conn = await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, MONGO_OPTIONS);
    console.log(`[MongoDB] Reconnected: ${conn.connection.host}`);
  } catch (error) {
    console.error('[MongoDB] Reconnect failed:', error.message);
    scheduleReconnect('retry after failure');
  } finally {
    isReconnecting = false;
  }
}

function registerConnectionHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;

  const conn = mongoose.connection;

  conn.on('disconnected', () => {
    console.warn('[MongoDB] Disconnected');
    scheduleReconnect('disconnected');
  });

  conn.on('error', (error) => {
    console.error('[MongoDB] Connection error:', error.message);
    if (isMongoConnectivityError(error)) {
      scheduleReconnect(error.name || 'connectivity error');
    }
  });

  conn.on('reconnected', () => {
    console.log('[MongoDB] Connection restored');
  });
}

const connectDB = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aurora';

  try {
    const conn = await mongoose.connect(uri, MONGO_OPTIONS);
    console.log(`MongoDB Connected: ${conn.connection.host} (pool max=${MONGO_OPTIONS.maxPoolSize})`);
    registerConnectionHandlers();
  } catch (error) {
    console.warn('[MongoDB] Configured URI connection attempt failed:', error.message);
    if (process.env.NODE_ENV !== 'production') {
      try {
        console.log('[MongoDB] Starting in-memory MongoDB server for local development...');
        const { MongoMemoryServer } = require('mongodb-memory-server');
        const mongoServer = await MongoMemoryServer.create();
        const memUri = mongoServer.getUri();
        process.env.MONGO_URI = memUri;
        process.env.MONGODB_URI = memUri;
        try {
          if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
          }
        } catch (_) {}
        const conn = await mongoose.connect(memUri, MONGO_OPTIONS);
        console.log(`[MongoDB] In-memory MongoDB connected successfully: ${memUri}`);
        registerConnectionHandlers();
        return;
      } catch (memErr) {
        console.error('[MongoDB] In-memory fallback failed:', memErr.message);
      }
    }
    registerConnectionHandlers();
    scheduleReconnect('initial connection failed');
    process.exit(1);
  }
};

module.exports = connectDB;
