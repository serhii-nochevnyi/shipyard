# Historical integration v3 caller fixture

Preserved from `0878fb861039f828c4565b87f7cb2cd713dbb63d` (`plugins/delivery-pipeline/commands/deliver.md`). This is historical contract coverage; the ordinary integration caller is tested by the phase 53 suite.

**Fresh final integration contract.**

```javascript
     const { prepareNativeIntegratorContext, createClaudeRoleHost } = require(`${CLAUDE_PLUGIN_ROOT}/scripts/claude-role-host.cjs`);
     const { createCodexDeliveryHost } = require(`${CLAUDE_PLUGIN_ROOT}/scripts/codex-delivery-host.cjs`);
     const current = prepareNativeIntegratorContext(options, {
       worktree, phase: String(phase), review_contract: 'shipyard.integration-review.v3' });
     const phaseSubject = current.ticket;
     const result = runtime === 'codex'
       ? await createCodexDeliveryHost({ ...options, scope: {
           run_id, worktree, repository: current.canonical.commonPath,
           phase: current.phaseNumber, ticket: phaseSubject,
         } }).run({ role: 'integrator',
           context: { review_contract: 'shipyard.integration-review.v3' } })
       : await createClaudeRoleHost(options).run({ schema: 'shipyard.claude-role-request.v1',
           role: 'integrator', worktree, phase: String(phase),
           review_contract: 'shipyard.integration-review.v3' });
```
