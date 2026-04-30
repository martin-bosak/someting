import { z } from "zod";

export const runtimeSchema = z.enum(["php", "node", "python", "static", "html"]);

export const siteInputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
  name: z.string().min(1),
  runtime: runtimeSchema,
  repo_url: z.string().regex(/^(https:\/\/|git@|ssh:\/\/|upload:\/\/).+/),
  branch: z.string().min(1).default("main"),
  build_command: z.string().optional().nullable(),
  start_command: z.string().optional().nullable(),
  healthcheck_path: z.string().startsWith("/").default("/"),
});

export const domainInputSchema = z.object({
  site_id: z.coerce.number().int().positive(),
  hostname: z
    .string()
    .toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/),
  is_primary: z.coerce.boolean().default(false),
});

export const mailNoteSchema = z.object({
  domain: z.string().min(1),
  mode: z.enum(["external", "forwarding", "smtp-relay", "self-hosted"]),
  provider: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const deployAuthSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("none"),
  }),
  z.object({
    mode: z.literal("https-token"),
    username: z.string().min(1).default("x-access-token"),
    token: z.string().min(1),
  }),
  z.object({
    mode: z.literal("ssh-key"),
    private_key: z.string().min(1),
  }),
]);
