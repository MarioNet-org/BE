import { createServer } from "node:http";
import { PrismaClient } from "@prisma/client";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createMailer } from "./mail.js";

const config = loadConfig();
const db = new PrismaClient();
await db.$connect();
// Presence is process-local: sessions pending at a previous shutdown cannot resume silently.
await db.connection.updateMany({
  where: { status: { in: ["PENDING", "ACCEPTED"] } },
  data: { status: "CLOSED" },
});
const { app, realtime } = createApp(db, config, createMailer(config));
const server = createServer(app);
realtime.attach(server);
server.listen(config.PORT, config.HOST, () =>
  console.log(`MarioNet API listening on ${config.HOST}:${config.PORT}`),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await realtime.stop();
  await closed;
  await db.$disconnect();
  clearTimeout(deadline);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
