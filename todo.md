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

## Layer 2: Authentication (Section 4 of Scope)

- [x] Add DB tables: `email_verification_tokens`, `password_reset_tokens`, `refresh_tokens`
- [x] Run migration for the 3 new auth token tables
- [x] Set up Resend API key secret
- [x] Build auth service: bcrypt password hashing, UUID generation, JWT signing/verification
- [x] Build email service: send verification email, send password reset email via Resend
- [x] Build tRPC `iauth.register` procedure (solo/agency only — admin blocked on public form)
- [x] Build tRPC `iauth.verifyEmail` procedure (sets email_verified=true, deletes token)
- [x] Build tRPC `iauth.login` procedure (returns access JWT + refresh token, sets HttpOnly cookie)
- [x] Build tRPC `iauth.logout` procedure (invalidates refresh token)
- [x] Build tRPC `iauth.refresh` procedure (rotates refresh token, issues new access token)
- [x] Build tRPC `iauth.forgotPassword` procedure (sends reset link via Resend, 1-hour expiry)
- [x] Build tRPC `iauth.resetPassword` procedure (validates token, hashes new password, invalidates all tokens)
- [x] Verify: registration creates iaudit_users row
- [x] Verify: email verification link works end-to-end
- [x] Verify: login returns valid JWT
- [x] Verify: logout invalidates refresh token
- [x] Verify: password reset sends email and link works
- [x] Verify: account_type=admin blocked on public signup
- [x] 99 vitest tests pass with zero TypeScript errors (50 Layer 2 + 48 Layer 1 + 1 scaffold)

## Pre-Launch Checklist (MUST complete before going live)

- [ ] ⚠️  RESEND EMAIL SENDER: Update `RESEND_FROM_EMAIL` in Settings → Secrets to a real verified sender address (e.g. noreply@iaudit.com.au). Go to resend.com → Domains → Add Domain, verify DNS records, then update the secret. Without this, NO emails (verification, password reset) will be delivered to users.
- [ ] Connect Stripe live keys (replace test keys) when pricing is finalised
- [ ] Verify all environment variables are set for production

## Layer 3: Business Profile & Website Scrape (Section 7 of Scope)

- [x] Install puppeteer-core + @sparticuz/chromium for serverless-compatible headless scraping
- [x] Build scrape engine: fetch homepage, about, services, contact (max 10 pages, 30s timeout)
- [x] Implement all 5 scrape failure states: 404/unreachable, JS-rendered fallback, timeout (partial data), non-English (AI translates), robots.txt blocked (manual fill)
- [x] Build AI brand voice inference: invokeLLM with scraped copy → brand_voice paragraph + tone label
- [x] Build businesses DB helpers: createBusiness, getBusinessByUserId, updateBusiness
- [x] Build tRPC `business.startScrape` procedure (creates pending business row, triggers scrape)
- [x] Build tRPC `business.getScrapeStatus` procedure (poll scrape progress)
- [x] Build tRPC `business.saveBusiness` procedure (save partial or complete profile)
- [x] Build tRPC `business.confirmBusiness` procedure (validates required fields, sets stage1_complete=true)
- [x] Build frontend: URL input screen (single field + Begin button)
- [x] Build frontend: scrape progress indicator ("Analysing your website...")
- [x] Build frontend: editable review form with all 14 fields, red border on empty required fields
- [x] Build frontend: Continue button disabled until all required fields filled
- [x] Build frontend: Save Progress button always visible
- [x] Verify: scrape runs on a real website and populates fields correctly
- [x] Verify: brand voice inferred by AI and pre-filled
- [x] Verify: all required fields enforced (Continue button disabled)
- [x] Verify: Save Progress works at all times
- [x] Verify: stage1_complete sets to true on confirmation
- [x] Verify: all 5 scrape failure states display correct messages
- [x] Vitest tests for scrape engine, AI inference, and all tRPC procedures (123/123 pass)
