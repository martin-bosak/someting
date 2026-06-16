import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  ADMIN_USERNAME: z.string().min(1).default("admin"),
  ADMIN_PASSWORD: z.string().min(12),
  SESSION_SECRET: z.string().min(32).optional(),
  HOSTING_ROOT: z.string().min(1).default("/srv/hosting"),
  CREATE_SITE_SCRIPT: z.string().min(1).default("/srv/hosting/bin/create-site.sh"),
  DEPLOY_SCRIPT: z.string().min(1).default("/srv/hosting/bin/deploy-site.sh"),
  WEDOS_WAPI_USER: z.string().optional(),
  WEDOS_WAPI_PASSWORD: z.string().optional(),
  WEDOS_A_RECORD_IP: z.string().optional(),
  ACTIVE24_API_ID: z.string().optional(),
  ACTIVE24_API_SECRET: z.string().optional(),
  ACTIVE24_A_RECORD_IP: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(16).optional(),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  BACKUP_DIR: z.string().min(1).default("/srv/hosting/backups"),
  MANAGEMENT_HOST: z.string().min(1).default("localhost"),
});

export const config = envSchema.parse(process.env);
