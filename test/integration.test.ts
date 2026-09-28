import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Mail } from '../src/mail.js';
import { digest } from '../src/security.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must point to a dedicated MySQL database ending in _test. Run migrations there first.');
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const mail: Mail[] = [];
const config = loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: 'test', PORT: '0' });
const { app, auth, realtime } = createApp(db, config, { async send(value) { mail.push(value); } });
const server = createServer(app);
realtime.attach(server);
let base: string;
const users: string[] = [];
const sockets: WebSocket[] = [];
const password = 'initial-test-password!';
const email = () => `test-${randomUUID()}@example.com`;

before(async () => {
  await db.$connect();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  for (const socket of sockets) socket.terminate();
  await realtime.stop();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await db.user.deleteMany({ where: { email: { in: users } } });
  await db.$disconnect();
});

async function request(method: string, path: string, body?: unknown, token?: string, key?: string) {
  const response = await fetch(`${base}/api/v1${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'X-Node-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
}
function mailToken(address: string, subject: string) {
  const message = mail.findLast(m => m.to === address && m.subject.includes(subject)); assert.ok(message);
  const link = message.text.split('\n').at(-1)!;
  return new URLSearchParams(new URL(link).hash.slice(1)).get('token')!;
}
async function account() {
  const address = email(); users.push(address);
  const user = await auth.signup(address, password);
  await auth.consumeAction(mailToken(address, '인증'), 'VERIFY_EMAIL');
  return { email: address, id: user.user.id, ...await auth.signin(address, password) };
}

function connect(accessToken: string, nodeId?: string, nodeKey?: string) {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/v1/ws`); sockets.push(socket);
  const events: any[] = [];
  const waiters: { match: (value: any) => boolean; resolve: (value: any) => void }[] = [];
  socket.on('error', () => {});
  socket.on('open', () => socket.send(JSON.stringify({ type: 'authenticate', accessToken, nodeId, nodeKey })));
  socket.on('message', data => {
    const value = JSON.parse(data.toString());
    const index = waiters.findIndex(w => w.match(value));
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(value); else events.push(value);
  });
  const next = (match: (value: any) => boolean): Promise<any> => {
    const index = events.findIndex(match);
    if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); reject(new Error('Timed out waiting for WebSocket event')); }, 5000);
      const waiter = { match, resolve: (value: any) => { clearTimeout(timer); resolve(value); } }; waiters.push(waiter);
    });
  };
  return { socket, next, ready: () => next(v => v.type === 'ready') };
}

test('signup, verification, login and explicit absence of user GET endpoints', async () => {
  const address = email(); users.push(address);
  assert.equal((await request('POST', '/auth/signup', { email: address, password: 'short' })).status, 400);
  const created = await request('POST', '/auth/signup', { email: address.toUpperCase(), password });
  assert.equal(created.status, 201); assert.equal(created.body.user.email, address);
  assert.equal((await request('POST', '/auth/signup', { email: address, password })).status, 409);
  const initial = await request('POST', '/auth/signin', { email: address, password });
  assert.equal(initial.status, 200); assert.equal(initial.body.user.emailVerified, false);
  assert.equal((await request('POST', '/nodes', { name: 'PC', platform: 'windows' }, initial.body.accessToken)).status, 403);
  const token = mailToken(address, '인증');
  assert.equal((await request('POST', '/auth/email/verification/confirm', { token })).status, 204);
  assert.equal((await request('POST', '/auth/email/verification/confirm', { token })).status, 400);
  assert.equal((await request('POST', '/auth/signin', { email: address, password: 'wrong-long-password' })).status, 401);
  assert.equal((await request('POST', '/auth/signin', { email: address, password })).body.user.emailVerified, true);
  assert.equal((await request('GET', '/users/me', undefined, initial.body.accessToken)).status, 404);
  const stored = await db.user.findUniqueOrThrow({ where: { email: address } }); assert.notEqual(stored.passwordHash, password);
});

test('refresh rotation, replay revocation, and session-scoped versus global logout', async () => {
  const a = await account(); const b = await auth.signin(a.email, password);
  const refreshed = await request('POST', '/auth/refresh', { refreshToken: a.refreshToken });
  assert.equal(refreshed.status, 200);
  assert.equal((await request('GET', '/nodes', undefined, a.accessToken)).status, 401);
  assert.equal((await request('POST', '/auth/refresh', { refreshToken: a.refreshToken })).body.error.code, 'REFRESH_TOKEN_REUSED');
  assert.equal((await request('GET', '/nodes', undefined, refreshed.body.accessToken)).status, 401);
  assert.equal((await request('GET', '/nodes', undefined, b.accessToken)).status, 200);
  const c = await auth.signin(a.email, password);
  assert.equal((await request('POST', '/auth/signout', {}, b.accessToken)).status, 204);
  assert.equal((await request('GET', '/nodes', undefined, c.accessToken)).status, 200);
  assert.equal((await request('POST', '/auth/signout-all', {}, c.accessToken)).status, 204);
  assert.equal((await request('GET', '/nodes', undefined, c.accessToken)).status, 401);
});

test('reset links conceal unknown accounts, expire, and can only be used once; password changes revoke sessions', async () => {
  const a = await account();
  const missing = await request('POST', '/auth/password/forgot', { email: email() });
  const known = await request('POST', '/auth/password/forgot', { email: a.email });
  assert.deepEqual(missing, known);
  let token = mailToken(a.email, '재설정');
  await db.actionToken.update({ where: { hash: digest(token) }, data: { expiresAt: new Date(0) } });
  assert.equal((await request('POST', '/auth/password/reset', { token, newPassword: 'reset-test-password!' })).status, 400);
  await auth.requestReset(a.email); token = mailToken(a.email, '재설정');
  assert.equal((await request('POST', '/auth/password/reset', { token, newPassword: 'reset-test-password!' })).status, 204);
  assert.equal((await request('POST', '/auth/password/reset', { token, newPassword: 'another-password!' })).status, 400);
  assert.equal((await request('GET', '/nodes', undefined, a.accessToken)).status, 401);
  const login = await auth.signin(a.email, 'reset-test-password!');
  assert.equal((await request('PATCH', '/auth/password', { currentPassword: 'incorrect-password', newPassword: 'changed-password!' }, login.accessToken)).status, 401);
  assert.equal((await request('PATCH', '/auth/password', { currentPassword: 'reset-test-password!', newPassword: 'changed-password!' }, login.accessToken)).status, 204);
  assert.equal((await request('GET', '/nodes', undefined, login.accessToken)).status, 401);
  await assert.rejects(auth.signin(a.email, 'reset-test-password!'));
  assert.ok((await auth.signin(a.email, 'changed-password!')).accessToken);
});

test('MySQL serializes simultaneous refresh use and revokes the replayed session', async () => {
  const a = await account();
  const results = await Promise.allSettled([auth.refresh(a.refreshToken), auth.refresh(a.refreshToken)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const winner = results.find(r => r.status === 'fulfilled'); assert.ok(winner?.status === 'fulfilled');
  await assert.rejects(auth.authenticate(winner.value.accessToken));
});

test('node ownership, host-only approval, signaling authorization and offline cleanup', async () => {
  const owner = await account(); const other = await account();
  const hostLogin = await auth.signin(owner.email, password);
  const result = await request('POST', '/nodes', { name: 'Test Windows', platform: 'windows' }, hostLogin.accessToken);
  assert.equal(result.status, 201);
  const { node, nodeKey } = result.body;
  assert.equal((await request('GET', '/nodes', undefined, other.accessToken)).body.nodes.length, 0);
  assert.equal((await request('PATCH', `/nodes/${node.id}`, { name: 'stolen' }, other.accessToken)).status, 404);
  assert.equal((await request('DELETE', `/nodes/${node.id}`, undefined, other.accessToken)).status, 404);
  assert.equal((await request('POST', '/connections', { nodeId: node.id }, owner.accessToken)).status, 409);
  const fake = connect(other.accessToken, node.id, nodeKey);
  assert.equal((await fake.next(v => v.type === 'error')).code, 'INVALID_NODE_KEY');
  const host = connect(hostLogin.accessToken, node.id, nodeKey); await host.ready();
  const client = connect(owner.accessToken); await client.ready();
  assert.equal((await request('GET', '/nodes', undefined, owner.accessToken)).body.nodes[0].online, true);
  assert.equal((await request('POST', '/connections', { nodeId: node.id }, other.accessToken)).status, 404);
  const pending = await request('POST', '/connections', { nodeId: node.id }, owner.accessToken);
  assert.equal(pending.status, 201); const id = pending.body.connection.id;
  await host.next(v => v.type === 'connection.updated' && v.connection.id === id);
  client.socket.send(JSON.stringify({ type: 'signal', connectionId: id, kind: 'offer', payload: { sdp: 'before approval' } }));
  assert.equal((await client.next(v => v.type === 'error')).code, 'SIGNAL_FORBIDDEN');
  assert.equal((await request('POST', `/connections/${id}/accept`, {}, owner.accessToken)).status, 403);
  assert.equal((await request('POST', `/connections/${id}/accept`, {}, other.accessToken, nodeKey)).status, 404);
  assert.equal((await request('POST', `/connections/${id}/accept`, {}, hostLogin.accessToken, nodeKey)).status, 200);
  assert.equal((await request('POST', `/connections/${id}/accept`, {}, hostLogin.accessToken, nodeKey)).status, 409);
  await client.next(v => v.type === 'connection.updated' && v.connection.status === 'ACCEPTED');
  client.socket.send(JSON.stringify({ type: 'signal', connectionId: id, kind: 'offer', payload: { sdp: 'test-offer' } }));
  const forwarded = await host.next(v => v.type === 'signal'); assert.deepEqual(forwarded.payload, { sdp: 'test-offer' });
  host.socket.send(JSON.stringify({ type: 'signal', connectionId: id, kind: 'answer', payload: { sdp: 'test-answer' } }));
  assert.equal((await client.next(v => v.type === 'signal')).from, 'host');
  host.socket.close();
  await client.next(v => v.type === 'connection.updated' && v.connection.status === 'CLOSED');
  await client.next(v => v.type === 'node.status' && !v.online);
  assert.equal((await request('GET', '/nodes', undefined, owner.accessToken)).body.nodes[0].online, false);
  assert.equal((await request('DELETE', `/nodes/${node.id}`, undefined, owner.accessToken)).status, 204);
  assert.equal(await db.node.findUnique({ where: { id: node.id } }), null);
});

test('live sockets survive refresh; unrelated sessions cannot signal; logout closes remote connections', async () => {
  const owner = await account();
  const hostLogin = await auth.signin(owner.email, password);
  const unrelatedLogin = await auth.signin(owner.email, password);
  const created = await request('POST', '/nodes', { name: 'Refresh test', platform: 'linux' }, hostLogin.accessToken);
  const { node, nodeKey } = created.body;
  const host = connect(hostLogin.accessToken, node.id, nodeKey); await host.ready();
  const client = connect(owner.accessToken); await client.ready();
  const unrelated = connect(unrelatedLogin.accessToken); await unrelated.ready();
  const pending = await request('POST', '/connections', { nodeId: node.id }, owner.accessToken);
  const id = pending.body.connection.id;
  assert.equal((await request('POST', `/connections/${id}/accept`, {}, hostLogin.accessToken, nodeKey)).status, 200);
  const refreshed = await request('POST', '/auth/refresh', { refreshToken: owner.refreshToken });
  assert.equal(refreshed.status, 200);
  client.socket.send(JSON.stringify({ type: 'signal', connectionId: id, kind: 'ice', payload: { candidate: 'after-refresh' } }));
  assert.equal((await host.next(v => v.type === 'signal')).payload.candidate, 'after-refresh');
  unrelated.socket.send(JSON.stringify({ type: 'signal', connectionId: id, kind: 'offer', payload: {} }));
  assert.equal((await unrelated.next(v => v.type === 'error')).code, 'SIGNAL_FORBIDDEN');
  assert.equal((await request('DELETE', `/connections/${id}`, undefined, unrelatedLogin.accessToken)).status, 403);
  assert.equal((await request('POST', '/auth/signout', {}, refreshed.body.accessToken)).status, 204);
  await host.next(v => v.type === 'connection.updated' && v.connection.id === id && v.connection.status === 'CLOSED');
  assert.equal((await db.connection.findUniqueOrThrow({ where: { id } })).status, 'CLOSED');

  const second = await request('POST', '/connections', { nodeId: node.id }, unrelatedLogin.accessToken);
  assert.equal(second.status, 201);
  const secondId = second.body.connection.id;
  assert.equal((await request('POST', `/connections/${secondId}/reject`, {}, hostLogin.accessToken, nodeKey)).body.connection.status, 'REJECTED');
  const third = await request('POST', '/connections', { nodeId: node.id }, unrelatedLogin.accessToken);
  const thirdId = third.body.connection.id;
  await db.connection.update({ where: { id: thirdId }, data: { expiresAt: new Date(0) } });
  assert.equal((await request('POST', `/connections/${thirdId}/accept`, {}, hostLogin.accessToken, nodeKey)).status, 409);
  await realtime.sweep();
  await unrelated.next(v => v.type === 'connection.updated' && v.connection.id === thirdId && v.connection.status === 'EXPIRED');
});

test('persistent sessions survive expired access tokens on established sockets and recover a lost refresh response', async () => {
  const owner = await account();
  const socket = connect(owner.accessToken); await socket.ready();
  const session = await db.session.findUniqueOrThrow({ where: { accessHash: digest(owner.accessToken) } });
  assert.equal(session.expiresAt, null);
  await db.session.update({ where: { id: session.id }, data: { accessExpiresAt: new Date(0) } });
  await realtime.revalidate();
  assert.equal(socket.socket.readyState, WebSocket.OPEN);
  assert.equal((await request('GET', '/nodes', undefined, owner.accessToken)).status, 401);
  const nextRefreshToken = 'c'.repeat(64);
  const first = await request('POST', '/auth/refresh', { refreshToken: owner.refreshToken, nextRefreshToken });
  const retry = await request('POST', '/auth/refresh', { refreshToken: owner.refreshToken, nextRefreshToken });
  assert.equal(first.status, 200); assert.equal(retry.status, 200);
  assert.equal(first.body.accessToken, retry.body.accessToken);
  assert.equal(first.body.refreshToken, nextRefreshToken);
  assert.equal((await request('POST', '/auth/email/verification/status', {}, first.body.accessToken)).body.emailVerified, true);
  assert.equal((await request('POST', '/auth/signout-refresh', { refreshToken: nextRefreshToken })).status, 204);
  assert.equal((await request('POST', '/auth/refresh', { refreshToken: nextRefreshToken })).status, 401);
  assert.ok((await db.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt);
  const page = await fetch(base + '/verify-email');
  assert.equal(page.status, 200); assert.match(await page.text(), /email-action.js/);
  assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/);
});
