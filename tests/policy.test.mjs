import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  actionReferenceProblems,
  checkoutCredentialProblems,
  collectPolicyProblems,
  composePolicyProblems,
  requiredWorkflowEventProblems,
  rootPermissionProblems,
  workflowTriggerProblems,
} from '../scripts/check-policy.mjs';
import {
  createE2EProjectName,
  projectCollisionProblems,
} from './container-project.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the checked-in public template satisfies its infrastructure policy', () => {
  assert.deepEqual(collectPolicyProblems(root), []);
});

test('mutable GitHub Action tags are rejected', () => {
  const problems = actionReferenceProblems(`steps:\n  - uses: actions/checkout@v7\n`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /full commit SHA/u);
});

test('container actions require an immutable image digest', () => {
  assert.match(actionReferenceProblems('steps:\n  - uses: docker://alpine:3.24\n')[0], /sha256/u);
  assert.deepEqual(
    actionReferenceProblems(
      `steps:\n  - uses: docker://alpine@sha256:${'a'.repeat(64)}\n`
    ),
    []
  );
});

test('pull_request_target is rejected as an event but ignored in comments', () => {
  const safe = `
on:
  pull_request:
  # pull_request_target: this comment must not count as an event
jobs: {}
`;
  assert.deepEqual(workflowTriggerProblems(safe), []);

  for (const workflow of [
    `on: pull_request_target\njobs: {}\n`,
    `on: [push, pull_request_target]\njobs: {}\n`,
    `"on":\n  "pull_request_target":\njobs: {}\n`,
    `x-event: &event pull_request_target\non: *event\njobs: {}\n`,
    `on: [\n  push,\n  pull_request_target\n]\njobs: {}\n`,
  ]) {
    assert.ok(
      workflowTriggerProblems(workflow).some((problem) => problem.includes('pull_request_target'))
    );
  }
});

test('every checkout step must disable persisted credentials itself', () => {
  const safe = `steps:
  - name: Checkout
    uses: actions/checkout@${'a'.repeat(40)}
    with:
      persist-credentials: false
  - name: Another checkout
    uses: actions/checkout@${'b'.repeat(40)}
    with:
      persist-credentials: false
`;
  assert.deepEqual(checkoutCredentialProblems(safe), []);
  assert.match(
    checkoutCredentialProblems(safe.replace(/      persist-credentials: false\n/u, ''))[0],
    /same step/u
  );
  const leakedFromFollowingStep = `steps:
  - uses: actions/checkout@${'a'.repeat(40)}
  - run: echo safe
    env:
      persist-credentials: false
`;
  assert.match(checkoutCredentialProblems(leakedFromFollowingStep)[0], /same step/u);
});

test('workflow permissions default to repository read only', () => {
  assert.deepEqual(rootPermissionProblems('permissions:\n  contents: read\njobs: {}\n'), []);
  assert.match(
    rootPermissionProblems('permissions:\n  contents: write\njobs: {}\n')[0],
    /exactly contents: read/u
  );
  assert.match(rootPermissionProblems('permissions: write-all\njobs: {}\n')[0], /mapping/u);
});

test('required workflows cover main, pull requests and the merge queue', () => {
  const safe = `on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  merge_group: {}
`;
  assert.deepEqual(requiredWorkflowEventProblems(safe), []);
  assert.ok(
    requiredWorkflowEventProblems(safe.replace('  merge_group: {}\n', '')).some((problem) =>
      problem.includes('merge_group')
    )
  );
  assert.ok(
    requiredWorkflowEventProblems(safe.replace('    branches: [main]\n', '')).some((problem) =>
      problem.includes('push must be limited to main')
    )
  );
  assert.ok(
    requiredWorkflowEventProblems(
      safe.replace('  pull_request:\n    branches: [main]\n', '  pull_request:\n')
    ).some((problem) => problem.includes('pull_request must be limited to main'))
  );
});

test('direct secret exposure is rejected even when *_FILE remains configured', () => {
  const compose = `
services:
  one:
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: [/tmp]
    ports: ['127.0.0.1:\${A:-1}:1', '127.0.0.1:\${B:-2}:2']
    environment:
      COLLAB_TOKENS: leaked
      COLLAB_TOKENS_FILE: /run/secrets/collab_tokens
      COLLAB_READONLY_TOKENS_FILE: /run/secrets/collab_readonly_tokens
      WEBHOOK_SECRET_FILE: /run/secrets/webhook_secret
    volumes: [- collab-data:/data]
    networks: [- collab-network]
    logging: {driver: local}
  two:
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: [/tmp]
    ports: ['127.0.0.1:\${C:-3}:3']
    environment:
      PROVIDER_API_KEY_FILE: /run/secrets/provider_api_key
      AI_TOKENS_FILE: /run/secrets/ai_tokens
    networks: [- ai-network]
    logging: {driver: local}
secrets:
  a: {environment: COLLAB_TOKENS}
  b: {environment: PROVIDER_API_KEY}
`;
  assert.ok(
    composePolicyProblems(compose).some((problem) => problem.includes('exposes COLLAB_TOKENS'))
  );
  assert.ok(
    composePolicyProblems(
      compose.replace(
        '    environment:\n      COLLAB_TOKENS: leaked\n',
        '    environment: { COLLAB_TOKENS: leaked }\n'
      )
    ).some((problem) => problem.includes('block-style service environment'))
  );
});

test('all E2E services are explicitly local-only', () => {
  const compose = readFileSync(resolve(root, 'tests/docker-compose.e2e.yml'), 'utf8');
  assert.equal((compose.match(/^\s+pull_policy:\s*never\s*$/gmu) ?? []).length, 4);
});

test('container E2E uses only isolated project names and refuses occupied resources', () => {
  assert.equal(
    createE2EProjectName(undefined, { pid: 42, nonce: '0123abcd' }),
    'domternal-e2e-local-42-0123abcd'
  );
  assert.equal(
    createE2EProjectName('domternal-pro-e2e-123-amd64'),
    'domternal-pro-e2e-123-amd64'
  );
  for (const unsafe of [
    '',
    'production',
    'domternal-e2e-',
    'domternal-e2e-PROD',
    'domternal-e2e-prod/escape',
    `domternal-e2e-${'a'.repeat(64)}`,
  ]) {
    assert.throws(() => createE2EProjectName(unsafe), /E2E_PROJECT_NAME/u);
  }
  assert.throws(
    () => createE2EProjectName(undefined, { pid: 0, nonce: '0123abcd' }),
    /safe unique/u
  );
  assert.throws(
    () => createE2EProjectName(undefined, { pid: 42, nonce: 'not-safe' }),
    /safe unique/u
  );
  assert.deepEqual(
    projectCollisionProblems('domternal-e2e-local', {
      containers: '',
      networks: '\n',
      volumes: '',
    }),
    []
  );
  assert.deepEqual(
    projectCollisionProblems('domternal-e2e-local', {
      containers: 'container-id\n',
      networks: '',
      volumes: 'volume-id\n',
    }),
    [
      'Compose project domternal-e2e-local already owns containers',
      'Compose project domternal-e2e-local already owns volumes',
    ]
  );
});

test('the documented start path overrides an inherited development mode', () => {
  const result = spawnSync('npm', ['--silent', 'start'], {
    cwd: resolve(root, 'ai-proxy'),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PROVIDER: 'none',
      PROVIDER_API_KEY: '',
      AI_TOKENS: 'dev-token',
      UPSTREAM_URL: 'http://127.0.0.1:11434/v1/chat/completions',
      PORT: '0',
    },
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Refusing to start with placeholder tokens in production/u);
});
