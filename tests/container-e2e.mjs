#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createE2EProjectName, projectCollisionProblems } from './container-project.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseCompose = join(root, 'docker-compose.yml');
const e2eCompose = join(root, 'tests', 'docker-compose.e2e.yml');
const skipBuild = process.argv.includes('--skip-build');
const keep = process.argv.includes('--keep');
const project = createE2EProjectName(process.env.E2E_PROJECT_NAME);
const WRITER_TOKEN = 'e2e-only-not-a-secret-collab-writer-0001';
const READER_TOKEN = 'e2e-only-not-a-secret-collab-reader-0001';
const AI_TOKEN = 'e2e-only-not-a-secret-ai-caller-0001';
const PROVIDER_KEY = 'e2e-only-not-a-secret-provider-key-0001';
const WEBHOOK_SECRET = 'e2e-only-not-a-secret-webhook-signing-key-0001';

function run(program, args, { env, allowFailure = false, input, timeout } = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: env ?? process.env,
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  if (!allowFailure && result.status !== 0) {
    const spawnError = result.error instanceof Error ? `\n${result.error.message}` : '';
    throw new Error(
      `${program} ${args.join(' ')} failed (${String(result.status)}):\n${result.stdout}${result.stderr}${spawnError}`
    );
  }
  return result;
}

const projectResourceQueries = [
  ['containers', ['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]],
  ['networks', ['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]],
  ['volumes', ['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]],
];
const resourceInventory = Object.fromEntries(
  projectResourceQueries.map(([resource, args]) => [resource, run('docker', args).stdout])
);
const collisionProblems = projectCollisionProblems(project, resourceInventory);
if (collisionProblems.length !== 0) {
  throw new Error(
    `Refusing to reuse a nonempty Compose project because cleanup removes volumes:\n${collisionProblems.join('\n')}`
  );
}

const composePrefix = [
  'compose',
  '--ansi',
  'never',
  '--project-name',
  project,
  '--file',
  baseCompose,
  '--file',
  e2eCompose,
];

function compose(args, options = {}) {
  return run('docker', [...composePrefix, ...args], { ...options, env: testEnvironment });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        server.close();
        reject(new Error('Could not reserve a TCP port.'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

const [collabPort, restPort, aiPort] = await Promise.all([freePort(), freePort(), freePort()]);
const scratch = mkdtempSync(join(tmpdir(), 'domternal-container-e2e-'));
const secretScratch = mkdtempSync(join(root, '.container-e2e-secrets-'));
chmodSync(secretScratch, 0o700);
const secretSourceEnvironment = {};
try {
  for (const [environmentName, fileName, value] of [
    ['COLLAB_TOKENS_SOURCE_FILE', 'collab_tokens', WRITER_TOKEN],
    ['COLLAB_READONLY_TOKENS_SOURCE_FILE', 'collab_readonly_tokens', READER_TOKEN],
    ['WEBHOOK_SECRET_SOURCE_FILE', 'webhook_secret', WEBHOOK_SECRET],
    ['PROVIDER_API_KEY_SOURCE_FILE', 'provider_api_key', PROVIDER_KEY],
    ['AI_TOKENS_SOURCE_FILE', 'ai_tokens', AI_TOKEN],
  ]) {
    const path = join(secretScratch, fileName);
    writeFileSync(path, `${value}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    chmodSync(path, 0o644);
    secretSourceEnvironment[environmentName] = path;
  }
} catch (error) {
  rmSync(secretScratch, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  throw error;
}
const testEnvironment = {
  ...process.env,
  ...secretSourceEnvironment,
  COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS: '1',
  WEBHOOK_URL: 'http://mock-webhook:1260/hooks/collab',
  WEBHOOK_ALLOW_INSECURE_HTTP: '1',
  UPSTREAM_URL: 'http://mock-provider:1260/v1/chat/completions',
  PROVIDER: 'openai',
  UPSTREAM_ALLOW_INSECURE_HTTP: '1',
  ALLOWED_ORIGINS: 'https://app.example.test',
  REQUEST_TIMEOUT_MS: '5000',
  COLLAB_HOST_PORT: String(collabPort),
  COLLAB_REST_HOST_PORT: String(restPort),
  AI_HOST_PORT: String(aiPort),
};

async function response(path, options = {}) {
  return fetch(path, { signal: AbortSignal.timeout(10_000), ...options });
}

function serviceNode(service, source) {
  return compose(['exec', '-T', service, 'node', '--input-type=module', '-e', source], {
    timeout: 30_000,
  }).stdout.trim();
}

async function waitFor(description, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`
  );
}

function readWebhookRecords() {
  return JSON.parse(
    serviceNode(
      'mock-webhook',
      "const r=await fetch('http://127.0.0.1:1260/hooks/records',{signal:AbortSignal.timeout(2000)});if(!r.ok)throw new Error('records HTTP '+r.status);console.log(await r.text());"
    )
  );
}

function resetWebhookRecords() {
  const result = JSON.parse(
    serviceNode(
      'mock-webhook',
      "const r=await fetch('http://127.0.0.1:1260/hooks/records',{method:'DELETE',signal:AbortSignal.timeout(2000)});console.log(JSON.stringify({status:r.status,body:await r.text()}));"
    )
  );
  assert.deepEqual(result, { status: 204, body: '' });
}

function yjsMapValue(encodedUpdate) {
  return JSON.parse(
    serviceNode(
      'collab-server',
      `import * as Y from 'yjs';const d=new Y.Doc();Y.applyUpdate(d,Buffer.from(${JSON.stringify(
        encodedUpdate
      )},'base64'));console.log(JSON.stringify(d.getMap('e2e').get('value')??null));d.destroy();`
    )
  );
}

function webhookRecordsFor(documentName) {
  return readWebhookRecords().filter(
    (record) => JSON.parse(record.body).payload?.documentName === documentName
  );
}

function hasWebhook(records, event, readOnly) {
  return records.some((record) => {
    const envelope = JSON.parse(record.body);
    return (
      envelope.event === event &&
      (readOnly === undefined || envelope.payload.readOnly === readOnly)
    );
  });
}

async function waitForWebhooks(documentName, requirements) {
  return waitFor('signed collaboration webhook deliveries', () => {
    const records = webhookRecordsFor(documentName);
    return requirements.every(({ event, readOnly }) => hasWebhook(records, event, readOnly))
      ? records
      : null;
  });
}

function webhookCount(records, event) {
  return records.filter((record) => JSON.parse(record.body).event === event).length;
}

function verifyWebhookRecords(records, documentName) {
  for (const record of records) {
    assert.equal(record.method, 'POST');
    assert.equal(record.url, '/hooks/collab');
    assert.equal(record.contentType, 'application/json');
    assert.equal(
      record.signature,
      `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(record.body).digest('hex')}`
    );
    const envelope = JSON.parse(record.body);
    assert.deepEqual(Object.keys(envelope).sort(), ['event', 'payload', 'sentAt']);
    if (envelope.event === 'document.changed') {
      assert.deepEqual(envelope.payload, { documentName });
    } else {
      assert.ok(['client.connected', 'client.disconnected'].includes(envelope.event));
      assert.equal(typeof envelope.payload.readOnly, 'boolean');
      assert.deepEqual(envelope.payload, {
        documentName,
        readOnly: envelope.payload.readOnly,
      });
    }
    const sentAt = Date.parse(envelope.sentAt);
    assert.ok(Number.isFinite(sentAt));
    assert.equal(new Date(sentAt).toISOString(), envelope.sentAt);
    assert.ok(Math.abs(Date.now() - sentAt) < 120_000);
  }
  const serialized = JSON.stringify(records);
  for (const privateValue of [
    WRITER_TOKEN,
    READER_TOKEN,
    AI_TOKEN,
    PROVIDER_KEY,
    WEBHOOK_SECRET,
    'rest-before-websocket',
    'writer-through-websocket',
    'reader-write-must-be-rejected',
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
}

function runWebsocketClient(options) {
  const clientSource = readFileSync(join(root, 'tests', 'websocket-client.mjs'), 'utf8');
  const source = `${clientSource}\nconsole.log(JSON.stringify(await runWebsocketClient(${JSON.stringify(options)})));`;
  return JSON.parse(serviceNode('collab-server', source));
}

function byteSize(value) {
  const match = String(value).match(/^(\d+)([kmgt]?)$/iu);
  if (!match) return Number.NaN;
  const scale = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[
    match[2].toLowerCase()
  ];
  return Number(match[1]) * scale;
}

function inspectSecurity(
  service,
  {
    dataWritable = false,
    pidsLimit,
    secretFiles,
    healthStartPeriodSeconds,
  }
) {
  const secretPaths = secretFiles.map(({ path }) => path);
  const report = JSON.parse(
    serviceNode(
      service,
      `import {accessSync,constants,lstatSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
const canWrite=(path)=>{try{writeFileSync(path,'probe',{flag:'wx'});rmSync(path);return true}catch{return false}};
const status=Object.fromEntries(readFileSync('/proc/1/status','utf8').trim().split('\\n').map((line)=>line.split(/:\\s+/,2)));
const secretFiles=${JSON.stringify(secretPaths)}.map((path)=>{try{const stat=lstatSync(path);accessSync(path,constants.R_OK);let writable=true;try{accessSync(path,constants.W_OK)}catch{writable=false}return {path,regular:stat.isFile(),readable:true,writable,nonempty:stat.size>0}}catch{return {path,regular:false,readable:false,writable:false,nonempty:false}}});
console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),capEff:status.CapEff,noNewPrivs:status.NoNewPrivs,appWritable:canWrite('/app/src/.e2e-write-probe'),tmpWritable:canWrite('/tmp/.e2e-write-probe'),dataWritable:canWrite('/data/.e2e-write-probe'),secretFiles}));`
    )
  );
  assert.equal(report.uid, 1000, `${service} must run as uid 1000`);
  assert.equal(report.gid, 1000, `${service} must run as gid 1000`);
  assert.equal(report.capEff, '0000000000000000', `${service} must have zero effective capabilities`);
  assert.equal(report.noNewPrivs, '1', `${service} must set no-new-privileges`);
  assert.equal(report.appWritable, false, `${service} root filesystem must be read-only`);
  assert.equal(report.tmpWritable, true, `${service} /tmp must be a writable tmpfs`);
  assert.equal(report.dataWritable, dataWritable, `${service} /data write policy differs`);
  for (const expected of secretFiles) {
    const actual = report.secretFiles.find(({ path }) => path === expected.path);
    assert.ok(actual, `${service} did not inspect ${expected.path}`);
    assert.equal(actual.regular, true, `${expected.path} must be a regular mounted file`);
    assert.equal(actual.readable, true, `${expected.path} must be readable by uid 1000`);
    assert.equal(actual.writable, false, `${expected.path} must not be writable by uid 1000`);
    assert.equal(actual.nonempty, expected.nonempty, `${expected.path} emptiness differs`);
  }

  const tools = compose([
    'exec',
    '-T',
    service,
    'sh',
    '-ec',
    'for tool in g++ gcc make python python3; do if command -v "$tool" >/dev/null 2>&1; then echo "$tool"; exit 1; fi; done',
  ]);
  assert.equal(tools.stdout, '');

  const container = compose(['ps', '--quiet', service]).stdout.trim();
  const inspection = JSON.parse(run('docker', ['inspect', container]).stdout)[0];
  assert.equal(inspection.Config.User, 'node');
  assert.equal(inspection.Config.StopSignal, 'SIGTERM');
  assert.equal(inspection.Config.StopTimeout ?? inspection.HostConfig.StopTimeout, 30);
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(inspection.HostConfig.CapDrop, ['ALL']);
  assert.ok(inspection.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  assert.equal(inspection.HostConfig.Init, true);
  assert.equal(inspection.HostConfig.PidsLimit, pidsLimit);
  assert.equal(inspection.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.equal(inspection.HostConfig.LogConfig.Type, 'local');
  assert.equal(inspection.HostConfig.LogConfig.Config['max-size'], '10m');
  assert.equal(inspection.HostConfig.LogConfig.Config['max-file'], '3');
  const tmpfsOptions = new Set((inspection.HostConfig.Tmpfs?.['/tmp'] ?? '').split(','));
  for (const option of ['rw', 'noexec', 'nosuid', 'nodev']) {
    assert.ok(tmpfsOptions.has(option), `${service} /tmp is missing ${option}`);
  }
  const tmpfsSize = [...tmpfsOptions].find((option) => option.startsWith('size='));
  assert.equal(byteSize(tmpfsSize?.slice('size='.length)), 64 * 1024 * 1024);
  assert.equal(inspection.Config.Healthcheck.Interval, 10 * 1_000_000_000);
  assert.equal(inspection.Config.Healthcheck.Timeout, 3 * 1_000_000_000);
  assert.equal(inspection.Config.Healthcheck.Retries, 5);
  assert.equal(
    inspection.Config.Healthcheck.StartPeriod,
    healthStartPeriodSeconds * 1_000_000_000
  );
  const mounts = new Map((inspection.Mounts ?? []).map((mount) => [mount.Destination, mount]));
  for (const { path } of secretFiles) {
    const mount = mounts.get(path);
    assert.ok(mount, `${service} is missing the declared secret mount ${path}`);
    assert.equal(mount.Type, 'bind', `${path} must be a single-file bind mount`);
    assert.equal(mount.RW, false, `${path} must be mounted read-only`);
  }
  if (dataWritable) {
    assert.equal(mounts.get('/data')?.Type, 'volume');
    assert.equal(mounts.get('/data')?.RW, true);
  }
  for (const bindings of Object.values(inspection.NetworkSettings.Ports ?? {})) {
    for (const binding of bindings ?? []) assert.equal(binding.HostIp, '127.0.0.1');
  }
  const environment = run('docker', [
    'inspect',
    '--format',
    '{{range .Config.Env}}{{println .}}{{end}}',
    container,
  ]).stdout;
  for (const secret of [
    'COLLAB_TOKENS=',
    'COLLAB_READONLY_TOKENS=',
    'WEBHOOK_SECRET=',
    'PROVIDER_API_KEY=',
    'AI_TOKENS=',
  ]) {
    assert.equal(environment.split(/\r?\n/u).some((line) => line.startsWith(secret)), false);
  }
  const health = run('docker', [
    'inspect',
    '--format',
    '{{.State.Health.Status}}',
    container,
  ]).stdout.trim();
  assert.equal(health, 'healthy');
  return new Set(Object.keys(inspection.NetworkSettings.Networks ?? {}));
}

function serviceNetworks(service) {
  const container = compose(['ps', '--quiet', service]).stdout.trim();
  const inspection = JSON.parse(run('docker', ['inspect', container]).stdout)[0];
  return new Set(Object.keys(inspection.NetworkSettings.Networks ?? {}));
}

function assertSameNetworks(actual, expected) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

function expectStartupRefusal(service, extraEnvironment, expectedMessage) {
  const args = ['run', '--rm', '--no-deps'];
  for (const [name, value] of Object.entries(extraEnvironment)) {
    args.push('--env', `${name}=${value}`);
  }
  args.push(service);
  const result = compose(args, { allowFailure: true });
  assert.notEqual(result.status, 0, `${service} unexpectedly accepted insecure production config`);
  assert.match(`${result.stdout}\n${result.stderr}`, expectedMessage);
}

function exerciseStartupGuards() {
  expectStartupRefusal(
    'collab-server',
    { COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS: '' },
    /Refusing the permissive authorizeDocument policy/u
  );
  expectStartupRefusal(
    'collab-server',
    {
      COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS: '1',
      COLLAB_TOKENS_FILE: '',
      COLLAB_TOKENS: 'short-but-never-printed',
    },
    /secrets shorter than 32 UTF-8 bytes/u
  );
  expectStartupRefusal(
    'collab-server',
    {
      WEBHOOK_URL: 'https://webhook.example.test/collab',
      WEBHOOK_SECRET_FILE: '',
      WEBHOOK_SECRET: '',
      WEBHOOK_ALLOW_UNSIGNED: '',
    },
    /Refusing to start unsigned webhooks/u
  );
  expectStartupRefusal(
    'collab-server',
    {
      WEBHOOK_URL: 'http://webhook.example.test/collab',
      WEBHOOK_SECRET_FILE: '',
      WEBHOOK_SECRET: 'e2e-only-not-a-secret-webhook-signing-key-0001',
      WEBHOOK_ALLOW_INSECURE_HTTP: '',
    },
    /Refusing an HTTP WEBHOOK_URL/u
  );
  expectStartupRefusal(
    'ai-proxy',
    { UPSTREAM_ALLOW_INSECURE_HTTP: '' },
    /Refusing an HTTP UPSTREAM_URL/u
  );
  expectStartupRefusal(
    'ai-proxy',
    { AI_TOKENS_FILE: '', AI_TOKENS: 'short-but-never-printed' },
    /AI_TOKENS shorter than 32 UTF-8 bytes/u
  );
  expectStartupRefusal(
    'ai-proxy',
    { AI_TOKENS: AI_TOKEN },
    /AI_TOKENS and AI_TOKENS_FILE are both set/u
  );
}

async function exerciseCollab() {
  const base = `http://127.0.0.1:${String(restPort)}`;
  const writer = { authorization: `Bearer ${WRITER_TOKEN}` };
  const reader = { authorization: `Bearer ${READER_TOKEN}` };

  let reply = await response(`${base}/documents/e2e-document`);
  assert.equal(reply.status, 401);
  assert.equal(reply.headers.get('www-authenticate'), 'Bearer');

  reply = await response(`${base}/documents/e2e-document`, { headers: writer });
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).name, 'e2e-document');

  reply = await response(`${base}/documents/%E0%A4%A`, { headers: writer });
  assert.equal(reply.status, 400);

  reply = await response(`${base}/documents/e2e-document/update`, {
    method: 'POST',
    headers: { ...reader, 'content-type': 'application/json' },
    body: '{"update":"AAA="}',
  });
  assert.equal(reply.status, 403);

  reply = await response(`${base}/documents/e2e-document/update`, {
    method: 'POST',
    headers: { ...writer, 'content-type': 'application/json' },
    body: '{broken',
  });
  assert.equal(reply.status, 400);

  const update = serviceNode(
    'collab-server',
    "import * as Y from 'yjs';const d=new Y.Doc();d.getMap('e2e').set('value','before-backup');console.log(Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64'));"
  );
  reply = await response(`${base}/documents/e2e-document/update`, {
    method: 'POST',
    headers: { ...writer, 'content-type': 'application/json' },
    body: JSON.stringify({ update }),
  });
  assert.equal(reply.status, 200);

  reply = await response(`${base}/documents/e2e-document/update`, { headers: reader });
  assert.equal(reply.status, 200);
  const beforeBackup = (await reply.json()).update;

  const websocketDocument = 'e2e-websocket-document';
  const websocketSeed = serviceNode(
    'collab-server',
    "import * as Y from 'yjs';const d=new Y.Doc();d.getMap('e2e').set('value','rest-before-websocket');console.log(Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64'));d.destroy();"
  );
  reply = await response(`${base}/documents/${websocketDocument}/update`, {
    method: 'POST',
    headers: { ...writer, 'content-type': 'application/json' },
    body: JSON.stringify({ update: websocketSeed }),
  });
  assert.equal(reply.status, 200);
  await waitForWebhooks(websocketDocument, [{ event: 'document.changed' }]);
  resetWebhookRecords();
  assert.deepEqual(readWebhookRecords(), []);

  const writerReport = runWebsocketClient({
    documentName: websocketDocument,
    token: WRITER_TOKEN,
    expectedInitial: 'rest-before-websocket',
    nextValue: 'writer-through-websocket',
    readOnly: false,
  });
  assert.deepEqual(writerReport, { scope: 'read-write', saved: true });
  await waitFor('the websocket writer update to persist through REST', async () => {
    const current = await response(`${base}/documents/${websocketDocument}/update`, {
      headers: reader,
    });
    if (!current.ok) return false;
    return yjsMapValue((await current.json()).update) === 'writer-through-websocket';
  });
  const writerWebhooks = await waitForWebhooks(websocketDocument, [
    { event: 'document.changed' },
    { event: 'client.connected', readOnly: false },
    { event: 'client.disconnected', readOnly: false },
  ]);
  verifyWebhookRecords(writerWebhooks, websocketDocument);
  const writerChangeCount = webhookCount(writerWebhooks, 'document.changed');
  assert.equal(writerChangeCount, 1);

  const readerReport = runWebsocketClient({
    documentName: websocketDocument,
    token: READER_TOKEN,
    expectedInitial: 'writer-through-websocket',
    nextValue: 'reader-write-must-be-rejected',
    readOnly: true,
  });
  assert.deepEqual(readerReport, { scope: 'readonly', saved: false });
  await waitForWebhooks(websocketDocument, [
    { event: 'client.connected', readOnly: true },
    { event: 'client.disconnected', readOnly: true },
  ]);
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_500));
  reply = await response(`${base}/documents/${websocketDocument}/update`, { headers: reader });
  assert.equal(reply.status, 200);
  assert.equal(yjsMapValue((await reply.json()).update), 'writer-through-websocket');
  const allWebhooks = webhookRecordsFor(websocketDocument);
  assert.equal(webhookCount(allWebhooks, 'document.changed'), writerChangeCount);
  verifyWebhookRecords(allWebhooks, websocketDocument);

  compose([
    'exec',
    '-T',
    'collab-server',
    'node',
    'scripts/sqlite-maintenance.mjs',
    'check',
    '/data/collab.sqlite',
  ]);
  const backupInContainer = `/data/.e2e-backup-export-${process.pid}.sqlite`;
  compose([
    'exec',
    '-T',
    'collab-server',
    'node',
    'scripts/sqlite-maintenance.mjs',
    'backup',
    backupInContainer,
    '/data/collab.sqlite',
  ]);
  const hostBackup = join(scratch, 'collab.sqlite');
  compose(['cp', `collab-server:${backupInContainer}`, hostBackup]);
  compose(['exec', '-T', 'collab-server', 'rm', '-f', backupInContainer]);
  assert.ok(readFileSync(hostBackup).length > 0);

  const secondUpdate = serviceNode(
    'collab-server',
    "import * as Y from 'yjs';const d=new Y.Doc();d.getMap('e2e').set('value','after-backup');console.log(Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64'));"
  );
  reply = await response(`${base}/documents/e2e-document/update`, {
    method: 'POST',
    headers: { ...writer, 'content-type': 'application/json' },
    body: JSON.stringify({ update: secondUpdate }),
  });
  assert.equal(reply.status, 200);
  reply = await response(`${base}/documents/e2e-document/update`, { headers: writer });
  assert.notEqual((await reply.json()).update, beforeBackup);

  compose(['stop', '--timeout', '30', 'collab-server']);
  assert.match(
    compose(['logs', '--no-color', 'collab-server']).stdout,
    /Graceful shutdown complete/u
  );
  compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '--no-TTY',
      '--entrypoint',
      'sh',
      'collab-server',
      '-ec',
      'umask 077; set -C; cat > "$1"',
      'sh',
      '/data/e2e-restore.sqlite',
    ],
    { input: readFileSync(hostBackup) }
  );
  const restore = compose([
    'run',
    '--rm',
    '--no-deps',
    '--env',
    'COLLAB_MAINTENANCE_OFFLINE=1',
    '--entrypoint',
    'node',
    'collab-server',
    'scripts/sqlite-maintenance.mjs',
    'restore',
    '/data/e2e-restore.sqlite',
    '/data/collab.sqlite',
  ]);
  const rollbackMatch = restore.stdout.match(
    /Previous database preserved at (\/data\/collab\.sqlite\.before-restore-[^\s]+)/u
  );
  assert.ok(rollbackMatch, 'restore must report its automatic rollback database');
  const rollbackPath = rollbackMatch[1];
  compose(['up', '--detach', '--wait', '--wait-timeout', '120', 'collab-server']);
  compose([
    'exec',
    '-T',
    'collab-server',
    'node',
    'scripts/sqlite-maintenance.mjs',
    'check',
    rollbackPath,
  ]);
  reply = await response(`${base}/documents/e2e-document/update`, { headers: writer });
  assert.equal((await reply.json()).update, beforeBackup);

  compose(['restart', '--timeout', '30', 'collab-server']);
  compose(['up', '--detach', '--wait', '--wait-timeout', '120', 'collab-server']);
  reply = await response(`${base}/documents/e2e-document/update`, { headers: reader });
  assert.equal((await reply.json()).update, beforeBackup);

  const native = serviceNode(
    'collab-server',
    "import Database from 'better-sqlite3';const p='/data/e2e-native.sqlite';const db=new Database(p);db.exec('CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES (\\'ok\\')');console.log(db.prepare('SELECT value FROM probe').pluck().get());db.close();"
  );
  assert.equal(native, 'ok');
  compose(['exec', '-T', 'collab-server', 'rm', '-f', '/data/e2e-native.sqlite']);
  compose([
    'exec',
    '-T',
    'collab-server',
    'sh',
    '-ec',
    "test -f /app/node_modules/@domternal-pro/core/LICENSE.md && test -f /app/node_modules/@domternal-pro/core/THIRD-PARTY-LICENSES.md && test -f /app/node_modules/@domternal-pro/extension-comments/LICENSE.md && test -f /app/node_modules/@domternal-pro/extension-comments/THIRD-PARTY-LICENSES.md",
  ]);
}

async function exerciseProxy() {
  const endpoint = `http://127.0.0.1:${String(aiPort)}/`;
  let reply = await response(endpoint, { method: 'POST', body: '{}' });
  assert.equal(reply.status, 401);
  assert.equal(reply.headers.get('www-authenticate'), 'Bearer');

  reply = await response(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${AI_TOKEN}`,
      cookie: 'must-not-cross=1',
      'content-type': 'application/json',
      origin: 'https://app.example.test',
    },
    body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('access-control-allow-origin'), 'https://app.example.test');
  assert.equal(reply.headers.get('cache-control'), 'no-store');
  assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
  const stream = await reply.text();
  assert.match(stream, /data: \{/u);
  assert.match(stream, /data: \[DONE\]/u);
  const firstLine = stream.split('\n').find((line) => line.startsWith('data: {'));
  const observed = JSON.parse(firstLine.slice('data: '.length));
  assert.equal(observed.authorizationMatched, true);
  assert.equal(observed.cookieForwarded, false);
  assert.equal(observed.body.messages[0].content, 'hello');

  reply = await response(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${AI_TOKEN}`,
      'content-type': 'application/json',
      origin: 'https://evil.example.test',
    },
    body: JSON.stringify({ model: 'mock' }),
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('access-control-allow-origin'), null);
  await reply.arrayBuffer();

  reply = await response(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${AI_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'error' }),
  });
  assert.equal(reply.status, 429);
  assert.equal(reply.headers.get('retry-after'), '7');
  await reply.arrayBuffer();

  reply = await response(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${AI_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'redirect' }),
  });
  assert.equal(reply.status, 502);
  assert.match((await reply.json()).error, /redirected/u);

  reply = await response(endpoint, {
    method: 'OPTIONS',
    headers: { origin: 'https://app.example.test' },
  });
  assert.equal(reply.status, 204);
  assert.equal(reply.headers.get('access-control-allow-methods'), 'POST');

  compose(['stop', '--timeout', '30', 'ai-proxy']);
  assert.match(compose(['logs', '--no-color', 'ai-proxy']).stdout, /Graceful shutdown complete/u);
  compose(['up', '--detach', '--wait', '--wait-timeout', '120', 'ai-proxy']);
  reply = await response(endpoint, { method: 'POST', body: '{}' });
  assert.equal(reply.status, 401);
}

let failed = false;
try {
  compose(['config', '--quiet']);
  if (!skipBuild) compose(['build', '--pull']);
  exerciseStartupGuards();
  compose(['up', '--detach', '--wait', '--wait-timeout', '180']);
  const collabNetworks = inspectSecurity('collab-server', {
    dataWritable: true,
    pidsLimit: 256,
    healthStartPeriodSeconds: 15,
    secretFiles: [
      { path: '/run/secrets/collab_tokens', nonempty: true },
      { path: '/run/secrets/collab_readonly_tokens', nonempty: true },
      { path: '/run/secrets/webhook_secret', nonempty: true },
    ],
  });
  const aiNetworks = inspectSecurity('ai-proxy', {
    pidsLimit: 128,
    healthStartPeriodSeconds: 10,
    secretFiles: [
      { path: '/run/secrets/provider_api_key', nonempty: true },
      { path: '/run/secrets/ai_tokens', nonempty: true },
    ],
  });
  const providerNetworks = serviceNetworks('mock-provider');
  const webhookNetworks = serviceNetworks('mock-webhook');
  for (const [service, networks] of [
    ['collab-server', collabNetworks],
    ['ai-proxy', aiNetworks],
    ['mock-provider', providerNetworks],
    ['mock-webhook', webhookNetworks],
  ]) {
    assert.equal(networks.size, 1, `${service} must join exactly one isolated E2E network`);
  }
  assert.equal([...collabNetworks].some((network) => aiNetworks.has(network)), false);
  assertSameNetworks(webhookNetworks, collabNetworks);
  assertSameNetworks(providerNetworks, aiNetworks);
  await exerciseCollab();
  await exerciseProxy();
  console.log('[container-e2e] OK - security, SQLite, WebSocket, webhook, REST and proxy contracts verified');
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.stack : error);
  const logs = compose(['logs', '--no-color', '--tail', '200'], { allowFailure: true });
  console.error(logs.stdout);
  console.error(logs.stderr);
} finally {
  if (!keep) {
    const teardown = compose(['down', '--volumes', '--remove-orphans', '--timeout', '35'], {
      allowFailure: true,
    });
    if (teardown.status !== 0) {
      failed = true;
      console.error(`[container-e2e] cleanup command failed:\n${teardown.stdout}${teardown.stderr}`);
    }
    for (const [resource, args] of projectResourceQueries) {
      const leftovers = run('docker', args, { allowFailure: true }).stdout.trim();
      if (leftovers !== '') {
        failed = true;
        console.error(`[container-e2e] cleanup left project ${resource} behind: ${leftovers}`);
      }
    }
  } else {
    console.log(`[container-e2e] --keep selected; Compose project ${project} remains running`);
    console.log(`[container-e2e] E2E secret sources remain at ${secretScratch}`);
    console.log('[container-e2e] Run the matching Compose down command before removing that directory');
  }
  if (!keep) rmSync(secretScratch, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
