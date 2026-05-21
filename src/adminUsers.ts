import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { pool } from "./db.js";

const hashPrefix = "scrypt";

export async function ensureConfiguredAdminUser() {
  await createOrUpdateAdminUser(config.ADMIN_USERNAME, config.ADMIN_PASSWORD, false);
}

export async function createOrUpdateAdminUser(email: string, password: string, overwrite = true) {
  const normalizedEmail = normalizeEmail(email);
  const passwordHash = hashPassword(password);

  if (overwrite) {
    await pool.query(
      `insert into admin_users (email, password_hash, is_active)
       values ($1, $2, true)
       on conflict (email) do update
       set password_hash = excluded.password_hash,
           is_active = true,
           updated_at = now()`,
      [normalizedEmail, passwordHash],
    );
    return;
  }

  await pool.query(
    `insert into admin_users (email, password_hash, is_active)
     values ($1, $2, true)
     on conflict (email) do nothing`,
    [normalizedEmail, passwordHash],
  );
}

export async function verifyAdminUser(email: string, password: string) {
  const normalizedEmail = normalizeEmail(email);
  const result = await pool.query<{ password_hash: string }>(
    "select password_hash from admin_users where email = $1 and is_active = true",
    [normalizedEmail],
  );

  if (result.rowCount === 1) {
    return verifyPassword(password, result.rows[0].password_hash);
  }

  return normalizedEmail === normalizeEmail(config.ADMIN_USERNAME) && safeEqual(password, config.ADMIN_PASSWORD);
}

export async function isActiveAdminUser(email: string) {
  const normalizedEmail = normalizeEmail(email);
  const result = await pool.query("select 1 from admin_users where email = $1 and is_active = true", [normalizedEmail]);
  return result.rowCount === 1 || normalizedEmail === normalizeEmail(config.ADMIN_USERNAME);
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `${hashPrefix}$${salt}$${hash}`;
}

function verifyPassword(password: string, storedHash: string) {
  const [prefix, salt, hash] = storedHash.split("$");
  if (prefix !== hashPrefix || !salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(password, salt, expected.length);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}
