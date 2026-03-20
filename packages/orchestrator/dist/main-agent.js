"use strict";
/**
 * MainAgent — the developer's single point of contact.
 *
 * Receives natural language tasks, decomposes them via TaskDispatcher,
 * fans out to WorkerAgents, and synthesizes results.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MainAgent = void 0;
const llm_client_1 = require("./llm-client");
const agent_registry_1 = require("./agent-registry");
const task_dispatcher_1 = require("./task-dispatcher");
const worker_agent_1 = require("./worker-agent");
const tools_1 = require("@gossip/tools");
const CHAT_SYSTEM_PROMPT = `You are a developer assistant powering Gossip Mesh. Be concise and direct.

When you want to present the developer with choices, use this format in your response:

[CHOICES]
message: Your question here?
- option_value | Display Label | Optional hint text
- option_value | Display Label | Optional hint
[/CHOICES]

Examples of when to use choices:
- Multiple approaches to a task (refactor in-place vs extract vs rewrite)
- Confirming a destructive action (delete files, reset branch)
- Selecting which files/modules to work on
- Choosing between trade-offs (speed vs thoroughness)

Only present choices when there's a genuine decision. Don't use them for simple yes/no — just ask directly.
When there's a clear best option, recommend it but still offer alternatives.`;
class MainAgent {
    llm;
    registry;
    dispatcher;
    workers = new Map();
    relayUrl;
    constructor(config) {
        this.llm = (0, llm_client_1.createProvider)(config.provider, config.model, config.apiKey);
        this.registry = new agent_registry_1.AgentRegistry();
        this.dispatcher = new task_dispatcher_1.TaskDispatcher(this.llm, this.registry);
        this.relayUrl = config.relayUrl;
        for (const agent of config.agents) {
            this.registry.register(agent);
        }
    }
    /** Start all worker agents (connect to relay) */
    async start() {
        for (const config of this.registry.getAll()) {
            const llm = (0, llm_client_1.createProvider)(config.provider, config.model);
            const worker = new worker_agent_1.WorkerAgent(config.id, llm, this.relayUrl, tools_1.ALL_TOOLS);
            await worker.start();
            this.workers.set(config.id, worker);
        }
    }
    /** Stop all worker agents */
    async stop() {
        for (const worker of this.workers.values()) {
            await worker.stop();
        }
        this.workers.clear();
    }
    /** Handle a user message: decompose, dispatch, synthesize. Returns structured ChatResponse. */
    async handleMessage(userMessage) {
        const plan = await this.dispatcher.decompose(userMessage);
        this.dispatcher.assignAgents(plan);
        // Handle unassigned tasks directly with main LLM
        const unassigned = plan.subTasks.filter(st => !st.assignedAgent);
        if (unassigned.length === plan.subTasks.length) {
            const response = await this.llm.generate([
                { role: 'system', content: CHAT_SYSTEM_PROMPT },
                { role: 'user', content: userMessage },
            ]);
            return this.parseResponse(response.text);
        }
        // If multiple approaches, present choices before executing
        if (plan.subTasks.length > 1 && plan.strategy !== 'parallel') {
            // Ask the LLM if it wants to present choices
            const planSummary = plan.subTasks.map((st, i) => `${i + 1}. ${st.description}`).join('\n');
            await this.llm.generate([
                { role: 'system', content: CHAT_SYSTEM_PROMPT },
                { role: 'user', content: userMessage },
                { role: 'assistant', content: `I've broken this into steps:\n${planSummary}\n\nShould I present these as choices to the developer, or just execute them all?` },
            ]);
            // If the LLM suggests choices, the response will be parsed by parseResponse
        }
        // Execute assigned sub-tasks
        const results = [];
        const assigned = plan.subTasks.filter(st => st.assignedAgent);
        if (plan.strategy === 'parallel') {
            const promises = assigned.map(subTask => this.executeSubTask(subTask));
            results.push(...await Promise.all(promises));
        }
        else {
            for (const subTask of assigned) {
                results.push(await this.executeSubTask(subTask));
            }
        }
        const text = await this.synthesize(userMessage, results);
        return {
            text,
            status: 'done',
            agents: results.map(r => r.agentId),
        };
    }
    /** Handle a user's choice selection — continues the conversation with context */
    async handleChoice(originalMessage, choiceValue) {
        const response = await this.llm.generate([
            { role: 'system', content: CHAT_SYSTEM_PROMPT },
            { role: 'user', content: originalMessage },
            { role: 'assistant', content: `I presented options and the developer chose: "${choiceValue}". Proceeding with that approach.` },
            { role: 'user', content: `Yes, go with "${choiceValue}".` },
        ]);
        return this.parseResponse(response.text);
    }
    /**
     * Parse LLM response for structured elements.
     * Detects choice blocks in the format:
     *   [CHOICES]
     *   message: How should I proceed?
     *   - option_value | Display Label | Optional hint
     *   - option_value | Display Label
     *   [/CHOICES]
     */
    parseResponse(text) {
        const choiceMatch = text.match(/\[CHOICES\]([\s\S]*?)\[\/CHOICES\]/);
        if (!choiceMatch) {
            return { text, status: 'done' };
        }
        const choiceBlock = choiceMatch[1].trim();
        const lines = choiceBlock.split('\n').map(l => l.trim()).filter(Boolean);
        const messageLine = lines.find(l => l.startsWith('message:'));
        const optionLines = lines.filter(l => l.startsWith('- '));
        const message = messageLine?.replace('message:', '').trim() || 'How should I proceed?';
        const options = optionLines.map(line => {
            const parts = line.slice(2).split('|').map(p => p.trim());
            return {
                value: parts[0],
                label: parts[1] || parts[0],
                hint: parts[2],
            };
        });
        const textBefore = text.slice(0, text.indexOf('[CHOICES]')).trim();
        const textAfter = text.slice(text.indexOf('[/CHOICES]') + '[/CHOICES]'.length).trim();
        const cleanText = [textBefore, textAfter].filter(Boolean).join('\n\n');
        return {
            text: cleanText,
            choices: options.length > 0 ? { message, options, allowCustom: true, type: 'select' } : undefined,
            status: 'done',
        };
    }
    async executeSubTask(subTask) {
        const worker = this.workers.get(subTask.assignedAgent);
        if (!worker) {
            return { agentId: 'unknown', task: subTask.description, result: '', error: 'No worker', duration: 0 };
        }
        const start = Date.now();
        try {
            const result = await worker.executeTask(subTask.description);
            return { agentId: subTask.assignedAgent, task: subTask.description, result, duration: Date.now() - start };
        }
        catch (err) {
            return {
                agentId: subTask.assignedAgent, task: subTask.description,
                result: '', error: err.message, duration: Date.now() - start,
            };
        }
    }
    async synthesize(originalTask, results) {
        if (results.length === 1) {
            return results[0].error || results[0].result;
        }
        const summaryPrompt = results.map(r => `Agent ${r.agentId} (${r.duration}ms):\n${r.error ? `ERROR: ${r.error}` : r.result}`).join('\n\n---\n\n');
        const response = await this.llm.generate([
            { role: 'system', content: 'Synthesize the following agent results into a single coherent response. Be concise.' },
            { role: 'user', content: `Original task: ${originalTask}\n\nAgent results:\n${summaryPrompt}` },
        ]);
        return response.text;
    }
}
exports.MainAgent = MainAgent;
//# sourceMappingURL=main-agent.js.map