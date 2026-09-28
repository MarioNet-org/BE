import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, hashPassword, newToken, passwordSchema, verifyPassword } from '../src/security.js';
import { loadConfig } from '../src/config.js';

test('passwords use independent salts and reject incorrect passwords', async () => {
  const a = await hashPassword('a long secure password');
  const b = await hashPassword('a long secure password');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('a long secure password', a), true);
  assert.equal(await verifyPassword('incorrect password', a), false);
  assert.equal(await verifyPassword('a long secure password', 'bad'), false);
});
test('tokens are random 256-bit values; password size is bounded', () => {
  const a = newToken();
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, newToken());
  assert.notEqual(a, digest(a));
  assert.equal(passwordSchema.safeParse('short').success, false);
  assert.equal(passwordSchema.safeParse('x'.repeat(129)).success, false);
});
test('configuration requires MySQL and rejects insecure production mail settings', () => {
  assert.throws(() => loadConfig({ DATABASE_URL: 'file:./sqlite.db' }));
  assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://user:pass@localhost/db', NODE_ENV: 'production' }));
  const result = loadConfig({ DATABASE_URL: 'mysql://user:pass@localhost/db', NODE_ENV: 'production', MAIL_MODE: 'smtp', PUBLIC_APP_URL: 'https://app.example.com' });
  assert.equal(result.MAIL_MODE, 'smtp');
});
