# Nexus Security Controls

This document summarizes key security controls implemented in the Nexus backend. It is a living document and must be updated when security-relevant behavior changes.

## Authentication and Sessions
- Password authentication uses server-side hashing and standard credential validation flows.
- Access tokens are short-lived JWTs; every authenticated request verifies the referenced session in PostgreSQL (`authenticate` middleware) so logout, session revocation, password resets, and suspensions take effect immediately.
- Refresh tokens are opaque, stored hashed, rotated on use, and replay/reuse is detected.
- CSRF protections apply to cookie/session flows as configured by the auth middleware.
- Sessions created via SSO follow the same refresh-token rotation and CSRF rules as password login.

## SSO / OIDC / SAML (Workspace-scoped)
- **Protocols:** OIDC supported first (Google Workspace, Microsoft Entra, Okta configurations). SAML 2.0 support is planned/expandable behind the same workspace SSO configuration model.
- **Per-workspace configuration:** SSO is configured per workspace. Only workspace owners and organization owners/admins may create or modify SSO settings.
- **Domain verification:** DNS TXT record verification is required before SSO can be enforced for a workspace domain. Unverified domains cannot be used to enforce `require SSO`.
- **Require SSO:** Workspaces can optionally require SSO for member access. When enabled, password login for workspace access is blocked except for documented break-glass recovery.
- **Break-glass access:** Owner break-glass recovery codes are generated one-time, stored hashed, consumed on use, audited, and intended to be rate-limited at the API edge. Break-glass use/failure is recorded as security audit events.
- **JIT provisioning and account linking:** SSO identities are mapped to existing Nexus accounts by **verified email only**.
  - Never auto-link an unverified email.
  - Never auto-provision/link based on untrusted or unverified email claims.
  - Email-change and account takeover attempts must be rejected when email verification/domain trust cannot be established.
- **Token/state validation:** OAuth/OIDC state values are signed and validated for tampering, provider match, expiry, and nonce/state integrity. ID token assertions must be validated for signature (provider integration), issuer, audience, expiry, and nonce; replayed assertions/states must be rejected.
- **Session revocation on membership removal:** When SSO access/membership requiring SSO is removed, active sessions for the affected user are revoked so access is terminated promptly.
- **Auditing:** SSO configuration changes, domain verification events, break-glass generation/use/failure, JIT provisioning blocks, and SSO login outcomes are recorded in the audit log; security-relevant events are flagged (`securityEvent=true`).

## SCIM Provisioning (Workspace-scoped)

- **Protocol:** SCIM 2.0 Users and Groups endpoints are mounted under `/scim/v2` and are authenticated exclusively with per-workspace bearer tokens (not Nexus sessions).
- **Per-workspace bearer tokens:** Each SCIM token is bound to exactly one workspace. The plaintext bearer token is returned once at creation and never again; only its SHA-256 hash (`tokenHash`) is persisted. Tokens are revocable, may carry an expiry, and are rate-limited per token.
- **Scope:** A SCIM token can only read/write users and groups within its own workspace. Cross-workspace access is rejected at the service layer.
- **Users:** SCIM users map to Nexus users within the workspace (`User` + `WorkspaceMembership`). Creating a SCIM user provisions a Nexus account and membership; updating can change display name, emails, and active state.
- **Groups:** SCIM groups map to Nexus teams. Group membership is reflected in team membership.
- **Deprovisioning:** Deactivating a SCIM user sets the account to `DEACTIVATED`, suspends the workspace membership, and revokes all of the user's sessions, SCIM tokens, and workspace integration tokens. Data is never deleted on deactivate unless `hardDelete` is explicitly requested.
- **Auditing:** Token creation/revocation, user provisioning/deactivation, and group changes are recorded in the audit log as security events.

## Authorization
- Authorization is enforced server-side using workspace/project/team policies and capability checks.
- Frontend checks are not trusted for access control.

## Audit Logging
- Security-relevant actions are recorded in `AuditLog` with `securityEvent` flagging for monitoring and incident response.
- Audit retention is managed by background prune workers according to configured retention policy.

## Operational Notes
- Secrets (client secrets, tokens, break-glass codes) must never be returned in plaintext except one-time generation responses where explicitly required, and must never be logged.
- Provider-specific integrations must validate signatures using trusted provider keys/metadata and enforce replay protection.
