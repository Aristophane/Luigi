import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL doit être défini pour connecter Luigi à PostgreSQL.");
}

const client = postgres(databaseUrl, {
  max: 10,
  connect_timeout: 5,
  connection: { statement_timeout: 30000 },
  prepare: false,
});

export const db = drizzle({ client, schema });
export type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export const closeDatabase = () => client.end({ timeout: 5 });
