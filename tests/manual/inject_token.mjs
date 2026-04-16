#!/usr/bin/env node
/**
 * Inject a manually-obtained user_access_token into the local encrypted store
 * so that getValidToken() returns it immediately, allowing PoC tests to skip
 * the interactive OAuth flow.
 *
 * Usage:
 *   node inject_token.mjs <appId> <openId> <accessToken> [expiresInSec]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOOLS_DIR = path.resolve(__dirname, '..', '..', 'tools');

const { saveToken, getTokenFilePath } = await import(
  'file://' + path.join(TOOLS_DIR, 'auth.mjs').replace(/\\/g, '/')
);

const [, , appId, openId, accessToken, expiresInArg] = process.argv;
if (!appId || !openId || !accessToken) {
  console.error('Usage: node inject_token.mjs <appId> <openId> <accessToken> [expiresInSec]');
  process.exit(1);
}

const expiresIn = parseInt(expiresInArg || '7200', 10);
const now = Date.now();

saveToken(openId, appId, {
  accessToken,
  refreshToken: null,                            // not provided
  expiresAt: now + expiresIn * 1000,
  refreshExpiresAt: now + 86400 * 1000,          // dummy 24h
  scope: '',                                     // unknown; will be re-discovered on next OAuth
  grantedAt: now,
});

console.log(JSON.stringify({
  injected: true,
  file: getTokenFilePath(openId, appId),
  expires_at: new Date(now + expiresIn * 1000).toISOString(),
}, null, 2));
