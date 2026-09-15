# Deferred decisions

Items the owner has chosen not to build yet, each with the condition that
reopens it. Recorded on 2026-09-14 from the RFC 0004 and RFC 0005 decisions of
2026-09-12. Nothing on this list is due now.

| Item                    | Source        | Deferred on | Reopens when                                                    |
| ----------------------- | ------------- | ----------- | --------------------------------------------------------------- |
| SAML sign-in            | RFC 0004, H11 | 2026-09-12  | A buyer asks for it; OIDC and SCIM cover the demand seen so far |
| PDF generation          | RFC 0004, H10 | 2026-09-12  | A business module names the document it needs                   |
| Outbox event bus        | RFC 0004, H9  | 2026-09-12  | A second module needs decoupling from a producer                |
| Per-tenant mail wording | RFC 0005, I5  | 2026-09-12  | A business asks for it; the locale rule from I4 already exists  |

When a trigger fires, reopen the RFC section named in the source column and
run it through `spec-interview` before implementation. Keep this file in sync
with the RFC status lines when an item moves.
