import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL doit être défini pour connecter Luigi à PostgreSQL.");
}

const client = postgres(databaseUrl, {
  max: process.env.NODE_ENV === "production" ? 10 : 1,
  prepare: false,
});

export const db = drizzle({ client, schema });
