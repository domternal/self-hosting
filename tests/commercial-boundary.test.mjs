import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MAX_INSPECTED_FILE_BYTES,
  commercialBoundaryProblems,
} from '../scripts/check-commercial-boundary.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'domternal-commercial-boundary-'));
  for (const service of ['ai-proxy', 'collab-server']) {
    write(
      join(directory, service, 'package.json'),
      `${JSON.stringify({ name: service, private: true, dependencies: {} }, null, 2)}\n`
    );
    write(join(directory, service, 'index.mjs'), "import fs from 'node:fs';\nvoid fs;\n");
  }
  return directory;
}

function withFixture(run) {
  const directory = fixture();
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function problemText(directory) {
  return commercialBoundaryProblems(directory).join('\n');
}

function completeKey(version = 2, kind = 'evaluation') {
  const fields =
    version === 1
      ? {
          o: 'order_test',
          p: 'Solo',
          s: 1,
          e: '2099-12-31',
        }
      : kind === 'commercial'
        ? {
            t: 'commercial',
            i: '1'.repeat(32),
            l: 'domternal-pro',
            b: '2026-08-01',
            c: '2027-08-16',
            e: '2027-08-30',
            g: false,
            n: '2'.repeat(32),
          }
        : kind === 'commercial-prelaunch'
          ? {
              t: 'commercial',
              i: '4'.repeat(32),
              l: 'domternal-pro',
              b: '2026-08-01',
              f: null,
              e: '2027-08-30',
              n: '5'.repeat(32),
            }
        : {
            t: kind,
            e: '2099-12-31',
            n: '3'.repeat(32),
          };
  const payload = Buffer.from(
    JSON.stringify({
      v: version,
      k: 1,
      ...fields,
    })
  ).toString('base64url');
  const signature = Buffer.alloc(64, 0x5a).toString('base64url');
  return `DMP${String(version)}.${payload}.${signature}`;
}

function initializeGitFixture(directory) {
  execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
}

test('the checked-in MIT deployment surfaces contain no commercial reference', () => {
  assert.deepEqual(commercialBoundaryProblems(root), []);
});

test('rejects commercial references anywhere in package manifests', async (t) => {
  const cases = [
    ['dependency key', { dependencies: { '@domternal-pro/runtime': '1.0.0' } }],
    ['development dependency', { devDependencies: { '@domternal-pro/tool': '1.0.0' } }],
    ['optional dependency', { optionalDependencies: { '@domternal-pro/optional': '1.0.0' } }],
    ['peer dependency', { peerDependencies: { '@domternal-pro/peer': '1.0.0' } }],
    ['npm alias value', { dependencies: { safe: 'npm:@domternal-pro/runtime@1.0.0' } }],
    ['override key', { overrides: { '@domternal-pro/runtime': '1.0.0' } }],
    ['nested override value', { overrides: { safe: { replacement: '@domternal-pro/runtime' } } }],
    ['resolution value', { resolutions: { safe: 'npm:@domternal-pro/runtime@1.0.0' } }],
    ['array value', { bundledDependencies: ['@domternal-pro/runtime'] }],
    ['package script', { scripts: { preload: 'node --import @domternal-pro/runtime app.mjs' } }],
    ['config value', { config: { entrypoint: '@domternal-pro/runtime/register' } }],
  ];

  for (const [name, fragment] of cases) {
    await t.test(name, () => {
      withFixture((directory) => {
        write(
          join(directory, 'collab-server', 'package.json'),
          `${JSON.stringify({ name: 'collab', ...fragment }, null, 2)}\n`
        );
        const problems = problemText(directory);
        assert.match(problems, /collab-server\/package\.json/u);
        assert.match(problems, /commercial package/u);
      });
    });
  }
});

test('rejects commercial residue anywhere in a package lock', () => {
  withFixture((directory) => {
    write(
      join(directory, 'collab-server', 'package-lock.json'),
      `${JSON.stringify(
        {
          name: 'collab',
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { safe: 'npm:@domternal-pro/runtime@1.0.0' } },
            'node_modules/@domternal-pro/runtime': {
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/@domternal-pro/runtime/-/runtime-1.0.0.tgz',
            },
          },
        },
        null,
        2
      )}\n`
    );
    const problems = problemText(directory);
    assert.match(problems, /collab-server\/package-lock\.json/u);
    assert.match(problems, /commercial package/u);
  });
});

test('rejects every JavaScript module reference form, including dynamic templates', async (t) => {
  const cases = [
    "import value from '@domternal-pro/static';\nvoid value;\n",
    "export { value } from '@domternal-pro/reexport';\n",
    "await import('@domternal-pro/dynamic');\n",
    'const name = "runtime";\nawait import(`@domternal-pro/${name}`);\n',
    "const specifier = '@domternal-pro/indirect';\nawait import(specifier);\n",
    "require('@domternal-pro/commonjs');\n",
    "require.resolve('@domternal-pro/resolved');\n",
  ];

  for (const [index, source] of cases.entries()) {
    await t.test(`reference ${String(index + 1)}`, () => {
      withFixture((directory) => {
        const service = index % 2 === 0 ? 'ai-proxy' : 'collab-server';
        write(join(directory, service, `commercial-${String(index)}.mjs`), source);
        assert.match(
          problemText(directory),
          new RegExp(`${service}/commercial-${String(index)}\\.mjs`, 'u')
        );
      });
    });
  }
});

test('rejects Docker, Compose, workflow, shell, entrypoint and config references', async (t) => {
  const cases = [
    ['collab-server/Dockerfile', 'RUN npm install @domternal-pro/runtime\n'],
    ['docker-compose.yml', 'services:\n  app:\n    image: @domternal-pro/runtime\n'],
    ['.github/workflows/deploy.yml', 'jobs:\n  deploy:\n    uses: @domternal-pro/runtime\n'],
    ['collab-server/entrypoint.sh', 'node --import @domternal-pro/runtime app.mjs\n'],
    ['ai-proxy/entrypoint', 'exec node --import @domternal-pro/runtime app.mjs\n'],
    ['collab-server/runtime.config', 'preload=@domternal-pro/runtime\n'],
    ['ai-proxy/runtime.toml', 'module = "@domternal-pro/runtime"\n'],
    ['collab-server/.dockerignore', '!node_modules/@domternal-pro/runtime\n'],
  ];

  for (const [path, source] of cases) {
    await t.test(path, () => {
      withFixture((directory) => {
        write(join(directory, path), source);
        assert.match(problemText(directory), new RegExp(path.replaceAll('.', '\\.'), 'u'));
      });
    });
  }
});

test('rejects complete DMP1 and DMP2 keys in every text surface', async (t) => {
  const cases = [
    ['README.md', `Accidental customer key: ${completeKey(1)}\n`],
    ['collab-server/deployment.notes', `${completeKey(2)}\n`],
    ['collab-server/commercial.notes', `${completeKey(2, 'commercial')}\n`],
    ['collab-server/prelaunch-commercial.notes', `${completeKey(2, 'commercial-prelaunch')}\n`],
    [
      'ai-proxy/package.json',
      `${JSON.stringify({ name: 'ai-proxy', private: true, copiedKey: completeKey(2) })}\n`,
    ],
  ];

  for (const [path, source] of cases) {
    await t.test(path, () => {
      withFixture((directory) => {
        write(join(directory, path), source);
        const problems = problemText(directory);
        assert.match(problems, new RegExp(path.replaceAll('.', '\\.'), 'u'));
        assert.match(problems, /complete DMP1 or DMP2 license key/u);
      });
    });
  }
});

test('rejects complete DMP1 and DMP2 keys in binary files', async (t) => {
  const cases = [
    [
      'collab-server/image.dat',
      Buffer.concat([
        Buffer.from([0, 255, 0]),
        Buffer.from(completeKey(1)),
        Buffer.from([0]),
      ]),
    ],
    [
      'ai-proxy/archive.dat',
      Buffer.concat([
        Buffer.from([255, 254]),
        Buffer.from(completeKey(2)),
      ]),
    ],
  ];

  for (const [path, bytes] of cases) {
    await t.test(path, () => {
      withFixture((directory) => {
        write(join(directory, path), bytes);
        const problems = problemText(directory);
        assert.match(problems, new RegExp(path.replaceAll('.', '\\.'), 'u'));
        assert.match(problems, /complete DMP1 or DMP2 license key/u);
      });
    });
  }
});

test('rejects a complete key assembled from adjacent string literals', () => {
  withFixture((directory) => {
    const [prefix, payload, signature] = completeKey(2).split('.');
    write(join(directory, 'collab-server', 'split-key.mjs'), [
      `const mixed = '${prefix}.' /* hidden */ + "${payload}" + \`.\` + '${signature}';`,
      `const joined = ['${prefix}.', '${payload}', '.', '${signature}'].join('');`,
      'void mixed;',
      'void joined;',
      '',
    ].join('\n'));
    const problems = problemText(directory);
    assert.match(problems, /collab-server\/split-key\.mjs/u);
    assert.match(problems, /complete DMP1 or DMP2 license key/u);
  });
});

test('allows a non-canonical DMP lookalike that cannot activate the verifier', () => {
  withFixture((directory) => {
    const segment = 'A'.repeat(32);
    write(join(directory, 'README.md'), `Placeholder: DMP2.${segment}.${segment}\n`);
    assert.deepEqual(commercialBoundaryProblems(directory), []);
  });
});

test('rejects Pro activation calls and license environment wiring on executable surfaces', async (t) => {
  const cases = [
    ['collab-server/license-bootstrap.mjs', 'setLicenseKey(value);\n', /setLicenseKey/u],
    [
      'ai-proxy/runtime.config',
      "configureProLicense({ mode: 'evaluation' });\n",
      /configureProLicense/u,
    ],
    [
      'docker-compose.yml',
      'services:\n  app:\n    environment:\n      DOMTERNAL_PRO_LICENSE: copied\n',
      /DOMTERNAL_PRO_LICENSE/u,
    ],
    [
      'collab-server/runtime.toml',
      'license_env = "VITE_DOMTERNAL_PRO_LICENSE_KEY"\n',
      /DOMTERNAL_PRO_LICENSE/u,
    ],
  ];

  for (const [path, source, expected] of cases) {
    await t.test(path, () => {
      withFixture((directory) => {
        write(join(directory, path), source);
        const problems = problemText(directory);
        assert.match(problems, new RegExp(path.replaceAll('.', '\\.'), 'u'));
        assert.match(problems, expected);
      });
    });
  }
});

test('scans previously unrecognized UTF-8 configuration and executable filenames', async (t) => {
  const cases = [
    ['.env', 'DOMTERNAL_PRO_LICENSE=copied\n', /DOMTERNAL_PRO_LICENSE/u],
    ['.npmrc', 'node-options=--import=@domternal-pro/runtime\n', /commercial package/u],
    ['Makefile', 'license:\n\tsetLicenseKey(value)\n', /setLicenseKey/u],
    ['Containerfile', 'RUN npm install @domternal-pro/runtime\n', /commercial package/u],
    [
      'collab-server/bootstrap',
      "configureProLicense({ mode: 'evaluation' });\n",
      /configureProLicense/u,
    ],
  ];

  for (const [path, source, expected] of cases) {
    await t.test(path, () => {
      withFixture((directory) => {
        write(join(directory, path), source);
        const problems = problemText(directory);
        assert.match(problems, new RegExp(path.replaceAll('.', '\\.'), 'u'));
        assert.match(problems, expected);
      });
    });
  }
});

test('fails closed for binary files and malformed package manifests', () => {
  withFixture((directory) => {
    write(
      join(directory, 'collab-server', 'nul-binary.dat'),
      Buffer.concat([
        Buffer.from('@domternal-pro/runtime'),
        Buffer.from([0]),
        Buffer.from('setLicenseKey(value)'),
      ])
    );
    write(
      join(directory, 'collab-server', 'invalid-utf8.dat'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('@domternal-pro/runtime')])
    );
    const binaryProblems = problemText(directory);
    assert.match(binaryProblems, /nul-binary\.dat is binary or not valid UTF-8 text/u);
    assert.match(binaryProblems, /invalid-utf8\.dat is binary or not valid UTF-8 text/u);

    write(
      join(directory, 'collab-server', 'package.json'),
      Buffer.from([0xff, 0xfe, 0xfd])
    );
    assert.match(problemText(directory), /package\.json is not valid UTF-8 text/u);
  });
});

test('rejects tracked files inside generated dependency and output directories', async (t) => {
  const directories = ['node_modules', 'dist', 'coverage', '.pnpm-store'];
  for (const name of directories) {
    await t.test(name, () => {
      withFixture((directory) => {
        initializeGitFixture(directory);
        const path = join(directory, 'collab-server', name, 'leak.bin');
        write(path, Buffer.from(completeKey(2)));
        execFileSync('git', ['add', '--force', path], { cwd: directory, stdio: 'ignore' });
        const problems = problemText(directory);
        assert.match(problems, new RegExp(`collab-server/${name.replace('.', '\\.')}`, 'u'));
        assert.match(problems, /tracked inside the excluded generated directory/u);
      });
    });
  }
});

test('rejects a tracked generated file even when index flags hide its worktree path', () => {
  withFixture((directory) => {
    initializeGitFixture(directory);
    const relativePath = 'collab-server/dist/leak.bin';
    const path = join(directory, relativePath);
    write(path, Buffer.from(completeKey(2)));
    execFileSync('git', ['add', '--force', relativePath], { cwd: directory, stdio: 'ignore' });
    rmSync(join(directory, 'collab-server', 'dist'), { recursive: true, force: true });
    const problems = problemText(directory);
    assert.match(problems, /collab-server\/dist\/leak\.bin/u);
    assert.match(problems, /tracked inside the excluded generated directory/u);
  });
});

test('ignores an inherited alternate Git index and inspects the repository index', () => {
  withFixture((directory) => {
    initializeGitFixture(directory);
    const relativePath = 'collab-server/dist/leak.bin';
    write(join(directory, relativePath), Buffer.from(completeKey(2)));
    execFileSync('git', ['add', '--force', relativePath], { cwd: directory, stdio: 'ignore' });
    const alternateIndex = join(directory, 'empty-alternate-index');
    execFileSync('git', ['read-tree', '--empty'], {
      cwd: directory,
      env: { ...process.env, GIT_INDEX_FILE: alternateIndex },
      stdio: 'ignore',
    });
    const previous = process.env['GIT_INDEX_FILE'];
    process.env['GIT_INDEX_FILE'] = alternateIndex;
    try {
      assert.match(problemText(directory), /collab-server\/dist\/leak\.bin/u);
    } finally {
      if (previous === undefined) delete process.env['GIT_INDEX_FILE'];
      else process.env['GIT_INDEX_FILE'] = previous;
    }
  });
});

test('ignores untracked dependency output in a Git checkout', () => {
  withFixture((directory) => {
    initializeGitFixture(directory);
    write(
      join(directory, 'collab-server', 'node_modules', 'dependency', 'index.js'),
      'setLicenseKey(value);\n'
    );
    assert.deepEqual(commercialBoundaryProblems(directory), []);
  });
});

test('accepts the exact scan limit and fails closed before reading oversized files', () => {
  withFixture((directory) => {
    write(
      join(directory, 'collab-server', 'exact-limit.dat'),
      Buffer.alloc(MAX_INSPECTED_FILE_BYTES, 0x20)
    );
    assert.deepEqual(commercialBoundaryProblems(directory), []);
  });

  withFixture((directory) => {
    const path = join(directory, 'collab-server', 'oversized.dat');
    write(path, Buffer.alloc(MAX_INSPECTED_FILE_BYTES + 1, 0x41));
    const problems = problemText(directory);
    assert.match(problems, /collab-server\/oversized\.dat/u);
    assert.match(problems, /exceeds the 1048576 byte commercial-boundary scan limit/u);
  });
});

test('allows prose API examples and empty non-activating calls', () => {
  withFixture((directory) => {
    write(
      join(directory, 'README.md'),
      [
        'This MIT server never calls setLicenseKey(value).',
        "It does not use configureProLicense({ mode: 'production', key }).",
        'It ignores DOMTERNAL_PRO_LICENSE_KEY because no Pro license belongs here.',
      ].join('\n')
    );
    write(
      join(directory, 'collab-server', 'empty-reference.mjs'),
      'setLicenseKey();\nconfigureProLicense();\n'
    );
    assert.deepEqual(commercialBoundaryProblems(directory), []);
  });
});

test('ignores only the reviewed negative fixture path', () => {
  withFixture((directory) => {
    write(
      join(directory, 'tests', 'commercial-boundary.test.mjs'),
      "await import('@domternal-pro/fixture');\n"
    );
    assert.deepEqual(commercialBoundaryProblems(directory), []);

    write(
      join(directory, 'tests', 'neighbor.test.mjs'),
      "await import('@domternal-pro/not-a-fixture');\n"
    );
    assert.match(problemText(directory), /tests\/neighbor\.test\.mjs/u);
  });
});

test('never exempts a complete license key in the reviewed fixture path', () => {
  withFixture((directory) => {
    write(
      join(directory, 'tests', 'commercial-boundary.test.mjs'),
      `const leaked = "${completeKey(2)}";\n`
    );
    const problems = problemText(directory);
    assert.match(problems, /tests\/commercial-boundary\.test\.mjs/u);
    assert.match(problems, /complete DMP1 or DMP2 license key/u);
  });
});

test('never exempts binary content in the reviewed fixture path', () => {
  withFixture((directory) => {
    write(
      join(directory, 'tests', 'commercial-boundary.test.mjs'),
      Buffer.from([0x00, 0xff, 0x00])
    );
    assert.match(
      problemText(directory),
      /tests\/commercial-boundary\.test\.mjs is binary or not valid UTF-8 text/u
    );
  });
});

test('fails closed for malformed manifests, missing services and source symlinks', async (t) => {
  await t.test('malformed manifest', () => {
    withFixture((directory) => {
      write(join(directory, 'collab-server', 'package.json'), '{not json\n');
      assert.match(problemText(directory), /package\.json is not valid JSON/u);
    });
  });

  await t.test('missing service', () => {
    withFixture((directory) => {
      rmSync(join(directory, 'ai-proxy'), { recursive: true, force: true });
      assert.match(problemText(directory), /ai-proxy service directory is missing/u);
    });
  });

  await t.test('source symlink', () => {
    withFixture((directory) => {
      write(join(directory, 'outside.mjs'), "export const safe = true;\n");
      symlinkSync('../../outside.mjs', join(directory, 'collab-server', 'linked.mjs'));
      assert.match(problemText(directory), /linked\.mjs is a symbolic link/u);
    });
  });
});
