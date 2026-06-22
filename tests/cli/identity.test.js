"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const identity_1 = require("../../apps/cli/src/identity");
describe('normalizeGitUrl', () => {
    it('normalizes SSH URLs', () => {
        expect((0, identity_1.normalizeGitUrl)('git@github.com:team/myapp.git')).toBe('github.com/team/myapp');
    });
    it('normalizes HTTPS URLs', () => {
        expect((0, identity_1.normalizeGitUrl)('https://github.com/team/myapp.git')).toBe('github.com/team/myapp');
    });
    it('normalizes SCP-style URLs', () => {
        expect((0, identity_1.normalizeGitUrl)('github.com:team/myapp.git')).toBe('github.com/team/myapp');
    });
    it('strips .git suffix', () => {
        expect((0, identity_1.normalizeGitUrl)('https://github.com/team/myapp.git')).toBe('github.com/team/myapp');
        expect((0, identity_1.normalizeGitUrl)('https://github.com/team/myapp')).toBe('github.com/team/myapp');
    });
    it('returns null for empty input', () => {
        expect((0, identity_1.normalizeGitUrl)('')).toBeNull();
    });
    it('handles non-standard URLs via fallback', () => {
        const result = (0, identity_1.normalizeGitUrl)('ssh://git@gitlab.com/team/myapp.git');
        expect(result).toBe('gitlab.com/team/myapp');
    });
});
describe('getTeamUserId', () => {
    it('produces consistent hash from email + salt', () => {
        const id1 = (0, identity_1.getTeamUserId)('alice@co.com', 'salt123');
        const id2 = (0, identity_1.getTeamUserId)('alice@co.com', 'salt123');
        expect(id1).toBe(id2);
        expect(id1).toHaveLength(16);
    });
    it('produces different hashes for different emails', () => {
        const id1 = (0, identity_1.getTeamUserId)('alice@co.com', 'salt123');
        const id2 = (0, identity_1.getTeamUserId)('bob@co.com', 'salt123');
        expect(id1).not.toBe(id2);
    });
    it('produces different hashes for different salts', () => {
        const id1 = (0, identity_1.getTeamUserId)('alice@co.com', 'salt-a');
        const id2 = (0, identity_1.getTeamUserId)('alice@co.com', 'salt-b');
        expect(id1).not.toBe(id2);
    });
});
describe('getGitEmail', () => {
    it('returns a string or null', () => {
        const email = (0, identity_1.getGitEmail)();
        expect(typeof email === 'string' || email === null).toBe(true);
    });
});
//# sourceMappingURL=identity.test.js.map