import type { Server } from 'node:http';
import type { PrismaClient, Connection } from '@prisma/client';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { AuthService, type Identity } from './auth.js';
import { ApiError, digest, requireThat, tokenSchema } from './security.js';

type Peer = { socket: WebSocket; identity: Identity; nodeId?: string; alive: boolean };
const hello = z.object({ type: z.literal('authenticate'), accessToken: tokenSchema, nodeId: z.uuid().optional(), nodeKey: tokenSchema.optional() }).strict();
const signal = z.object({ type: z.literal('signal'), connectionId: z.uuid(), kind: z.enum(['offer', 'answer', 'ice']), payload: z.unknown().refine(v => v !== undefined) }).strict();

export class Realtime {
  private peers = new Set<Peer>();
  private hosts = new Map<string, Peer>();
  private clients = new Map<string, Peer>();
  private wss?: WebSocketServer;
  private timer?: NodeJS.Timeout;
  private sweeping = false;
  private stopping = false;
  private removals = new Set<Promise<void>>();
  constructor(private db: PrismaClient, private auth: AuthService, private origins: string[]) {}

  isOnline(nodeId: string) { return this.hosts.has(nodeId); }
  hasClient(sessionId: string) { return this.clients.has(sessionId); }
  private send(socket: WebSocket, data: unknown) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'Slow consumer'); return; }
    socket.send(JSON.stringify(data));
  }
  broadcast(userId: string, data: unknown) {
    for (const peer of this.peers) if (peer.identity.userId === userId) this.send(peer.socket, data);
  }
  notify(connection: Connection) {
    const event = { type: 'connection.updated', connection };
    const host = this.hosts.get(connection.nodeId);
    const client = this.clients.get(connection.requesterSessionId);
    if (host) this.send(host.socket, event);
    if (client) this.send(client.socket, event);
  }

  attach(server: Server) {
    const wss = this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/api/v1/ws' || (request.headers.origin && !this.origins.includes(request.headers.origin)) || wss.clients.size >= 1000) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
      }
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
    });
    wss.on('connection', socket => {
      let peer: Peer | undefined;
      let chain = Promise.resolve();
      let queued = 0;
      let messageCount = 0;
      let windowStarted = Date.now();
      const deadline = setTimeout(() => socket.close(4401, 'Authentication required'), 5000);
      socket.on('error', () => socket.terminate());
      socket.on('pong', () => { if (peer) peer.alive = true; });
      socket.on('message', (bytes, binary) => {
        if (Date.now() - windowStarted > 10_000) { windowStarted = Date.now(); messageCount = 0; }
        if (binary || ++queued > 32 || ++messageCount > 100) { socket.close(1008, 'Message limit exceeded'); return; }
        chain = chain.then(async () => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const value: unknown = JSON.parse(bytes.toString());
          if (!peer) {
            const input = hello.parse(value);
            const identity = await this.auth.authenticate(input.accessToken);
            requireThat(!!input.nodeId === !!input.nodeKey, 400, 'NODE_KEY_REQUIRED', 'Both nodeId and nodeKey are required');
            await this.auth.protected(identity, async tx => {
              if (input.nodeId) {
                const node = await tx.node.findFirst({ where: { id: input.nodeId, userId: identity.userId, keyHash: digest(input.nodeKey!) } });
                requireThat(node, 403, 'INVALID_NODE_KEY', 'Host credentials invalid');
                requireThat(!this.hosts.has(node.id), 409, 'HOST_ALREADY_CONNECTED', 'Host already connected');
                await tx.node.update({ where: { id: node.id }, data: { lastSeenAt: new Date() } });
              } else requireThat(!this.clients.has(identity.sessionId), 409, 'CLIENT_ALREADY_CONNECTED', 'This session already has a client socket');
              requireThat(socket.readyState === WebSocket.OPEN, 400, 'SOCKET_CLOSED', 'Socket closed');
              peer = { socket, identity, nodeId: input.nodeId, alive: true };
              this.peers.add(peer);
              if (peer.nodeId) this.hosts.set(peer.nodeId, peer);
              else this.clients.set(identity.sessionId, peer);
            });
            clearTimeout(deadline);
            this.send(socket, { type: 'ready', role: input.nodeId ? 'host' : 'client', nodeId: input.nodeId });
            if (input.nodeId) this.broadcast(identity.userId, { type: 'node.status', nodeId: input.nodeId, online: true });
            return;
          }
          const input = signal.parse(value);
          const sender = peer;
          await this.auth.protected(sender.identity, async tx => {
            const connection = await tx.connection.findUnique({ where: { id: input.connectionId }, include: { node: true } });
            requireThat(connection && connection.node.userId === sender.identity.userId && connection.status === 'ACCEPTED', 403, 'SIGNAL_FORBIDDEN', 'Approved connection required');
            const fromHost = sender.nodeId === connection.nodeId;
            requireThat(fromHost || (!sender.nodeId && sender.identity.sessionId === connection.requesterSessionId), 403, 'SIGNAL_FORBIDDEN', 'Not a connection participant');
            const recipient = fromHost ? this.clients.get(connection.requesterSessionId) : this.hosts.get(connection.nodeId);
            requireThat(recipient, 409, 'PEER_OFFLINE', 'Peer is offline');
            await this.auth.assertLiveSession(recipient.identity, tx);
            this.send(recipient.socket, { ...input, from: fromHost ? 'host' : 'client' });
          }, true);
        }).catch(error => {
          this.send(socket, { type: 'error', code: error instanceof ApiError ? error.code : 'INVALID_MESSAGE' });
          if (!peer || (error instanceof ApiError && error.status === 401)) socket.close(4401, 'Authentication failed or expired');
        }).finally(() => { queued--; });
      });
      socket.on('close', () => {
        clearTimeout(deadline);
        const cleanup = chain.then(async () => { if (peer) await this.remove(peer); }).catch(() => console.error('WebSocket cleanup failed'));
        this.removals.add(cleanup);
        void cleanup.finally(() => this.removals.delete(cleanup));
      });
    });
    this.timer = setInterval(() => { void this.sweep().catch(() => console.error('Realtime maintenance failed')); }, 15_000);
    this.timer.unref();
  }

  private async remove(peer: Peer) {
    if (!this.peers.delete(peer)) return;
    // Keep the registry entry until cleanup commits, preventing reconnect/cleanup races.
    try {
      const connections = await this.auth.withUser(peer.identity.userId, async tx => {
        const where = { ...(peer.nodeId ? { nodeId: peer.nodeId } : { requesterSessionId: peer.identity.sessionId }), status: { in: ['PENDING', 'ACCEPTED'] as ('PENDING' | 'ACCEPTED')[] } };
        const connections = await tx.connection.findMany({ where });
        await tx.connection.updateMany({ where, data: { status: 'CLOSED' } });
        return connections;
      });
      for (const connection of connections) this.notify({ ...connection, status: 'CLOSED' });
    } finally {
      if (peer.nodeId) {
        if (this.hosts.get(peer.nodeId) === peer) this.hosts.delete(peer.nodeId);
        this.broadcast(peer.identity.userId, { type: 'node.status', nodeId: peer.nodeId, online: false });
      } else if (this.clients.get(peer.identity.sessionId) === peer) this.clients.delete(peer.identity.sessionId);
    }
  }

  async invalidate(userId: string, sessionId?: string) {
    const selected = [...this.peers].filter(p => p.identity.userId === userId && (!sessionId || p.identity.sessionId === sessionId));
    for (const peer of selected) {
      peer.socket.close(4401, 'Session changed; authenticate again');
      await this.remove(peer);
    }
  }
  async disconnectNode(nodeId: string) {
    const peer = this.hosts.get(nodeId);
    if (peer) { peer.socket.close(4403, 'Node removed'); await this.remove(peer); }
  }

  async revalidate() {
    for (const peer of [...this.peers]) {
      try { await this.auth.assertLiveSession(peer.identity); }
      catch (error) {
        if (error instanceof ApiError && error.status === 401) { peer.socket.close(4401, 'Session revoked'); await this.remove(peer); }
        else throw error;
      }
    }
  }

  async sweep() {
    if (this.sweeping || this.stopping) return;
    this.sweeping = true;
    try {
      await this.revalidate();
      for (const peer of [...this.peers]) {
        if (!peer.alive) { peer.socket.terminate(); await this.remove(peer); continue; }
        peer.alive = false; peer.socket.ping();
        if (peer.nodeId) await this.db.node.updateMany({ where: { id: peer.nodeId }, data: { lastSeenAt: new Date() } });
      }
      const expired = await this.db.connection.findMany({ where: { status: 'PENDING', expiresAt: { lte: new Date() } } });
      for (const connection of expired) {
        const result = await this.db.connection.updateMany({ where: { id: connection.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
        if (result.count) this.notify({ ...connection, status: 'EXPIRED' });
      }
    } finally { this.sweeping = false; }
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const peer of [...this.peers]) { peer.socket.terminate(); await this.remove(peer); }
    for (const socket of this.wss?.clients ?? []) socket.terminate();
    await new Promise<void>(resolve => this.wss ? this.wss.close(() => resolve()) : resolve());
    await Promise.all(this.removals);
  }
}
