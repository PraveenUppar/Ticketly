import { PrismaClient } from "@prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { DATABASE_URL } from "./env.js";

const adapter = new PrismaMariaDb(DATABASE_URL);

const prisma = new PrismaClient({ adapter });

export default prisma;

// This file creates ONE Prisma client that the whole app shares.
// How it works:
//   1. DATABASE_URL is imported from env.js (your MySQL connection string)
//   2. PrismaMariaDb is a "driver adapter". It is the piece that actually
//      connects to the database. MySQL and MariaDB use the same protocol,
//      so this one adapter works for your MySQL database.
//   3. PrismaClient is created with that adapter, so every query goes
//      through it
//   4. The client is exported as default, so any file can use it
//
// Why only one client:
//   Each client opens its own database connections. Creating many clients
//   wastes connections. One shared client avoids that.
