#!/usr/bin/env node
// Live smoke test: drives every exposed tool against a local fixture page through the stdio MCP server.
// Requires Chrome running with the extension connected to the native bridge.
// Usage: node scripts/smoke-test.mjs [path/to/mcp-server-stdio.js]
/* global process, console, setTimeout, clearTimeout, URL */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stdioEntry = process.argv[2] || join(root, 'app/native-server/dist/mcp/mcp-server-stdio.js');
const downloadName = `mcp-smoke-download-${Date.now().toString(36)}`;

const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>mcp-smoke</title></head><body>
<h1>MCP Smoke Fixture</h1>
<input id="name" aria-label="name">
<select id="color" aria-label="color"><option value="red">red</option><option value="blue">blue</option></select>
<button id="go">Go</button><div id="out"></div>
<button id="late-btn">Late</button>
<button id="fetch-btn">Fetch</button><div id="api"></div>
<button id="alert-btn">Alert</button>
<textarea id="kbd" aria-label="kbd"></textarea>
<input type="file" id="file" aria-label="file">
<a id="dl" href="/download.txt" download="${downloadName}.txt">Download</a>
<script>
console.log('smoke-console-marker');
const $ = (id) => document.getElementById(id);
$('go').onclick = () => setTimeout(() => { $('out').textContent = 'clicked:' + $('name').value; }, 300);
$('late-btn').onclick = () => setTimeout(() => {
  const d = document.createElement('div'); d.id = 'late'; d.textContent = 'late-ready'; document.body.appendChild(d);
}, 800);
$('fetch-btn').onclick = () => fetch('/api.json?delay=600').then((r) => r.json()).then((j) => { $('api').textContent = j.ok; });
$('alert-btn').onclick = () => setTimeout(() => { alert('smoke-alert'); $('out').textContent = 'alert-closed'; }, 200);
</script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api.json') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: 'api-ok' }));
    }, Number(url.searchParams.get('delay') || 0));
  } else if (url.pathname === '/download.txt') {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-disposition': `attachment; filename="${downloadName}.txt"`,
    });
    res.end('download-body');
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
  }
});
// Loopback by default: Chrome treats plain-HTTP downloads from other hosts (e.g. *.localhost)
// as insecure and asks where to save them, which an unattended run cannot answer.
const host = process.env.SMOKE_HOST || '127.0.0.1';
await new Promise((resolve) => server.listen(0, host, resolve));
const base = `http://${host}:${server.address().port}/`;
const uploadFile = join(tmpdir(), 'mcp-smoke-upload.txt');
writeFileSync(uploadFile, 'upload-body');

const child = spawn(process.execPath, [stdioEntry], { stdio: ['pipe', 'pipe', 'ignore'] });
const pending = new Map();
let nextId = 1;
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});
const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 90000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
const call = async (name, args = {}) => {
  const message = await rpc('tools/call', { name, arguments: args });
  if (message.error) throw new Error(message.error.message);
  const content = message.result?.content || [];
  const text = content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  return { isError: Boolean(message.result?.isError), text, content };
};
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
const ok = (result, label) => {
  expect(!result.isError, `${label}: ${result.text.slice(0, 600)}`);
  return result;
};

const results = [];
const step = async (tool, label, fn) => {
  try {
    results.push({ tool, label, ok: true, detail: (await fn()) || '' });
  } catch (error) {
    results.push({ tool, label, ok: false, detail: String(error.message).slice(0, 600) });
  }
};

let originalTabId;
let tabId;
const listTabs = async () => {
  const { text } = ok(await call('get_windows_and_tabs'), 'get_windows_and_tabs');
  const data = JSON.parse(text);
  return (data.windows || []).flatMap((window) => window.tabs || []);
};

try {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  await step('tools/list', 'lists exposed tools', async () => {
    const message = await rpc('tools/list', {});
    const names = message.result.tools.map((tool) => tool.name);
    expect(names.includes('chrome_wait_for'), 'chrome_wait_for missing');
    return `${names.length} tools, ${JSON.stringify(message.result.tools).length} bytes`;
  });
  await step('get_windows_and_tabs', 'lists tabs', async () => {
    const tabs = await listTabs();
    originalTabId = tabs.find((tab) => tab.active)?.tabId ?? tabs[0]?.tabId;
    return `${tabs.length} tabs`;
  });
  await step('chrome_navigate', 'opens fixture in a new tab', async () => {
    const { text } = ok(await call('chrome_navigate', { url: base }), 'navigate');
    // A freshly created tab may not report its URL yet, so trust the id returned by navigate.
    tabId = JSON.parse(text).tabId;
    expect(typeof tabId === 'number', 'fixture tab not found');
    return `tab ${tabId}`;
  });
  // Every later step targets the fixture tab; without it they would act on the user's active tab.
  if (typeof tabId !== 'number') throw new Error('fixture tab unavailable, aborting remaining steps');
  await step('chrome_wait_for', 'waits for page text', async () => {
    ok(await call('chrome_wait_for', { text: 'MCP Smoke Fixture', tabId, timeout: 10000 }), 'wait');
  });
  await step('chrome_read_page', 'interactive elements', async () => {
    const { text } = ok(await call('chrome_read_page', { filter: 'interactive', tabId }), 'read');
    expect(text.includes('Go'), 'button "Go" not in tree');
    return `${text.length} chars`;
  });
  await step('chrome_get_web_content', 'text content', async () => {
    const { text } = ok(await call('chrome_get_web_content', { tabId, textContent: true }), 'web');
    expect(text.includes('MCP Smoke Fixture'), 'fixture text missing');
    return `${text.length} chars`;
  });
  await step('chrome_fill_or_select', 'fills input and select', async () => {
    ok(await call('chrome_fill_or_select', { selector: '#name', value: 'smoke', tabId }), 'fill');
    ok(await call('chrome_fill_or_select', { selector: '#color', value: 'blue', tabId }), 'select');
  });
  await step('chrome_click_element', 'clicks button with trusted input', async () => {
    const { text } = ok(await call('chrome_click_element', { selector: '#go', tabId }), 'click');
    expect(JSON.parse(text).clickMethod === 'trusted', `click method ${text.slice(0, 120)}`);
    ok(await call('chrome_wait_for', { text: 'clicked:smoke', tabId, timeout: 5000 }), 'after click');
  });
  await step('chrome_javascript', 'evaluates code', async () => {
    const { text } = ok(
      await call('chrome_javascript', { code: "return document.getElementById('color').value", tabId }),
      'js',
    );
    expect(text.includes('blue'), `unexpected result ${text.slice(0, 120)}`);
  });
  await step('chrome_keyboard', 'types into textarea', async () => {
    ok(await call('chrome_keyboard', { selector: '#kbd', keys: 'abc', tabId }), 'keyboard');
    const { text } = ok(
      await call('chrome_javascript', { code: "return document.getElementById('kbd').value", tabId }),
      'js',
    );
    expect(text.includes('abc'), `textarea value ${text.slice(0, 120)}`);
  });
  await step('chrome_wait_for', 'selector appears / hidden / timeout', async () => {
    ok(await call('chrome_click_element', { selector: '#late-btn', tabId }), 'click late');
    const appear = ok(await call('chrome_wait_for', { selector: '#late', tabId, timeout: 5000 }), 'appear');
    ok(await call('chrome_wait_for', { text: 'no-such-text', state: 'hidden', tabId }), 'hidden');
    const timeout = await call('chrome_wait_for', { selector: '#never', tabId, timeout: 800 });
    expect(timeout.isError && timeout.text.includes('Timed out'), 'expected a timeout error');
    return `appear ${JSON.parse(appear.text).elapsedMs}ms`;
  });
  await step('chrome_network_capture', 'captures fetch', async () => {
    ok(await call('chrome_network_capture', { action: 'start', needResponseBody: true }), 'start');
    ok(await call('chrome_click_element', { selector: '#fetch-btn', tabId }), 'click fetch');
    const idle = ok(
      await call('chrome_wait_for', { text: 'api-ok', networkIdleMs: 300, tabId, timeout: 10000 }),
      'network idle',
    );
    const { text } = ok(await call('chrome_network_capture', { action: 'stop' }), 'stop');
    expect(text.includes('api.json'), 'api.json not captured');
    return `idle after ${JSON.parse(idle.text).elapsedMs}ms`;
  });
  await step('chrome_network_request', 'sends request', async () => {
    const { text } = ok(await call('chrome_network_request', { url: `${base}api.json` }), 'request');
    expect(text.includes('api-ok'), 'response body missing');
  });
  await step('chrome_console', 'reads console', async () => {
    const snapshot = ok(await call('chrome_console', { tabId }), 'console');
    expect(snapshot.text.includes('smoke-console-marker'), 'console marker missing');
  });
  await step('chrome_screenshot', 'captures viewport', async () => {
    const shot = ok(await call('chrome_screenshot', { tabId, storeBase64: true, savePng: false }), 'shot');
    const image = shot.content.find((item) => item.type === 'image');
    expect(image || shot.text.includes('base64'), 'no image data');
    return image ? `${image.data.length} b64 chars` : 'text payload';
  });
  await step('chrome_computer', 'scrolls', async () => {
    ok(
      await call('chrome_computer', {
        action: 'scroll',
        coordinates: { x: 100, y: 100 },
        scrollDirection: 'down',
        scrollAmount: 1,
        tabId,
      }),
      'computer',
    );
  });
  await step('chrome_upload_file', 'sets file input', async () => {
    ok(await call('chrome_upload_file', { selector: '#file', filePath: uploadFile, tabId }), 'upload');
    const { text } = ok(
      await call('chrome_javascript', {
        code: "return document.getElementById('file').files[0]?.name || ''",
        tabId,
      }),
      'js',
    );
    expect(text.includes('mcp-smoke-upload.txt'), `file name ${text.slice(0, 120)}`);
  });
  await step('chrome_handle_download', 'waits for download', async () => {
    ok(await call('chrome_click_element', { selector: '#dl', tabId }), 'click download');
    const { text } = ok(
      await call('chrome_handle_download', { filenameContains: downloadName, timeoutMs: 15000 }),
      'download',
    );
    const filename = JSON.parse(text).download?.filename || JSON.parse(text).filename;
    if (filename) rmSync(filename, { force: true });
    return filename ? 'downloaded and removed' : text.slice(0, 120);
  });
  await step('chrome_handle_dialog', 'arms and accepts alert', async () => {
    ok(await call('chrome_handle_dialog', { action: 'accept', arm: true, timeoutMs: 10000, tabId }), 'arm');
    ok(await call('chrome_click_element', { selector: '#alert-btn', tabId }), 'click alert');
    ok(await call('chrome_wait_for', { text: 'alert-closed', tabId, timeout: 8000 }), 'alert closed');
  });
  await step('chrome_switch_tab', 'restores original tab', async () => {
    expect(typeof originalTabId === 'number', 'original tab unknown');
    ok(await call('chrome_switch_tab', { tabId: originalTabId }), 'switch');
  });
  await step('chrome_close_tabs', 'closes fixture tab', async () => {
    ok(await call('chrome_close_tabs', { tabIds: [tabId] }), 'close');
  });
} catch (error) {
  results.push({ tool: 'abort', label: 'run aborted', ok: false, detail: String(error.message) });
} finally {
  child.kill();
  server.close();
  rmSync(uploadFile, { force: true });
}

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.tool.padEnd(24)} ${result.label}${result.detail ? ` | ${result.detail}` : ''}`);
}
const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
