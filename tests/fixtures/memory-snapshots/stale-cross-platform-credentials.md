---
name: Cross-platform credential storage
description: Current Keychain class is macOS-only — needs Linux + Windows support before we can ship to non-mac users
type: project
---

**Status:** macOS only. Current `Keychain` class in `apps/cli/src/keychain.ts` shells out to the `security` CLI which is darwin-only. Linux and Windows users have no working credential persistence path today.

**Why it matters:** Setup wizard writes API keys to Keychain on macOS, but on Linux/Windows the wizard either errors out or silently drops the key, leaving the user with no working config.

**How to apply:**
1. Add a Linux branch using `secret-tool` (libsecret / Secret Service).
2. Add a Windows branch using `cmdkey` or a `keytar`-style native dep.
3. Provide an encrypted-file fallback for headless environments where no OS keychain is available.
4. Centralize platform detection in `isKeychainAvailable()` so call sites stay clean.

Blocked on: deciding whether to take the `keytar` native-dep hit or write three execFileSync branches by hand.
