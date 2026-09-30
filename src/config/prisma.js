import { PrismaClient } from "@prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { DATABASE_URL } from "./env.js";

const adapter = new PrismaMariaDb(DATABASE_URL);

const prisma = new PrismaClient({ adapter });

export default prisma;
