import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Glob } from 'bun';

/**
 * Architectural guard: domain code depends on nothing but other domain code.
 * Fails if a domain file imports a framework, a driver, or an outer layer.
 */
const ROOT = join(import.meta.dir, '../../..');
const FORBIDDEN = [
  /^@nestjs\//,
  /^@mikro-orm\//,
  /^@aws-sdk\//,
  /^express$/,
  /^pg$/,
  /\/(application|infrastructure|presentation)\//,
];

const domainFiles = [...new Glob('src/**/domain/**/*.ts').scanSync(ROOT)];
const importsOf = (file: string) =>
  [...readFileSync(join(ROOT, file), 'utf8').matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(
    (m) => m[1] as string,
  );

describe('domain purity', () => {
  it('finds the domain files', () => {
    expect(domainFiles.length).toBeGreaterThan(10);
  });

  it.each(domainFiles.map((f) => [relative(ROOT, join(ROOT, f))]))('%s imports only domain code', (file) => {
    const offending = importsOf(file).filter((spec) => FORBIDDEN.some((rule) => rule.test(spec)));
    expect(offending).toEqual([]);
  });

  it('application layers never import the ORM, the database driver or SQS', () => {
    const applicationFiles = [...new Glob('src/**/application/**/*.ts').scanSync(ROOT)];
    expect(applicationFiles.length).toBeGreaterThan(5);
    const offending = applicationFiles.flatMap((f) =>
      importsOf(f)
        .filter((spec) => /^@mikro-orm\/|^@aws-sdk\/|^pg$|\/(infrastructure|presentation)\//.test(spec))
        .map((spec) => `${f} → ${spec}`),
    );
    expect(offending).toEqual([]);
  });

  it('wallets and messaging domains never import wagering (one-way module dependencies)', () => {
    const offending = domainFiles
      .filter((f) => f.includes('/wallets/') || f.includes('/messaging/'))
      .flatMap((f) =>
        importsOf(f)
          .filter((spec) => spec.includes('/wagering/'))
          .map((spec) => `${f} → ${spec}`),
      );
    expect(offending).toEqual([]);
  });
});
