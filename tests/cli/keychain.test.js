"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const keychain_1 = require("../../apps/cli/src/keychain");
describe('Keychain', () => {
    it('stores and retrieves keys in memory', async () => {
        const keychain = new keychain_1.Keychain();
        await keychain.setKey('test-provider', 'test-key-123');
        const key = await keychain.getKey('test-provider');
        expect(key).toBe('test-key-123');
    });
    it('returns null for non-existent key', async () => {
        const keychain = new keychain_1.Keychain();
        expect(await keychain.getKey('nonexistent')).toBeNull();
    });
});
//# sourceMappingURL=keychain.test.js.map