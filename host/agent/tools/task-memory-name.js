// The `task_memory` tool's registered name, in a module with no imports so
// the pure memory modules (guidance.js) can name the tool without loading the
// SDK or zod. See task-memory.js for why the name must also be passed to
// buildIsolatedOptions()'s `extraToolNames` wherever the tool is registered.
export const TASK_MEMORY_TOOL_NAME = "task_memory";
