import mongoose from 'mongoose';
import { MONGO_URL } from './env.js';
import logger from '../utils/logger.js';

// Fail fast (5s) with a clear message if MongoDB isn't running,
// instead of mongoose silently buffering queries forever.
export async function connectMongo() {
  await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  logger.info('MongoDB connected');
}

export async function disconnectMongo() {
  await mongoose.disconnect();
}
