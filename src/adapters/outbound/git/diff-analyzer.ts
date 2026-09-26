/**
 * DiffAnalyzer — concrete outbound wrapper (issue #92).
 *
 * The deterministic diff-digest logic lives in the core attention use case
 * (`src/core/application/use-cases/attention/diff-analyzer.ts`); this
 * adapter supplies the Node {@link GitClientPort} so callers can keep
 * constructing `new DiffAnalyzer()` with no arguments.
 */
import type { GitClientPort } from '../../../core/application/ports/outbound/git-client.js';
import { DiffAnalyzer as CoreDiffAnalyzer } from '../../../core/application/use-cases/attention/diff-analyzer.js';
import { NodeGitClient } from './node-git-client.js';

/**
 * Deterministic {@link DiffAnalyzer} wired to the Node git client.
 * Behaviour is identical to the core analyzer; this subclass only supplies
 * the default {@link GitClientPort}.
 */
export class DiffAnalyzer extends CoreDiffAnalyzer {
  constructor(git: GitClientPort = new NodeGitClient()) {
    super(git);
  }
}

export {
  collectTestResults,
  SENSITIVE_CATEGORIES,
} from '../../../core/application/use-cases/attention/diff-analyzer.js';
