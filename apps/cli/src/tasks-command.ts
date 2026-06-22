import { TaskGraph } from '@gossip/orchestrator';
import type { ReconstructedTask } from '@gossip/orchestrator';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};

function statusColor(status: string): string {
  if (status === 'completed') return c.green;
  if (status === 'failed') return c.red;
  if (status === 'cancelled') return c.yellow;
  return c.dim;
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '?s';
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function printTask(task: ReconstructedTask, indent: string = '  ', showCosts: boolean = false): void {
  const color = statusColor(task.status);
  const dur = formatDuration(task.duration);
  const desc = task.task.replace(/\n/g, ' ').slice(0, 80);
  const tokStr = showCosts && task.inputTokens !== undefined
    ? `  ${c.dim}${formatTokenCount(task.inputTokens + (task.outputTokens ?? 0))} tok${c.reset}`
    : '';
  console.log(`${indent}${c.dim}${task.taskId}${c.reset}  ${task.agentId}  ${color}${task.status}${c.reset}  ${c.dim}${dur}${c.reset}  ${desc}${tokStr}`);
}

export function runTasksCommand(args: string[]): void {
  const graph = new TaskGraph(process.cwd());
  const showCosts = args.includes('--costs');

  // gossipcat tasks <taskId> — detail view
  if (args[0] && !args[0].startsWith('--')) {
    const task = graph.getTask(args[0]);
    if (!task) {
      console.log(`Task "${args[0]}" not found.`);
      return;
    }
    console.log(`\n${c.bold}Task ${task.taskId}${c.reset}`);
    console.log(`  Agent: ${task.agentId}`);
    console.log(`  Status: ${statusColor(task.status)}${task.status}${c.reset}`);
    console.log(`  Duration: ${formatDuration(task.duration)}`);
    console.log(`  Skills: ${task.skills.join(', ') || 'none'}`);
    console.log(`  Created: ${task.createdAt}`);
    if (task.completedAt) console.log(`  Completed: ${task.completedAt}`);
    if (task.inputTokens !== undefined) {
      console.log(`  Tokens: ${formatTokenCount(task.inputTokens)} input + ${formatTokenCount(task.outputTokens ?? 0)} output = ${formatTokenCount(task.inputTokens + (task.outputTokens ?? 0))} total`);
    }
    if (task.result) console.log(`\n  Result:\n    ${task.result.slice(0, 500).replace(/\n/g, '\n    ')}`);
    if (task.error) console.log(`\n  Error: ${task.error}`);

    if (task.children?.length) {
      console.log(`\n  Sub-tasks:`);
      for (const childId of task.children) {
        const child = graph.getTask(childId);
        if (child) printTask(child, '    ', showCosts);
      }
    }

    if (task.references?.length) {
      console.log(`\n  References:`);
      for (const ref of task.references) {
        console.log(`    ${ref.fromTaskId} → ${ref.toTaskId} (${ref.relationship})${ref.evidence ? ` — ${ref.evidence}` : ''}`);
      }
    }
    console.log('');
    return;
  }

  // gossipcat tasks --agent <id>
  const agentIdx = args.indexOf('--agent');
  const agentFilter = agentIdx >= 0 ? args[agentIdx + 1] : undefined;

  const tasks = agentFilter
    ? graph.getTasksByAgent(agentFilter)
    : graph.getRecentTasks();

  if (tasks.length === 0) {
    console.log('\nNo tasks found.\n');
    return;
  }

  console.log(`\n${c.bold}Recent Tasks${agentFilter ? ` (${agentFilter})` : ''} (${tasks.length}):${c.reset}\n`);

  for (const task of tasks) {
    printTask(task, '  ', showCosts);
    if (task.children?.length) {
      for (let i = 0; i < task.children.length; i++) {
        const child = graph.getTask(task.children[i]);
        if (child) {
          const prefix = i === task.children.length - 1 ? '└─' : '├─';
          printTask(child, `    ${prefix} `, showCosts);
        }
      }
    }
  }

  if (showCosts) {
    let totalInput = 0, totalOutput = 0;
    for (const task of tasks) {
      totalInput += task.inputTokens ?? 0;
      totalOutput += task.outputTokens ?? 0;
    }
    if (totalInput + totalOutput > 0) {
      console.log(`  ${c.dim}Total: ${formatTokenCount(totalInput)} input + ${formatTokenCount(totalOutput)} output = ${formatTokenCount(totalInput + totalOutput)} tokens${c.reset}`);
    }
  }

  console.log('');
}
