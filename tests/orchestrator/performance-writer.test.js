"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// tests/orchestrator/performance-writer.test.ts
const orchestrator_1 = require("@gossip/orchestrator");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
describe('PerformanceWriter', () => {
    let tmpDir;
    let writer;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-writer-'));
        fs.mkdirSync(path.join(tmpDir, '.gossip'), { recursive: true });
        writer = new orchestrator_1.PerformanceWriter(tmpDir);
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('appends a signal to agent-performance.jsonl', () => {
        const signal = {
            type: 'consensus',
            taskId: 'abc123',
            signal: 'agreement',
            agentId: 'gemini-reviewer',
            counterpartId: 'gemini-tester',
            evidence: 'both found SQL injection at auth.ts:47',
            timestamp: '2026-03-24T10:00:00Z',
        };
        writer.appendSignal(signal);
        const filePath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
        expect(fs.existsSync(filePath)).toBe(true);
        const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toEqual(signal);
    });
    it('appends multiple signals', () => {
        const signal1 = {
            type: 'consensus', taskId: 't1', signal: 'agreement',
            agentId: 'a', evidence: 'e1', timestamp: '2026-03-24T10:00:00Z',
        };
        const signal2 = {
            type: 'consensus', taskId: 't2', signal: 'disagreement',
            agentId: 'b', counterpartId: 'a', outcome: 'correct',
            evidence: 'e2', timestamp: '2026-03-24T10:01:00Z',
        };
        writer.appendSignal(signal1);
        writer.appendSignal(signal2);
        const filePath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
        const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
        expect(lines).toHaveLength(2);
    });
    it('appendSignals batch writes', () => {
        const signals = [
            { type: 'consensus', taskId: 't1', signal: 'agreement', agentId: 'a', evidence: 'e1', timestamp: '2026-03-24T10:00:00Z' },
            { type: 'consensus', taskId: 't2', signal: 'new_finding', agentId: 'b', evidence: 'e2', timestamp: '2026-03-24T10:01:00Z' },
        ];
        writer.appendSignals(signals);
        const filePath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
        const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
        expect(lines).toHaveLength(2);
    });
});
//# sourceMappingURL=performance-writer.test.js.map