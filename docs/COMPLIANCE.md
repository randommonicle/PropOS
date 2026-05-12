# PropOS — Compliance Notes

## UK GDPR

- Supabase project region: eu-west-2 (London). Set at project creation; cannot be changed.
- Personal data fields are limited to what is strictly necessary for property management operations.
- `retention_until` on `documents` table enables automated GDPR retention policy enforcement.
- `leaseholders.is_current = false` records are retained per lease obligation; deletion must be a deliberate PM action with confirmation UI.
- Data export: full tenant data export capability is required before any client off-boarding.

## RICS Compliance

- `bank_accounts.rics_designated` flags accounts that are RICS-designated client accounts.
- `payment_authorisations` dual-auth workflow satisfies RICS client money handling rules.
- `service_charge_accounts` status lifecycle (draft → active → reconciling → finalised) mirrors RICS service charge accounting obligations.
- `demands.s21b_attached` enforcement (cannot issue demand without Summary of Rights) satisfies LTA 1985 s.21B.

## Building Safety Act 2022 — Higher-Risk Building

Canonical citation form (AUDIT R-8 close in 00034): `Building Safety Act 2022 — Higher-Risk Building`. Used verbatim in user-facing UI strings; specific statutory section citations (`s.78`, `s.83`, `s.85`, `s.88`, `s.91`) retain their concrete form in migration comments and audit-log surfaces.

- `golden_thread_records` table is immutable by design (no `updated_at`, RLS blocks DELETE and UPDATE).
- `pgAudit` captures all DML at the database level for the statutory audit trail.
- `properties.is_hrb` flag gates Higher-Risk Building workflows (1:1-matched to `buildings_bsa.is_hrb`); all properties track fire risk assessment regardless of HRB status.
- `bsa_mandatory_occurrences` satisfies mandatory occurrence reporting obligations for Higher-Risk Buildings under Building Safety Act 2022 s.78.
- `principal_accountable_persons` (00034) backs the multi-PAP regime per Building Safety Act 2022 s.83 — corporate and resident accountable persons coexist via an identity-XOR check.
- `building_safety_cases` (00034) carries the per-Higher-Risk-Building Safety Case Report per Building Safety Act 2022 s.85, with supersede-chain immutability (no `updated_at`; revisions create new rows).
- `safety_strategies` (00034) carries Fire and Structural strategies via a `strategy_type` discriminator; review cadence + responsible party tracked structurally.
- `golden_thread_documents` (00034) replaces the inline `golden_thread_records.document_ids[]` with a proper junction (per-link metadata, primary-flag partial-unique idx).
- Golden Thread records are superseded (not deleted or overwritten) — new record created with `superseded_by_id` set on the old record.

## LTA 1985 Compliance

- s.20 threshold: £250 per leaseholder. Defined as `SECTION_20_THRESHOLD_GBP` constant in `/app/src/lib/constants.ts`.
- s.20B: 18-month rule on service charge demand enforced by Edge Function `financial-rules`.
- s.21B: Summary of leaseholder rights must be attached before demand can be issued. Enforced by Edge Function.

## Data Security

- `bank_accounts.sort_code_last4` and `account_number_last4`: only last 4 digits stored. Full account details are never persisted.
- `dispatch_log.token`: single-use tokenised URLs for contractor accept/decline. Tokens expire after `token_expires_at`.
- RLS enforces `firm_id` isolation on every table. Cross-tenant data access is impossible at the database layer.
