import { createHmac } from "node:crypto";
import { PrismaClient, Prisma, TokenPurpose } from "@prisma/client";
import { MailDeliveryError, type Mailer } from "./mail.js";
import type { Config } from "./config.js";
import {
  after,
  digest,
  hashPassword,
  newToken,
  requireThat,
  verifyPassword,
} from "./security.js";

export type Identity = {
  userId: string;
  sessionId: string;
  accessHash: string;
};
export type Tx = Prisma.TransactionClient;
const ACCESS_SECONDS = 15 * 60;
const sessionLive = (session: {
  revokedAt: Date | null;
  expiresAt: Date | null;
}) =>
  !session.revokedAt && (!session.expiresAt || session.expiresAt > new Date());

export class AuthService {
  private dummyHash = hashPassword(newToken());
  constructor(
    readonly db: PrismaClient,
    private mailer: Mailer,
    private config: Config,
  ) {}

  // Serialize account mutations so password changes cannot race new sessions or token use.
  async withUser<T>(userId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM User WHERE id = ${userId} FOR UPDATE`;
        return work(tx);
      },
      { maxWait: 5000, timeout: 15000 },
    );
  }

  async authenticate(token: string): Promise<Identity> {
    requireThat(
      /^[a-f0-9]{64}$/.test(token),
      401,
      "UNAUTHORIZED",
      "Valid access token required",
    );
    const session = await this.db.session.findUnique({
      where: { accessHash: digest(token) },
    });
    requireThat(
      session && sessionLive(session) && session.accessExpiresAt > new Date(),
      401,
      "UNAUTHORIZED",
      "Session expired or invalid",
    );
    return {
      userId: session.userId,
      sessionId: session.id,
      accessHash: session.accessHash,
    };
  }

  async assertLiveSession(identity: Identity, db: Tx = this.db) {
    const session = await db.session.findUnique({
      where: { id: identity.sessionId },
    });
    requireThat(
      session && session.userId === identity.userId && sessionLive(session),
      401,
      "UNAUTHORIZED",
      "Session expired or invalid",
    );
  }

  async protected<T>(
    identity: Identity,
    work: (tx: Tx) => Promise<T>,
    establishedSocket = false,
  ): Promise<T> {
    return this.withUser(identity.userId, async (tx) => {
      const session = await tx.session.findUnique({
        where: { id: identity.sessionId },
      });
      requireThat(
        session &&
          session.userId === identity.userId &&
          sessionLive(session) &&
          (establishedSocket ||
            (session.accessHash === identity.accessHash &&
              session.accessExpiresAt > new Date())),
        401,
        "UNAUTHORIZED",
        "Session expired or invalid",
      );
      return work(tx);
    });
  }

  private async actionToken(tx: Tx, userId: string, purpose: TokenPurpose) {
    const token = newToken();
    await tx.actionToken.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.actionToken.create({
      data: {
        userId,
        purpose,
        hash: digest(token),
        expiresAt: after(purpose === "RESET_PASSWORD" ? 1800 : 86400),
      },
    });
    return token;
  }

  private async deliver(email: string, token: string, purpose: TokenPurpose) {
    const url = new URL(
      purpose === "RESET_PASSWORD" ? "/reset-password" : "/verify-email",
      this.config.PUBLIC_APP_URL,
    );
    // Fragment avoids including the secret in HTTP requests and referrer URLs.
    url.hash = new URLSearchParams({ token }).toString();
    try {
      await this.mailer.send({
        to: email,
        subject:
          purpose === "RESET_PASSWORD"
            ? "MarioNet 비밀번호 재설정"
            : "MarioNet 이메일 인증",
        text: `아래 링크를 브라우저에서 열어 완료하세요. 요청하지 않았다면 무시하세요.\n\n${url}`,
      });
      return true;
    } catch (error) {
      // Never log the email body, token, API key, or full recipient address.
      const recipient = email.replace(/^(.{2}).*(@.*)$/, "$1***$2");
      const details =
        error instanceof MailDeliveryError
          ? error.details
          : {
              code: "MAILER_UNEXPECTED_ERROR",
              message: error instanceof Error ? error.message : String(error),
            };
      console.error("Mail delivery failed", {
        provider: this.config.MAIL_MODE === "resend" ? "resend" : "file",
        purpose,
        recipient,
        code: details.code,
        statusCode: details.statusCode,
        requestId: details.requestId,
        message: details.message,
      });
      return false;
    }
  }

  async signup(email: string, password: string) {
    const passwordHash = await hashPassword(password);
    const result = await this.db.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email, passwordHash } });
      const token = await this.actionToken(tx, user.id, "VERIFY_EMAIL");
      return { user, token };
    });
    const verificationEmailSent = await this.deliver(
      email,
      result.token,
      "VERIFY_EMAIL",
    );
    return {
      user: { id: result.user.id, email, emailVerified: false },
      verificationEmailSent,
    };
  }

  async signin(email: string, password: string) {
    const user = await this.db.user.findUnique({ where: { email } });
    const valid = await verifyPassword(
      password,
      user?.passwordHash ?? (await this.dummyHash),
    );
    requireThat(
      user && valid,
      401,
      "INVALID_CREDENTIALS",
      "Email or password is incorrect",
    );
    return this.withUser(user.id, async (tx) => {
      const current = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      requireThat(
        current.passwordHash === user.passwordHash,
        401,
        "INVALID_CREDENTIALS",
        "Please sign in again",
      );
      const accessToken = newToken();
      const refreshToken = newToken();
      await tx.session.create({
        data: {
          userId: user.id,
          accessHash: digest(accessToken),
          accessExpiresAt: after(ACCESS_SECONDS),
          expiresAt: null,
          refreshTokens: { create: { hash: digest(refreshToken) } },
        },
      });
      return {
        accessToken,
        refreshToken,
        tokenType: "Bearer",
        expiresIn: ACCESS_SECONDS,
        user: {
          id: user.id,
          email: user.email,
          emailVerified: !!current.emailVerifiedAt,
        },
      };
    });
  }

  async refresh(token: string, nextRefreshToken?: string) {
    const found = await this.db.refreshToken.findUnique({
      where: { hash: digest(token) },
      include: { session: true },
    });
    requireThat(found, 401, "INVALID_REFRESH_TOKEN", "Refresh token invalid");
    const result = await this.withUser(found.session.userId, async (tx) => {
      const current = await tx.refreshToken.findUniqueOrThrow({
        where: { id: found.id },
        include: { session: true },
      });
      const user = await tx.user.findUniqueOrThrow({
        where: { id: found.session.userId },
      });
      const accessFor = (value: string) =>
        createHmac("sha256", value)
          .update("MarioNet access token v1")
          .digest("hex");
      const response = (accessToken: string, refreshToken: string) => ({
        accessToken,
        refreshToken,
        tokenType: "Bearer",
        expiresIn: ACCESS_SECONDS,
        user: {
          id: user.id,
          email: user.email,
          emailVerified: !!user.emailVerifiedAt,
        },
      });
      if (
        current.usedAt &&
        nextRefreshToken &&
        current.replacementHash === digest(nextRefreshToken) &&
        sessionLive(current.session) &&
        current.session.accessHash === digest(accessFor(nextRefreshToken))
      ) {
        await tx.session.update({
          where: { id: current.sessionId },
          data: { accessExpiresAt: after(ACCESS_SECONDS) },
        });
        return response(accessFor(nextRefreshToken), nextRefreshToken);
      }
      if (current.usedAt) {
        await this.revoke(tx, { id: current.sessionId });
        return null; // Commit revocation before raising the error.
      }
      requireThat(
        sessionLive(current.session),
        401,
        "INVALID_REFRESH_TOKEN",
        "Refresh token expired or revoked",
      );
      const refreshToken = nextRefreshToken ?? newToken();
      requireThat(
        refreshToken !== token,
        400,
        "INVALID_REFRESH_TOKEN",
        "A new token is required",
      );
      const accessToken = accessFor(refreshToken);
      await tx.refreshToken.update({
        where: { id: current.id },
        data: { usedAt: new Date(), replacementHash: digest(refreshToken) },
      });
      await tx.refreshToken.create({
        data: { sessionId: current.sessionId, hash: digest(refreshToken) },
      });
      await tx.session.update({
        where: { id: current.sessionId },
        data: {
          accessHash: digest(accessToken),
          accessExpiresAt: after(ACCESS_SECONDS),
        },
      });
      return response(accessToken, refreshToken);
    });
    requireThat(
      result,
      401,
      "REFRESH_TOKEN_REUSED",
      "Session revoked; sign in again",
    );
    return result;
  }

  async revoke(tx: Tx, where: Prisma.SessionWhereInput) {
    await tx.session.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async signout(identity: Identity, all: boolean) {
    await this.protected(identity, (tx) =>
      this.revoke(
        tx,
        all ? { userId: identity.userId } : { id: identity.sessionId },
      ),
    );
  }

  async signoutRefresh(token: string) {
    const found = await this.db.refreshToken.findUnique({
      where: { hash: digest(token) },
      include: { session: true },
    });
    if (found)
      await this.withUser(found.session.userId, (tx) =>
        this.revoke(tx, { id: found.sessionId }),
      );
  }

  async requestReset(email: string) {
    const user = await this.db.user.findUnique({ where: { email } });
    if (!user) return;
    const token = await this.withUser(user.id, (tx) =>
      this.actionToken(tx, user.id, "RESET_PASSWORD"),
    );
    await this.deliver(email, token, "RESET_PASSWORD");
  }

  async requestVerification(identity: Identity) {
    const result = await this.protected(identity, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: identity.userId },
      });
      if (user.emailVerifiedAt) return null;
      return {
        email: user.email,
        token: await this.actionToken(tx, user.id, "VERIFY_EMAIL"),
      };
    });
    if (result)
      requireThat(
        await this.deliver(result.email, result.token, "VERIFY_EMAIL"),
        503,
        "MAIL_UNAVAILABLE",
        "Email delivery unavailable",
      );
  }

  async consumeAction(
    token: string,
    purpose: TokenPurpose,
    newPassword?: string,
  ) {
    const found = await this.db.actionToken.findUnique({
      where: { hash: digest(token) },
    });
    requireThat(
      found && found.purpose === purpose,
      400,
      "INVALID_TOKEN",
      "Link invalid or expired",
    );
    const passwordHash = newPassword
      ? await hashPassword(newPassword)
      : undefined;
    await this.withUser(found.userId, async (tx) => {
      const consumed = await tx.actionToken.updateMany({
        where: { id: found.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      requireThat(
        consumed.count === 1,
        400,
        "INVALID_TOKEN",
        "Link invalid or expired",
      );
      if (purpose === "VERIFY_EMAIL") {
        await tx.user.update({
          where: { id: found.userId },
          data: { emailVerifiedAt: new Date() },
        });
      } else {
        requireThat(
          passwordHash,
          400,
          "INVALID_PASSWORD",
          "New password required",
        );
        await tx.user.update({
          where: { id: found.userId },
          data: { passwordHash },
        });
        await this.revoke(tx, { userId: found.userId });
        await tx.actionToken.updateMany({
          where: { userId: found.userId, purpose, usedAt: null },
          data: { usedAt: new Date() },
        });
      }
    });
  }

  async changePassword(
    identity: Identity,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: identity.userId },
    });
    requireThat(
      await verifyPassword(currentPassword, user.passwordHash),
      401,
      "INVALID_CREDENTIALS",
      "Current password is incorrect",
    );
    requireThat(
      currentPassword !== newPassword,
      400,
      "PASSWORD_UNCHANGED",
      "Choose a different password",
    );
    const passwordHash = await hashPassword(newPassword);
    await this.protected(identity, async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: user.id, passwordHash: user.passwordHash },
        data: { passwordHash },
      });
      requireThat(
        updated.count === 1,
        409,
        "PASSWORD_CHANGED",
        "Password was already changed; sign in again",
      );
      await this.revoke(tx, { userId: user.id });
      await tx.actionToken.updateMany({
        where: { userId: user.id, purpose: "RESET_PASSWORD", usedAt: null },
        data: { usedAt: new Date() },
      });
    });
  }
}
