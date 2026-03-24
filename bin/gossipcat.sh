#!/bin/bash
# Launch gossipcat interactive chat in the CURRENT directory
GOSSIP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export NODE_PATH="$GOSSIP_ROOT/node_modules"
exec node -e "
  require('$GOSSIP_ROOT/node_modules/ts-node').register({
    transpileOnly: true,
    compilerOptions: { strict: false, noImplicitAny: false, noUnusedLocals: false, noUnusedParameters: false },
    project: '$GOSSIP_ROOT/tsconfig.json',
  });
  require('$GOSSIP_ROOT/node_modules/tsconfig-paths').register({
    baseUrl: '$GOSSIP_ROOT',
    paths: {
      '@gossip/types': ['packages/types/src'],
      '@gossip/types/*': ['packages/types/src/*'],
      '@gossip/relay': ['packages/relay/src'],
      '@gossip/relay/*': ['packages/relay/src/*'],
      '@gossip/client': ['packages/client/src'],
      '@gossip/client/*': ['packages/client/src/*'],
      '@gossip/tools': ['packages/tools/src'],
      '@gossip/tools/*': ['packages/tools/src/*'],
      '@gossip/orchestrator': ['packages/orchestrator/src'],
      '@gossip/orchestrator/*': ['packages/orchestrator/src/*'],
    },
  });
  require('$GOSSIP_ROOT/apps/cli/src/index.ts');
" "$@"
