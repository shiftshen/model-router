import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductService, parseOfficialRunning } from '../src/product-service.mjs';
import { officialDesktopEnvironment } from '../src/platform-runtime.mjs';

test('official activation targets only the detected default PID and coalesces concurrent requests', async () => {
  const service = new ProductService();
  service.officialCodexRunning = async () => [{ pid: 123 }];
  const calls = [];
  service.openOfficialDesktop = async (options) => {
    calls.push(options);
    await new Promise(resolve => setTimeout(resolve, 10));
    return { pid: options.pid, delivered: true };
  };
  const results = await Promise.all([service.launchOfficial(), service.launchOfficial(), service.launchOfficial()]);
  assert.deepEqual(calls, [{ pid: 123 }]);
  assert.ok(results.every(result => result.delivered && result.pid === 123 && result.reused));
});

test('successful command, wrong PID and unconfirmed visibility must not report success', async () => {
  for (const response of [{ launched: true, pid: 123 }, { delivered: true, pid: 456 }, { delivered: false, pid: 123 }]) {
    const service = new ProductService();
    service.officialCodexRunning = async () => [{ pid: 123 }];
    service.openOfficialDesktop = async () => response;
    await assert.rejects(service.launchOfficial(), /未确认窗口/);
    assert.equal(service.officialLaunchPending, null);
  }
});

test('cold start discovers and activates the new default PID instead of trusting launcher PID', async () => {
  const service = new ProductService();
  let started = false;
  service.officialCodexRunning = async () => started ? [{ pid: 789 }] : [];
  const calls = [];
  service.openOfficialDesktop = async (options) => {
    calls.push(options);
    if (!options) { started = true; return { launched: true, pid: 999 }; }
    return { delivered: true, pid: options.pid };
  };
  const result = await service.launchOfficial();
  assert.deepEqual(calls, [undefined, { pid: 789 }]);
  assert.equal(result.pid, 789);
  assert.equal(result.reused, false);
});

test('exited default instance never activates a stale PID', async () => {
  const service = new ProductService();
  let reads = 0;
  service.officialCodexRunning = async () => ++reads === 1 ? [{ pid: 123 }] : [];
  service.openOfficialDesktop = async () => { throw Error('must not activate'); };
  await assert.rejects(service.launchOfficial(), /未确认窗口/);
});

test('custom profiles with either argument spelling are excluded from official selection', () => {
  const exe = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  const lines = [`1 ${exe}`, `2 ${exe} --user-data-dir=/tmp/router`, `3 ${exe} --user-data-dir /tmp/other`];
  assert.deepEqual(parseOfficialRunning(lines.join('\n'), '/tmp/model-assistant').map(row => row.pid), [1]);
});

test('official launch environment cannot inherit router or provider credentials', () => {
  const env = { CODEX_HOME: '/tmp/router', CMA_ROUTE_TOKEN: 'fixture', OPENAI_BASE_URL: 'http://localhost', OPENAI_API_KEY: 'fixture', ELECTRON_RUN_AS_NODE: '1', HOME: '/Users/test', PATH: '/bin' };
  assert.deepEqual(officialDesktopEnvironment(env), { HOME: '/Users/test', PATH: '/bin' });
  assert.equal(env.CODEX_HOME, '/tmp/router');
});
