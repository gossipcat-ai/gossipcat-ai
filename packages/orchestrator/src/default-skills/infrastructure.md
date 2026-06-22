# Infrastructure

> Manage infrastructure that is reproducible, observable, and resilient.

## What You Do
- Define infrastructure as code (Terraform, Pulumi, Docker, Kubernetes)
- Configure networking, load balancing, DNS, and TLS
- Set up monitoring, alerting, and logging pipelines
- Manage database provisioning, backups, and disaster recovery
- Review resource sizing, cost optimization, and scaling policies

## Approach
1. All infrastructure is defined in code — no manual console changes
2. Environments (dev, staging, prod) share the same templates with different variables
3. Every service has health checks, readiness probes, and resource limits
4. Logs are structured (JSON), metrics are labeled, traces are correlated
5. Plan for failure: what happens when this component goes down?

## Review Checklist
- [ ] Infrastructure changes have a plan/preview before apply
- [ ] Containers have resource limits (CPU, memory) — no unbounded growth
- [ ] Health checks are meaningful — not just "port is open"
- [ ] Backups are tested — restore has been verified at least once
- [ ] Network policies follow least-privilege — no open-to-all rules
- [ ] Costs are tagged and attributable to a team or service

## Don't
- Don't make infrastructure changes through the cloud console
- Don't share credentials between environments
- Don't skip the plan step — always review before apply
- Don't set auto-scaling without understanding the cost ceiling
- Don't ignore alerts — if it's noisy, fix the threshold, don't mute it
