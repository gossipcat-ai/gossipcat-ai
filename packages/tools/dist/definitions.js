"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALL_TOOLS = exports.GIT_TOOLS = exports.SHELL_TOOLS = exports.FILE_TOOLS = void 0;
exports.FILE_TOOLS = [
    {
        name: 'file_read',
        description: 'Read the contents of a file',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to project root' },
                startLine: { type: 'string', description: 'Optional start line number' },
                endLine: { type: 'string', description: 'Optional end line number' }
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
exports.SHELL_TOOLS = [
    {
        name: 'shell_exec',
        description: 'Execute a shell command in the project directory',
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
exports.GIT_TOOLS = [
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
                staged: { type: 'string', description: 'If "true", show staged differences' }
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
exports.ALL_TOOLS = [...exports.FILE_TOOLS, ...exports.SHELL_TOOLS, ...exports.GIT_TOOLS];
//# sourceMappingURL=definitions.js.map