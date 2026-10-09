/**
 * `npm run db:migrate`
 *
 * Kept separate from the app on purpose -- see `migrate.ts` for why this
 * cannot run inside the Next server runtime.
 */
import { migrate } from "./migrate";

migrate()
  .then(() => {
    console.log("Migrations applied.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
