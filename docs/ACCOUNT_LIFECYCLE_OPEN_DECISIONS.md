# Account Lifecycle Open Decisions

**Status:** Prepared for product-owner, legal and accounting review. The 30-day scheduled deletion, recovery window, workspace retention/suspension, explicit ownership acceptance, separate billing acceptance, preservation of shared content, payable outstanding invoices, no automatic refund, deletion of purely personal attachments at finalization, and “retain and review” treatment of personal information in collaboration content are approved product decisions. This document is not legal advice and does not claim legal approval or regulatory compliance.

No numeric financial-record retention period is currently configured by the account-lifecycle implementation. The 30-day interval is an account recovery period, not a financial-record retention period.

## Financial and accounting records

| Category | Backend records | Configured retention period | Personal information to review | Decision and options |
|---|---|---|---|---|
| Subscription history and billing responsibility | `Subscription`, `BillingCancellation`, `BillingSeatSync`, `WorkspaceOwnershipTransfer` | None | Billing owner IDs, provider customer/subscription references, encrypted management credentials, dates and plan | Approve purpose, access roles, retention trigger/period, and fields to pseudonymize. Options: retain a minimized history for an approved period; or preserve only legally/accountingly necessary fields. Risk of early removal includes loss of billing dispute and ownership evidence. |
| Checkout and invoice/payment evidence | `BillingCheckout`, `BillingPayment` (the current schema has no separate `Invoice` model) | None | Creator/user IDs, checkout and provider references, amounts, currency, status, payment dates and covered periods | Accounting/legal must identify applicable obligations by jurisdiction and customer contract, then set the period. Options: retain complete records with restricted access or retain a minimized accounting record. Do not make outstanding invoices unpayable or delete payment evidence before approval. |
| Refund, dispute and provider event history | `BillingPayment`, `BillingWebhookEvent`, provider fields on checkout/subscription | None | Provider event/reference values may be linkable to a person/payment instrument | Confirm which records are needed for refunds, chargebacks, disputes and reconciliation, plus the applicable clock and access policy. Do not infer these periods from the 30-day recovery window. |
| Audit/security history | `AuditLog` | None | Actor/target identifiers, metadata, IP address, user agent and event context | Decide retention period, field-level minimization, access logging and legal-hold handling. Existing finalization clears selected identity fields while retaining audit rows; arbitrary nested metadata may still contain identifiers and requires schema-aware review. |
| Email delivery and suppression | `EmailDelivery`, `EmailSuppression` | None | Recipient/sender addresses, message content/provider IDs, suppression address and reason | Decide operational/support retention and whether suppression identifiers must remain to prevent unwanted mail. Options: remove message content and minimize delivery metadata, or retain limited evidence for a defined purpose. |
| Worker/provider retry state | `BillingCancellation`, `BillingSeatSync` | No expiry configured | Provider identifiers and error text may include sensitive information | Decide when completed/error rows and provider identifiers can be pruned or scrubbed; restrict access while retained. |

## Collaboration content and files

### Messages and comments

The current backend schema in this repository has no `Message`, `Conversation`, or `Channel` model, so message-attachment relationships cannot be inventoried or verified here. `Comment` rows are attached to tasks and retain their author foreign key; account finalization keeps a neutral `Deleted user` tombstone so the attribution remains referentially valid. **Product-approved: retain and review.** Shared messages, comments, tasks and project updates remain; attribution changes to `Deleted user` and profile references are removed, but this does not establish that embedded personal information is anonymized. Privacy request records and authenticated owner/reviewer decision APIs now exist. Approved redaction can replace exact text in task comments while preserving the rest of the comment; messaging/channel and other collaboration redaction remain unavailable because those models do not exist. Applicable legal rights, response timelines and exceptions remain for qualified legal review.

### Attachments and storage references

`FileAttachment` stores `workspaceId`, optional project/task/comment links, `uploadedById`, filename, MIME type, size, unique `storageKey`, timestamps and optional `deletedAt`. For attachments passing the personal-file classifier, the worker deletes storage bytes and then removes metadata within the same account-finalization transaction. Storage errors are audited and leave the account pending for retry. Shared-workspace and collaboration-linked attachments are not modified by this worker. Database foreign keys restrict uploader deletion for retained files, so the user tombstone remains necessary to preserve valid references.

The approved product rule is to delete purely personal attachments after final deletion and the 30-day recovery period; recovery preserves them. Classification uses the personal-workspace owner, all retained workspace memberships, project ownership/memberships, task creators/assignees, and discussion relationships, never uploader ID alone. Shared workspace/project/task discussion files and uploads by other users remain. The backend currently has no `Message`, `Conversation`, or `Channel` models, so message attachments cannot yet be identified. Legal/accounting review must confirm any records subject to preservation obligations before deployment. The worker fails closed when storage deletion fails; storage deletion is idempotent, metadata is removed only after successful storage deletion, and the account row lock serializes recovery/finalization. Review the classifier whenever sharing or attachment relationships change.

### File metadata anonymization and access

Approved product behavior replaces shared author attribution with `Deleted user` and removes profile picture/profile references while retaining collaboration content. The current implementation keeps the neutral user tombstone where needed for foreign keys. Purely personal attachment metadata rows are deleted only after the private object deletion succeeds; shared file metadata remains. Legal/product review is still required for personal information embedded within retained content, filenames and metadata, and for access/restriction rules beyond existing authorization. Do not broaden access to private files as part of anonymization.

## Legal/accounting confirmation required

Legal and accounting reviewers should identify applicable recordkeeping requirements for each relevant jurisdiction and contract, including the event that starts each retention clock, exceptions/holds, access roles, disposal procedure, backups and provider copies. This document intentionally names no statute, legal obligation, or period because none has been confirmed in the repository. Product-owner approval is required for content/file disposition and access behavior; legal/accounting approval is required before documenting legal retention obligations or time periods.

## Approval record

Record the decision owner, approved wording, date, jurisdiction/contract scope, and implementation follow-up here only after an actual review. No approvals are recorded by this draft.
