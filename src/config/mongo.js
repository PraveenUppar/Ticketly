import mongoose from "mongoose";
import { MONGO_URL } from "./env.js";
import logger from "../utils/logger.js";

export async function connectMongo() {
  await mongoose.connect(MONGO_URL);
  logger.info("MongoDB connected");
}

export async function disconnectMongo() {
  await mongoose.disconnect();
}

// This file connects your app to MongoDB (and disconnects from it).
// What each part does:
//   connectMongo()     opens the connection using MONGO_URL from env.js.
//                      If MongoDB does not respond within 5 seconds
//                      (serverSelectionTimeoutMS), it throws an error instead
//                      of waiting forever. On success, it logs "MongoDB connected".
//   disconnectMongo()  closes the connection cleanly.
//
// Where to use them:
//   - Call connectMongo() once when your server starts, before accepting requests
//   - Call disconnectMongo() when the server shuts down, or at the end of tests
