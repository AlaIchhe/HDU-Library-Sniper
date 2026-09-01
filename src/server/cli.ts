import { AuthService } from "./auth";
import { BookingExecutor } from "./booking";

const command = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (command !== "booking-run") {
  console.error("Usage: bun run src/server/cli.ts booking-run");
  process.exit(64);
}

const auth = new AuthService();
if (!(await auth.restore())) {
  console.error("登录态失效，无法执行预约");
  process.exit(2);
}
const result = await new BookingExecutor(auth.client).run(dryRun);
console.log(JSON.stringify(result));
process.exit(result.success ? 0 : 1);
