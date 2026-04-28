import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  ADMIN_USERNAME: z.string().min(1).default("admin"),
  ADMIN_PASSWORD: z.string().min(12),
  HOSTING_ROOT: z.string().min(1).default("/srv/hosting"),
  CREATE_SITE_SCRIPT: z.string().min(1).default("/srv/hosting/bin/create-site.sh"),
  DEPLOY_SCRIPT: z.string().min(1).default("/srv/hosting/bin/deploy-site.sh"),
});

export const config = envSchema.parse(process.env);
