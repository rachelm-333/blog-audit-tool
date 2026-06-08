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

- [x] Layer 2: Auth (registration, email verification, login, JWT)
- [x] Layer 3: Stage 1 — Business Profile & Website Scrape
- [x] Layer 4: Stage 2 — CMS Connection & Post Import
- [x] Layer 5: Stage 3 — Keyword Identification
- [x] Layer 6: Stage 4 — Audit Engine
- [x] Layer 7: Stage 5 — Rewrite Engine
- [x] Layer 8: Stage 6 — Review & Edit
- [x] Layer 9: Stage 7 — Post Back to CMS
- [x] Layer 10: Free Public Audit Tool (/audit)
- [x] Layer 11: Dashboard
- [x] Layer 12: Credits & Stripe
- [x] Layer 13: Wix & Shopify CMS integrations
- [x] Layer 14: Agency features
- [x] Layer 15: Admin Panel
- [x] Layer 16: Support Centre
- [x] Layer 17: Onboarding flow & UX polish

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

## Layer 4: CMS Connection & Post Import (Section 8)

- [x] Extend `posts` table: add `featured_image_url`, `featured_image_alt`, `body_image_alts` (JSONB), `categories` (JSONB), `tags` (JSONB) columns
- [x] Run migration for new posts columns
- [x] Build AES-256-GCM encryption service for CMS credentials at rest
- [x] Build WordPress REST API import engine (Application Password auth, all 3 statuses, Yoast keyword, all fields)
- [x] Build CMS connections DB helpers: createConnection, getConnection, updateConnectionStatus, listConnections
- [x] Build posts DB helpers: upsertPost, listPostsByBusiness, getPostById
- [x] Build tRPC `cms.connect` procedure (WordPress only — validates credentials, saves encrypted to DB)
- [x] Build tRPC `cms.testConnection` procedure
- [x] Build tRPC `cms.importPosts` procedure (post type filter, no trash, upserts by cms_post_id)
- [x] Build tRPC `cms.getConnection` and `cms.listConnections` procedures
- [x] Build tRPC `cms.disconnectConnection` procedure
- [x] Wix, Shopify, Zapier connection flows fully implemented (Layer 13)
- [x] Build all 5 error states from Section 8.4 / Table 12
- [x] Build frontend: platform selector screen
- [x] Build frontend: WordPress connection form (URL, username, application password)
- [x] Build frontend: import options (Published / Scheduled / Draft / All)
- [x] Build frontend: import progress indicator ("Connecting to WordPress... Importing your posts...")
- [x] Build frontend: post import results screen (count by status)
- [x] Build frontend: all 5 error state messages
- [x] Verify: WordPress connection works with real credentials
- [x] Verify: published, scheduled, draft posts all import correctly
- [x] Verify: trash posts never imported
- [x] Verify: author ID, author name, CMS post ID, focus keyword stored accurately
- [x] Verify: credentials encrypted in DB (never plain text)
- [x] Verify: all 5 error states display correct messages
- [x] Vitest tests for encryption, WP import engine, and all tRPC procedures

## Layer 5: Keyword Identification (Section 9)

- [x] Add `keyword_source` column to posts table (TEXT: cms_scraped / ai_suggested / user_entered)
- [x] Update Layer 4 WordPress import to set keyword_source=cms_scraped when focus_keyword found
- [x] Build AI keyword suggestion service: LLM call with post title + first 500 words → top 3 keywords with rationale
- [x] Build cannibalisation detection: scan all posts for same business for duplicate focus_keyword, set cannibalization_flag=true on all affected posts
- [x] Build tRPC `keyword.suggest` procedure (returns 3 AI suggestions for a post with no keyword)
- [x] Build tRPC `keyword.confirm` procedure (sets focus_keyword + keyword_source on post)
- [x] Build tRPC `keyword.runCannibalisationScan` procedure (scans all posts for business, sets flags)
- [x] Frontend: keyword status indicator on post list (cms_scraped / ai_suggested / user_entered / missing)
- [x] Frontend: AI keyword suggestion modal with 3 clickable options + text field for custom keyword
- [x] Frontend: exact warning message from spec: "No focus keyword was found for this post..."
- [x] Frontend: cannibalisation warning banner linking to both conflicting posts
- [x] Frontend: Fix button disabled with tooltip "Resolve the duplicate keyword before rewriting." on flagged posts
- [x] Verify: post with CMS keyword shows keyword_source=cms_scraped
- [x] Verify: post with no keyword shows 3 AI suggestions
- [x] Verify: user can confirm suggestion or type their own
- [x] Verify: two posts sharing same keyword both show cannibalisation warning + cannibalization_flag=true in DB
- [x] Verify: Fix button disabled on flagged posts
- [x] Vitest tests for all Layer 5 flows (189 tests pass — 28 Layer 5 + all prior layers)

## Layer 6: Audit Engine (Section 10 of Scope)

- [x] Add `audit_status` enum column to posts table (pending / running / complete / failed)
- [x] Add `audited_at` timestamp column to posts table
- [x] Run migration for new posts columns
- [x] Build mechanical audit checker: P1 keyword density, P2 keyword in H1, P3 keyword in H2, P4 keyword in H3, P5 keyword in first 100 words, P6 keyword in URL, P7 meta title, P8 meta description, P13 schema markup (page source check), P16 word count / article type
- [x] Build AI audit scorer: single LLM call for P9 opening answer block, P10 external authority link, P11 internal CTA link, P12 internal blog link, P14 E-E-A-T signals, P15 human authenticity
- [x] Build audit DB helpers: saveAuditResults, getAuditResults, listPostsForDashboard
- [x] Build tRPC `audit.runAudit` procedure (single post — free, no credits)
- [x] Build tRPC `audit.runAuditAll` procedure (all posts for business — free, no credits)
- [x] Build tRPC `audit.getDashboard` procedure (health score, grade breakdown, score potential, cannibalisation warnings)
- [x] Build tRPC `audit.getPostResults` procedure (per-post audit results)
- [x] Wire audit router into routers.ts
- [x] Frontend: Audit All button on PostList page with progress indicator
- [x] Frontend: per-post audit results panel (score, grade badge, passing/failing points in plain English)
- [x] Frontend: Fix This Post button (1 Credit · Ready in ~2 minutes) — placeholder for Layer 7
- [x] Frontend: Dashboard overview (health score, grade breakdown, score potential banner, cannibalisation warnings)
- [x] Failure handling: AI call fails → mark P9/P10/P11/P12/P14/P15 as unable_to_score, show retry message
- [x] Verify: audit runs on a real WordPress post, all 16 points scored
- [x] Verify: mechanical points score correctly against known test values
- [x] Verify: AI-scored points return pass/fail with plain-English notes
- [x] Verify: score and grade are correct
- [x] Verify: results stored in audit_results JSONB
- [x] Verify: dashboard shows health score, grade breakdown, score potential
- [x] Verify: audit consumes zero credits
- [x] Vitest tests for all Layer 6 flows (223 total tests pass — 34 Layer 6 + all prior layers)

## Layer 7: Rewrite Engine (Section 11 of Scope)

- [x] Add `paa_question` TEXT column to posts table
- [x] Add `article_type` enum column (cornerstone/pillar/cluster) to posts table
- [x] Add `schema_json` JSON column to posts table
- [x] Add `rewrite_status` enum column (pending/running/complete/failed/needs_manual_review) to posts table
- [x] Add `rewritten_at` TIMESTAMP column to posts table
- [x] Run migration for new posts columns
- [x] Build PAA lookup service: LLM call with keyword → most relevant People Also Ask question
- [x] Build article type inference: cornerstone (2000+ words), pillar (1000–1999), cluster (<1000)
- [x] Build internal link map builder: all published posts + scheduled posts before this post's date
- [x] Build Pass 1 rewrite: LLM call with full context (keyword, PAA, article type, word count target, business profile, internal link map, 16-point requirements, failing points list)
- [x] Build mechanical enforcement layer: P1 density, P3 H2 keyword, P5 first 150 words, P7 meta title 60 chars, P8 meta description 140–160 chars
- [x] Build Pass 2 fingerprint scrub: second LLM call to rewrite language patterns only (no SEO structure/keyword/link/fact changes)
- [x] Build schema generation: Article + Breadcrumb schema for all posts; FAQ schema for Cornerstone/Pillar
- [x] Build re-scoring: run full Layer 6 audit engine against rewritten content, store rewrite_score and rewrite_grade
- [x] Build auto-retry: if rewrite_score < 13, retry from Pass 1 once with adjusted instructions
- [x] Build credit deduction: deduct 1 credit before Pass 1, log credit_transactions type=use with post_id
- [x] Build credit refund: if retry also scores < 13, refund 1 credit, log type=refund, set rewrite_status=needs_manual_review, notify user
- [x] Build zero-credits guard: block rewrite if credits_remaining=0, show "You have no credits remaining. Buy more to continue rewriting posts."
- [x] Build rewrite DB helpers: saveRewriteResult, setRewriteStatus, getPostForRewrite
- [x] Build tRPC `rewrite.getPaaQuestion` procedure (returns suggested PAA, user can confirm or change)
- [x] Build tRPC `rewrite.runRewrite` procedure (full pipeline: credit deduct → Pass 1 → enforce → Pass 2 → schema → re-score → auto-retry → save)
- [x] Build tRPC `rewrite.getRewriteResult` procedure (returns rewrite result for a post)
- [x] Wire rewrite router into routers.ts
- [x] Frontend: PAA confirmation modal (shows suggested PAA, user can confirm or type their own before rewrite starts)
- [x] Frontend: Fix This Post button triggers PAA modal then rewrite
- [x] Frontend: rewrite progress indicator (step-by-step: Deducting credit → Pass 1 → Enforcing → Pass 2 → Scoring → Done)
- [x] Frontend: rewrite results panel (rewrite_score, rewrite_grade, comparison with audit_score)
- [x] Frontend: zero-credits error message
- [x] Frontend: needs_manual_review state with user notification
- [x] Verify: rewrite runs end-to-end on a real post
- [x] Verify: both AI passes run
- [x] Verify: mechanical enforcement fires correctly
- [x] Verify: score after rewrite is at least 13
- [x] Verify: credit deducted from iaudit_users and logged in credit_transactions
- [x] Verify: auto-retry triggers if score below 13
- [x] Verify: credit refunded and user notified if retry also fails
- [x] Verify: schema generated and stored
- [x] Verify: zero credits remaining blocks the rewrite
- [x] Vitest tests for all Layer 7 flows

## Layer 8: Review and Edit (Sections 12 and 20)

- [x] Layer 8: Stage 6 — Review and Edit
- [x] Build review.db.ts: getPostForReview, saveApprovedContent, setApprovedStatus
- [x] Build tRPC review router: getPost, saveEdits, rescore, approveForPostBack
- [x] Wire review router into routers.ts
- [x] Install TipTap rich-text editor
- [x] Frontend: ReviewEdit page (/review/:postId) with rich-text body editor
- [x] Frontend: meta title field with live character counter (red over 60)
- [x] Frontend: meta description field with live counter (green 140-160, warn outside)
- [x] Frontend: read-only fields: URL (with tooltip), author name, publish/scheduled date, post status
- [x] Frontend: image alt text list (every img in body listed with individual editable alt text field)
- [x] Frontend: auto-save every 30 seconds with visual indicator ("Saved" / "Saving...")
- [x] Frontend: manual Save button always visible
- [x] Frontend: re-score on save — updates score/grade badge; shows point-specific warning on regression
- [x] Frontend: before/after score comparison (original audit score vs rewrite score) with grade badges
- [x] Frontend: export buttons — Plain Text, HTML, Markdown — always visible, download on click
- [x] Frontend: Approve and Post Back button (prominent, advances to Layer 9)
- [x] Add ReviewEdit route to App.tsx
- [x] Add "Review" link from PostList to ReviewEdit page for posts with completed rewrites
- [x] Verify: inline body edits persist on save
- [x] Verify: meta title counter turns red over 60 chars
- [x] Verify: meta description counter shows green 140-160, warns outside range
- [x] Verify: URL field visible but not editable
- [x] Verify: auto-save fires every 30 seconds
- [x] Verify: re-score runs on manual save and updates displayed score
- [x] Verify: deliberate bad edit (delete meta description) triggers point-specific warning
- [x] Verify: all three export formats download correctly
- [x] Verify: Approve and Post Back button present and functional
- [x] Vitest tests for all Layer 8 flows

## Layer 9: Post Back to CMS (Section 13 + 16.1 of Scope)

- [x] Build `server/postback.service.ts` — WordPress PATCH /wp-json/wp/v2/posts/{cms_post_id} with ONLY: content (body_approved), meta title, meta description, image alt texts, author_id_cms. NEVER include status, date, or slug.
- [x] Build `server/postback.db.ts` — DB helpers: getPostForPostBack, setPostBackComplete, setPostBackFailed
- [x] Build `server/routers/postback.ts` — tRPC procedures: runPostBack (with all 4 error states), getPostBackStatus
- [x] Wire postback router into `server/routers.ts`
- [x] Error state 1: CMS connection lost → prompt reconnection before attempting write
- [x] Error state 2: Post no longer exists in CMS → offer export instead
- [x] Error state 3: Insufficient write permissions → show credentials error with instructions
- [x] Error state 4: Partial failure (content written but meta could not update) → show correct values for manual copy-paste
- [x] Schema injection: attempt via CMS API; if fails, show copyable JSON-LD fallback with exact message
- [x] Update `ReviewEdit.tsx`: wire "Approve and Post Back" button to trigger actual post-back flow
- [x] Add post-back confirmation screen: post title, final score + grade badge, live link (post_url), Blog Batcher upsell if credits=0
- [x] Add copyable JSON-LD schema fallback block with exact message from spec
- [x] Write Layer 9 vitest tests (19 new tests, 291 total)
- [x] Run full test suite — all 291 tests pass, zero TypeScript errors

## Layer 10: Free Public Audit Tool (Section 6, 20, 21 of Scope)

- [x] Add `free_rewrites` table to schema: id, email (unique), post_url, audit_score_before, rewrite_score_after, body_rewritten, meta_title_rewritten, meta_description_rewritten, created_at
- [x] Run migration for free_rewrites table
- [x] Build `server/public-audit.service.ts`: scrapeAndAudit(url) — Puppeteer scrape + full 16-point audit engine, returns score/grade/results
- [x] Build `server/public-rewrite.service.ts`: freeRewrite(params) — full Layer 7 pipeline (Pass 1 + mechanical enforcement + Pass 2 + re-score), NO credit deduction
- [x] Build `server/public-audit.db.ts`: checkEmailUsed(email), recordFreeRewrite(data), getFreeRewriteByEmail(email)
- [x] Build `server/routers/publicAudit.ts`: publicProcedure `runAudit` (scrape + audit), `runFreeRewrite` (email gate + full pipeline + save record)
- [x] Wire publicAudit router into `server/routers.ts`
- [x] Build `/audit` frontend page: hero section with URL input + "Audit This Post Free" button
- [x] Stage 1 results: score/16, grade badge, failing points list (red ❌), passing points list (green ✅), potential score line
- [x] Stage 2 CTA: "Fix This Post Free" button reveals unlock form
- [x] Stage 2 form: business name, industry, who is your customer, most important page URL, brand voice selector (4 buttons), email address
- [x] Stage 2 duplicate email error: "This email address has already used its free rewrite. Sign up for an account to fix all your posts."
- [x] Stage 2 rewrite delivery: before/after score, 3 copy buttons (Plain Text, HTML, Markdown), Blog Batcher upsell banner
- [x] Register /audit route in App.tsx (public, no auth required)
- [x] Add "Free Audit" link to nav/sidebar for unauthenticated users
- [x] Write Layer 10 vitest tests (20 new tests, 311 total)
- [x] Run full test suite — all 311 tests pass, zero TypeScript errors

## Layer 11: Dashboard (Sections 10.4, 20.3, 20.4)

- [x] Build `server/dashboard.db.ts` — getDashboardStats(businessId): overall health score, score potential, post counts by status, grade breakdown counts, cannibalisation count, credits remaining
- [x] Build `server/routers/dashboard.ts` — tRPC procedures: getStats, getPostTable, listBusinesses
- [x] Wire dashboard router into `server/routers.ts`
- [x] Frontend: Dashboard page at /dashboard (authenticated) — 4 stat cards (health score, score potential, total posts, credits remaining)
- [x] Frontend: Grade breakdown row — 4 cards (Optimised, Strong, Needs Work, Poor/Critical) with correct badge colours from spec
- [x] Frontend: Cannibalisation warning banner (orange) — appears when cannibalization_flag posts exist
- [x] Frontend: Score potential banner (blue) — appears when Poor/Critical posts exist, shows exact spec message
- [x] Frontend: Post table — title, keyword, status, score bar, grade badge, issues count, Fix/View button
- [x] Frontend: Post table filter buttons — All, Optimised, Strong, Needs Work, Poor, Critical + Published, Scheduled, Draft
- [x] Frontend: Post table sort — by score, grade, title
- [x] Frontend: Fix button disabled with tooltip on cannibalised posts
- [x] Frontend: Empty state 1 — no businesses added ("Add your first business to get started...")
- [x] Frontend: Empty state 2 — business added but no posts imported ("No posts found. Make sure your CMS connection is working...")
- [x] Frontend: Empty state 3 — posts imported but no audit run ("Your posts are ready. Click Start Audit...")
- [x] Frontend: Skeleton loader while data fetches
- [x] Write Layer 11 vitest tests (24 new tests, 335 total)
- [x] Run full test suite — all 335 tests pass, zero TypeScript errors

## Layer 12: Credits and Stripe (Sections 17, 20, 21)

- [x] Add Stripe feature via webdev_add_feature
- [x] Confirm stripe_customer_id column exists on iaudit_users; run migration if not
- [x] Build `server/credits.db.ts` — helpers: getCreditsBalance, incrementCredits, getCreditHistory, setStripeCustomerId, getStripeCustomerId, getUserByStripeCustomerId, getUserById
- [x] Build `server/stripe.service.ts` — CREDIT_PACKS (4 packs), createCheckoutSession, createOrGetStripeCustomer
- [x] Build `server/routers/credits.ts` — tRPC procedures: getBalance, getPacks, createCheckout, getHistory
- [x] Wire credits router into `server/routers.ts`; register webhook route in server entry before express.json()
- [x] Credit packs: Starter (10 credits, $19 AUD), Standard (50 credits, $79 AUD), Business (100 credits, $139 AUD), Agency (500 credits, $599 AUD)
- [x] Stripe Checkout: one-time payment in AUD, test mode, allow_promotion_codes: true
- [x] Webhook handler: on checkout.session.completed → increment credits_remaining, log credit_transactions type=purchase with stripe_payment_intent_id
- [x] Stripe customer: create on first purchase, store stripe_customer_id; reuse on subsequent purchases
- [x] Top-up reminder email at credits_remaining=3 and credits_remaining=0 (once per threshold crossing)
- [x] Frontend: Credits page at /credits — 4 pack cards with per-post price, "Credits never expire", "All prices include GST"
- [x] Frontend: Buy Now button → Stripe Checkout redirect (new tab)
- [x] Frontend: Success toast on return from Stripe (?session_id param)
- [x] Frontend: Cancel toast on return from cancelled checkout (?cancelled=1 param)
- [x] Frontend: Credit balance updates via refetchInterval after successful purchase
- [x] Frontend: In-app low-credit banner (red at 0, amber at ≤3)
- [x] Frontend: Credit history table — date, type, amount (+/-), post title (if type=use), balance after
- [x] Frontend: Blog Batcher upsell banner at bottom of Credits page
- [x] Register /credits and /credits/success routes in App.tsx
- [x] Updated DashboardLayout sidebar nav with all 5 iAudit links
- [x] Write Layer 12 vitest tests (25 new tests, 360 total)
- [x] Run full test suite — all 360 tests pass, zero TypeScript errors

## Layer 13: Wix, Shopify, and Zapier CMS Integrations (Sections 8, 13, 16.2, 16.3, 16.4)

- [x] Build `server/wix.service.ts` — connectWix (validate credentials), importWixPosts (GET /blog/v3/posts, map all fields), postBackToWix (PATCH /blog/v3/posts/{id}, body+meta only, always show JSON-LD fallback)
- [x] Build `server/shopify.service.ts` — connectShopify (validate credentials), importShopifyPosts (GET /blogs/{blog_id}/articles.json + metafields), postBackToShopify (PUT /blogs/{blog_id}/articles/{id}.json, fetch-then-merge pattern)
- [x] Build `server/zapier.service.ts` — generateWebhookToken (unique per connection), handleInboundWebhook (create/update posts row), sendOutboundWebhook (POST to user-configured URL with approved content payload)
- [x] Register Express routes for Zapier inbound webhooks at POST /api/zapier/inbound/:token (public, no auth)
- [x] Update `server/routers/cms.ts` — wire Wix connect/import, Shopify connect/import, Zapier connect/getWebhookUrl procedures
- [x] Update `server/postback.service.ts` — dispatch to correct platform service based on cms_platform field
- [x] Update `server/routers/postback.ts` — wire Wix and Shopify post-back (Wix always shows JSON-LD fallback, no API injection attempt)
- [x] Update CMS connection frontend — all 4 platform options fully functional (WordPress, Wix, Shopify, Other/Zapier)
- [x] Wix connection form: Site ID + API Key fields
- [x] Shopify connection form: Store URL + Admin API access token fields
- [x] Zapier connection: show unique inbound webhook URL + outbound webhook URL input field
- [x] Platform selector: all 4 options selectable, no "Coming soon" stubs
- [x] Write Layer 13 vitest tests (25 new tests)
- [x] Run full test suite — all 385 tests pass, zero TypeScript errors

## Layer 14: Agency Multi-Client Features (Sections 3, 21)

- [x] Backend: Add Solo restriction to `business.startScrape` — if accountType=solo and user already has ≥1 business, throw FORBIDDEN
- [x] Backend: Build `server/routers/agency.ts` — `listBusinesses` (returns all businesses for user, throws FORBIDDEN if solo) and `addBusiness` guard
- [x] Backend: Wire agency router into `server/routers.ts`
- [x] Backend: Verify all existing business-scoped queries already enforce `userId` ownership (audit, posts, cms, keywords, rewrite, review, postback)
- [x] Frontend: Create `client/src/contexts/BusinessContext.tsx` — stores selectedBusinessId in localStorage, exposes `useBusinessContext()` hook
- [x] Frontend: Update `DashboardLayout.tsx` — add Businesses section to sidebar (visible for agency accounts only), each business is a clickable nav item that sets selectedBusinessId, Add Business link at bottom
- [x] Frontend: Update `Dashboard.tsx` — read businessId from BusinessContext instead of URL param; remove inline business selector dropdown (now in sidebar)
- [x] Frontend: Update `PostList.tsx` — read businessId from BusinessContext instead of URL param
- [x] Frontend: Update `CmsConnect.tsx` — read businessId from BusinessContext instead of URL param
- [x] Frontend: Update `ReviewEdit.tsx` — read businessId from BusinessContext if needed
- [x] Frontend: Update `BusinessSetup.tsx` — after confirm, navigate to CmsConnect with the new businessId, then on CmsConnect success navigate to dashboard with new business auto-selected
- [x] Frontend: Update `Login.tsx` — after login, if agency account with existing businesses, navigate to /dashboard; if no businesses, navigate to /business/setup
- [x] Frontend: Solo accounts do not see business selector or Add Business option
- [x] Frontend: If Solo user navigates to /business/setup when they already have a business, show error and redirect
- [x] Write Layer 14 vitest tests (25 new tests)
- [x] Run full test suite — all 410 tests pass, zero TypeScript errors

## Corrections to Layers 5 and 7 (pre-Layer 15)

### Correction 1 — Layer 5: Remove AI keyword suggestion, add secondary_keywords
- [x] Add `secondary_keywords` JSON column to `posts` table in `drizzle/schema.ts`
- [x] Add `rewrite_mode` enum column (`full_rewrite | smart_patch`) to `posts` table in `drizzle/schema.ts`
- [x] Generate migration SQL and apply via `webdev_execute_sql`
- [x] Remove `suggestKeywordsForPost`, `extractFirst500Words`, `KeywordSuggestion`, `KeywordSuggestionResult` from `server/keyword.service.ts`
- [x] Remove `keyword.suggest` procedure from `server/routers/keyword.ts`
- [x] Remove `ai_suggested` from `keywordSource` enum (replaced with `cms_scraped | user_entered`)
- [x] Update `keyword.confirm` — accept `source: 'cms_scraped' | 'user_entered'` only
- [x] Add `keyword.saveKeyword` mutation — saves focusKeyword + secondaryKeywords + source, clears audit if keyword changed
- [x] Update WordPress CMS import to scrape secondary keywords (Yoast related fields, RankMath additional terms)
- [x] Update Wix CMS import to scrape secondary keywords from `post.seoData.tags`
- [x] Update Shopify CMS import to scrape secondary keywords from metafields
- [x] Update `keyword.db.ts` — add `secondaryKeywords` to `updatePostKeyword` and `getPostForKeyword`
- [x] Update `keyword.listPosts` — include `secondaryKeywords` in response
- [x] Add `keyword.exportCsv` procedure — returns CSV with post title, primary keyword, secondary keywords, post URL, post status, audit grade
- [x] Update Layer 5 tests — remove AI suggestion tests, add secondary keyword tests

### Correction 2 — Layer 5: Editable keyword with Save before Rewrite
- [x] Update `ReviewEdit.tsx` — keyword and secondary keywords are editable fields with Save Keyword button
- [x] Rewrite button disabled until keyword is saved (track `keywordSaved` state)
- [x] Show warning when keyword changed after audit: "Changing the keyword will require a full re-audit. Your current audit results will be cleared."
- [x] On confirm: clear `auditScore`, `auditGrade`, `auditResults` for the post and re-run audit before enabling rewrite

### Correction 3 — Layer 7: Smart Patch mode + secondary keywords in prompts
- [x] Add `runSmartPatch` function to `server/rewrite.service.ts` with Smart Patch prompt
- [x] Update `Pass1Input` interface — add `secondaryKeywords: string[]` field
- [x] Update `buildPass1SystemPrompt` — include secondary keywords in prompt
- [x] Update `runFullRewrite` — accept `secondaryKeywords` and pass to Pass1
- [x] Update `rewrite.runRewrite` tRPC procedure — accept `rewriteMode: 'full_rewrite' | 'smart_patch'` input
- [x] Dispatch to `runFullRewrite` or `runSmartPatch` based on `rewriteMode`
- [x] Save `rewriteMode` to `posts.rewriteMode` column after rewrite
- [x] Update `ReviewEdit.tsx` — show Full Rewrite and Smart Patch buttons
- [x] Update Layer 7 tests — add Smart Patch tests, secondary keyword prompt tests
- [x] Run full test suite — all tests pass

## Layer 15: Admin Panel

- [x] Add `error_log` table to drizzle/schema.ts (id UUID PK, user_id FK iaudit_users, business_id FK businesses nullable, post_id FK posts nullable, error_type TEXT, error_message TEXT, layer TEXT, reviewed BOOLEAN default false, created_at TIMESTAMP)
- [x] Generate and apply migration for error_log table
- [x] Build server/admin.db.ts with all admin query helpers (listAllUsers, getUserStats, addCredits, setSuspended, deleteUserAndData, getUsageDashboard, getRevenueDashboard, getErrorLog, markErrorReviewed, getKeywordRegistryForUser)
- [x] Build server/routers/admin.ts with adminProcedure guard (FORBIDDEN for non-admin)
- [x] `admin.listUsers` — all users with name, email, accountType, joinDate, creditsRemaining, totalRewrites, lastActive, isSuspended
- [x] `admin.addCredits` — increment creditsRemaining, log admin_grant credit_transaction with note
- [x] `admin.suspendUser` — toggle isSuspended true/false
- [x] `admin.deleteUser` — delete user and all associated data (businesses, posts, cms_connections, credit_transactions, error_log rows)
- [x] `admin.getUsageDashboard` — total audits, total rewrites, free rewrites, rewrite breakdown by mode, per-user breakdown
- [x] `admin.getRevenueDashboard` — total purchases, total revenue AUD, breakdown by pack size, Stripe test mode detection
- [x] `admin.getErrorLog` — all error_log rows with user email, business name, error type, message, timestamp, reviewed status
- [x] `admin.markErrorReviewed` — toggle reviewed boolean on error_log row
- [x] `admin.downloadKeywordRegistry` — CSV for all businesses of a given userId
- [x] Wire admin router into server/routers.ts
- [x] Wire logError into Layer 3 (business scrape failures), Layer 4 (CMS import failures), Layer 7 (rewrite failures), Layer 9 (post-back failures), Layer 13 (Wix/Shopify/Zapier failures)
- [x] Build client/src/pages/AdminPanel.tsx with 4 views: User List, Usage Dashboard, Revenue Dashboard, Error Log
- [x] User List view: table with all required columns, Add Credits button, Suspend/Unsuspend toggle, Delete Account (confirmation dialog), Download Keyword Registry button
- [x] Add Credits modal: number input + required note field, success toast
- [x] Usage Dashboard view: total audits, total rewrites, free rewrites, rewrite mode breakdown, per-user table, Export CSV button
- [x] Revenue Dashboard view: total purchases, total revenue, breakdown by pack, Stripe test mode banner, Export CSV button
- [x] Error Log view: table with timestamp, user email, business name, error type, error message, Mark as Reviewed checkbox, unreviewed rows highlighted
- [x] Admin nav item in DashboardLayout sidebar — completely absent from DOM for non-admin users (no hidden/greyed, not in DOM at all)
- [x] Register /admin route in App.tsx
- [x] Write Layer 15 vitest tests (admin guard FORBIDDEN for non-admin, listUsers, addCredits, suspendUser, deleteUser, getUsageDashboard, getRevenueDashboard, getErrorLog, markErrorReviewed, downloadKeywordRegistry, error_log population)
- [x] Run full test suite — all tests pass, zero TypeScript errors

## Layer 16: Support Centre

- [x] Create `server/routers/support.ts` — `sendContactEmail` procedure (Resend to rachel.m@noize.com.au)
- [x] Wire support router into `server/routers.ts`
- [x] Create `client/src/components/HelpTooltip.tsx` — reusable inline `?` icon with 2–3 sentence tooltip
- [x] Create `client/src/pages/SupportCentre.tsx` — 15 articles, real-time search, contact form
- [x] Add Support nav item to DashboardLayout sidebar (visible to all authenticated users)
- [x] Add `/support` route to App.tsx
- [x] Wire tooltips into BusinessSetup.tsx (Brand Voice, Primary CTA URL)
- [x] Wire tooltips into CmsConnect.tsx (all CMS credential fields)
- [x] Wire tooltips into ReviewEdit.tsx (focus keyword, secondary keywords, meta title, meta description, schema injection)
- [x] Wire tooltips into PostList.tsx (rewrite mode selector)
- [x] Write Layer 16 vitest tests (sendContactEmail, article search, tooltip rendering)
- [x] Run full test suite — all tests pass

## Layer 17: Onboarding Flow, Blog Batcher Upsell & Final UX Polish

### DB Migration
- [x] Add `onboarding_complete` BOOLEAN column (default false) to `iaudit_users` table
- [x] Run migration via webdev_execute_sql

### Onboarding Flow
- [x] Build `client/src/pages/Onboarding.tsx` — 5-step wizard (Welcome, Business, CMS, Credits, Audit)
- [x] Step 1: Welcome screen — iAudit logo, tagline, Get Started button
- [x] Step 2: Business profile — embed BusinessSetup flow, must complete before Step 3 unlocks
- [x] Step 3: CMS connection — embed CmsConnect flow, must connect before Step 4 unlocks
- [x] Step 4: Buy credits or skip — show 4 credit packs + "Skip for now" link
- [x] Step 5: Run first audit — Start Audit button + explanatory text; on completion set onboarding_complete=true
- [x] Add `onboarding_complete` field to iaudit_users Drizzle schema
- [x] Build tRPC `iauth.completeOnboarding` procedure — sets onboarding_complete=true
- [x] Add `/onboarding` route to App.tsx
- [x] Guard: new users redirected to /onboarding after first login (check onboarding_complete in auth flow)
- [x] Guard: returning users redirected to /dashboard if they land on /onboarding directly
- [x] Progress indicator (Step X of 5) visible on Steps 2–5

### Blog Batcher Upsell
- [x] Sidebar: persistent "Create New Posts → Blog Batcher" link at bottom of DashboardLayout sidebar (accent blue, always visible)
- [x] Post-completion screen (PostBack): add Blog Batcher banner after successful post-back
- [x] Zero credits screen (Credits page): add secondary Blog Batcher line below top-up CTA
- [x] Free audit tool delivery screen (/audit): add Blog Batcher upsell banner after free rewrite delivered
- [x] All upsell links use href="https://blogbatcher.com.au"

### Final UX Polish
- [x] Audit every screen for empty states — no blank white areas when data is absent
- [x] Audit every screen for loading states — skeleton loaders or spinners on all data fetches
- [x] Audit every screen for error states — plain-English messages, no raw error codes
- [x] Add live character counters to meta title and meta description on ALL screens where they appear
- [x] Confirm all Layer 16 HelpTooltips are present and working on every screen
- [x] Mobile responsiveness: sidebar collapses on ≤768px with hamburger menu
- [x] Verify hamburger menu opens/closes sidebar on tablet

### Tests & Pre-launch
- [x] Write Layer 17 vitest tests (onboarding_complete flag, completeOnboarding procedure, Blog Batcher upsell placement)
- [x] Run full test suite — all tests pass, zero TypeScript errors
- [x] Pre-launch checklist review: RESEND_FROM_EMAIL, Stripe live keys, Blog Batcher URL, env vars documented

## Bug Fixes (June 2026)

- [x] Fix Free Audit page (/audit) — stuck on "Auditing..." for Wix/JS-rendered pages due to Puppeteer timeout; replace with fast HTTP fetch + better error messaging
- [x] Fix Audit All button disabled — add keyword.bulkSuggest tRPC procedure to AI-suggest keywords for all posts without one; add "Suggest Keywords for All" button to PostList UI
- [x] Add tooltip/explanation to Audit All button explaining why it requires keywords

## Bug Fixes — Free Audit Scraper (Wix Pages)

- [x] Fix Puppeteer scraper to use networkidle2 instead of networkidle0 (Wix never reaches networkidle0 due to analytics calls)
- [x] Add DOM-based content extraction using page.evaluate() with priority selectors ([data-hook="post-description"] for Wix, then article, main)
- [x] Fix keyword auto-extraction from page title when no meta keyword found
- [x] Update AuditResults UI to show auto-detected keyword as a green confirmed badge (not a scary warning)
- [x] Add "Change" button to let user override the auto-detected keyword
- [x] Clean up TypeScript errors from scraper refactor

## Bug Fixes — Audit Check Accuracy (False Negatives)

- [x] Fix P9 (Opening Answer Block): pass plain text opening 500 words to AI, explicitly instruct AI to look in body not title
- [x] Fix P10 (External Authority Link): mechanically pre-extract all external links from HTML and pass as a clean list to AI
- [x] Fix P15 (Human Authenticity): pass plain text body (not raw HTML with CSS/JS noise) to AI
- [x] Fix P16 (Article Type Structure): raise cornerstone ceiling from 3,200 to 5,000 words (13-min reads are valid cornerstone articles)
- [x] Add Re-audit button (re-runs audit on same URL without clearing results)
- [x] Add "Audit a different post" / Clear button (clears results and URL, scrolls back to top)
- [x] Fix P11 (Internal CTA Link): mechanically pre-extract all internal links and pass as a list; broaden CTA detection to include product-page, store, and any non-blog internal link with CTA anchor text
- [x] Fix P12 (Internal Blog Link): use mechanically pre-extracted internal links list; AI now has the full list to check against
- [x] Add extractInternalLinks() helper that identifies internal links by domain match or relative path, excludes self-links to current post URL

## Bug Fixes — Rewrite Engine

- [x] Fix critical bug: rewrite engine was returning success:false and showing "credits refunded" without ever displaying the rewritten article
- [x] Fix: always save and deliver the best rewrite result regardless of score; needsManualReview flag shown as a notice, not a blocker
- [x] Fix: when retry scores higher than first attempt, pick the best result (not just the retry)
- [x] Fix: retry catch block now saves first attempt result before refunding
- [x] Improve Pass 1 prompt: explicit mandatory structure for P9 (opening answer block with exact HTML example), P10 (external authority link with acceptable sources), P11 (CTA link with exact URLs), P12 (internal blog link), P14 (E-E-A-T with 2+ required signals), P15 (banned phrases list)
- [x] Improve Pass 1 prompt: word count is now marked MANDATORY with instruction to count carefully
- [x] Improve Pass 1 prompt: Australian English spelling rules explicitly stated

## Bug Fixes — Rewrite Quality (Target 14-16/16)

- [x] Add post-rewrite mechanical enforcement for P9 (opening answer block injection if missing)
- [x] Fix re-scoring audit to use plain text + internal link extraction (same as free audit fixes)
- [x] Add mechanical enforcement for P11 (inject CTA link if AI omitted one)
- [x] Add mechanical enforcement for P12 (inject internal blog link if AI omitted one)
- [x] Add mechanical enforcement for P13 (inject schema JSON-LD into body before re-scoring so P13 always passes)
- [x] Fix ARTICLE_TYPE_TARGETS in rewrite service to match audit service (cornerstone 2500-5000, pillar 1500-2499, cluster 800-1499)
- [x] Fix inferArticleType thresholds to match (>=2500 cornerstone, >=1500 pillar)
- [x] Run mechanical enforcement twice: once after Pass 1, once after Pass 2 fingerprint scrub (to catch regressions)
- [x] Raise rewrite target threshold from 13 to 14 in the router

## Bug Fixes — Word Count Targets & Editor UX

- [x] Fix word count targets: Cornerstone 2500-3200 (±50), Pillar 1500-1800 (±50), Cluster 1000-1200 (±50) — updated both audit.service.ts and rewrite.service.ts
- [x] Fix rewrite engine to target the midpoint of the word count range (not just minimum)
- [x] Add "Re-run Rewrite" button to the post editor page (amber button in header, uses stored paaQuestion, deducts 1 credit)
- [x] Add rewrite.rerunRewrite tRPC procedure to the rewrite router
- [x] Fix invisible header buttons in post editor (now slate-800 bg with slate-200 text — clearly visible on dark navy)
- [x] Fix HTML output spacing: added instruction to place blank line between every heading and paragraph
- [x] Preserve original images in rewrite: added PRESERVE ALL IMAGES instruction to Pass 1 prompt
- [x] Fix saveEdits re-scoring: now passes business primaryCtaUrl so P11 scores correctly
- [x] Fix saveEdits score counting: now counts pass + na (not just pass) to match audit service semantics
- [x] Add paaQuestion and articleType to getPostForReview query so review page can access them

## Feature — Editor Sidebar SEO Breakdown

- [x] Add SeoScorePanel component to ReviewEdit sidebar: shows all 16 points with pass/fail/unable-to-score grouped sections
- [x] Failing points shown first in red with the exact reason (note field) so user knows what to fix
- [x] Passing points shown in green (collapsible, expanded by default)
- [x] Panel collapses/expands via "Point Breakdown" toggle button
- [x] currentAuditPoints state initialised from post.auditResults on load, updated on every save
- [x] saveEdits onSuccess now updates currentAuditPoints from the re-score response
- [x] Fix saveEdits: now passes business primaryCtaUrl and counts na as passing (already done in previous batch)
