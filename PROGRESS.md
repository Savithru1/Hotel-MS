# PROGRESS: Hospitality Platform (live checklist)

> **This is the single source of truth for what is done and what is next.**
> Every Claude session MUST read this file first, follow it, and keep it up to date (rules in `CLAUDE.md`).
> Detail for each task lives in `IMPLEMENTATION_PLAN.md`. This file only tracks status.

Legend: `[x]` done and verified, `[ ]` not done. A task being worked on right now gets the suffix `(IN PROGRESS)`. A task that cannot proceed gets `(BLOCKED: reason)`.

---

## RESUME POINT (update this block every time)

- **Last updated:** 2026-11-26
- **Current phase / sub-phase:** Phase 1. **P1.3 to P1.8 are done and verified** (backend, staff app and a real-browser check). P1.8 (food menu and kitchen) was built on the owner's "start 1.8". **P1.9 (facilities, spa, recreation) or P1.10 (billing) is next**, order flexible; P1.10 needs the open items below first. Work stops here until the owner says to continue. Pushed to `Savithru1/Hotel-MS` `main` on the owner's instruction (see the Git line).
- **Currently in progress:** nothing.
- **Next action:** wait for the owner. Then P1.9 (or P1.10; P1.8, P1.9 and P1.7 order is flexible after P1.6). To run the whole system locally: `pnpm db:up` (Docker Desktop must be running), copy `.env.example` to `.env` and fill the two JWT secrets, `pnpm --filter @hospitality/backend seed`, then `pnpm --filter @hospitality/backend dev` and `pnpm --filter @hospitality/staff-app dev`; sign in at http://localhost:5173 with property `grand-plaza` and e.g. `front.desk@grandplaza.example`. The development password is in `apps/backend/src/modules/seed/seed.ts` (the seed refuses non-local databases and production).
- **Blockers / open questions for the owner:** none for P1.1 or P1.2. Open items are in section "Open items" at the bottom.
- **Git / push status (updated 2026-11-26):** the owner asked for everything to be updated in `https://github.com/Savithru1/Hotel-MS` with all new commits by `s4meer-dev` only. That repo already held the P1.1 to P1.7 history (11 commits authored by `Savithru1`); it was left as it is, because changing it would need a force-push. On top of it, `s4meer-dev` added the owner's two docs commits (README and `docs/01` to `docs/05`) and the P1.8 work as separate conventional commits, pushed to `main` as a normal fast-forward, never forced. No `Co-Authored-By` trailer is used, per the owner. In the local clone that remote is named `hotelms`; `origin` still points at `https://github.com/s4meer-dev/xd.git` and was not changed. The earlier "do not push yet" instruction was lifted for this push only; push again only when the owner says so. Older note, kept for reference: a remote now exists: `origin` -> `https://github.com/Savithru1/Hotel-MS.git` (it was NOT added by Claude; it appeared between P1.1 and the end of P1.2, and `origin/main` already contained the P1.1 commit, pushed by the owner or another process). **The owner said "do not push anything yet" (repeated for P1.3 to P1.7), so everything after the P1.1 commit is committed locally only (`main` is ahead of `origin/main`).** Do not push until the owner says to. Once they do, push `main`, then update this line.
- **State of the code:** backend modules exist for auth, staff, properties, rooms and room types, guests, bookings (with `room_nights`), housekeeping (`service_requests`), maintenance, menu (GridFS photos) and food orders, plus the event bus and Socket.IO gateway; 675 backend tests (the 97% coverage figure was measured before P1.8 and not re-measured). The staff app (`apps/staff-app`, React 19 + Vite + Tailwind 4 + TanStack Query + react-router) has the sign-in flow, role-based menu, front desk (today, room board, bookings, new booking, calendar, guests), housekeeping and maintenance queues, the kitchen screen (order board, new-order dialog, cancel, sound switch, late highlighting) and the menu editor (items, options, photos), rooms, room types, staff and property settings; 136 component tests. `apps/guest-app` is still an empty skeleton. Shared packages: `constants`, `shared-types`, `validation` (Zod + E.164 phone normalisation). Total tests across the repo: 938 (constants 23, validation 55, staff app 136, backend 675, repo structure 49).
- **Toolchain facts:** Node 24, pnpm 12.23.0 (installed globally with npm), TypeScript 6.0.3 (pinned below 6.1 because typescript-eslint 8.74 requires it), ESLint 10, Vitest 5, Prettier 3. pnpm added a `minimumReleaseAgeExclude` block to `pnpm-workspace.yaml` for vitest, coverage and mongoose; leave it. pnpm install scripts are denied for `@scarf/scarf`, `esbuild` and `mongodb-memory-server` (`allowBuilds` in `pnpm-workspace.yaml`); that is intentional and everything still works.
- **Backend test facts:** backend tests need no Docker. A shared in-memory MongoDB replica set starts in `apps/backend/test/global-setup.ts`; the first run downloads a MongoDB binary of about 780 MB into `~/.cache/mongodb-binaries`. Use `useTestDatabase()` from `apps/backend/test/db.ts` in any test that touches the database, and wrap model calls in `runWithTenant(id, ...)` or `runAsPlatform(...)`. Run from `apps/backend`: `pnpm exec vitest run`, or `pnpm test:coverage`.
- **Test helpers:** `test/http.ts` (`buildTestApp()`, `actAs(staffId, propertyId)` signs a real token so requests use the real auth), `test/fixtures.ts` (`lookup`, `addStaff`, `checkInGuest`), `seedDevelopmentData()` for two properties with every role and 10 rooms each. Run the real stack with the steps in "Next action".
- **Rules every new model and service must follow:** apply `tenantPlugin` to the schema; never read `req.body` directly, use `validate()` and `req.validated`; throw `HttpError` helpers; use `transition()` for any status change; call `recordAudit()` for sensitive actions; no `Model.collection` (lint blocks it).

---

## Scope reminders (do not drift)

- **Only Phase 1 is being built now:** the hotel management system, including the guest in-stay app (P1.12).
- **Not now:** AI trip planner, local recommendations, Google Maps (Phase 2); public booking site (Phase 3); advanced features (Phase 4).
- **No QR codes in Phase 1.** Guests log in with the phone number linked to the booking plus the Booking ID, only after check-in. Built so phone + SMS OTP can be added later (plan section 3.9).
- **MongoDB is the ONLY database.** No Redis, Postgres, Firebase or any other store.
- **Everything is written from scratch.** No code copied from LuxuryStay or hotel-ops.
- Currency INR (paise as integers), GST per config (plan section 3.4). Payments: Razorpay first behind a `PaymentProvider` interface.

---

## Phase 0: Research and planning (DONE)

- [x] Read the requirements and understand the project
- [x] Search GitHub for similar repos and shortlist candidates
- [x] Read LuxuryStay in detail (backend: models, controllers, routes, middleware)
- [x] Read hotel-ops in detail (services, models, routes, webhooks, tests setup)
- [x] Write `IMPLEMENTATION_PLAN.md` (architecture, data model, phases)
- [x] Lock owner decisions (Razorpay first and pluggable, any LLM, Google Maps, India/INR/GST, front-desk bookings, from-scratch rebuild, private project)
- [x] Split into phases: Phase 1 = hotel management system only; AI, Maps and booking site deferred
- [x] Keep the guest in-stay app inside Phase 1 (P1.12)
- [x] Remove QR from Phase 1, use phone number + Booking ID login
- [x] Design guest login so phone + OTP can be added later without a rewrite
- [x] Create `PROGRESS.md` and `CLAUDE.md` (this tracking system)

---

## Phase 1: Hotel management system (BUILD NOW)

Sub-phases are in dependency order. P1.7, P1.8 and P1.9 may be done in any order after P1.6.

### P1.1 Project setup (1-2 days)

- [x] Create monorepo folders exactly as in the spec (no trip-planner, recommendations, local-recommendations folders). Enforced by `tests/repo-structure.test.ts`.
- [x] `pnpm-workspace.yaml`, root `package.json`, shared strict `tsconfig` (`tsconfig.base.json`, TypeScript pinned to 6.0.x)
- [x] ESLint 10, Prettier, Vitest 5 configured (`pnpm lint`, `pnpm format:check`, `pnpm test` all pass)
- [x] Docker Compose with a one-node MongoDB replica set. Verified: node is primary, transaction abort rolls back and commit persists. `pnpm db:up` / `db:down` / `db:reset`.
- [x] `.env.example` and `.gitignore`
- [x] `docs/architecture/decisions.md` recording plan section 3 decisions
- [x] Minimal CI workflow (install, lint, typecheck, test) in `.github/workflows/ci.yml`. The same four commands were run locally and pass; the workflow itself has not run on GitHub yet because no remote exists.
- [x] **Done when:** `pnpm install && pnpm lint && pnpm typecheck && pnpm test` pass on the skeleton (verified 2026-11-25: 49 root tests + 3 constants tests pass), replica set starts with one command (`pnpm db:up`, verified)

### P1.2 Backend core (4 days)

- [x] `environment.ts` with Zod-validated env, fails fast on missing secrets (no fallbacks; error never prints values). Verified by running the built server with no config: exits 1 with a clear list.
- [x] `database.ts` (Mongoose connection, credentials never in errors). `socket.ts` is deliberately **not** created here: the Socket.IO gateway is built in P1.4 and a stub would be fake code.
- [x] `app.ts` / `server.ts`, `HttpError`, async error handler, validation middleware, pino logging with redaction, helmet, CORS allow-list, rate limiting (health and docs exempt), request ids, `GET /health`. Graceful shutdown in `server.ts`.
- [x] Tenant plugin + `AsyncLocalStorage` request context (`propertyId` injected into every query, throws without context). Review found and fixed two real holes (replace and upsert could orphan or move a document); both tested.
- [x] State-machine helper (`transition()` with optimistic concurrency, `history[]`, transaction support)
- [x] `audit_logs` model (append-only) and `recordAudit` helper
- [x] Test harness: one shared in-memory replica set, one throwaway database per test file, `twoTenants()` ids. **Moved to P1.3:** the HTTP act-as-user helper (it needs login tokens) and a two-property seed with real `Property` documents (the model arrives in P1.5).
- [x] Swagger/OpenAPI at `/docs` and `/openapi.json`, generated from Zod (off by default in production)
- [x] Tests: tenant isolation (find/update/delete/count/aggregate/replace/upsert/bulk), state machine incl. 15 racing rounds, config fail-fast, errors, validation, rate limit, CORS, docs, audit. 153 backend tests, 95%+ line coverage.
- [x] **Done when:** a dummy tenant-scoped model proves isolation in tests (yes), `/health` and `/docs` respond (yes, also checked against the real built server and the Docker MongoDB)

### P1.3 Authentication and staff access (4 days)

- [x] Staff login (bcrypt), short-lived access token (15 min), hashed refresh token in `refresh_tokens` with TTL, rotation with reuse detection, 30-day absolute session limit, logout/revoke, token cutoff after a password change. Security review done; its medium findings were fixed (see session log).
- [x] HTTP test helper that acts as a given user (moved from P1.2) and a two-property seed with real `Property` documents (the `properties` model is created here or in P1.5, whichever comes first)
- [x] Every new Mongoose model that belongs to a property applies `tenantPlugin` (and a test lists all registered models to prove it, with an allow-list for `properties`, `users`, `refresh_tokens`)
- [x] Login rate limiting and lockout
- [x] RBAC with roles: property_admin, manager, front_desk, kitchen, housekeeping, maintenance, spa_recreation (+ platform_admin)
- [x] Role and propertyId only from token/DB, never from request body
- [x] Staff management (create/edit/deactivate/reset password), audit-logged, no creating a higher role
- [x] Seed script: two properties, one staff per role
- [x] Staff app shell: login page, single-flight token refresh, route guards by role, role-based menu and department pages, typed API client. Verified in a real browser against the real backend and Docker MongoDB (sign-in, session restore on reload, role-scoped menu).
- [x] Tests: wrong/locked/expired/reused tokens, every role vs every protected route, client-supplied role/propertyId ignored, cross-tenant
- [x] **Done when:** seeded user logs in from the staff app, sees only pages for their role, and the staff app reaches the backend (verified live as front desk and property admin, plus 57 component tests for every role)

### P1.4 Real-time foundation (3 days)

- [x] Typed in-process event bus (services emit, only the gateway forwards)
- [x] Socket.IO gateway with JWT handshake auth and server-decided rooms (`p:{propertyId}:dept:{department}`, `:managers`, `:user:{userId}`)
- [x] Clients cannot join rooms by name or send mutating events
- [x] Mongo Socket.IO adapter wired in (off by default, `SOCKET_ADAPTER=mongo`; tested: an event emitted on one instance reaches a client on another)
- [x] `useRealtime` hook in staff app with reconnect indicator
- [x] Tests: bad token rejected, no cross-property events, no cross-department events, manager sees own property only
- [x] **Done when:** a service event reaches exactly the right clients and no others (end-to-end test over HTTP + real gateway; also seen live in two browser windows)

### P1.5 Property, rooms and guest records (4 days)

- [x] Property settings (legal name, address, state, GSTIN, timezone, check-in/out times, departments, effective-dated GST rules)
- [x] Room types (capacity, nightly tariff in paise, amenities)
- [x] Rooms (number, floor, type, status rules, active flag)
- [x] Guest records (`users`): name, phone in E.164, optional email/GSTIN/ID, `phoneVerifiedAt` empty
- [x] Staff app pages: property settings, room types, rooms, guest search/profile
- [x] Tests: tenant isolation, invalid tariff, duplicate room numbers, room status rules, phone normalisation
- [x] **Done when:** the real property, room types and rooms can be entered and show correctly (works with the seeded development data; the friend's real property data is still an open item below)

### P1.6 Bookings and front desk (6 days)

- [x] Availability search by dates and room type
- [x] `room_nights` collection with unique index; create booking in a transaction; booking code generation
- [x] Booking lifecycle: Pending, Confirmed, Checked-in, Checked-out, Cancelled, No-show; change dates/room, extend, cancel frees nights
- [x] Check-in (assign room, set occupied, record details)
- [x] Front desk dashboard: arrivals/departures, in-house, room board, calendar, search
- [x] Events emitted to front desk and manager rooms
- [x] Tests: parallel booking race gives exactly one winner, back-to-back stays allowed, overlaps refused, illegal moves 409, timezone handling, front-desk-only access
- [x] **Done when:** real bookings can be created, changed, cancelled and checked in, and the room board updates live in a second window (create, check-in and live room-board updates verified in the browser; change and cancel are covered by backend tests and 70 booking route tests but their dialogs were not clicked through in the browser)

### P1.7 Housekeeping and maintenance (5 days)

- [x] Housekeeping requests and cleaning tasks (New, In Progress, Completed)
- [x] Maintenance issues (New, Assigned, In Progress, Resolved) with priority and technician assignment
- [x] Transactional room-state chain (maintenance takes room out of service; cleaning complete frees room)
- [x] Escalation flag to front desk/manager
- [x] Housekeeping and Maintenance dashboards with live updates and department scoping
- [x] Tests: illegal transitions, wrong role, double-assign races, room-status rules, correct-department live delivery
- [x] **Done when:** front desk logs a request, it appears live on the right dashboard, completes, and the room status follows (verified in the browser: request logged in the UI, started and completed by a housekeeper, card moved live and room 101 went cleaning to available; maintenance issue reported, assigned, started and resolved in the UI, and a room taken out of service showed as Maintenance)

### P1.8 Food menu and kitchen (5 days)

- [x] Menu management (categories, items, prices, availability, customisation options, GridFS images). Managers only; photos are JPEG/PNG/WebP up to 2 MB, checked by their real bytes.
- [x] Food orders entered by staff on behalf of a guest, server-side pricing with snapshots (front desk, kitchen and managers; the room must have a guest checked in)
- [x] Kitchen dashboard (Received, Preparing, Ready to Serve, Delivered, Cancelled) with sound and late highlighting. The sound switch starts off (browsers need a click first); the chime on a live event has no automated test.
- [x] `order.delivered` event emitted (billing posts it in P1.10). In-process only, no screen receives it; the step and its audit entry are one transaction so it cannot be lost to a failed audit write.
- [x] Tests: client cannot set price, option snapshots, illegal transitions, kitchen scoping, live delivery (130 new backend tests, 80 new shared and staff-app tests)
- [x] **Done when:** an order for Room 204 appears on the kitchen screen, is delivered, and front desk sees the status (verified 2026-11-26 in a real browser against the real backend: front desk placed a ₹350 order for Room 204, the kitchen's start and ready moved it live on the open front desk screen, the front desk marked it delivered; the manager's menu editor was also viewed. Photo upload in the browser was not clicked through; it is covered by 28 menu tests and component tests.)

### P1.9 Facilities, spa and recreation (5 days)

- [ ] Facilities (hours, slot length, capacity, price)
- [ ] Available-slots API
- [ ] Facility bookings with double-booking protection (partial unique index and capacity check in a transaction)
- [ ] Workflow: Booking Request, Confirmed, Active, Completed, Cancelled, No-show
- [ ] Spa and Recreation dashboard
- [ ] Tests: concurrent last-slot booking, capacity, cancel frees slot, past-slot rules, scoping, live updates
- [ ] **Done when:** a facility can be booked, confirmed, started, completed, and a full slot cannot be booked again

### P1.10 Billing, GST and checkout (8 days)

- [ ] Bill (folio) per booking with line snapshots and unique source reference per line (idempotent posting)
- [ ] Posting of room nights, delivered food orders, completed facility bookings in transactions, plus reconciliation of earlier events
- [ ] Manual charges/discounts with reason and manager approval over a limit
- [ ] GST engine (effective-dated rules, room slab by nightly tariff, per-line tax, CGST/SGST vs IGST, rounding)
- [ ] Invoices: gap-free numbers per property per financial year, printable/PDF, immutable, credit notes
- [ ] Staff-recorded payments (cash, UPI, card, partial) and refunds
- [ ] Check-out transaction (finalize bill, release room, create cleaning task) refusing unpaid balance unless manager overrides with reason
- [ ] Staff app pages: bill, add charge, record payment, finalize/print, payments ledger
- [ ] Tests: GST at every slab boundary (1,000 / 1,001 / 7,500 / 7,501), intra vs inter-state, rounding, idempotent posting, gap-free invoice numbers under parallel finalization, immutability, checkout rollback
- [ ] **Done when:** a full stay produces a correct GST invoice the accountant approves, and check-out leaves the room cleaning-ready

### P1.11 Manager dashboard, notifications and jobs (5 days)

- [ ] Manager dashboard: all department queues, assign/reassign, escalations, pending vs completed
- [ ] Real statistics from actual data (occupancy, room status, arrivals/departures, revenue by day and department, response times), no placeholder values
- [ ] Staff account management UI and audit log viewer
- [ ] `notifications` module and in-app notification centre with live delivery
- [ ] `background_jobs` collection and polling worker (locking, retries): notification cleanup, SLA reminders
- [ ] Tests: statistics match hand-computed fixtures, manager property scoping, job worker never runs a job twice, notification scoping
- [ ] **Done when:** the manager can see and act on everything from one place and every number traces to real data

### P1.12 Guest in-stay app (7 days)

- [ ] Guest app shell (React + Vite + Tailwind, mobile-first, installable, loading/error/success states)
- [ ] Two-step guest login API (`/guest/auth/start`, `/guest/auth/verify`) and `GuestVerifier` interface
- [ ] Phone + Booking ID verifier: checked-in bookings only, E.164 matching, generic errors, rate limits (IP/phone/booking), lockout and front-desk reset, audit-logged failures
- [ ] Per-property `guestLoginMode` setting (only `phone_booking_id` implemented)
- [ ] Guest session scoped to `{propertyId, bookingId, roomId}`, valid to check-out plus grace
- [ ] Front desk booking screen shows Booking ID and guest login link
- [ ] Guest pages: dashboard, food-ordering, service-requests, maintenance, facility-booking, billing
- [ ] Guest live updates via `p:{propertyId}:booking:{bookingId}` room
- [ ] Guest-scoped endpoints take booking/room only from the session
- [ ] Tests: own-booking-only access, client cannot override price/booking/room/property, phone formats, refusal before check-in and after grace, lockout/reset, no other room's events, cart component tests
- [ ] **Done when:** a checked-in guest logs in with phone + Booking ID, orders food from Room 204, watches it move live, requests housekeeping, and it all shows on staff dashboards

### P1.13 Online payments with Razorpay (4 days)

- [ ] `PaymentProvider` interface, Razorpay adapter, fake provider for tests
- [ ] Server creates Razorpay order for the server-computed outstanding balance; guest app opens Checkout
- [ ] Webhook: raw-body signature check, confirm with Razorpay API, amount check, idempotent by payment id
- [ ] Edge cases: duplicate webhooks, underpayment, late payment flagged, failed/abandoned, refunds by manager
- [ ] Receipts in guest app and staff ledger
- [ ] Tests: bad signature 401, duplicate recorded once, underpayment rejected, out-of-order webhooks, refund flow, Razorpay test-mode smoke test
- [ ] **Done when:** a guest pays the balance in test mode and bill, ledger and guest screen agree

### P1.14 Hardening, deployment and acceptance (4 days)

- [ ] Full security review and dependency audit
- [ ] Cross-tenant contract test over every route and socket event
- [ ] Indexes verified on realistic data, Atlas backups on, restore test, ID-details retention rule
- [ ] Deployment: Atlas (Mumbai), always-on backend, static frontends, domain + HTTPS, env settings, `/health` uptime check
- [ ] Printed check-in slips/room cards carrying the guest login link
- [ ] README setup/run guide, API docs export, schema docs, staff user guide per department
- [ ] Acceptance walkthrough passes on the deployed system (8 steps in plan P1.14)
- [ ] Accountant has approved sample GST invoices
- [ ] **Done when:** the acceptance walkthrough passes on the real deployment

---

## Deferred phases (do NOT start without the owner's go-ahead)

- [ ] Phase 2: local recommendations, AI trip planner, Google Maps (pluggable LLM)
- [ ] Phase 3: public online booking site
- [ ] Phase 4: advanced features
- [ ] Later add-on (any time after P1.12): phone number + SMS OTP login (about 3-4 days; DLT registration should start early)

---

## Open items (ask the owner in the sub-phase that needs them)

- [ ] Property facts: name/type, rooms and room types with nightly tariffs, floors, departments, state, GSTIN (needed at P1.5)
- [ ] Billing policy: are food orders always charged to the room? service charge? one menu or several outlets? (needed P1.8 to P1.10)
- [ ] GST sign-off by the friend's accountant (before P1.10 goes live)
- [ ] Razorpay account, test mode is enough (needed at P1.13)
- [ ] Domain name (before P1.13)
- [ ] Guest login method beyond phone + Booking ID, and the public booking site (decide later, Phase 3)
- [ ] **For P1.10 (from the P1.8 security review):** check-out must block or resolve open food orders (a guest could check out while an order is Ready and have it delivered to a closed booking), and billing must reconcile `delivered` orders it missed, idempotently by order id (a crash between commit and emit loses the in-process event).
- [ ] Known low items from the P1.8 reviews, not fixed: live events go by department but REST by role (a non-kitchen role given the kitchen department would hear order codes and room numbers); no idempotency key on order creation (the screen disables the button while sending); two simultaneous photo uploads on one item can orphan a GridFS file; GridFS `remove` has no property filter (safe today, defence in depth); menu and room lists stop at 100 rows (a notice is shown); `getBlob` duplicates some request logic; some React components are over 50 lines.

---

## Decisions log (append only)

| Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-25 | Razorpay first, behind a pluggable `PaymentProvider`; LLM provider pluggable; Google Maps; India, INR, GST; front-desk-only bookings; everything re-implemented from scratch; private project, not published.                                                                                                                                                                                                                          |
| 2026-11-25 | Phase 1 = hotel management system only. AI trip planner, recommendations, Maps and the public booking site are deferred.                                                                                                                                                                                                                                                                                                               |
| 2026-11-25 | Guest in-stay app stays in Phase 1 as P1.12.                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-11-25 | QR removed from Phase 1. Guest login = linked phone number + Booking ID, checked-in bookings only.                                                                                                                                                                                                                                                                                                                                     |
| 2026-11-25 | Guest login built OTP-ready (two-step API, `guestLoginMode` setting, `phoneVerifiedAt`, pluggable verifier) so phone + SMS OTP can be added later.                                                                                                                                                                                                                                                                                     |
| 2026-11-26 | Staff sign in with property link name + email + password (the property comes from the link, never the client body). Access token 15 min, refresh token 14 days sliding and 30 days absolute, rotated on use, a replayed token revokes the whole session. `platform_admin` cannot be created through the API (seed only). Staff management only works strictly downwards (nobody manages an account at or above their own role).        |
| 2026-11-26 | The staff app keeps the refresh token in `localStorage` (access token only in memory). This deviates from the global web rule "never store sessions in localStorage". Reason: the API returns tokens in the response body and the front desk needs to stay signed in across reloads. The proper fix is an httpOnly cookie refresh token plus CSRF protection; the owner should decide whether to schedule that before go-live (P1.14). |
| 2026-11-26 | A booking always holds a specific room from creation (`room_nights` needs a room); the system auto-picks the lowest free room when none is named. Dates are plain `YYYY-MM-DD` in the property timezone; a stay holds nights from check-in up to, not including, check-out.                                                                                                                                                            |
| 2026-11-26 | Housekeeping requests and cleaning tasks share the `service_requests` collection (the guest app will use it too). A `cancelled` status was added to the housekeeping workflow for mistaken requests (the plan listed only New, In Progress, Completed). Maintenance reassigning is Assigned to Assigned. Housekeeping can report a maintenance problem but cannot see the maintenance queue.                                           |
| 2026-11-26 | Room status is only changed through the workflow table; staff set only available, cleaning or out of service by hand. Resolving the last maintenance issue that took a room out of service sets it to available; completing a room-cleaning task sets a cleaning room to available.                                                                                                                                                    |
| 2026-11-26 | Default GST rules are loaded per property as an effective-dated list (from 2025-04-01). Rule sets are append-only: a new set must start after the latest one, so history is never rewritten. They are starting values to be confirmed by the accountant.                                                                                                                                                                               |
| 2026-11-26 | P1.8: menu categories are free text on each item (no category collection); item names are unique per property ignoring case; prices are paise before tax and GST is applied when billing posts the order (P1.10); deleting a menu item never changes placed orders (they hold snapshots).                                                                                                                                              |
| 2026-11-26 | P1.8: the kitchen role may also place orders (room service). Front desk, kitchen and managers can deliver or cancel; only kitchen and managers start or finish cooking. Cancel only while Received. An order needs a guest checked in to the room.                                                                                                                                                                                     |
| 2026-11-26 | P1.8: `order.delivered` is in-process with no screen audience. An order step and its audit entry commit in one transaction, so a failed audit write undoes the step and a delivered order always announces. Menu photos live in GridFS (`menu_images`), tagged with the property, checked by real bytes, uploaded as the raw request body (no multipart dependency), served to menu readers with `nosniff` and a locked-down CSP.      |

---

## Session log (append only, newest at the bottom; one line per meaningful step)

| Date       | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Where it stopped                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 2026-11-25 | Research, reference-repo review, implementation plan written and revised through several owner decisions. Created this checklist and `CLAUDE.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Planning complete. Build not started. Next: P1.1.                                 |
| 2026-11-25 | Initialised local git (`main`), first commit of the planning files. Owner chose not to create a GitHub remote yet, so nothing is pushed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Local commit only. Next: P1.1 when the owner says go; re-ask about a remote then. |
| 2026-11-25 | **P1.1 done.** Monorepo skeleton, tooling (TypeScript, ESLint, Prettier, Vitest), Docker one-node replica set, `.env.example`, decisions doc, CI workflow. Tests written first and seen failing before the code. Replica set and transactions verified in the container. Committed locally, not pushed (no remote).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | P1.1 complete. Next: P1.2 Backend core.                                           |
| 2026-11-25 | **P1.2 done.** Backend core built test-first: config, errors, request context, tenant plugin, state machine, audit log, middleware, app, health, OpenAPI, server, tsup build. Self-review found and fixed two tenant-isolation holes (replace, upsert) plus a lazy-query context bug. 153 backend tests pass, 95% coverage, built server verified against Docker MongoDB. Committed locally, **not pushed** (owner said do not push).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | P1.2 complete. Next: P1.3 Authentication and staff access.                        |
| 2026-11-26 | **P1.3 to P1.7 done** (owner: "start P1.3 to P1.7, do not push"). Built test-first: staff auth with refresh-token rotation and lockout, RBAC, staff management, seed; event bus and Socket.IO gateway; property settings with effective-dated GST rules, room types, rooms, guests (E.164 phones, audited ID details); bookings with `room_nights` unique index and transactions (parallel race tests pass), check-in, availability, calendar, front desk overview; housekeeping and maintenance queues with a transactional room-state chain and escalation; the staff app with all those pages. A separate security review of the auth code found no critical or high issues; its medium findings (property deactivation, absolute session lifetime, password-change token cutoff, lockout extension, update race, rate-limit key, seed guard) were fixed. A second independent review of P1.5 to P1.7 found no critical or high issues; its medium findings were fixed (manual room changes can no longer free an occupied room or override an open maintenance block, resolving maintenance keeps a room in cleaning if a cleaning is owed, rooms with bookings cannot be retired, impossible dates like 31 February are refused, check-in room swap uses current dates, stale booking dialog). Known low items left: two simultaneous resolves of different issues on one room can leave it in maintenance, new-booking default dates use the browser timezone, a failed renewal on the live connection stays offline until reload, ID numbers are stored in plain text (access is audited). 754 tests pass (backend 592, staff app 57, shared 56, repo 49); lint, typecheck and format check pass. Verified in a real browser against the real backend and Docker MongoDB. Committed locally, **not pushed**. | P1.3 to P1.7 complete. Next: P1.8 Food menu and kitchen, when the owner says go.  |
| 2026-11-26 | **P1.8 done** (owner: "start 1.8"). Set up the toolchain on this machine first (pnpm 12.23.0, `pnpm install`, one-time 781 MB MongoDB test binary, all approved by the owner). Built test-first: shared constants, validation and types; the `menu` module (items, options, availability, GridFS photos) and `food-orders` module (server pricing with snapshots, kitchen workflow, `order.delivered` billing hook, summary with late count, live events); a sample-menu seed; the staff app Kitchen screen and Menu editor. Two independent reviews (code and security) found no critical or high issues. Fixed from them: a delivery whose audit write failed could stay delivered with billing never told (step and audit are now one transaction, tested); "Delivered (latest)" now sorts by delivery time; photos always revalidate; image responses carry a locked-down CSP; non-image blobs are refused; errors and a cut-off list are shown instead of hidden. Verified in a real browser (Docker was not running, so a throwaway MongoDB replica set from the cached test binary was used; the temporary `.env` and database were removed). Lint, typecheck and all 938 tests pass. Found that this clone's git history did not match the notes above (see the Git line). Afterwards, on the owner's instruction, committed and pushed to `Savithru1/Hotel-MS` `main` as `s4meer-dev` (see the Git line).                                                                                                                                                                                                                                                                                                                                                                                                  | P1.8 complete and pushed. Next: P1.9 or P1.10, when the owner says go.            |
