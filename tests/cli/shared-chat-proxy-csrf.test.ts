/**
 * The shared-chat page (apps/cli/src/shared-chat-web.ts) is served on its own
 * port and proxies /dashboard/api/* to the relay. The relay rejects
 * cookie-authenticated cross-origin writes (csrf-guard.ts), so the proxy must
 * verify the browser Origin is its OWN and forward it as the relay origin —
 * the legitimate shared-chat → bridge path keeps working, a foreign page does not.
 */
import { createServer, request, type Server } from 'http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AddressInfo } from 'net';
import { DashboardRouter } from '@gossip/relay/dashboard/routes';
import { DashboardAuth } from '@gossip/relay/dashboard/auth';
import { startSharedChatWeb } from '../../apps/cli/src/shared-chat-web';

let root: string;
let relay: Server;
let web: Server;
let relayPort: number;
let webPort: number;
let cookie: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'shared-csrf-'));
  mkdirSync(join(root, '.gossip', 'codex-bridge'), { recursive: true });
  mkdirSync(join(root, 'dist-dashboard'));
  writeFileSync(join(root, 'dist-dashboard', 'index.html'), '<h1>x</h1>');
  const auth = new DashboardAuth();
  auth.init();
  cookie = `dashboard_session=${auth.createSession(auth.getKey())}`;
  const router = new DashboardRouter(auth, root, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
  relay = createServer((req, res) => { void router.handle(req, res); });
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
  relayPort = (relay.address() as AddressInfo).port;
  writeFileSync(join(root, '.gossip', 'relay.port'), String(relayPort));
  web = startSharedChatWeb(root);
  await new Promise<void>((r) => web.once('listening', () => r()));
  webPort = Number(readFileSync(join(root, '.gossip', 'codex-bridge', 'web.port'), 'utf8'));
});
afterEach(async () => {
  await new Promise<void>((r) => web.close(() => r()));
  await new Promise<void>((r) => relay.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

function post(port: number, headers: Record<string, string>): Promise<number> {
  const body = JSON.stringify({ chat_id: 'chat-s', message: 'from shared chat' });
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/dashboard/api/bridge', headers: { 'Content-Type': 'application/json', cookie, ...headers } },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end(body);
  });
}

it('the shared-chat page (its own origin) can still POST to the bridge through the proxy', async () => {
  expect(await post(webPort, { host: `localhost:${webPort}`, origin: `http://localhost:${webPort}` })).toBe(202);
});

it('a foreign origin is refused by the proxy before reaching the relay', async () => {
  expect(await post(webPort, { host: `localhost:${webPort}`, origin: `http://localhost:${webPort + 1}` })).toBe(403);
});

it('the shared-chat origin is NOT accepted by the relay directly (same host, different port)', async () => {
  expect(await post(relayPort, { host: `localhost:${relayPort}`, origin: `http://localhost:${webPort}` })).toBe(403);
});
