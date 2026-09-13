/**
 * ToolRegistry — the typed catalog of things the Secretary may do
 * (DEC-034, issue #70).
 *
 * Tools are registered with a JSON-Schema parameter spec (sent to the model
 * verbatim in OpenAI `tools` format) and an execute handler. The loop calls
 * {@link ToolRegistry.execute} for every model-requested tool call; unknown
 * names and handler failures both come back as tool-result errors so the
 * model can recover instead of crashing the loop.
 */

/** JSON-Schema object describing a tool's parameters (subset we emit). */
export type ToolParameters = {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
};

/** OpenAI `tools[]` wire spec for one tool. */
export interface ToolSpec {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: ToolParameters;
  };
}

/** Outcome of executing a tool. */
export interface ToolResult {
  /** Text content handed back to the model. */
  readonly content: string;
  /** True when execution failed — the model sees it as an error result. */
  readonly isError?: boolean;
}

/** Context handed to every tool execution. */
export interface ToolContext {
  /** Opaque per-run data the caller wants tools to see (e.g. daemon refs). */
  readonly data?: Record<string, unknown>;
}

/** A registrable tool. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameters;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/** Raised when registering an invalid or duplicate tool. */
export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /** Register a tool. Throws on duplicate names or invalid definitions. */
  register(tool: ToolDefinition): void {
    if (tool.name.length === 0) {
      throw new ToolRegistryError('tool name must not be empty');
    }
    if (this.tools.has(tool.name)) {
      throw new ToolRegistryError(`tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Registered tool names, in registration order. */
  names(): readonly string[] {
    return [...this.tools.keys()];
  }

  /** OpenAI `tools[]` specs for every registered tool. */
  specs(): readonly ToolSpec[] {
    return [...this.tools.values()].map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * Execute one model-requested call. Never throws: unknown tools and
   * handler exceptions both return `{isError: true}` results so the model
   * receives feedback and the loop keeps running.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext = {},
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return { content: `error: unknown tool "${name}"`, isError: true };
    }
    try {
      return await tool.execute(args, context);
    } catch (err) {
      return {
        content: `error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}
