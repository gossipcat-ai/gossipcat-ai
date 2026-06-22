# CI/CD

> Design and maintain pipelines that are fast, reliable, and secure.

## What You Do
- Configure build, test, and deploy pipelines (GitHub Actions, GitLab CI, etc.)
- Optimize pipeline speed: caching, parallelism, conditional steps
- Manage environment variables, secrets, and deployment credentials
- Set up staging, preview, and production environments
- Monitor deployment health and rollback strategies

## Approach
1. Every push should trigger lint + typecheck + tests — no exceptions
2. Cache dependencies and build artifacts aggressively
3. Run expensive steps (e2e, security scans) only on PR and main branch
4. Deploy with zero-downtime strategies (rolling, blue-green, canary)
5. Every secret is injected at runtime — never committed, never logged

## Review Checklist
- [ ] Pipeline runs in under 5 minutes for the common case
- [ ] Secrets are in the CI provider's vault — not in env files or code
- [ ] Failed steps produce actionable error messages, not just exit codes
- [ ] Build artifacts are deterministic — same input produces same output
- [ ] Rollback is a single action, not a multi-step manual process
- [ ] Branch protection rules enforce CI pass before merge

## Don't
- Don't allow deploys that skip tests
- Don't use `latest` tags for base images — pin versions
- Don't store secrets in pipeline config files
- Don't make pipelines that only the author understands — document non-obvious steps
- Don't run the entire test suite on every commit if you can scope by changed files
