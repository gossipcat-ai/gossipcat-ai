import { ToolDefinition } from '@gossip/types';

export const FILE_TOOLS: ToolDefinition[] = [
  {
    name: 'file_read',
    description: 'Read the contents of a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        startLine: { type: 'number', description: 'Optional start line number' },
        endLine: { type: 'number', description: 'Optional end line number' }
      },
      required: ['path']
    }
  },
  {
    name: 'file_write',
    description: 'Write content to a file (creates parent directories if needed)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        content: { type: 'string', description: 'Content to write to the file' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'file_delete',
    description: 'Delete a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' }
      },
      required: ['path']
    }
  },
  {
    name: 'file_search',
    description: 'Search for files by name pattern (glob-style)',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob-style pattern to match file names (e.g. "*.ts")' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'file_grep',
    description: 'Search file contents using a regex pattern',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for in file contents' },
        path: { type: 'string', description: 'Optional directory path to limit search scope' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'file_tree',
    description: 'Display directory tree structure',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional directory path (defaults to project root)' },
        depth: { type: 'string', description: 'Optional max depth (default 3)' }
      },
      required: []
    }
  }
];

export const SHELL_TOOLS: ToolDefinition[] = [
  {
    name: 'shell_exec',
    description: 'Execute a shell command (60s timeout). Use for: npm install, npm run build, npx tsc --noEmit, etc. NEVER run dev servers (npm run dev, npm start) — they run forever and will timeout.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'string', description: 'Timeout in milliseconds (default 30000)' }
      },
      required: ['command']
    }
  }
];

export const GIT_TOOLS: ToolDefinition[] = [
  {
    name: 'git_status',
    description: 'Show working tree status (short format)',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'git_diff',
    description: 'Show file differences',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Show staged differences' }
      },
      required: []
    }
  },
  {
    name: 'git_log',
    description: 'Show commit history',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'string', description: 'Number of commits to show (default 20)' }
      },
      required: []
    }
  },
  {
    name: 'git_commit',
    description: 'Stage files and create a commit',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message' },
        files: { type: 'string', description: 'Comma-separated list of files to stage (optional, stages all if omitted)' }
      },
      required: ['message']
    }
  },
  {
    name: 'git_branch',
    description: 'List branches or create a new branch',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Branch name to create (optional, lists branches if omitted)' }
      },
      required: []
    }
  }
];

export const SKILL_TOOLS: ToolDefinition[] = [
  {
    name: 'suggest_skill',
    description: 'Suggest a skill that would help with the current task. Non-blocking — logs the suggestion and you keep working.',
    parameters: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: 'Skill name using underscores (e.g. "dos_resilience")' },
        reason: { type: 'string', description: 'Why you need this skill' },
        task_context: { type: 'string', description: 'What you were doing when you noticed the gap' }
      },
      required: ['skill_name', 'reason', 'task_context']
    }
  }
];

export const VERIFY_TOOLS: ToolDefinition[] = [
  {
    name: 'verify_write',
    description: 'Run tests and get a peer review of your changes. Call this after writing files to verify correctness. Returns test results + reviewer feedback.',
    parameters: {
      type: 'object',
      properties: {
        test_file: { type: 'string', description: 'Specific test file to run (e.g. "tests/tools/tool-server-scope.test.ts"). If omitted, runs full test suite.' },
      },
    },
  },
];

export const IDENTITY_TOOLS: ToolDefinition[] = [
  {
    name: 'self_identity',
    description: 'Return your own identity: agent_id, runtime (native or relay), provider, and model. Use when you need to know who you are — for example, to pick the right tool variant (gossip_remember vs memory_query) or to cite your own past findings. Identity is also injected into your system prompt at dispatch time, so you usually do not need to call this.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

export const MEMORY_TOOLS: ToolDefinition[] = [
  {
    name: 'memory_query',
    description: 'Search YOUR OWN archived knowledge files, task summaries, and consensus signals from prior sessions. Use BEFORE reviewing code that names a specific file/function/module so you don\'t re-discover or contradict prior findings. Scoped to your own archive — you cannot read other agents\' memory.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Concrete identifier to search for: file path, function name, module, or commit hash. Two-to-five focused words. Vague terms like "review" or "bug" waste the call.' },
        max_results: { type: 'string', description: 'Max results to return (default 3, max 10)' },
      },
      required: ['query'],
    },
  },
];

export const ALL_TOOLS: ToolDefinition[] = [...FILE_TOOLS, ...SHELL_TOOLS, ...GIT_TOOLS, ...SKILL_TOOLS, ...VERIFY_TOOLS, ...MEMORY_TOOLS, ...IDENTITY_TOOLS];
