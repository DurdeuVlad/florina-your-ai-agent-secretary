/**
 * Manager MCP registration — the per-provider launch-config descriptor that
 * makes a manager agent's CLI aware of the Secretary tool server
 * (DEC-018, issue #63).
 *
 * A manager is spawned by a provider CLI; that CLI must be told where the
 * Secretary MCP server lives. {@link managerMcpRegistration} produces the
 * exact registration command for each supported provider so the launch
 * path (or the human) can run it verbatim — no guessing at flag shapes.
 */
/** One provider's MCP registration command. */
export interface McpRegistration {
  /** Provider id (matches adapter id). */
  readonly provider: string;
  /** The executable to run. */
  readonly command: string;
  /** Arguments for {@link command}. */
  readonly args: readonly string[];
  /** The MCP endpoint being registered. */
  readonly url: string;
  /** Project the manager is scoped to, if any. */
  readonly projectId?: string;
}

/** Providers with a known `mcp add` surface. */
export const MCP_CAPABLE_PROVIDERS: readonly string[] = [
  'claude-code',
  'codex',
  'gemini',
  'devin',
] as const;

/**
 * Build the registration command for `provider` pointing at `mcpUrl`.
 *
 * The project scope travels on the URL as `?project=<id>` so every tool
 * call the manager makes is resolved against its own project (DEC-003
 * isolation) — no side channel needed.
 */
export function managerMcpRegistration(
  provider: string,
  mcpUrl: string,
  projectId?: string,
): McpRegistration {
  const url =
    projectId !== undefined
      ? `${mcpUrl}${mcpUrl.includes('?') ? '&' : '?'}project=${encodeURIComponent(projectId)}`
      : mcpUrl;
  const args: readonly string[] = (() => {
    switch (provider) {
      case 'claude-code':
        return ['mcp', 'add', '--transport', 'http', 'secretary', url];
      case 'codex':
        return ['mcp', 'add', 'secretary', '--url', url];
      case 'gemini':
        return ['mcp', 'add', '--transport', 'http', 'secretary', url];
      case 'devin':
        return ['mcp', 'add', 'secretary', url];
      default:
        // Unknown provider: emit the generic shape for the human to adapt.
        return ['mcp', 'add', 'secretary', url];
    }
  })();
  return {
    provider,
    command: provider === 'claude-code' ? 'claude' : provider,
    args,
    url,
    projectId,
  };
}

/**
 * Registration descriptors for every MCP-capable provider — used to print
 * or apply launch configs when a manager is spawned.
 */
export function managerMcpRegistrations(
  mcpUrl: string,
  projectId?: string,
): readonly McpRegistration[] {
  return MCP_CAPABLE_PROVIDERS.map((provider) =>
    managerMcpRegistration(provider, mcpUrl, projectId),
  );
}
