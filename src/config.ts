import "dotenv/config";
import { z } from "zod";

const environment = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  DATABASE_URL: z.string().startsWith("mysql://"),
  CLIENT_ORIGINS: z.string().default("http://localhost:5173"),
  PUBLIC_APP_URL: z.url().default("http://127.0.0.1:4000"),
  MAIL_MODE: z.enum(["file", "smtp", "resend"]).default("file"),
  RESEND_API_KEY: z.string().optional(),
  RESEND_TEST_EMAIL: z.string().optional(),
  MAIL_FROM: z.string().default("MarioNet <noreply@example.com>"),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
});
export function loadConfig(env = process.env) {
  const parsed = environment.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid environment: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const config = parsed.data;
  if (config.MAIL_MODE === "resend" && !config.RESEND_API_KEY?.trim())
    throw new Error("RESEND_API_KEY is required for resend mail mode");
  if (
    config.NODE_ENV === "production" &&
    (config.MAIL_MODE === "file" ||
      !config.PUBLIC_APP_URL.startsWith("https://"))
  ) {
    throw new Error(
      "Production requires real email delivery and an HTTPS PUBLIC_APP_URL",
    );
  }
  return config;
}
export type Config = ReturnType<typeof loadConfig>;
