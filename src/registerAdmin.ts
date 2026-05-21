import { createOrUpdateAdminUser } from "./adminUsers.js";
import { migrate, pool } from "./db.js";

const [, , email, password] = process.argv;

if (!email || !password) {
  console.error("Usage: node dist/registerAdmin.js <email> <password>");
  process.exit(1);
}

await migrate();
await createOrUpdateAdminUser(email, password);
await pool.end();

console.log(`Registered admin user: ${email}`);
