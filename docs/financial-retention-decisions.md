# Financial and legal retention decisions

**Status:** Open for product-owner, legal and accounting review. This document records the data currently represented by the backend and questions requiring a decision. It does not set retention periods or claim legal compliance.

## Records the backend currently preserves

| Record | Current data represented | Personal or sensitive data to review | Current deletion behavior | Access that must be restricted |
| --- | --- | --- | --- | --- |
| `Subscription` | Plan, interval, currency, seat count, provider customer/subscription references, encrypted management token, billing owner, periods and cancellation state | Provider references, billing owner identity, encrypted provider token | Workspace subscriptions remain with retained workspaces. Billing owner foreign key uses `SET NULL` if its user is removed; current account finalization keeps a user tombstone. | Workspace billing roles only; provider references and encrypted token remain server-side. Confirm administrative access and audit logging. |
| `BillingCheckout` | Workspace and creator IDs, checkout reference/URL, plan, amount, currency, provider references and payment state | Creator ID, provider customer/subscription references, URL and provider token | Retained with the workspace. No account-deletion cleanup is currently applied. | Workspace billing roles; checkout URLs and provider identifiers must not be exposed through unrelated workspace or user APIs. |
| `BillingPayment` | Workspace, amount, currency, status, provider reference/event key, paid and covered-period dates | Provider references may be linkable to an individual or payment instrument | Retained with the workspace. No account-deletion cleanup is currently applied. | Workspace billing roles and explicitly authorized finance/support staff; confirm role matrix and access audit requirements. |
| `BillingWebhookEvent` | Provider event key, event type and processing timestamp | Provider event key may be externally linkable | Retained; no user relation exists. | Internal billing operations only; never expose raw event identifiers or payloads to ordinary workspace members. |
| `BillingCancellation` / `BillingSeatSync` | Workspace, retry state, provider identifiers, encrypted management token and last error | Provider identifiers and error text may contain personal or account data | Retained with the workspace. Retry/error fields need a minimization and expiry decision. | Internal billing workers/operators only; redact secrets and sensitive provider error text from logs and user APIs. |
| `AuditLog` | Actor/target identifiers, action, workspace, metadata, IP, user agent and timestamp | Identity, IP address, device/browser data, and arbitrary event metadata | Account finalization clears the deleted user's actor reference, matching user-target metadata, IP and user agent; records remain. Review whether this scrubbing is sufficient for all metadata shapes. | Authorized security/audit reviewers; restrict by workspace and log access to audit records. Confirm platform-administrator access boundaries. |
| `EmailDelivery` | Recipient/sender addresses, template, subject/body, provider IDs, delivery status, attempts and errors | Direct identifiers and message content | Rows to the deleted account email are removed at finalization. Retention and deletion should be confirmed against delivery/support requirements. | Delivery operators only; message bodies, addresses and provider errors must not be generally available to workspace users. |
| `EmailSuppression` | Email address, suppression reason and timestamp | Direct identifier and potentially a complaint/bounce | Not currently removed by account finalization; assess whether suppression must remain to prevent unwanted email. | Email operations only; confirm when suppression can be removed without causing unwanted contact. |
| `WorkspaceOwnershipTransfer` | Initiator, recipient, billing acceptor, timestamps and status | Direct user links and ownership/billing decisions | Retained with the workspace and tombstone references. Review post-transfer accountability requirements. | Transfer participants and authorized workspace/platform administrators only; billing acceptance records require separate billing-role access. |

## Decisions required

Product, legal and accounting owners should decide, for each record class above:

1. The lawful/business purpose for retaining it and the event that starts the retention clock.
2. The applicable retention period, including any jurisdiction or customer-contract differences.
3. Which fields are required, which can be removed or pseudonymized, and whether amounts/provider references must remain linked to an individual.
4. Which roles may access retained financial and audit data, and what access logging is required.
5. Whether legal holds, disputes, refunds, chargebacks, tax obligations, or accounting close periods pause deletion.
6. How records should be disposed of at the end of an approved period, including backups and provider copies.

Until these decisions are approved, the backend retains financial and audit records and does not invent a numeric expiry. Credentials and encrypted provider management tokens must remain restricted and must never be surfaced in API responses or logs. This note does not authorize broader access to private workspace content.

## Implementation boundary

The current account-deletion worker anonymizes the account profile into a stable tombstone, retains workspaces, shared collaboration records, shared file objects/metadata, and financial records, and clears selected identity-bearing audit fields. Purely personal attachments are deleted after the recovery period; if storage deletion fails, the account remains pending and metadata stays available for retry. This behavior is a technical preservation policy only; legal/accounting approval is outstanding. Any change to remove or retain additional personal fields requires a documented product/legal decision and corresponding migration and tests.
