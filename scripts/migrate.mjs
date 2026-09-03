import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL doit être défini pour appliquer les migrations.");
}

const client = postgres(databaseUrl, { max: 1, prepare: false });
const database = drizzle(client);

try {
  await migrate(database, { migrationsFolder: "drizzle" });
  console.log("Migrations PostgreSQL appliquées.");
} finally {
  await client.end();
}
