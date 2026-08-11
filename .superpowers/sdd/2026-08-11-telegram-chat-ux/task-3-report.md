# Task 3 Report: `describeTool()` and `renderToolLine()`

## Status
**DONE**

## Commits
- `003aeee`: feat(render): deterministic catalog for tool call descriptions

## Test Summary
**409 passed** (41 in render.test.ts, including 18 new tests for `describeTool` and `renderToolLine`)
- Baseline: 392 tests
- Added: 18 tests (13 for `describeTool`, 5 for `renderToolLine`)
- TypeScript strict mode: ✓ passed

## Implementation Details

### Added to `bot/render.ts`
- `ToolLine` interface: icon, label, target, detail, code
- `describeTool(toolName, input, projectDir)`: Deterministic tool call descriptor
  - Handles Bash, Read, Write, Edit, Glob, Grep, Fetch, Search, Agent (Task), Skill, Command, Workflow, Plan, Todo
  - Parses MCP tool names correctly: splits on the **last** `__` to handle server names with underscores
  - Prioritizes human-friendly descriptions (Bash) over raw commands
  - Shortens paths using existing `shortenPath()` function
- `renderToolLine(line)`: HTML-escaped rendering of ToolLine
  - Escapes dynamic fragments in detail/target/code using `htmlEscape()`
  - Truncates long strings using existing `truncateAtWord()`
  - Puts Bash command on a separate line in `<code>` tags

### Test Coverage
- Bash description handling with fallback to command
- Path shortening for Read/Write/Edit operations
- Line range reporting for Read with offset/limit
- Tool-type differentiation (Write vs Edit)
- Skill recognition
- MCP tool name parsing with server underscore handling
- Non-descriptive key filtering for MCP tools
- Subagent (Task) handling
- Todo counter with current item display
- Unknown tool fallback to first string value
- Empty input resilience
- HTML escaping of dynamic content
- Multi-line rendering with code block support

## No Concerns
- All tests pass
- TypeScript strict mode enforced
- ESM with relative imports using `.js` extension
- No external I/O (all tests use synthetic data)
- Comment language: English as required
