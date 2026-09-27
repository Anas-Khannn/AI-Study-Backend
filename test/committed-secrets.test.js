const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { describe, it } = require('node:test');

const REPOSITORY_ROOT = path.join(__dirname, '..');

// A PostgreSQL URL that carries an inline password. Documentation and tests are
// allowed to show the *shape* of a connection string, so the obviously fake
// placeholders are listed below and only a value that is not one of them counts
// as a leak.
const CREDENTIAL_BEARING_URL = /postgres(?:ql)?:\/\/[^/\s'"@]*:([^@\s'"]*)@/g;
const DOCUMENTED_PLACEHOLDER_PASSWORDS = new Set([
  'PASSWORD',
  'password',
  'placeholder',
  'test_password',
  '***',
  '*****',
  // Decoding fixtures: a percent-escaped password, and a malformed escape.
  'p%40ss%2Fword',
  '100%pure',
]);

// Only files Git tracks are scanned. Walking the working tree instead would fail
// for every developer who followed the setup instructions in the README: their
// local `.env` holds a real credential by design, and it is never tracked, so
// flagging it would report a leak that Git cannot publish. The question this
// guard answers is "could a credential be committed", which is exactly the set
// of tracked files.
const listTrackedFiles = () => {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });

  return output.split('\0').filter(entry => entry !== '');
};

const readRepositoryFile = filePath => fs.readFileSync(filePath, 'utf8');

const findCredentialBearingUrls = content => {
  const findings = [];

  for (const [, password] of content.matchAll(CREDENTIAL_BEARING_URL)) {
    if (!DOCUMENTED_PLACEHOLDER_PASSWORDS.has(password)) {
      findings.push(password);
    }
  }

  return findings;
};

describe('committed secrets', () => {
  it('never writes a credentialed connection string into a tracked file', () => {
    const offenders = [];

    for (const relativePath of listTrackedFiles()) {
      const filePath = path.join(REPOSITORY_ROOT, relativePath);

      for (const password of findCredentialBearingUrls(readRepositoryFile(filePath))) {
        offenders.push(`${relativePath} (password of length ${password.length})`);
      }
    }

    assert.deepEqual(offenders, []);
  });

  // A developer's local `.env` is supposed to exist and to hold real credentials,
  // so its presence in the working tree is expected, not a failure. What has to
  // hold is that Git ignores it and therefore cannot commit it, which is what
  // protects the password the moment it is written.
  it('keeps the real .env ignored and untracked', () => {
    const isIgnored = () => {
      try {
        execFileSync('git', ['check-ignore', '-q', '.env'], { cwd: REPOSITORY_ROOT });

        return true;
      } catch {
        return false;
      }
    };

    assert.equal(isIgnored(), true, '.env must be listed in .gitignore');

    const trackedEnvironmentFiles = listTrackedFiles().filter(
      relativePath =>
        path.basename(relativePath).startsWith('.env') &&
        path.basename(relativePath) !== '.env.example',
    );

    assert.deepEqual(trackedEnvironmentFiles, []);
  });

  it('ships DATABASE_URL in the template without a value', () => {
    const template = readRepositoryFile(path.join(REPOSITORY_ROOT, '.env.example'));

    assert.match(template, /^DATABASE_URL=\s*$/m);
  });
});
