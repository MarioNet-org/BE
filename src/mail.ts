import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Resend } from "resend";
import type { Config } from "./config.js";

export type Mail = { to: string; subject: string; text: string };
export type MailFailure = {
  code: string;
  message: string;
  statusCode?: number;
  requestId?: string;
};
export class MailDeliveryError extends Error {
  readonly details: MailFailure;
  constructor(details: MailFailure) {
    super(details.message);
    this.name = "MailDeliveryError";
    this.details = details;
  }
}
export interface Mailer {
  send(mail: Mail): Promise<void>;
}
export function createMailer(config: Config): Mailer {
  if (config.MAIL_MODE === "file")
    return {
      async send(mail) {
        await mkdir(".local/mail", { recursive: true });
        await writeFile(
          `.local/mail/${Date.now()}-${randomUUID()}.json`,
          JSON.stringify(mail, null, 2),
          { mode: 0o600 },
        );
      },
    };

  const resend = new Resend(config.RESEND_API_KEY);

  return {
    async send(mail) {
      if (
        config.RESEND_TEST_EMAIL &&
        mail.to.toLowerCase() !== config.RESEND_TEST_EMAIL.toLowerCase()
      )
        throw new MailDeliveryError({
          code: "RESEND_TEST_RECIPIENT_ONLY",
          message: "Resend test mode only allows delivery to RESEND_TEST_EMAIL",
        });

      const response = await resend.emails.send({
        from: config.MAIL_FROM,
        to: mail.to,
        replyTo: config.MAIL_FROM,
        subject: mail.subject,
        text: mail.text,
      });

      if (response.error) {
        const error = response.error as unknown as Record<string, unknown>;
        const headers = error.headers as Record<string, unknown> | undefined;
        const statusCode =
          typeof error.statusCode === "number" ? error.statusCode : undefined;
        const requestId =
          typeof error.requestId === "string"
            ? error.requestId
            : typeof headers?.["x-resend-request-id"] === "string"
            ? headers["x-resend-request-id"]
            : undefined;
        const code =
          typeof error.name === "string"
            ? error.name
            : "RESEND_DELIVERY_FAILED";
        const message =
          typeof error.message === "string"
            ? error.message
            : "Resend rejected the email";
        throw new MailDeliveryError({ code, message, statusCode, requestId });
      }
    },
  };
}
