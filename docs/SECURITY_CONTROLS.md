# Nexus Security Controls — SCIM Provisioning

This document summarizes the security controls for SCIM 2.0 provisioning in the
Nexus backend. SCIM is mounted under `/scim/v2` and is authenticated exclusively
with per-workspace bearer tokens (not Nexus sessions).

## SCIM bearer tokens

- **Per-workspace scoping:** every SCIM bearer token is bound to exactly one
  workspace. A token can only read or write users and groups within that
  workspace; cross-workspace access is rejected at the service layer.
- **Hashed at rest:** only the SHA-256 digest of a bearer token is persisted
  (`ScimToken.tokenHash`). The plaintext token is never stored, logged, or
  returned after creation.
- **Shown once:** the plaintext bearer token is returned to the caller exactly
  once, at token creation. It cannot be retrieved again.
- **Revokable:** tokens can be revoked (`ScimToken.status = REVOKED`) at any
  time. Revoked tokens are rejected immediately.
- **Expirable:** tokens may carry an expiry (`ScimToken.expiresAt`); expired
  tokens are rejected.
- **Rate limited:** SCIM endpoints are rate limited per token so a single
  credential cannot be abused to spam provisioning requests.

## SCIM users

- A SCIM user maps to a Nexus `User` plus a `WorkspaceMembership` in the target
  workspace. Creating a SCIM user provisions a Nexus account and workspace
  membership; updating can change the display name, emails, and active state.
- The SCIM `userName` maps to the user's email address.

## SCIM groups

- A SCIM group maps to a Nexus `Team`. Group membership is reflected in team
  membership (`TeamMembership`).

## Deprovisioning

Deactivating a SCIM user (`DELETE /scim/v2/Users/{id}`):

- sets the Nexus account to `DEACTIVATED` (data is **not** deleted),
- suspends the user's workspace membership,
- revokes all of the user's sessions,
- revokes all of the user's SCIM tokens in that workspace,
- revokes/disables the user's workspace integration tokens.

Data is never deleted on deactivate unless `hardDelete` is explicitly requested.

## Audit logging

Token creation, token revocation, user provisioning, user updates, user
deactivation, and group changes are recorded in `AuditLog` and flagged as
security events (`securityEvent=true`).

## Authentication

SCIM does not use Nexus sessions or JWT access tokens. It is authenticated
solely by the per-workspace bearer token in the `Authorization: Bearer`
header. The bearer token is scoped to one workspace and cannot be used to
access another workspace's resources.
