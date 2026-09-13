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
      if (
        (isDynamicImport || isRequire) &&
        firstArg !== undefined &&
        ts.isStringLiteral(firstArg)
      ) {
        specifiers.push(firstArg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/**
 * Node.js globals core modules may never reference: `Buffer`, `process`,
 * `NodeJS`, `__dirname`, `__filename`, `require`. Core is platform-neutral —
 * byte decoding, environment access, and Node-specific types belong to
 * adapters (DEC-037).
 */
const FORBIDDEN_CORE_GLOBALS: ReadonlySet<string> = new Set([
  'Buffer',
  'process',
  'NodeJS',
  '__dirname',
  '__filename',
  'require',
]);

/**
 * True when `node` occupies a name position rather than a reference
 * position: property names (`x.process`, `{ process: 1 }`), declaration
 * names (`const process = ...`), import/export specifier names, qualified-
 * name right sides, and labels. References — including `require(x)` callees,
 * `NodeJS.Timeout` left sides, and shorthand `{ process }` values — return
 * false and are flagged.
 */
function isNameOnlyPosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) {
    return false;
  }
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isExportSpecifier(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return true;
  }
  if (ts.isLabeledStatement(parent) && parent.label === node) {
    return true;
  }
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) {
    return true;
  }
  return false;
}

/**
 * Collect every forbidden Node.js global *reference* in a TypeScript source
 * text. Comments and string literals are not AST identifiers and are never
 * flagged.
 */
function collectForbiddenGlobalRefs(text: string, fileName = 'source.ts'): string[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const refs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      FORBIDDEN_CORE_GLOBALS.has(node.text) &&
      !isNameOnlyPosition(node)
    ) {
      refs.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return refs;
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
    const kind = edge.specifier.startsWith('node:') ? 'node builtin' : 'external package';
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
  if ((layer === 'application' || layer === 'core-root') && !relPath.endsWith('/index.ts')) {
    return `${relPath} (${layer} roots may contain only index.ts barrels)`;
  }
  return null;
}

const OUTBOUND_PREFIX = 'src/adapters/outbound/';
const OUTBOUND_ROOT_BARREL = 'src/adapters/outbound/index.ts';

/** The adapter family of a path: first segment after `src/adapters/outbound/`. */
function outboundFamily(relPath: string): string {
  return relPath.slice(OUTBOUND_PREFIX.length).split('/')[0] ?? '';
}

/**
 * Evaluate one import edge for a file under `src/adapters/outbound`.
 * Outbound adapters may import `src/core/**`, siblings inside the same
 * adapter family, node builtins, and external packages — nothing else (no
 * legacy daemon/storage/attention/secretary paths, legacy adapter facades,
 * inbound adapters, bootstrap composition, or other adapter families).
 * `src/adapters/outbound/index.ts` is the only root barrel and may
 * additionally import each family's `index.ts`.
 */
function outboundEdgeViolation(edge: ImportEdge): string | null {
  if (!edge.source.startsWith(OUTBOUND_PREFIX)) {
    return null;
  }
  if (!isRelativeSpecifier(edge.specifier)) {
    return null; // node builtin or external package — allowed in adapters
  }
  if (edge.target === null) {
    return `${edge.source} -> ${edge.specifier} (unresolvable module specifier)`;
  }
  if (edge.target.startsWith('src/core/')) {
    return null;
  }
  if (!edge.target.startsWith(OUTBOUND_PREFIX)) {
    return (
      `${edge.source} -> ${edge.target} ` +
      '(outbound adapters may only import src/core or their same adapter family)'
    );
  }
  if (edge.source === OUTBOUND_ROOT_BARREL) {
    return edge.target.endsWith('/index.ts')
      ? null
      : `${edge.source} -> ${edge.target} (the root barrel may only import family barrels)`;
  }
  if (outboundFamily(edge.source) === outboundFamily(edge.target)) {
    return null;
  }
  return (
    `${edge.source} -> ${edge.target} ` +
    '(cross-family import: outbound adapters may only import src/core or ' +
    'their same adapter family)'
  );
}

/**
 * Assert a legacy compatibility wrapper file: every statement is an import,
 * export, function, class, or interface declaration; exports must resolve
 * into `allowedExportPrefixes`, imports into `allowedImportPrefixes`, and
 * function declarations are restricted to `allowedFunctionNames`. Returns
 * readable violation messages.
 */
function wrapperViolations(
  fileAbs: string,
  options: {
    readonly allowedImportPrefixes: readonly string[];
    readonly allowedExportPrefixes: readonly string[];
    readonly allowedFunctionNames?: readonly string[];
    readonly allowClasses?: boolean;
  },
): string[] {
  const rel = toRelPosix(fileAbs);
  if (!fs.existsSync(fileAbs)) {
    return [`${rel}: expected a compatibility wrapper but the file is missing`];
  }
  const text = fs.readFileSync(fileAbs, 'utf8');
  const sourceFile = ts.createSourceFile(fileAbs, text, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const specifierAllowed = (specifier: string, prefixes: readonly string[]): boolean => {
    const resolved = resolveSpecifier(fileAbs, specifier);
    if (resolved === null) {
      violations.push(`${rel} -> ${specifier} (unresolvable module specifier)`);
      return false;
    }
    return prefixes.some((prefix) => toRelPosix(resolved).startsWith(prefix));
  };
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (!options.allowedFunctionNames?.includes(statement.name?.text ?? '')) {
        violations.push(`${rel}: function "${statement.name?.text ?? '<anon>'}" is not allowed`);
      }
      continue;
    }
    if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      if (options.allowClasses !== true) {
        violations.push(`${rel}: class/interface declarations are not allowed in this wrapper`);
      }
      continue;
    }
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier;
      if (specifier === undefined || !ts.isStringLiteral(specifier)) {
        continue;
      }
      const prefixes = ts.isImportDeclaration(statement)
        ? options.allowedImportPrefixes
        : options.allowedExportPrefixes;
      if (!specifierAllowed(specifier.text, prefixes)) {
        const resolved = resolveSpecifier(fileAbs, specifier.text);
        violations.push(
          `${rel} -> ${resolved === null ? specifier.text : toRelPosix(resolved)} (wrapper boundary)`,
        );
      }
      continue;
    }
    violations.push(`${rel}: expected wrapper but found a disallowed statement`);
  }
  return violations;
}

/**
 * Assert a legacy file is a pure compatibility facade: every statement is an
 * `export ... from` declaration resolving into `requiredPrefix` (a
 * repo-relative posix path prefix such as `src/core/domain/`). Returns
 * readable violation messages.
 */
function facadeViolations(fileAbs: string, requiredPrefix: string): string[] {
  const rel = toRelPosix(fileAbs);
  if (!fs.existsSync(fileAbs)) {
    return [`${rel}: expected a compatibility facade but the file is missing`];
  }
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
    if (!targetRel.startsWith(requiredPrefix)) {
      violations.push(`${rel} -> ${targetRel} (facade must resolve inward to ${requiredPrefix})`);
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
      'model',
      'repositories',
      'runtime-registry',
      'credential-vault',
      'context-sources',
      'preference-profile',
      'quota-reader',
      'git-client',
      'voice',
      'health',
      'index',
    ]) {
      expect(
        fs.existsSync(path.join(CORE_DIR, 'application', 'ports', 'outbound', `${name}.ts`)),
        `missing src/core/application/ports/outbound/${name}.ts`,
      ).toBe(true);
    }
    for (const rel of [
      'index.ts',
      'metrics.ts',
      'health.ts',
      'control-plane/control-plane-api.ts',
      'control-plane/index.ts',
      'routing/quota-ledger.ts',
      'routing/quota-exhaustion.ts',
      'security/audit-report.ts',
      'security/hardening.ts',
      'security/index.ts',
      'routing/capacity-router.ts',
      'routing/index.ts',
      'context/context-isolation.ts',
      'context/context-store.ts',
      'context/context-router.ts',
      'context/context-estimator.ts',
      'context/context-resolver.ts',
      'context/index.ts',
      'tasks/task-lifecycle.ts',
      'tasks/session-manager.ts',
      'tasks/command-api.ts',
      'tasks/index.ts',
      'capabilities/capability-broker.ts',
      'capabilities/index.ts',
      'attention/attention-item.ts',
      'attention/attention-inbox.ts',
      'attention/engine.ts',
      'attention/adaptive-policy.ts',
      'attention/attention-metrics.ts',
      'attention/attention-tuning.ts',
      'attention/completion-digest.ts',
      'attention/diff-digest.ts',
      'attention/digest-builder.ts',
      'attention/failure-tracker.ts',
      'attention/liveness-monitor.ts',
      'attention/attention-aggregator.ts',
      'attention/diff-analyzer.ts',
      'attention/index.ts',
      'secretary/messages.ts',
      'secretary/tool-registry.ts',
      'secretary/todo-tool.ts',
      'secretary/condenser.ts',
      'secretary/loop.ts',
      'secretary/preference-tool.ts',
      'secretary/index.ts',
      'voice/voice-pipeline.ts',
      'voice/response-parser.ts',
      'voice/voice-approver.ts',
      'voice/approval-router.ts',
      'voice/index.ts',
    ]) {
      expect(
        fs.existsSync(path.join(CORE_DIR, 'application', 'use-cases', rel)),
        `missing src/core/application/use-cases/${rel}`,
      ).toBe(true);
    }
  });

  it('every src/core module only imports inward (domain <- ports/use-cases, no externals)', () => {
    expect(coreFiles.length).toBeGreaterThan(0);
    expect(coreViolations).toEqual([]);
  });

  it('every use-case file is covered by the core edge scanner with no outward imports', () => {
    const useCaseFiles = coreFiles.filter((fileAbs) =>
      toRelPosix(fileAbs).startsWith('src/core/application/use-cases/'),
    );
    expect(useCaseFiles.length).toBeGreaterThan(0);
    for (const fileAbs of useCaseFiles) {
      expect(coreLayerOf(toRelPosix(fileAbs))).toBe('use-cases');
    }
    const violations = useCaseFiles.flatMap(collectEdges).flatMap((edge) => {
      const violation = coreEdgeViolation(edge);
      return violation === null ? [] : [violation];
    });
    expect(violations).toEqual([]);
  });

  it('flags Node.js global references but not names, strings, or comments', () => {
    const flagged = collectForbiddenGlobalRefs(
      [
        `const buf = Buffer.from('x');`,
        `const env = process.env.HOME;`,
        `let t: NodeJS.Timeout;`,
        `const mod = require(name);`,
        `const dir = __dirname;`,
        `const file = __filename;`,
      ].join('\n'),
    );
    expect(flagged.sort()).toEqual([
      'Buffer',
      'NodeJS',
      '__dirname',
      '__filename',
      'process',
      'require',
    ]);

    const clean = collectForbiddenGlobalRefs(
      [
        `// process and Buffer are mentioned in comments`,
        `const s = 'Buffer process NodeJS __dirname require';`,
        `const o = { process: 1, Buffer: 2 };`,
        `const p = cfg.process;`,
        `function f(require_: string): void {}`,
        `type T = { NodeJS: number };`,
      ].join('\n'),
    );
    expect(clean).toEqual([]);
  });

  it('no src/core module references Node.js globals', () => {
    const violations = coreFiles.flatMap((fileAbs) => {
      const rel = toRelPosix(fileAbs);
      const text = fs.readFileSync(fileAbs, 'utf8');
      return collectForbiddenGlobalRefs(text, rel).map(
        (name) => `${rel} -> forbidden global ${name}`,
      );
    });
    expect(violations).toEqual([]);
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
    const violations = legacyFiles.flatMap((f) => facadeViolations(f, 'src/core/domain/'));
    expect(violations).toEqual([]);
  });
});

describe('migrated use-case compatibility facades', () => {
  const MIGRATED_FACADES = [
    'src/daemon/quota-ledger.ts',
    'src/daemon/capacity-router.ts',
    'src/daemon/context-isolation.ts',
    'src/daemon/context-store.ts',
    'src/daemon/metrics.ts',
    'src/attention/attention-item.ts',
    'src/attention/attention-inbox.ts',
    'src/attention/engine.ts',
    'src/attention/adaptive-policy.ts',
    'src/attention/attention-metrics.ts',
    'src/attention/attention-tuning.ts',
    'src/attention/completion-digest.ts',
    'src/attention/diff-digest.ts',
    'src/attention/digest-builder.ts',
    'src/attention/failure-tracker.ts',
    'src/attention/liveness-monitor.ts',
    'src/attention/attention-aggregator.ts',
    'src/secretary/messages.ts',
    'src/secretary/tool-registry.ts',
    'src/secretary/todo-tool.ts',
    'src/secretary/condenser.ts',
    'src/secretary/loop.ts',
    'src/secretary/preference-tool.ts',
    'src/daemon/task-lifecycle.ts',
    'src/daemon/session-manager.ts',
    'src/daemon/command-api.ts',
    'src/daemon/api.ts',
    'src/daemon/health.ts',
    'src/daemon/capability-broker.ts',
    'src/storage/context-estimator.ts',
    'src/storage/context-resolver.ts',
    'src/security/audit-report.ts',
    'src/security/hardening.ts',
    'src/voice/voice-pipeline.ts',
    'src/voice/response-parser.ts',
    'src/voice/voice-approver.ts',
    'src/voice/approval-router.ts',
  ];

  it('each migrated legacy file is a facade into src/core/application/use-cases', () => {
    const violations = MIGRATED_FACADES.flatMap((rel) =>
      facadeViolations(path.join(REPO_ROOT, rel), 'src/core/application/use-cases/'),
    );
    expect(violations).toEqual([]);
  });

  it('legacy context-router is a compatibility wrapper: factory plus re-exports only', () => {
    const fileAbs = path.join(SRC_DIR, 'daemon', 'context-router.ts');
    const text = fs.readFileSync(fileAbs, 'utf8');
    const sourceFile = ts.createSourceFile(fileAbs, text, ts.ScriptTarget.Latest, true);
    const violations: string[] = [];
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement)) {
        // Allowed: only the concrete createContextRouter(ContextCapsuleRepository)
        // compatibility factory — its parameter type keeps it outside core.
        if (statement.name?.text !== 'createContextRouter') {
          violations.push(
            `${toRelPosix(fileAbs)}: only a createContextRouter function declaration is allowed`,
          );
        }
        continue;
      }
      if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier;
        if (specifier === undefined || !ts.isStringLiteral(specifier)) {
          continue;
        }
        const resolved = resolveSpecifier(fileAbs, specifier.text);
        if (resolved === null) {
          violations.push(
            `${toRelPosix(fileAbs)} -> ${specifier.text} (unresolvable module specifier)`,
          );
          continue;
        }
        const targetRel = toRelPosix(resolved);
        const allowed =
          targetRel.startsWith('src/core/application/use-cases/') ||
          (ts.isImportDeclaration(statement) && targetRel.startsWith('src/storage/'));
        if (!allowed) {
          violations.push(
            `${toRelPosix(fileAbs)} -> ${targetRel} (wrapper may only reach use-cases` +
              ' and the concrete ContextCapsuleRepository)',
          );
        }
        continue;
      }
      violations.push(
        `${toRelPosix(fileAbs)}: expected factory + re-exports only, found another statement`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('outbound implementations import the core ports they satisfy directly', () => {
    const expectations: Readonly<Record<string, readonly string[]>> = {
      'src/adapters/outbound/persistence/sqlite/repositories/task.ts': [
        'src/core/application/ports/outbound/repositories.ts',
      ],
      'src/adapters/outbound/persistence/sqlite/repositories/event.ts': [
        'src/core/application/ports/outbound/repositories.ts',
      ],
      'src/adapters/outbound/persistence/sqlite/repositories/approval.ts': [
        'src/core/application/ports/outbound/repositories.ts',
      ],
      'src/adapters/outbound/persistence/sqlite/repositories/session.ts': [
        'src/core/application/ports/outbound/repositories.ts',
      ],
      'src/adapters/outbound/persistence/sqlite/repositories/context-capsule.ts': [
        'src/core/application/ports/outbound/repositories.ts',
      ],
      'src/adapters/outbound/persistence/sqlite/repositories/decision.ts': [
        'src/core/application/ports/outbound/repositories.ts',
      ],
      'src/adapters/outbound/persistence/sqlite/repositories/completion-digest.ts': [
        'src/core/application/ports/outbound/repositories.ts',
      ],
      'src/adapters/outbound/persistence/sqlite/repositories/project.ts': [
        'src/core/application/ports/outbound/repositories.ts',
      ],
      'src/adapters/outbound/persistence/sqlite/repositories/attention-item.ts': [
        'src/core/application/ports/outbound/repositories.ts',
      ],
      'src/adapters/outbound/persistence/sqlite/repositories/deliverable.ts': [
        'src/core/application/ports/outbound/repositories.ts',
      ],
      'src/adapters/outbound/persistence/sqlite/database.ts': [
        'src/core/application/ports/outbound/health.ts',
      ],
      'src/adapters/outbound/credentials/os-credential-vault.ts': [
        'src/core/application/ports/outbound/credential-vault.ts',
      ],
      'src/adapters/outbound/model/litellm-connector.ts': [
        'src/core/application/ports/outbound/model.ts',
      ],
      'src/adapters/outbound/preferences/json-preference-profile.ts': [
        'src/core/application/ports/outbound/preference-profile.ts',
      ],
      'src/adapters/outbound/quota/quota-readers.ts': [
        'src/core/application/ports/outbound/quota-reader.ts',
      ],
      'src/adapters/outbound/events/in-memory-event-bus.ts': [
        'src/core/application/ports/outbound/event-stream.ts',
      ],
      'src/adapters/outbound/voice/realtime-bridge.ts': [
        'src/core/application/ports/outbound/voice.ts',
      ],
      'src/adapters/outbound/voice/whisper-adapter.ts': [
        'src/core/application/ports/outbound/voice.ts',
      ],
      'src/adapters/outbound/voice/stdin-audio-transport.ts': [
        'src/core/application/ports/outbound/voice.ts',
      ],
      // The core voice pipeline orchestrates ports only — it must import
      // the voice port and nothing outside src/core.
      'src/core/application/use-cases/voice/voice-pipeline.ts': [
        'src/core/application/ports/outbound/voice.ts',
      ],
      'src/core/application/use-cases/voice/approval-router.ts': [
        'src/core/application/ports/outbound/event-stream.ts',
      ],
      'src/adapters/outbound/security/filesystem-security-auditor.ts': [
        'src/core/application/use-cases/security/audit-report.ts',
      ],
      // The canonical inbound event stream keeps the WebSocket transport but
      // must depend on the subscriber port, never a concrete bus.
      'src/adapters/inbound/websocket/event-stream.ts': [
        'src/core/application/ports/outbound/event-stream.ts',
      ],
      // The inbound WebSocket control-plane server routes envelopes to the
      // core use cases only — no storage or outbound imports.
      'src/adapters/inbound/websocket/control-plane-server.ts': [
        'src/core/application/use-cases/control-plane/control-plane-api.ts',
        'src/core/application/use-cases/tasks/command-api.ts',
        'src/adapters/inbound/websocket/event-stream.ts',
      ],
      // The CLI adapter family speaks the typed command API and renders
      // core snapshots — never daemon/storage facades.
      'src/adapters/inbound/cli/client.ts': ['src/core/application/use-cases/tasks/command-api.ts'],
      'src/adapters/inbound/cli/formatters.ts': [
        'src/core/application/use-cases/tasks/command-api.ts',
        'src/core/application/use-cases/metrics.ts',
        'src/core/application/use-cases/attention/completion-digest.ts',
      ],
      'src/adapters/inbound/cli/cli.ts': [
        'src/core/application/use-cases/tasks/command-api.ts',
        'src/core/domain/enums.ts',
      ],
      // The inbound voice surface translates model tool calls into typed
      // commands and drives the engine through the session port only.
      'src/adapters/inbound/voice/voice-tools.ts': [
        'src/core/application/use-cases/tasks/command-api.ts',
        'src/core/application/ports/outbound/voice.ts',
      ],
      'src/adapters/inbound/voice/voice-session-manager.ts': [
        'src/core/application/ports/outbound/voice.ts',
        'src/core/application/use-cases/tasks/command-api.ts',
        'src/core/application/use-cases/voice/voice-pipeline.ts',
      ],
      // The core control-plane and health use cases talk to ports only.
      'src/core/application/use-cases/control-plane/control-plane-api.ts': [
        'src/core/application/ports/outbound/repositories.ts',
        'src/core/application/ports/outbound/event-stream.ts',
      ],
      'src/core/application/use-cases/health.ts': [
        'src/core/application/ports/outbound/health.ts',
        'src/core/application/ports/outbound/event-stream.ts',
      ],
      'src/adapters/outbound/git/node-git-client.ts': [
        'src/core/application/ports/outbound/git-client.ts',
      ],
      'src/adapters/outbound/git/worktree-manager.ts': [
        'src/core/application/ports/outbound/worktree.ts',
      ],
      'src/adapters/outbound/agents/registry.ts': [
        'src/core/application/ports/outbound/agent-runtime.ts',
        'src/core/application/ports/outbound/runtime-registry.ts',
      ],
      'src/adapters/outbound/agents/base.ts': [
        'src/core/application/ports/outbound/agent-runtime.ts',
        'src/core/application/ports/outbound/event-stream.ts',
      ],
      // The legacy worktree wrapper still satisfies the core worktree port
      // through the canonical adapter and retains the TaskRepository seam.
      'src/daemon/worktree.ts': [
        'src/core/application/ports/outbound/worktree.ts',
        'src/adapters/outbound/git/worktree-manager.ts',
      ],
    };
    const violations: string[] = [];
    for (const [rel, requiredTargets] of Object.entries(expectations)) {
      const edges = collectEdges(path.join(REPO_ROOT, rel));
      for (const target of requiredTargets) {
        if (!edges.some((e) => e.target === target)) {
          violations.push(`${rel} must directly import ${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('adapter registry imports neither the daemon EventBus nor the event-stream port', () => {
    const edges = collectEdges(path.join(SRC_DIR, 'adapters', 'outbound', 'agents', 'registry.ts'));
    expect(
      edges.every(
        (e) =>
          e.target !== 'src/daemon/event-stream.ts' &&
          e.target !== 'src/core/application/ports/outbound/event-stream.ts',
      ),
      'src/adapters/outbound/agents/registry.ts must not import an event bus: ' +
        'adapters are created without one and the session manager publishes ' +
        'streamed events',
    ).toBe(true);
  });

  it('daemon event-stream no longer owns the EventBus implementation', () => {
    const edges = collectEdges(path.join(SRC_DIR, 'daemon', 'event-stream.ts'));
    expect(
      edges.every((e) => e.specifier !== 'node:events'),
      'src/daemon/event-stream.ts must not import node:events — the ' +
        'EventEmitter-backed EventBus moved to src/adapters/outbound/events',
    ).toBe(true);
  });
});

describe('src/adapters/outbound tree', () => {
  const OUTBOUND_EXPECTED: readonly string[] = [
    // SQLite persistence adapter
    'persistence/sqlite/database.ts',
    'persistence/sqlite/migrations.ts',
    'persistence/sqlite/schema.ts',
    'persistence/sqlite/index.ts',
    'persistence/sqlite/repositories/agent.ts',
    'persistence/sqlite/repositories/approval.ts',
    'persistence/sqlite/repositories/attention-item.ts',
    'persistence/sqlite/repositories/base.ts',
    'persistence/sqlite/repositories/completion-digest.ts',
    'persistence/sqlite/repositories/context-capsule.ts',
    'persistence/sqlite/repositories/decision.ts',
    'persistence/sqlite/repositories/deliverable.ts',
    'persistence/sqlite/repositories/event.ts',
    'persistence/sqlite/repositories/metrics.ts',
    'persistence/sqlite/repositories/project.ts',
    'persistence/sqlite/repositories/session.ts',
    'persistence/sqlite/repositories/task.ts',
    'persistence/sqlite/repositories/index.ts',
    // Provider runtime adapters
    'agents/base.ts',
    'agents/registry.ts',
    'agents/codex-adapter.ts',
    'agents/codex-mapper.ts',
    'agents/claude-adapter.ts',
    'agents/claude-hooks-adapter.ts',
    'agents/claude-hooks-mapper.ts',
    'agents/claude-mapper.ts',
    'agents/acp-adapter.ts',
    'agents/agy-adapter.ts',
    'agents/stub-adapter.ts',
    'agents/index.ts',
    // Quota observation readers
    'quota/quota-readers.ts',
    'quota/index.ts',
    // File-backed preference profile adapter
    'preferences/json-preference-profile.ts',
    'preferences/index.ts',
    // OS credential vault adapter
    'credentials/os-credential-vault.ts',
    'credentials/index.ts',
    // LiteLLM model connector adapter
    'model/litellm-connector.ts',
    'model/index.ts',
    // Git adapters (worktree + diff intelligence)
    'git/node-git-client.ts',
    'git/diff-analyzer.ts',
    'git/worktree-manager.ts',
    'git/index.ts',
    // Voice adapters (realtime + whisper + stdio audio transport)
    'voice/realtime-message.ts',
    'voice/realtime-bridge.ts',
    'voice/whisper-backend.ts',
    'voice/whisper-adapter.ts',
    'voice/stdin-audio-transport.ts',
    'voice/index.ts',
    // In-memory event bus adapter
    'events/in-memory-event-bus.ts',
    'events/index.ts',
    // Security auditor adapter
    'security/filesystem-security-auditor.ts',
    'security/index.ts',
    // Outbound barrel
    'index.ts',
  ];

  it('the expected outbound adapter tree exists', () => {
    const missing = OUTBOUND_EXPECTED.filter(
      (rel) => !fs.existsSync(path.join(SRC_DIR, 'adapters', 'outbound', rel)),
    );
    expect(missing).toEqual([]);
  });
});

describe('src/adapters/outbound boundary conformance', () => {
  it('outbound edge classification allows core, same adapter family, node, and packages', () => {
    const legal: readonly ImportEdge[] = [
      {
        source: 'src/adapters/outbound/agents/stub-adapter.ts',
        specifier: '../../../core/domain/events.js',
        target: 'src/core/domain/events.ts',
      },
      {
        source: 'src/adapters/outbound/agents/stub-adapter.ts',
        specifier: './base.js',
        target: 'src/adapters/outbound/agents/base.ts',
      },
      {
        source: 'src/adapters/outbound/git/diff-analyzer.ts',
        specifier: './node-git-client.js',
        target: 'src/adapters/outbound/git/node-git-client.ts',
      },
      {
        source: 'src/adapters/outbound/git/node-git-client.ts',
        specifier: 'node:child_process',
        target: null,
      },
      {
        source: 'src/adapters/outbound/persistence/sqlite/database.ts',
        specifier: 'better-sqlite3',
        target: null,
      },
    ];
    for (const edge of legal) {
      expect(outboundEdgeViolation(edge)).toBeNull();
    }
  });

  it('outbound edge classification rejects legacy, inbound, and bootstrap edges', () => {
    const illegal: readonly ImportEdge[] = [
      {
        source: 'src/adapters/outbound/agents/stub-adapter.ts',
        specifier: '../../daemon/event-stream.js',
        target: 'src/daemon/event-stream.ts',
      },
      {
        source: 'src/adapters/outbound/persistence/sqlite/repositories/task.ts',
        specifier: '../../../storage/schema.js',
        target: 'src/storage/schema.ts',
      },
      {
        source: 'src/adapters/outbound/agents/stub-adapter.ts',
        specifier: '../base.js',
        target: 'src/adapters/base.ts',
      },
      {
        source: 'src/adapters/outbound/git/diff-analyzer.ts',
        specifier: '../../attention/diff-digest.js',
        target: 'src/attention/diff-digest.ts',
      },
      {
        source: 'src/adapters/outbound/agents/base.ts',
        specifier: '../../bootstrap/index.js',
        target: 'src/bootstrap/index.ts',
      },
      {
        source: 'src/adapters/outbound/agents/base.ts',
        specifier: '../inbound/x.js',
        target: 'src/adapters/inbound/x.ts',
      },
      {
        // Cross-family import: agents must not reach into git (or any
        // other adapter family) — families stay isolated behind their
        // own barrels.
        source: 'src/adapters/outbound/agents/stub-adapter.ts',
        specifier: '../git/node-git-client.js',
        target: 'src/adapters/outbound/git/node-git-client.ts',
      },
      {
        // The root barrel may only import family barrels, not
        // implementation files.
        source: 'src/adapters/outbound/index.ts',
        specifier: './git/node-git-client.js',
        target: 'src/adapters/outbound/git/node-git-client.ts',
      },
      {
        source: 'src/adapters/outbound/git/worktree-manager.ts',
        specifier: '../../does-not-exist.js',
        target: null,
      },
    ];
    for (const edge of illegal) {
      expect(outboundEdgeViolation(edge)).not.toBeNull();
    }
    // Non-outbound sources are never flagged by the outbound rule.
    expect(
      outboundEdgeViolation({
        source: 'src/daemon/daemon.ts',
        specifier: '../storage/index.js',
        target: 'src/storage/index.ts',
      }),
    ).toBeNull();
  });

  it('no file under src/adapters/outbound imports outside core or its same adapter family', () => {
    const outboundDir = path.join(SRC_DIR, 'adapters', 'outbound');
    const outboundFiles = listTsFiles(outboundDir);
    expect(outboundFiles.length).toBeGreaterThan(0);
    const violations = outboundFiles
      .flatMap((f) => collectEdges(f))
      .map(outboundEdgeViolation)
      .filter((v): v is string => v !== null);
    expect(violations).toEqual([]);
  });
});

describe('migrated outbound compatibility facades', () => {
  const OUTBOUND_FACADES: readonly string[] = [
    // SQLite persistence facades
    'src/storage/database.ts',
    'src/storage/migrations.ts',
    'src/storage/schema.ts',
    'src/storage/repositories/agent.ts',
    'src/storage/repositories/approval.ts',
    'src/storage/repositories/attention-item.ts',
    'src/storage/repositories/base.ts',
    'src/storage/repositories/completion-digest.ts',
    'src/storage/repositories/context-capsule.ts',
    'src/storage/repositories/decision.ts',
    'src/storage/repositories/deliverable.ts',
    'src/storage/repositories/event.ts',
    'src/storage/repositories/metrics.ts',
    'src/storage/repositories/project.ts',
    'src/storage/repositories/session.ts',
    'src/storage/repositories/task.ts',
    'src/storage/repositories/index.ts',
    // Provider runtime adapter facades
    'src/adapters/base.ts',
    'src/adapters/registry.ts',
    'src/adapters/codex-adapter.ts',
    'src/adapters/codex-mapper.ts',
    'src/adapters/claude-adapter.ts',
    'src/adapters/claude-hooks-adapter.ts',
    'src/adapters/claude-hooks-mapper.ts',
    'src/adapters/claude-mapper.ts',
    'src/adapters/acp-adapter.ts',
    'src/adapters/agy-adapter.ts',
    'src/adapters/stub-adapter.ts',
    'src/adapters/quota-readers.ts',
    // Preference + credential + model facades
    'src/daemon/preference-profile.ts',
    'src/daemon/credential-broker.ts',
    'src/secretary/model-connector.ts',
    // Diff analyzer facade
    'src/attention/diff-analyzer.ts',
    // Voice adapter facades
    'src/voice/realtime-message.ts',
    'src/voice/realtime-bridge.ts',
    'src/voice/whisper-backend.ts',
    'src/voice/whisper-adapter.ts',
    'src/voice/stdin-audio-transport.ts',
    // Security auditor facade
    'src/security/auditors.ts',
  ];

  it('each moved implementation file is a facade into src/adapters/outbound', () => {
    const violations = OUTBOUND_FACADES.flatMap((rel) =>
      facadeViolations(path.join(REPO_ROOT, rel), 'src/adapters/outbound/'),
    );
    expect(violations).toEqual([]);
  });

  it('voice/audio-types.ts is a facade into the core voice port', () => {
    // The provider-neutral voice data/device contract lives in
    // `src/core/application/ports/outbound/voice.ts` (issue #92).
    expect(
      facadeViolations(
        path.join(REPO_ROOT, 'src/voice/audio-types.ts'),
        'src/core/application/ports/outbound/',
      ),
    ).toEqual([]);
  });

  it('daemon/worktree.ts is a compatibility wrapper, not a pure facade', () => {
    // Allowed statements: imports/exports resolving to src/core or
    // src/adapters/outbound (plus the TaskRepository storage seam), class and
    // interface declarations for WorktreeManager/WorktreeManagerOptions.
    expect(
      wrapperViolations(path.join(SRC_DIR, 'daemon', 'worktree.ts'), {
        allowedImportPrefixes: ['src/core/', 'src/adapters/outbound/', 'src/storage/'],
        allowedExportPrefixes: ['src/core/', 'src/adapters/outbound/'],
        allowClasses: true,
      }),
    ).toEqual([]);
  });
});

const INBOUND_PREFIX = 'src/adapters/inbound/';
const INBOUND_ROOT_BARREL = 'src/adapters/inbound/index.ts';

/** The adapter family of a path: first segment after `src/adapters/inbound/`. */
function inboundFamily(relPath: string): string {
  return relPath.slice(INBOUND_PREFIX.length).split('/')[0] ?? '';
}

/**
 * Evaluate one import edge for a file under `src/adapters/inbound`.
 * Inbound adapters may import `src/core/**`, siblings inside the same
 * adapter family, node builtins, and external packages — nothing else (no
 * outbound adapters, bootstrap composition, legacy paths, or other adapter
 * families). `src/adapters/inbound/index.ts` is the only root barrel and
 * may additionally import each family's `index.ts`.
 */
function inboundEdgeViolation(edge: ImportEdge): string | null {
  if (!edge.source.startsWith(INBOUND_PREFIX)) {
    return null;
  }
  if (!isRelativeSpecifier(edge.specifier)) {
    return null; // node builtin or external package — allowed in adapters
  }
  if (edge.target === null) {
    return `${edge.source} -> ${edge.specifier} (unresolvable module specifier)`;
  }
  if (edge.target.startsWith('src/core/')) {
    return null;
  }
  if (!edge.target.startsWith(INBOUND_PREFIX)) {
    return (
      `${edge.source} -> ${edge.target} ` +
      '(inbound adapters may only import src/core or their same adapter family)'
    );
  }
  if (edge.source === INBOUND_ROOT_BARREL) {
    return edge.target.endsWith('/index.ts')
      ? null
      : `${edge.source} -> ${edge.target} (the root barrel may only import family barrels)`;
  }
  if (inboundFamily(edge.source) === inboundFamily(edge.target)) {
    return null;
  }
  return (
    `${edge.source} -> ${edge.target} ` +
    '(cross-family import: inbound adapters may only import src/core or ' +
    'their same adapter family)'
  );
}

describe('src/adapters/inbound tree', () => {
  const INBOUND_EXPECTED: readonly string[] = [
    // Desktop inbound adapter family
    'desktop/desktop-app.ts',
    'desktop/hotkeys.ts',
    'desktop/ipc-bridge.ts',
    'desktop/keyboard-nav.ts',
    'desktop/renderer-state.ts',
    'desktop/system-tray.ts',
    'desktop/window-backend.ts',
    'desktop/index.ts',
    'desktop/views/approval-card.ts',
    'desktop/views/approval-templates.ts',
    'desktop/views/approval-types.ts',
    'desktop/views/diff-view.ts',
    'desktop/views/digest-diff-templates.ts',
    'desktop/views/digest-diff-types.ts',
    'desktop/views/digest-diff-viewer.ts',
    'desktop/views/digest-templates.ts',
    'desktop/views/digest-types.ts',
    'desktop/views/digest-view.ts',
    'desktop/views/inbox-templates.ts',
    'desktop/views/inbox-view.ts',
    'desktop/views/ptt-hud.ts',
    'desktop/views/ptt-templates.ts',
    'desktop/views/view-types.ts',
    // WebSocket inbound adapter family (event stream + control-plane server)
    'websocket/event-stream.ts',
    'websocket/control-plane-server.ts',
    'websocket/index.ts',
    // CLI inbound adapter family (secretary/asec binary surface)
    'cli/client.ts',
    'cli/formatters.ts',
    'cli/deps.ts',
    'cli/cli.ts',
    'cli/index.ts',
    // Voice inbound adapter family (session manager + tool mapping)
    'voice/voice-tools.ts',
    'voice/voice-session-manager.ts',
    'voice/index.ts',
    // MCP inbound adapter family (manager tool server, DEC-018, issue #63)
    'mcp/secretary-mcp-server.ts',
    'mcp/index.ts',
    // Inbound barrel
    'index.ts',
  ];

  it('the expected inbound adapter tree exists', () => {
    const missing = INBOUND_EXPECTED.filter(
      (rel) => !fs.existsSync(path.join(SRC_DIR, 'adapters', 'inbound', rel)),
    );
    expect(missing).toEqual([]);
  });
});

describe('src/adapters/inbound boundary conformance', () => {
  it('inbound edge classification allows core, same adapter family, node, and packages', () => {
    const legal: readonly ImportEdge[] = [
      {
        source: 'src/adapters/inbound/desktop/desktop-app.ts',
        specifier: '../../../core/application/use-cases/tasks/command-api.js',
        target: 'src/core/application/use-cases/tasks/command-api.ts',
      },
      {
        source: 'src/adapters/inbound/desktop/desktop-app.ts',
        specifier: './renderer-state.js',
        target: 'src/adapters/inbound/desktop/renderer-state.ts',
      },
      {
        source: 'src/adapters/inbound/desktop/views/inbox-view.ts',
        specifier: '../desktop-app.js',
        target: 'src/adapters/inbound/desktop/desktop-app.ts',
      },
      {
        source: 'src/adapters/inbound/desktop/ipc-bridge.ts',
        specifier: 'node:events',
        target: null,
      },
      {
        source: 'src/adapters/inbound/desktop/ipc-bridge.ts',
        specifier: 'ws',
        target: null,
      },
      {
        source: 'src/adapters/inbound/index.ts',
        specifier: './desktop/index.js',
        target: 'src/adapters/inbound/desktop/index.ts',
      },
    ];
    for (const edge of legal) {
      expect(inboundEdgeViolation(edge)).toBeNull();
    }
  });

  it('inbound edge classification rejects outbound, bootstrap, legacy, and cross-family edges', () => {
    const illegal: readonly ImportEdge[] = [
      {
        source: 'src/adapters/inbound/desktop/desktop-app.ts',
        specifier: '../../outbound/events/in-memory-event-bus.js',
        target: 'src/adapters/outbound/events/in-memory-event-bus.ts',
      },
      {
        source: 'src/adapters/inbound/desktop/desktop-app.ts',
        specifier: '../../bootstrap/index.js',
        target: 'src/bootstrap/index.ts',
      },
      {
        source: 'src/adapters/inbound/desktop/desktop-app.ts',
        specifier: '../../daemon/command-api.js',
        target: 'src/daemon/command-api.ts',
      },
      {
        // Cross-family import: desktop must not reach into another inbound
        // family — concrete combinations happen in bootstrap.
        source: 'src/adapters/inbound/desktop/ptt-hud.ts',
        specifier: '../voice/realtime-bridge.js',
        target: 'src/adapters/inbound/voice/realtime-bridge.ts',
      },
      {
        // The root barrel may only import family barrels.
        source: 'src/adapters/inbound/index.ts',
        specifier: './desktop/desktop-app.js',
        target: 'src/adapters/inbound/desktop/desktop-app.ts',
      },
      {
        source: 'src/adapters/inbound/desktop/desktop-app.ts',
        specifier: './does-not-exist.js',
        target: null,
      },
    ];
    for (const edge of illegal) {
      expect(inboundEdgeViolation(edge)).not.toBeNull();
    }
    // Non-inbound sources are never flagged by the inbound rule.
    expect(
      inboundEdgeViolation({
        source: 'src/daemon/daemon.ts',
        specifier: '../storage/index.js',
        target: 'src/storage/index.ts',
      }),
    ).toBeNull();
  });

  it('no file under src/adapters/inbound imports outside core or its same adapter family', () => {
    const inboundDir = path.join(SRC_DIR, 'adapters', 'inbound');
    const inboundFiles = listTsFiles(inboundDir);
    expect(inboundFiles.length).toBeGreaterThan(0);
    const violations = inboundFiles
      .flatMap((f) => collectEdges(f))
      .map(inboundEdgeViolation)
      .filter((v): v is string => v !== null);
    expect(violations).toEqual([]);
  });
});

describe('migrated inbound compatibility facades', () => {
  const INBOUND_FACADES: readonly string[] = [
    'src/desktop/desktop-app.ts',
    'src/desktop/hotkeys.ts',
    'src/desktop/index.ts',
    'src/desktop/ipc-bridge.ts',
    'src/desktop/keyboard-nav.ts',
    'src/desktop/renderer-state.ts',
    'src/desktop/system-tray.ts',
    'src/desktop/window-backend.ts',
    'src/desktop/views/approval-card.ts',
    'src/desktop/views/approval-templates.ts',
    'src/desktop/views/approval-types.ts',
    'src/desktop/views/diff-view.ts',
    'src/desktop/views/digest-diff-templates.ts',
    'src/desktop/views/digest-diff-types.ts',
    'src/desktop/views/digest-diff-viewer.ts',
    'src/desktop/views/digest-templates.ts',
    'src/desktop/views/digest-types.ts',
    'src/desktop/views/digest-view.ts',
    'src/desktop/views/inbox-templates.ts',
    'src/desktop/views/inbox-view.ts',
    'src/desktop/views/ptt-hud.ts',
    'src/desktop/views/ptt-templates.ts',
    'src/desktop/views/view-types.ts',
    // CLI + voice-session legacy surfaces
    'src/cli/client.ts',
    'src/cli/formatters.ts',
    'src/daemon/voice-session-manager.ts',
  ];

  it('each moved desktop file is a facade into src/adapters/inbound', () => {
    const violations = INBOUND_FACADES.flatMap((rel) =>
      facadeViolations(path.join(REPO_ROOT, rel), 'src/adapters/inbound/'),
    );
    expect(violations).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Bootstrap composition root (issue #93 sub-slice B)
 * ------------------------------------------------------------------ */

const BOOTSTRAP_PREFIX = 'src/bootstrap/';

/**
 * Evaluate one import edge for a file under `src/bootstrap`. The composition
 * root is the ONLY place concrete inbound and outbound adapters are combined
 * with core use cases. It may import `src/core/**`, canonical
 * `src/adapters/inbound/**` / `src/adapters/outbound/**` families, other
 * bootstrap files, node builtins, and external packages — never a legacy
 * facade path (`src/daemon`, `src/storage`, `src/attention`, `src/secretary`,
 * `src/voice`, `src/desktop`, `src/domain`, or old top-level `src/adapters/*`
 * provider facades).
 */
function bootstrapEdgeViolation(edge: ImportEdge): string | null {
  if (!edge.source.startsWith(BOOTSTRAP_PREFIX)) {
    return null;
  }
  if (!isRelativeSpecifier(edge.specifier)) {
    return null; // node builtin or external package — allowed in bootstrap
  }
  if (edge.target === null) {
    return `${edge.source} -> ${edge.specifier} (unresolvable module specifier)`;
  }
  const allowed =
    edge.target.startsWith('src/core/') ||
    edge.target.startsWith('src/adapters/inbound/') ||
    edge.target.startsWith('src/adapters/outbound/') ||
    edge.target.startsWith(BOOTSTRAP_PREFIX);
  if (allowed) {
    return null;
  }
  return (
    `${edge.source} -> ${edge.target} ` +
    '(bootstrap may only import src/core, canonical adapter families, or ' +
    'other bootstrap files — never legacy facade paths)'
  );
}

describe('src/bootstrap composition root', () => {
  const BOOTSTRAP_EXPECTED: readonly string[] = [
    'daemon.ts',
    'daemon-runner.ts',
    'cli.ts',
    'voice-session.ts',
    'index.ts',
  ];

  it('the expected bootstrap tree exists', () => {
    const missing = BOOTSTRAP_EXPECTED.filter(
      (rel) => !fs.existsSync(path.join(SRC_DIR, 'bootstrap', rel)),
    );
    expect(missing).toEqual([]);
  });

  it('bootstrap edge classification allows core, canonical adapters, node, and packages', () => {
    const legal: readonly ImportEdge[] = [
      {
        source: 'src/bootstrap/daemon.ts',
        specifier: '../core/application/use-cases/health.js',
        target: 'src/core/application/use-cases/health.ts',
      },
      {
        source: 'src/bootstrap/daemon.ts',
        specifier: '../adapters/outbound/git/worktree-manager.js',
        target: 'src/adapters/outbound/git/worktree-manager.ts',
      },
      {
        source: 'src/bootstrap/daemon.ts',
        specifier: '../adapters/inbound/websocket/control-plane-server.js',
        target: 'src/adapters/inbound/websocket/control-plane-server.ts',
      },
      {
        source: 'src/bootstrap/daemon.ts',
        specifier: 'node:fs',
        target: null,
      },
      {
        source: 'src/bootstrap/daemon.ts',
        specifier: 'ws',
        target: null,
      },
      {
        source: 'src/bootstrap/index.ts',
        specifier: './daemon.js',
        target: 'src/bootstrap/daemon.ts',
      },
    ];
    for (const edge of legal) {
      expect(bootstrapEdgeViolation(edge)).toBeNull();
    }
  });

  it('bootstrap edge classification rejects legacy facade roots', () => {
    const illegal: readonly ImportEdge[] = [
      {
        source: 'src/bootstrap/daemon.ts',
        specifier: '../daemon/daemon.js',
        target: 'src/daemon/daemon.ts',
      },
      {
        source: 'src/bootstrap/daemon.ts',
        specifier: '../storage/index.js',
        target: 'src/storage/index.ts',
      },
      {
        source: 'src/bootstrap/daemon.ts',
        specifier: '../adapters/base.js',
        target: 'src/adapters/base.ts',
      },
      {
        source: 'src/bootstrap/daemon.ts',
        specifier: '../secretary/model-connector.js',
        target: 'src/secretary/model-connector.ts',
      },
      {
        source: 'src/bootstrap/daemon.ts',
        specifier: '../voice/index.js',
        target: 'src/voice/index.ts',
      },
      {
        source: 'src/bootstrap/daemon.ts',
        specifier: '../domain/types.js',
        target: 'src/domain/types.ts',
      },
      {
        source: 'src/bootstrap/daemon.ts',
        specifier: './does-not-exist.js',
        target: null,
      },
    ];
    for (const edge of illegal) {
      expect(bootstrapEdgeViolation(edge)).not.toBeNull();
    }
    // Non-bootstrap sources are never flagged by the bootstrap rule.
    expect(
      bootstrapEdgeViolation({
        source: 'src/daemon/daemon.ts',
        specifier: '../storage/index.js',
        target: 'src/storage/index.ts',
      }),
    ).toBeNull();
  });

  it('no file under src/bootstrap imports a legacy facade root', () => {
    const bootstrapDir = path.join(SRC_DIR, 'bootstrap');
    const bootstrapFiles = listTsFiles(bootstrapDir);
    expect(bootstrapFiles.length).toBeGreaterThan(0);
    const violations = bootstrapFiles
      .flatMap((f) => collectEdges(f))
      .map(bootstrapEdgeViolation)
      .filter((v): v is string => v !== null);
    expect(violations).toEqual([]);
  });

  it('bootstrap daemon composes canonical families directly', () => {
    const edges = collectEdges(path.join(SRC_DIR, 'bootstrap', 'daemon.ts'));
    const requiredTargets: readonly string[] = [
      // Core application use cases
      'src/core/application/use-cases/control-plane/control-plane-api.ts',
      'src/core/application/use-cases/health.ts',
      'src/core/application/use-cases/tasks/command-api.ts',
      'src/core/application/use-cases/tasks/session-manager.ts',
      'src/core/application/use-cases/tasks/task-lifecycle.ts',
      'src/core/application/use-cases/metrics.ts',
      'src/core/application/use-cases/attention/attention-inbox.ts',
      'src/core/application/use-cases/attention/attention-aggregator.ts',
      // Canonical outbound adapter families
      'src/adapters/outbound/persistence/sqlite/index.ts',
      'src/adapters/outbound/events/in-memory-event-bus.ts',
      'src/adapters/outbound/git/worktree-manager.ts',
      'src/adapters/outbound/agents/registry.ts',
      'src/adapters/outbound/agents/stub-adapter.ts',
      // Canonical inbound adapter family
      'src/adapters/inbound/websocket/event-stream.ts',
      'src/adapters/inbound/websocket/control-plane-server.ts',
    ];
    const violations: string[] = [];
    for (const target of requiredTargets) {
      if (!edges.some((e) => e.target === target)) {
        violations.push(`src/bootstrap/daemon.ts must directly import ${target}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('bootstrap daemon-runner composes the daemon process lifecycle', () => {
    const edges = collectEdges(path.join(SRC_DIR, 'bootstrap', 'daemon-runner.ts'));
    expect(
      edges.some((e) => e.target === 'src/bootstrap/daemon.ts'),
      'src/bootstrap/daemon-runner.ts must import the daemon composition root',
    ).toBe(true);
  });

  it('bootstrap cli composes the inbound CLI adapter with concrete services', () => {
    const edges = collectEdges(path.join(SRC_DIR, 'bootstrap', 'cli.ts'));
    const requiredTargets: readonly string[] = [
      'src/adapters/inbound/cli/cli.ts',
      'src/adapters/inbound/cli/client.ts',
      'src/bootstrap/daemon-runner.ts',
      'src/bootstrap/voice-session.ts',
    ];
    const violations: string[] = [];
    for (const target of requiredTargets) {
      if (!edges.some((e) => e.target === target)) {
        violations.push(`src/bootstrap/cli.ts must directly import ${target}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('bootstrap voice-session composes the inbound voice surface with outbound engines', () => {
    const edges = collectEdges(path.join(SRC_DIR, 'bootstrap', 'voice-session.ts'));
    const requiredTargets: readonly string[] = [
      'src/adapters/inbound/voice/voice-session-manager.ts',
      'src/adapters/outbound/voice/stdin-audio-transport.ts',
      'src/adapters/outbound/voice/realtime-bridge.ts',
      'src/adapters/outbound/voice/whisper-adapter.ts',
      'src/adapters/outbound/voice/whisper-backend.ts',
    ];
    const violations: string[] = [];
    for (const target of requiredTargets) {
      if (!edges.some((e) => e.target === target)) {
        violations.push(`src/bootstrap/voice-session.ts must directly import ${target}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('no orphan implementations outside the hexagonal zones', () => {
  /**
   * Every TypeScript file outside `src/core`, `src/adapters/inbound`,
   * `src/adapters/outbound`, and `src/bootstrap` must be a compatibility
   * facade or barrel — a module whose top-level statements are only
   * import/export declarations. The only exceptions are the sanctioned
   * wrappers below, each restricted to the listed statement kinds.
   *
   * This is the catch-all that makes "all of it" mechanically true: a new
   * implementation file outside the hexagonal zones fails CI unless it is
   * deliberately sanctioned here.
   */
  const SANCTIONED: Readonly<Record<string, readonly string[]>> = {
    // CLI bin entrypoint shim: re-exports plus one run-as-main guard.
    'src/cli/index.ts': ['IfStatement'],
    // Compatibility factory whose parameter type is the legacy storage
    // repository — cannot move into core.
    'src/daemon/context-router.ts': ['FunctionDeclaration'],
    // Compatibility wrapper combining the canonical git worktree adapter
    // with the legacy TaskRepository seam.
    'src/daemon/worktree.ts': ['InterfaceDeclaration', 'ClassDeclaration'],
    // Package VERSION stamp on the public root barrel — `FirstStatement` is
    // the SyntaxKind enum's first-member name for VariableStatement.
    'src/index.ts': ['FirstStatement'],
  };

  it('every legacy-zone file is a facade/barrel or a sanctioned exception', () => {
    const violations: string[] = [];
    const legacyFiles = listTsFiles(SRC_DIR).filter(
      (abs) =>
        !toRelPosix(abs).startsWith('src/core/') &&
        !toRelPosix(abs).startsWith(INBOUND_PREFIX) &&
        !toRelPosix(abs).startsWith(OUTBOUND_PREFIX) &&
        !toRelPosix(abs).startsWith(BOOTSTRAP_PREFIX),
    );
    expect(legacyFiles.length).toBeGreaterThan(0);

    for (const fileAbs of legacyFiles) {
      const rel = toRelPosix(fileAbs);
      const sanctioned = SANCTIONED[rel];
      const text = fs.readFileSync(fileAbs, 'utf8');
      const sourceFile = ts.createSourceFile(fileAbs, text, ts.ScriptTarget.Latest, true);
      for (const statement of sourceFile.statements) {
        if (
          ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement) ||
          ts.isImportEqualsDeclaration(statement)
        ) {
          continue;
        }
        const kind = ts.SyntaxKind[statement.kind];
        if (sanctioned !== undefined && sanctioned.includes(kind)) {
          continue;
        }
        violations.push(
          `${rel}: unexpected ${kind} — implementation code outside the ` +
            'hexagonal zones must live in src/core, src/adapters, or ' +
            'src/bootstrap (or be a sanctioned exception)',
        );
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('legacy CLI surfaces (issue #93)', () => {
  it('src/cli/daemon-runner.ts is a facade into the bootstrap composition root', () => {
    expect(
      facadeViolations(path.join(REPO_ROOT, 'src', 'cli', 'daemon-runner.ts'), 'src/bootstrap/'),
    ).toEqual([]);
  });

  it('src/cli/index.ts is an entrypoint shim: re-exports plus one run guard', () => {
    // The package.json `bin` entry stays at dist/cli/index.js. The shim may
    // only re-export the canonical CLI surface (inbound adapter + bootstrap
    // composition root + core types) and carry a single run-as-main guard
    // `if` statement. Everything else lives in canonical locations.
    const fileAbs = path.join(SRC_DIR, 'cli', 'index.ts');
    const text = fs.readFileSync(fileAbs, 'utf8');
    const sourceFile = ts.createSourceFile(fileAbs, text, ts.ScriptTarget.Latest, true);
    const violations: string[] = [];
    let ifCount = 0;
    for (const statement of sourceFile.statements) {
      if (ts.isIfStatement(statement)) {
        ifCount++;
        continue;
      }
      if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier;
        if (specifier === undefined || !ts.isStringLiteral(specifier)) {
          continue;
        }
        const resolved = resolveSpecifier(fileAbs, specifier.text);
        if (resolved === null) {
          violations.push(
            `${toRelPosix(fileAbs)} -> ${specifier.text} (unresolvable module specifier)`,
          );
          continue;
        }
        const targetRel = toRelPosix(resolved);
        const allowed =
          targetRel.startsWith('src/bootstrap/') ||
          targetRel.startsWith('src/adapters/inbound/') ||
          targetRel.startsWith('src/core/');
        if (!allowed) {
          violations.push(
            `${toRelPosix(fileAbs)} -> ${targetRel} (entry shim may only reach ` +
              'bootstrap, canonical inbound adapters, or core)',
          );
        }
        continue;
      }
      violations.push(
        `${toRelPosix(fileAbs)}: expected an entrypoint shim but found a ` + 'disallowed statement',
      );
    }
    if (ifCount !== 1) {
      violations.push(
        `${toRelPosix(fileAbs)}: expected exactly one run-as-main guard ` +
          `if-statement, found ${ifCount}`,
      );
    }
    expect(violations).toEqual([]);

    const edges = collectEdges(fileAbs);
    expect(
      edges.some((e) => e.target === 'src/bootstrap/cli.ts'),
      'src/cli/index.ts must delegate to the bootstrap CLI composition root',
    ).toBe(true);
  });
});

describe('legacy daemon facades (issue #93)', () => {
  it('src/daemon/daemon.ts is a facade into the bootstrap composition root', () => {
    expect(
      facadeViolations(path.join(REPO_ROOT, 'src/daemon/daemon.ts'), 'src/bootstrap/'),
    ).toEqual([]);
  });

  it('src/daemon/event-stream.ts is a pure barrel for the inbound stream and outbound bus', () => {
    // Allowed statements: re-export declarations only — the inbound
    // EventStream implementation and the outbound in-memory EventBus. No
    // imports, functions, classes, or other implementation statements.
    expect(
      wrapperViolations(path.join(SRC_DIR, 'daemon', 'event-stream.ts'), {
        allowedImportPrefixes: [],
        allowedExportPrefixes: ['src/adapters/inbound/websocket/', 'src/adapters/outbound/events/'],
      }),
    ).toEqual([]);
  });
});
