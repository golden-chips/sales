import { resetDb } from "../scripts/reset-db.js";
import { testEnv } from "./env.js";

export default async function () {
  await resetDb(testEnv.DATABASE_ADMIN_URL, testEnv.APP_DB_PASSWORD);
}
