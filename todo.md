# iAudit — Project TODO

## Layer 1: Database Schema (Section 14 of Scope)

- [x] Write Drizzle schema for `iaudit_users` table (UUID PK, email unique varchar(255), password_hash, name, account_type enum, email_verified, credits_remaining, credits_total_purchased, is_suspended, stripe_customer_id, created_at, updated_at)
- [x] Write Drizzle schema for `businesses` table (UUID PK, user_id FK→iaudit_users, all text fields, services JSONB, secondary_ctas JSONB, competitors JSONB, scrape_status enum, stage1_complete, created_at, updated_at)
- [x] Write Drizzle schema for `cms_connections` table (UUID PK, business_id FK→businesses, platform enum, site_url, credentials_encrypted JSONB, connection_status enum, last_sync_at, created_at)
- [x] Write Drizzle schema for `posts` table (UUID PK, business_id FK→businesses, all CMS fields, body_original/rewritten/approved, audit_results JSONB, all grade/score/rewrite fields, cannibalization_flag, created_at, updated_at)
- [x] Write Drizzle schema for `credit_transactions` table (UUID PK, user_id FK→iaudit_users, type enum, credits_delta, post_id FK→posts nullable, stripe_payment_intent_id, note, created_at)
- [x] Add all required indexes (iaudit_users.email unique, businesses.user_id, cms_connections.business_id, posts.business_id, posts.focus_keyword, credit_transactions.user_id)
- [x] Generate migration SQL via drizzle-kit generate
- [x] Apply migration to database (all 5 tables + oauth_users + all indexes created)
- [x] Verify all 5 tables created with no errors
- [x] Verify all foreign keys correct (structural verification via information_schema)
- [x] Test insert and read on every table (44/44 vitest tests pass)
- [x] Confirm zero TypeScript or database errors (pnpm check passes clean)

## Layer 2–17: Future Layers (do not build until instructed)

- [ ] Layer 2: Auth (registration, email verification, login, JWT)
- [ ] Layer 3: Stage 1 — Business Profile & Website Scrape
- [ ] Layer 4: Stage 2 — CMS Connection & Post Import
- [ ] Layer 5: Stage 3 — Keyword Identification
- [ ] Layer 6: Stage 4 — Audit Engine
- [ ] Layer 7: Stage 5 — Rewrite Engine
- [ ] Layer 8: Stage 6 — Review & Edit
- [ ] Layer 9: Stage 7 — Post Back to CMS
- [ ] Layer 10: Free Public Audit Tool (/audit)
- [ ] Layer 11: Dashboard
- [ ] Layer 12: Credits & Stripe
- [ ] Layer 13: Wix & Shopify CMS integrations
- [ ] Layer 14: Agency features
- [ ] Layer 15: Admin Panel
- [ ] Layer 16: Support Centre
- [ ] Layer 17: Onboarding flow & UX polish
