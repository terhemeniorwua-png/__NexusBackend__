# Security Controls

## SSO enforcement (fail-closed)
- `requireWorkspaceAccess` and sibling workspace-permission helpers (`requireDepartmentAccess`, `requireTeamAccess`, `requireChannelAccess`) require an explicit session/auth `context`.
- Missing or invalid context is denied with `WORKSPACE_ACCESS_CONTEXT_REQUIRED`; SSO checks are never skipped (no "no context" => "no check" path).
- User request contexts must be derived from authenticated request/session state (`req.auth`) via `userWorkspaceAccessContext(req.auth)`.
- System contexts must be explicit, named, constructed only in server code via `createSystemWorkspaceContext(reason)`, and never derived from request input.

## System workspace access contexts
| Location | Reason / justification |
|---|---|
| `src/modules/automation/automation.engine.ts` (`assertOwnerCanManage`, `automation-engine:verify-owner-can-manage`) | Background automation execution runs without a user HTTP session; verifies the automation owner still has workspace update/manage permission at execution time so disabled/removed owners cannot execute actions. Context is server-constructed and not request-derived. |
| `src/modules/automation/automation.engine.ts` (`executePostMessageAction`, `automation-engine:post-message-as-owner`) | Background automation posts channel messages as the automation owner without a user HTTP session; owner permission is re-checked by `assertOwnerCanManage` before action. Context is server-constructed and not request-derived. |
