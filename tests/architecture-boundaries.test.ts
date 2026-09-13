/**
 * Hexagonal architecture boundary conformance (DEC-037, issue #90).
 *
 * Statically scans the module specifiers of every file under `src/core` with
 * the TypeScript AST and asserts the dependency rule:
 *
 *     domain <- application ports/use-cases <- adapters
 *
 * Core may never depend outward (on `src/adapters`, `src/daemon`, ...) or on
 * external packages / node builtins — it is pure domain + port contracts.
 *
 * It also asserts every legacy `src/domain/*.ts` module is a thin
 * compatibility facade that only re-exports from `src/core/domain`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const CORE_DIR = path.join(SRC_DIR, 'core');
const LEGACY_DOMAIN_DIR = path.join(SRC_DIR, 'domain');

/* ------------------------------------------------------------------ *
 * Layer model
 * ------------------------------------------------------------------ */

type CoreLayer = 'domain' | 'ports' | 'use-cases' | 'application' | 'core-root';

/** Classify a repo-relative posix path as a core layer, or null when outside src/core. */
function coreLayerOf(relPath: string): CoreLayer | null {
  if (!relPath.startsWith('src/core/')) {
    return null;
  }
  const rest = relPath.slice('src/core/'.length);
  if (rest.startsWith('domain/')) {
    return 'domain';
  }
  if (rest.startsWith('application/ports/')) {
    return 'ports';
  }
  if (rest.startsWith('application/use-cases/')) {
    return 'use-cases';
  }
  if (rest.startsWith('application/')) {
    return 'application';
  }
  return 'core-root';
}

/**
 * The allowed dependency matrix: which core layers each layer may import.
 * `domain` sits at the centre and may only depend on itself; ports and
 * use-cases point inward; `application`/`core-root` barrels may reach any
 * core layer.
 */
const ALLOWED_IMPORTS: Readonly<Record<CoreLayer, readonly CoreLayer[]>> = {
  domain: ['domain'],
  ports: ['domain', 'ports'],
  'use-cases': ['domain', 'ports', 'use-cases'],
  application: ['domain', 'ports', 'use-cases', 'application'],
  'core-root': ['domain', 'ports', 'use-cases', 'application', 'core-root'],
};

function isAllowedCoreImport(sourceLayer: CoreLayer, targetLayer: CoreLayer): boolean {
  return ALLOWED_IMPORTS[sourceLayer].includes(targetLayer);
}

/* ------------------------------------------------------------------ *
 * Module specifier scanning
 * ------------------------------------------------------------------ */

interface ImportEdge {
  /** Repo-relative posix path of the importing file. */
  source: string;
  /** Raw module specifier as written (`'./enums.js'`, `'node:fs'`, ...). */
  specifier: string;
  /** Repo-relative posix path the specifier resolves to, or null. */
  target: string | null;
}

function toRelPosix(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/** Resolve a relative ESM specifier (`./x.js`, `./dir/index.js`) to a .ts file. */
function resolveSpecifier(sourceAbs: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(sourceAbs), specifier);
  const stem = base.endsWith('.js') ? base.slice(0, -'.js'.length) : base;
  for (const candidate of [`${stem}.ts`, path.join(stem, 'index.ts'), base]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Collect every string-literal module specifier in a TypeScript source text:
 * static `import ... from` / `export ... from`, dynamic `import('...')`,
 * CommonJS `require('...')`, and `import x = require('...')`.
 */
function collectSpecifiersFromSource(text: string, fileName = 'source.ts'): string[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const firstArg = node.arguments[0];
      if ((isDynamicImport || isRequire) && firstArg !== undefined && ts.isStringLiteral(firstArg)) {
        specifiers.push(firstArg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** Collect every module specifier edge in a file on disk. */
function collectEdges(fileAbs: string): ImportEdge[] {
  const text = fs.readFileSync(fileAbs, 'utf8');
  return collectSpecifiersFromSource(text, fileAbs).map((raw) => {
    const resolved = isRelativeSpecifier(raw) ? resolveSpecifier(fileAbs, raw) : null;
    return {
      source: toRelPosix(fileAbs),
      specifier: raw,
      target: resolved === null ? null : toRelPosix(resolved),
    };
  });
}

function listTsFiles(dirAbs: string): string[] {
  if (!fs.existsSync(dirAbs)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const entryAbs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(entryAbs));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(entryAbs);
    }
  }
  return files.sort();
}

/* ------------------------------------------------------------------ *
 * Boundary checks
 * ------------------------------------------------------------------ */

/**
 * Evaluate one import edge for a file under `src/core`. Returns a readable
 * `source -> target` violation message, or null when the edge is legal.
 */
function coreEdgeViolation(edge: ImportEdge): string | null {
  const sourceLayer = coreLayerOf(edge.source);
  if (sourceLayer === null) {
    return null;
  }
  if (!isRelativeSpecifier(edge.specifier)) {
    const kind = edge.specifier.startsWith('node:')
      ? 'node builtin'
      : 'external package';
    return `${edge.source} -> ${edge.specifier} (${kind} imports are forbidden under src/core)`;
  }
  if (edge.target === null) {
    return `${edge.source} -> ${edge.specifier} (unresolvable module specifier)`;
  }
  const targetLayer = coreLayerOf(edge.target);
  if (targetLayer === null) {
    return `${edge.source} -> ${edge.target} (src/core modules may only import within src/core)`;
  }
  if (!isAllowedCoreImport(sourceLayer, targetLayer)) {
    return `${edge.source} -> ${edge.target} (${sourceLayer} may not depend on ${targetLayer})`;
  }
  return null;
}

/**
 * Generic core layer roots (`src/core/application/`, `src/core/` itself) may
 * contain barrels only. A non-index file there would bypass the
 * use-cases/ports layer rules by sidestepping them entirely.
 */
function barrelViolation(relPath: string): string | null {
  const layer = coreLayerOf(relPath);
  if (
    (layer === 'application' || layer === 'core-root') &&
    !relPath.endsWith('/index.ts')
  ) {
    return `${relPath} (${layer} roots may contain only index.ts barrels)`;
  }
  return null;
}

/**
 * Assert a legacy `src/domain` file is a pure compatibility facade: every
 * statement is an `export ... from` declaration resolving into
 * `src/core/domain`. Returns readable violation messages.
 */
function facadeViolations(fileAbs: string): string[] {
  const rel = toRelPosix(fileAbs);
  const text = fs.readFileSync(fileAbs, 'utf8');
  const sourceFile = ts.createSourceFile(fileAbs, text, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      violations.push(`${rel}: expected a compatibility facade but found a non-export statement`);
      continue;
    }
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) {
      violations.push(`${rel}: facade export must re-export from a module specifier`);
      continue;
    }
    const resolved = resolveSpecifier(fileAbs, specifier.text);
    if (resolved === null) {
      violations.push(`${rel} -> ${specifier.text} (unresolvable module specifier)`);
      continue;
    }
    const targetRel = toRelPosix(resolved);
    if (!targetRel.startsWith('src/core/domain/')) {
      violations.push(`${rel} -> ${targetRel} (facade must resolve inward to src/core/domain)`);
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('hexagonal dependency matrix', () => {
  it('permits the inward-pointing edges of the target architecture', () => {
    expect(isAllowedCoreImport('domain', 'domain')).toBe(true);
    expect(isAllowedCoreImport('ports', 'domain')).toBe(true);
    expect(isAllowedCoreImport('ports', 'ports')).toBe(true);
    expect(isAllowedCoreImport('use-cases', 'domain')).toBe(true);
    expect(isAllowedCoreImport('use-cases', 'ports')).toBe(true);
    expect(isAllowedCoreImport('use-cases', 'use-cases')).toBe(true);
  });

  it('rejects outward-pointing edges (the bad arrows)', () => {
    // Domain is the centre: it may not depend on any outer layer.
    expect(isAllowedCoreImport('domain', 'ports')).toBe(false);
    expect(isAllowedCoreImport('domain', 'use-cases')).toBe(false);
    expect(isAllowedCoreImport('domain', 'application')).toBe(false);
    // Ports may not depend on use-cases or barrels.
    expect(isAllowedCoreImport('ports', 'use-cases')).toBe(false);
    expect(isAllowedCoreImport('ports', 'application')).toBe(false);
    // Use-cases may not depend on application barrels.
    expect(isAllowedCoreImport('use-cases', 'application')).toBe(false);
  });

  it('rejects external, node builtin, and out-of-core imports from any core layer', () => {
    const cases: Array<[string, string, string | null]> = [
      // domain importing a node builtin
      ['src/core/domain/types.ts', 'node:fs', null],
      // ports importing a bare package
      ['src/core/application/ports/outbound/clock.ts', 'ws', null],
      // domain reaching out of core into the daemon
      ['src/core/domain/events.ts', '../../daemon/event-stream.js', 'src/daemon/event-stream.ts'],
      // ports reaching adapters
      [
        'src/core/application/ports/outbound/agent-runtime.ts',
        '../../../adapters/base.js',
        'src/adapters/base.ts',
      ],
      // use-cases reaching storage
      [
        'src/core/application/use-cases/delegate-task.ts',
        '../../../storage/index.js',
        'src/storage/index.ts',
      ],
      // unresolvable relative specifier
      ['src/core/domain/types.ts', './does-not-exist.js', null],
    ];
    for (const [source, specifier, target] of cases) {
      const violation = coreEdgeViolation({ source, specifier, target });
      expect(violation).not.toBeNull();
      expect(violation).toContain('->');
    }
  });

  it('collects specifiers from dynamic import(), require(), and import = require()', () => {
    const source = [
      `import a from 'node:fs';`,
      `export { b } from './local.js';`,
      `const c = await import('ws');`,
      `const d = require('node:path');`,
      `import e = require('legacy-module');`,
      `const f = require(dynamicName);`,
    ].join('\n');
    expect(collectSpecifiersFromSource(source)).toEqual([
      'node:fs',
      './local.js',
      'ws',
      'node:path',
      'legacy-module',
    ]);
  });

  it('rejects dynamic import and require edges inside core', () => {
    const source = `const x = await import('ws');\nconst y = require('node:fs');`;
    const violations = collectSpecifiersFromSource(source).map((specifier) =>
      coreEdgeViolation({
        source: 'src/core/application/use-cases/x.ts',
        specifier,
        target: null,
      }),
    );
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v !== null)).toBe(true);
  });

  it('flags non-barrel files under the generic application/core-root layers', () => {
    expect(barrelViolation('src/core/index.ts')).toBeNull();
    expect(barrelViolation('src/core/application/index.ts')).toBeNull();
    expect(barrelViolation('src/core/helper.ts')).not.toBeNull();
    expect(barrelViolation('src/core/application/helper.ts')).not.toBeNull();
    // Real modules inside the named layers are unaffected.
    expect(barrelViolation('src/core/domain/types.ts')).toBeNull();
    expect(barrelViolation('src/core/application/ports/outbound/clock.ts')).toBeNull();
    expect(barrelViolation('src/core/application/use-cases/delegate.ts')).toBeNull();
  });

  it('accepts the representative legal edges', () => {
    const cases: ImportEdge[] = [
      // domain -> domain
      {
        source: 'src/core/domain/events.ts',
        specifier: './enums.js',
        target: 'src/core/domain/enums.ts',
      },
      // port -> domain
      {
        source: 'src/core/application/ports/outbound/id-generator.ts',
        specifier: '../../../domain/types.js',
        target: 'src/core/domain/types.ts',
      },
      // use-case -> port
      {
        source: 'src/core/application/use-cases/delegate-task.ts',
        specifier: '../ports/outbound/clock.js',
        target: 'src/core/application/ports/outbound/clock.ts',
      },
      // core barrel -> ports barrel
      {
        source: 'src/core/index.ts',
        specifier: './application/index.js',
        target: 'src/core/application/index.ts',
      },
    ];
    for (const edge of cases) {
      expect(coreEdgeViolation(edge)).toBeNull();
    }
  });
});

describe('src/core boundary conformance', () => {
  const coreFiles = listTsFiles(CORE_DIR);
  const coreViolations = coreFiles.flatMap(collectEdges).flatMap((edge) => {
    const violation = coreEdgeViolation(edge);
    return violation === null ? [] : [violation];
  });

  it('has a canonical domain layer and outbound port contracts', () => {
    for (const name of [
      'approval',
      'capabilities',
      'enums',
      'events',
      'factories',
      'policy',
      'types',
      'index',
    ]) {
      expect(
        fs.existsSync(path.join(CORE_DIR, 'domain', `${name}.ts`)),
        `missing src/core/domain/${name}.ts`,
      ).toBe(true);
    }
    for (const name of [
      'clock',
      'id-generator',
      'event-stream',
      'agent-runtime',
      'worktree',
      'index',
    ]) {
      expect(
        fs.existsSync(
          path.join(CORE_DIR, 'application', 'ports', 'outbound', `${name}.ts`),
        ),
        `missing src/core/application/ports/outbound/${name}.ts`,
      ).toBe(true);
    }
  });

  it('every src/core module only imports inward (domain <- ports/use-cases, no externals)', () => {
    expect(coreFiles.length).toBeGreaterThan(0);
    expect(coreViolations).toEqual([]);
  });

  it('application and core-root layers contain index.ts barrels only', () => {
    const violations = coreFiles
      .map((fileAbs) => barrelViolation(toRelPosix(fileAbs)))
      .filter((v): v is string => v !== null);
    expect(violations).toEqual([]);
  });
});

describe('src/domain compatibility facades', () => {
  it('every legacy domain module is a facade resolving into src/core/domain', () => {
    const legacyFiles = listTsFiles(LEGACY_DOMAIN_DIR);
    expect(legacyFiles.length).toBeGreaterThan(0);
    const violations = legacyFiles.flatMap(facadeViolations);
    expect(violations).toEqual([]);
  });
});
