import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AuthService, type Identity } from "./auth.js";
import type { Config } from "./config.js";
import type { Mailer } from "./mail.js";
import { Realtime } from "./realtime.js";
import { installEmailPages } from "./email-pages.js";
import {
  after,
  ApiError,
  digest,
  emailSchema,
  newToken,
  passwordSchema,
  requireThat,
  tokenSchema,
} from "./security.js";

const credentials = z
  .object({ email: emailSchema, password: passwordSchema })
  .strict();
const idParam = (req: Request, name: string) =>
  z.uuid().parse(req.params[name]);
const identity = (res: Response) => res.locals.identity as Identity;
const nodeSelect = {
  id: true,
  name: true,
  platform: true,
  createdAt: true,
  lastSeenAt: true,
} as const;
const genericMailResponse = {
  message: "If eligible, an email with instructions will be sent.",
};

export function createApp(db: PrismaClient, config: Config, mailer: Mailer) {
  const app = express();
  const auth = new AuthService(db, mailer, config);
  const origins = config.CLIENT_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const realtime = new Realtime(db, auth, origins);
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY_HOPS);
  app.use(helmet());
  app.use(
    cors({
      origin: origins,
      allowedHeaders: ["Content-Type", "Authorization", "X-Node-Key"],
      methods: ["GET", "POST", "PATCH", "DELETE"],
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  installEmailPages(app);
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: 180,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        error: { code: "RATE_LIMITED", message: "Too many requests" },
      },
    }),
  );
  app.get("/health", async (_req, res) => {
    await db.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  });

  const secured = async (req: Request, res: Response, next: NextFunction) => {
    const match = /^Bearer ([a-f0-9]{64})$/i.exec(
      req.headers.authorization ?? "",
    );
    res.locals.identity = await auth.authenticate(match?.[1] ?? "");
    next();
  };
  const verified = async (req: Request, res: Response, next: NextFunction) => {
    const who = identity(res);
    const user = await db.user.findUnique({ where: { id: who.userId }, select: { emailVerifiedAt: true } });
    requireThat(!!user?.emailVerifiedAt, 403, 'EMAIL_NOT_VERIFIED', 'Verify email before using this feature');
    next();
  };
  const authRouter = express.Router();
  authRouter.use(
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 50,
      skip: (req) =>
        ["/refresh", "/signout-refresh", "/email/verification/status"].includes(
          req.path,
        ),
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        error: {
          code: "RATE_LIMITED",
          message: "Too many authentication requests",
        },
      },
    }),
  );
  const emailLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => digest(String(req.body?.email ?? "").toLowerCase()),
    message: {
      error: { code: "RATE_LIMITED", message: "Please try again later" },
    },
  });
  authRouter.post("/signup", emailLimit, async (req, res) => {
    const input = credentials.parse(req.body);
    res.status(201).json(await auth.signup(input.email, input.password));
  });
  authRouter.post("/signin", async (req, res) => {
    const input = credentials.parse(req.body);
    res.json(await auth.signin(input.email, input.password));
  });
  authRouter.post("/refresh", async (req, res) => {
    const { refreshToken, nextRefreshToken } = z
      .object({
        refreshToken: tokenSchema,
        nextRefreshToken: tokenSchema.optional(),
      })
      .strict()
      .parse(req.body);
    try {
      const result = await auth.refresh(refreshToken, nextRefreshToken);
      await realtime.revalidate();
      res.json(result);
    } catch (error) {
      await realtime.revalidate();
      throw error;
    }
  });
  authRouter.post("/signout-refresh", async (req, res) => {
    const { refreshToken } = z
      .object({ refreshToken: tokenSchema })
      .strict()
      .parse(req.body);
    await auth.signoutRefresh(refreshToken);
    await realtime.revalidate();
    res.sendStatus(204);
  });
  authRouter.post("/email/verification/status", secured, async (_req, res) => {
    const user = await db.user.findUniqueOrThrow({
      where: { id: identity(res).userId },
    });
    res.json({ emailVerified: !!user.emailVerifiedAt });
  });
  for (const all of [false, true])
    authRouter.post(
      all ? "/signout-all" : "/signout",
      secured,
      async (_req, res) => {
        const who = identity(res);
        await auth.signout(who, all);
        await realtime.invalidate(who.userId, all ? undefined : who.sessionId);
        res.sendStatus(204);
      },
    );
  authRouter.post("/password/forgot", emailLimit, async (req, res) => {
    const { email } = z.object({ email: emailSchema }).strict().parse(req.body);
    await auth.requestReset(email);
    res.status(202).json(genericMailResponse);
  });
  authRouter.post("/password/reset", async (req, res) => {
    const input = z
      .object({ token: tokenSchema, newPassword: passwordSchema })
      .strict()
      .parse(req.body);
    await auth.consumeAction(input.token, "RESET_PASSWORD", input.newPassword);
    await realtime.revalidate();
    res.sendStatus(204);
  });
  authRouter.patch("/password", secured, async (req, res) => {
    const input = z
      .object({ currentPassword: passwordSchema, newPassword: passwordSchema })
      .strict()
      .parse(req.body);
    const who = identity(res);
    await auth.changePassword(who, input.currentPassword, input.newPassword);
    await realtime.invalidate(who.userId);
    res.sendStatus(204);
  });
  authRouter.post(
    "/email/verification/request",
    secured,
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 5,
      keyGenerator: (_req, res) => identity(res).userId,
    }),
    async (_req, res) => {
      await auth.requestVerification(identity(res));
      res.status(202).json(genericMailResponse);
    },
  );
  authRouter.post("/email/verification/confirm", async (req, res) => {
    const { token } = z.object({ token: tokenSchema }).strict().parse(req.body);
    await auth.consumeAction(token, "VERIFY_EMAIL");
    res.sendStatus(204);
  });
  app.use("/api/v1/auth", authRouter);

  const nodes = express.Router();
  nodes.use(secured, verified);
  nodes.post("/", async (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(80),
        platform: z.enum(["windows", "macos", "linux"]),
      })
      .strict()
      .parse(req.body);
    const who = identity(res);
    const nodeKey = newToken();
    const node = await auth.protected(who, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: who.userId },
      });
      requireThat(
        user.emailVerifiedAt,
        403,
        "EMAIL_NOT_VERIFIED",
        "Verify email before registering a host",
      );
      requireThat(
        (await tx.node.count({ where: { userId: who.userId } })) < 100,
        409,
        "NODE_LIMIT",
        "Maximum 100 nodes per account",
      );
      return tx.node.create({
        data: { ...input, userId: who.userId, keyHash: digest(nodeKey) },
        select: nodeSelect,
      });
    });
    res.status(201).json({ node: { ...node, online: false }, nodeKey });
  });
  nodes.get("/", async (_req, res) => {
    const list = await db.node.findMany({
      where: { userId: identity(res).userId },
      select: nodeSelect,
      orderBy: { createdAt: "asc" },
    });
    res.json({
      nodes: list.map((node) => ({
        ...node,
        online: realtime.isOnline(node.id),
      })),
    });
  });
  nodes.patch("/:nodeId", async (req, res) => {
    const nodeId = idParam(req, "nodeId");
    const who = identity(res);
    const { name } = z
      .object({ name: z.string().trim().min(1).max(80) })
      .strict()
      .parse(req.body);
    const node = await auth.protected(who, async (tx) => {
      const result = await tx.node.updateMany({
        where: { id: nodeId, userId: who.userId },
        data: { name },
      });
      requireThat(result.count, 404, "NODE_NOT_FOUND", "Node not found");
      return tx.node.findUniqueOrThrow({
        where: { id: nodeId },
        select: nodeSelect,
      });
    });
    res.json({ node: { ...node, online: realtime.isOnline(nodeId) } });
  });
  nodes.delete("/:nodeId", async (req, res) => {
    const nodeId = idParam(req, "nodeId");
    const who = identity(res);
    const closed = await auth.protected(who, async (tx) => {
      const node = await tx.node.findFirst({
        where: { id: nodeId, userId: who.userId },
      });
      requireThat(node, 404, "NODE_NOT_FOUND", "Node not found");
      const connections = await tx.connection.findMany({
        where: { nodeId, status: { in: ["PENDING", "ACCEPTED"] } },
      });
      await tx.node.delete({ where: { id: nodeId } });
      return connections;
    });
    for (const connection of closed)
      realtime.notify({ ...connection, status: "CLOSED" });
    await realtime.disconnectNode(nodeId);
    res.sendStatus(204);
  });
  app.use("/api/v1/nodes", nodes);

  const connections = express.Router();
  connections.use(secured, verified);
  connections.post("/", async (req, res) => {
    const { nodeId } = z.object({ nodeId: z.uuid() }).strict().parse(req.body);
    const who = identity(res);
    const connection = await auth.protected(who, async (tx) => {
      const node = await tx.node.findFirst({
        where: { id: nodeId, userId: who.userId },
      });
      requireThat(node, 404, "NODE_NOT_FOUND", "Node not found");
      requireThat(
        realtime.isOnline(nodeId),
        409,
        "HOST_OFFLINE",
        "Host must be online",
      );
      requireThat(
        realtime.hasClient(who.sessionId),
        409,
        "CLIENT_OFFLINE",
        "Authenticate a client WebSocket first",
      );
      requireThat(
        !(await tx.connection.findFirst({
          where: {
            nodeId,
            requesterSessionId: who.sessionId,
            status: { in: ["PENDING", "ACCEPTED"] },
          },
        })),
        409,
        "CONNECTION_EXISTS",
        "Connection already pending or accepted",
      );
      return tx.connection.create({
        data: {
          nodeId,
          requesterSessionId: who.sessionId,
          expiresAt: after(60),
        },
      });
    });
    realtime.notify(connection);
    res.status(201).json({ connection });
  });
  for (const action of ["accept", "reject"] as const)
    connections.post(`/:connectionId/${action}`, async (req, res) => {
      const id = idParam(req, "connectionId");
      const who = identity(res);
      const key = tokenSchema.safeParse(req.headers["x-node-key"]);
      requireThat(
        key.success,
        403,
        "INVALID_NODE_KEY",
        "Host node key required",
      );
      const connection = await auth.protected(who, async (tx) => {
        const found = await tx.connection.findUnique({
          where: { id },
          include: { node: true, requester: true },
        });
        requireThat(
          found && found.node.userId === who.userId,
          404,
          "CONNECTION_NOT_FOUND",
          "Connection not found",
        );
        requireThat(
          found.node.keyHash === digest(key.data),
          403,
          "INVALID_NODE_KEY",
          "Host node key required",
        );
        requireThat(
          realtime.isOnline(found.nodeId) &&
            realtime.hasClient(found.requesterSessionId) &&
            !found.requester.revokedAt &&
            (!found.requester.expiresAt ||
              found.requester.expiresAt > new Date()),
          409,
          "PEER_OFFLINE",
          "Peer session unavailable",
        );
        const updated = await tx.connection.updateMany({
          where: { id, status: "PENDING", expiresAt: { gt: new Date() } },
          data: { status: action === "accept" ? "ACCEPTED" : "REJECTED" },
        });
        requireThat(
          updated.count,
          409,
          "INVALID_CONNECTION_STATE",
          "Request expired or already handled",
        );
        return tx.connection.findUniqueOrThrow({ where: { id } });
      });
      realtime.notify(connection);
      res.json({ connection });
    });
  connections.delete("/:connectionId", async (req, res) => {
    const id = idParam(req, "connectionId");
    const who = identity(res);
    const connection = await auth.protected(who, async (tx) => {
      const found = await tx.connection.findUnique({
        where: { id },
        include: { node: true },
      });
      requireThat(
        found && found.node.userId === who.userId,
        404,
        "CONNECTION_NOT_FOUND",
        "Connection not found",
      );
      const key = tokenSchema.safeParse(req.headers["x-node-key"]);
      requireThat(
        found.requesterSessionId === who.sessionId ||
          (key.success && found.node.keyHash === digest(key.data)),
        403,
        "CONNECTION_FORBIDDEN",
        "Only participants may close this connection",
      );
      await tx.connection.updateMany({
        where: { id, status: { in: ["PENDING", "ACCEPTED"] } },
        data: { status: "CLOSED" },
      });
      return tx.connection.findUniqueOrThrow({ where: { id } });
    });
    realtime.notify(connection);
    res.sendStatus(204);
  });
  app.use("/api/v1/connections", connections);
  app.use((_req, _res, next) =>
    next(new ApiError(404, "NOT_FOUND", "Endpoint not found")),
  );
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request",
            fields: error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
        });
        return;
      }
      if (error instanceof ApiError) {
        res
          .status(error.status)
          .json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        res.status(409).json({
          error: {
            code: "ALREADY_EXISTS",
            message: "Resource already exists",
          },
        });
        return;
      }
      if (
        error &&
        typeof error === "object" &&
        "type" in error &&
        (error.type === "entity.parse.failed" ||
          error.type === "entity.too.large")
      ) {
        res.status(error.type === "entity.too.large" ? 413 : 400).json({
          error: {
            code: "INVALID_BODY",
            message: "Invalid JSON body or payload too large",
          },
        });
        return;
      }
      console.error(
        "Request failed",
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code
          : "INTERNAL_ERROR",
      );
      res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Unexpected server error" },
      });
    },
  );
  return { app, auth, realtime };
}
