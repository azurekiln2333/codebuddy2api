import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startMockOAuth, type MockOAuthProvider } from './fixtures/mock-oauth.js';
import { startUpstream, type UpstreamServer } from './fixtures/upstream.js';
import { testConfig } from './helpers/config.js';
import { login, startGateway, type RunningGateway } from './helpers/gateway.js';
import { HttpClient } from './helpers/http-client.js';
import { validateRequestTarget } from '../src/server.js';

describe('model ID encoding stays inside its literal admin route', () => {
  let idp: MockOAuthProvider;
  let upstream: UpstreamServer;
  let gw: RunningGateway;
  let headers: Record<string, string>;

  before(async () => {
    idp = await startMockOAuth();
    upstream = await startUpstream();
    gw = await startGateway((publicOrigin, port) => testConfig(idp, upstream, { publicOrigin, port }));
    await login(gw, idp);
    const session = gw.client.json<{ csrf_token: string }>(await gw.client.get('/sso/session'));
    headers = { origin: gw.origin, 'x-csrf-token': session.csrf_token, 'content-type': 'application/json' };
    // Establish the bridge separately: subsequent probes must cause exactly
    // one upstream model request or no upstream request at all.
    assert.equal((await gw.client.get('/admin/dashboard')).status, 200);
  });

  after(async () => {
    await gw.close();
    await idp.close();
    await upstream.close();
  });

  it('forwards UI-encoded IDs unchanged for PUT, DELETE and POST preview', async () => {
    for (const id of ['org/model', 'vendor:model', '@org/model', 'org/model.v2', 'org/preview']) {
      for (const method of ['PUT', 'DELETE', 'POST']) {
        const path = `/admin/models/${encodeURIComponent(id)}${method === 'POST' ? '/preview' : ''}`;
        const decodedPath = `/admin/models/${id}${method === 'POST' ? '/preview' : ''}`;
        const beforeCount = upstream.counts[decodedPath] ?? 0;
        const beforeRequests = upstream.requests.length;
        const response = await gw.client.request(method, path, { rawPath: true, headers, body: '{}' });
        // This fixture deliberately has no model implementation. Its 404 and
        // counters prove transport/ASGI classification; backend.test.ts covers
        // the original FastAPI model CRUD and preview behavior.
        assert.equal(response.status, 404, `${method} ${path}: ${response.body}`);
        assert.deepEqual(upstream.requests.slice(beforeRequests), [path]);
        assert.equal(upstream.counts[decodedPath], beforeCount + 1, `${method} must preserve model ID ${id}`);
        assert.ok(String(upstream.lastHeaders[decodedPath]?.cookie).startsWith('cb_admin_session='));
        assert.notEqual(upstream.lastHeaders[decodedPath]?.['x-csrf-token'], headers['x-csrf-token']);
      }
    }
  });

  it('decodes the parameter once and preserves lowercase escapes and query encoding', async () => {
    const path = '/admin/models/%6Frg%2fmodel/preview?profile=cn-cli%2Ftest';
    const beforeRequests = upstream.requests.length;
    const beforeCount = upstream.counts['/admin/models/org/model/preview'] ?? 0;
    const response = await gw.client.request('POST', path, { rawPath: true, headers, body: '{}' });
    assert.equal(response.status, 404);
    assert.deepEqual(upstream.requests.slice(beforeRequests), [path]);
    assert.equal(upstream.counts['/admin/models/org/model/preview'], beforeCount + 1);
  });

  it('rejects unsafe model parameters before authorization or upstream access', async () => {
    const rejectedIds = [
      '', '.', '..', 'org/../session', 'org/./model', 'org//model', '/org/model', 'org/model/',
      'org%2F..%2F..%2Fsession', '%2E%2E%2Fsession', 'org%2F.%2Fmodel',
      'org%2F%2Fmodel', '%2Forg%2Fmodel', 'org%2Fmodel%2F',
      'org%252Fmodel', 'org%252e%252e', 'org%5cmodel', 'org\\model',
      'org%3fadmin', 'org%23model', 'org%20model', 'org%00model', 'org%7Fmodel',
      'org%25model', 'org%C3%A9', 'org%', 'org%2', 'org%ZZ', 'a'.repeat(161),
    ];
    for (const id of rejectedIds) {
      for (const method of ['PUT', 'DELETE', 'POST']) {
        const path = `/admin/models/${id}${method === 'POST' ? '/preview' : ''}`;
        const beforeRequests = upstream.requests.length;
        const beforeUserInfo = idp.counts.userinfo;
        const response = await gw.client.request(method, path, { rawPath: true, headers, body: '{}' });
        assert.equal(response.status, 400, `${method} ${path}: ${response.body}`);
        assert.equal(upstream.requests.length, beforeRequests, `unsafe model path reached upstream: ${path}`);
        assert.equal(idp.counts.userinfo, beforeUserInfo, `unsafe model path reached authorization: ${path}`);
      }
    }
  });

  it('rejects encoded route aliases and encoding outside supported model operations', async () => {
    const targets = [
      ['GET', '/admin/models/org%2Fmodel'],
      ['HEAD', '/admin/models/org%2Fmodel'],
      ['OPTIONS', '/admin/models/org%2Fmodel'],
      ['PATCH', '/admin/models/org%2Fmodel'],
      ['POST', '/admin/models/org%2Fmodel'],
      ['PUT', '/admin/model%73/org%2Fmodel'],
      ['PUT', '/%61dmin/models/org%2Fmodel'],
      ['POST', '/admin/models/org%2Fmodel/%70review'],
      ['POST', '/admin/models/org%2Fmodel%2Fpreview'],
      ['PUT', '/v1/models/org%2Fmodel'],
      ['PUT', '/v1/%2e%2e/admin/models/org%2Fmodel'],
      ['POST', '/admin/%73ession'],
      ['DELETE', '/admin/session%2F'],
    ] as const;
    for (const [method, path] of targets) {
      const beforeRequests = upstream.requests.length;
      const response = await gw.client.request(method, path, { rawPath: true, headers, body: '{}' });
      assert.equal(response.status, 400, `${method} ${path}: ${response.body}`);
      assert.equal(upstream.requests.length, beforeRequests);
    }
  });

  it('still requires an administrator, same Origin and gateway CSRF for encoded model IDs', async () => {
    const path = '/admin/models/org%2Fmodel';
    const anonymous = new HttpClient({ host: gw.host, port: gw.port });
    const beforeRequests = upstream.requests.length;
    const unauthenticated = await anonymous.request('PUT', path, { rawPath: true, headers, body: '{}' });
    assert.equal(unauthenticated.status, 401);
    const noCsrf = await gw.client.request('PUT', path, { rawPath: true, headers: { origin: gw.origin }, body: '{}' });
    assert.equal(noCsrf.status, 403);
    const noOrigin = await gw.client.request('PUT', path, {
      rawPath: true, headers: { 'x-csrf-token': headers['x-csrf-token']! }, body: '{}',
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(upstream.requests.length, beforeRequests);
  });

  it('validates decoded ID length and preserves existing canonical routes', () => {
    const longestId = `${'a'.repeat(155)}/name`;
    for (const method of ['PUT', 'DELETE', 'POST']) {
      const suffix = method === 'POST' ? '/preview' : '';
      assert.doesNotThrow(() => validateRequestTarget(`/admin/models/${encodeURIComponent(longestId)}${suffix}`, method));
      assert.throws(() => validateRequestTarget(`/admin/models/${encodeURIComponent(`${longestId}x`)}${suffix}`, method));
    }
    assert.doesNotThrow(() => validateRequestTarget('/admin/models/preview', 'POST'));
    assert.doesNotThrow(() => validateRequestTarget('/admin/models', 'POST'));
    assert.throws(() => validateRequestTarget('/admin/models/org%2Fmodel'));
  });
});
