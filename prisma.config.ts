import "dotenv/config";
// defineConfig is a helper from Prisma. It gives you autocomplete and type checking while you write the config.
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});

// A migration is a record of each change you made to the database structure
// When you run commands like npx prisma migrate dev, Prisma reads this file first to know what to do.
