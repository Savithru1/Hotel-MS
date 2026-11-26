# Hospitality Platform: Implementation Plan

Status: **Phase 1 is being built; P1.1 to P1.8 are done (see `PROGRESS.md` for the live state).** Revised after the owner's answers (see section 8 for the locked decisions).

**Live progress is tracked in `PROGRESS.md`** (checklist, resume point, session log). Every Claude session follows it via `CLAUDE.md`. This plan document describes *what* to build; `PROGRESS.md` records *how far we are*.

**Scope now: Phase 1 only, the hotel management system** (section 5). The AI trip planner, local recommendations, Google Maps and the public online booking site are deferred to later phases (Phases 2 to 4) and are not part of the current build. Sub-phases are numbered P1.1 to P1.14 to keep them distinct from the section numbers of this document.
Inputs: the requirements prompt, plus a code-level read of two reference repos.

- [MujtabaZadaii/LuxuryStay](https://github.com/MujtabaZadaii/LuxuryStay), MIT licence.
- [vicintel/hotel-ops](https://github.com/vicintel/hotel-ops), **no licence file** (all rights reserved by default).

What I read: LuxuryStay's whole backend (server, 10 models, 4 controllers, routes, middleware). For hotel-ops I read the README, `package.json`, `.env.example`, `server.js`, `app.js`, `db.js`, `lib/*`, 8 of the 10 models, and the order, booking, checkout, payment, notification and expiry services. I also read the orders, bookings, public, dashboard, departments, manage and webhooks routes, plus the agent's tool-loop structure.

What I did not read: LuxuryStay's frontend (about 150 KB of JSX), hotel-ops's POS, till and Moniepoint code, the agent's prompts, and the HTML pages.

---

## 1. What the two repos actually are

### 1.1 LuxuryStay (MERN, JavaScript, MIT)

**Useful as a schema and workflow sketch only.**

It has 10 Mongoose models: `User`, `Guest`, `Room`, `Reservation`, `Service`, `Housekeeping`, `Maintenance`, `Invoice`, `Notification`, `Feedback`. It has one `routes/api.js` with role-gated routes, and four controller files that put DB logic directly in the HTTP layer. There is no Socket.IO, TypeScript, validation, tests or multi-tenancy.

Good ideas worth keeping:
- **Role set:** admin, manager, receptionist, housekeeping, maintenance, guest.
- **Checkout side effects:** check-out creates the invoice, moves the room to `Cleaning`, auto-creates a housekeeping task, and notifies the guest.
- **Housekeeping and maintenance completion:** completing either one returns the room to `Available`.
- **Room status vocabulary:** Available / Occupied / Reserved / Cleaning / Maintenance / Out of Service.

**Defects I found. Do not carry any of these over:**

| # | Defect (file) | Consequence |
|---|---|---|
| 1 | `registerUser` accepts `role` from the request body (`authController.js`) | Anyone can register as `admin`. This is a privilege-escalation hole. |
| 2 | JWT secret falls back to `'supersecretjwtkey'` (`authMiddleware.js`, `authController.js`) | Tokens are forgeable if `JWT_SECRET` is unset. |
| 3 | `protect` can send two responses (`authMiddleware.js`) | Falls through to the "no token" branch after a failure. |
| 4 | Availability is `room.status === 'Available'`, with no date logic (`reservationController.js`) | Booking one night blocks the room for all future dates. Two overlapping future stays are impossible. |
| 5 | No transactions in create, check-out or housekeeping flows | Partial failures leave inconsistent state. |
| 6 | Services are billed by `guestId` with flat rates and hardcoded 12% tax, not by stay | Past stays' services leak into new bills. Prices are fiction. Tax is not configurable. |
| 7 | `getDashboardStats` falls back to `Math.random()` revenue and occupancy | Directly violates your "no placeholder presented as working" rule. |
| 8 | Every list query is unscoped (`Feedback.find({})`, `User.find({})`) | No property isolation at all. |
| 9 | No input validation, no rate limiting, no audit log | Fails your section 11. |
| 10 | Maintenance auto-assigns to "first active maintenance user" | Not a real assignment. |

### 1.2 hotel-ops (Express 5, Mongoose 9, Socket.IO, Claude, JavaScript, no licence)

**Far better engineered, especially around money and state. It is a design reference, not a base.**

It is a single-property, multi-department ordering and payments system, about 4,500 lines of server code and 126 `node --test` tests using `mongodb-memory-server`. It is built for a Lagos hotel group, so payments go through Monnify (bank transfer) and Moniepoint (card machines).

Patterns that are worth re-implementing:

1. **Order state machine** (`lib/orderStatus.js`). A transition table plus a `canTransition` guard. State changes use a conditional `findOneAndUpdate({_id, status: current})` for optimistic concurrency, and append to a `history[]` array.
2. **"Only a verified payment can set `paid`"** (`PAYMENT_ONLY`). The status API refuses it; only the payment service can.
3. **Payment idempotency.** `providerReference` is unique in the DB, and a duplicate-key error is treated as "already handled". `recordPayment` is safe to call twice.
4. **Late-money handling.** A payment that arrives after expiry is stored and the order is flagged `attention` for staff, never silently dropped.
5. **Webhook discipline.** The webhook router is mounted before `express.json()` so it gets the raw body. The flow is HMAC check, then server-to-server confirmation with the provider, then an amount check. Non-retryable business errors return 200, and 5xx is returned only for retryable failures.
6. **Money as integer minor units**, and line-item snapshots of name and price at order time.
7. **Unpaid expiry.** A sweep cancels unpaid orders and room holds after 30 minutes, then emits `order:expired`.
8. **Service-layer separation.** Routes are thin, services hold the logic, `HttpError` plus Express 5 async error handling, and a domain event bus that `server.js` forwards to Socket.IO. Services never import sockets.
9. **Availability by date range overlap** (`checkIn < out && checkOut > in`), Lagos-timezone "today", and strict `YYYY-MM-DD` parsing.
10. **AI agent safety design.** Server tools return all prices, totals and availability and the model only relays them. There is a max tool-round cap, an append-only message history, a confirm-before-write rule, and daily AI-usage limits.
11. **Test approach.** `mongodb-memory-server`, `supertest`, drop the DB before each test, and `syncIndexes()` so unique indexes exist.

Weaknesses (do not copy):

| # | Weakness | Fix in our build |
|---|---|---|
| 1 | One shared dashboard key; the README says roles are "coming soon" | Full JWT + RBAC (spec section 11). |
| 2 | Single tenant, no `propertyId` | Tenant plugin (section 3.2). |
| 3 | One Socket.IO room, `'staff'`, for every event | Scoped rooms by property and department. |
| 4 | Booking race: `roomsBooked` / `freeRooms` is read, then the order is created, with no atomic guard | `room_nights` unique-index pattern (section 3.3). |
| 5 | Bookings are modelled as orders, and rooms as menu items | Real `bookings`, `rooms`, `room_types` collections. |
| 6 | In-process `EventEmitter` and `setInterval` expiry | Fine for one instance. We use a Mongo-backed jobs collection and the Mongo Socket.IO adapter. |
| 7 | Plain JS and static HTML pages | TypeScript monorepo and React apps. |
| 8 | Monnify / Moniepoint / WhatsApp are Nigeria-specific | Razorpay per your spec. WhatsApp is deferred to Phase 4. |

### 1.3 Licence reality

**Decided: everything is re-implemented from scratch.** No code is copied from either repo. We take ideas and design only (hotel-ops has no licence, so copying its code would not be allowed; LuxuryStay's defects make its code not worth copying). No contact with either author is needed. This is a private, personal project for a friend's property and will not be published, but we still keep the code original.

---

## 2. Reuse matrix

| Our need | Source | How we use it |
|---|---|---|
| Role vocabulary, room status enum | LuxuryStay | Adapt as constants in `packages/constants`. |
| Checkout, housekeeping, room-state chain | LuxuryStay | Re-design as a transactional `checkout` service. |
| Order lifecycle state machine and `history[]` | hotel-ops | Re-implement as a generic `StateMachine` helper in `packages/constants`, one table per workflow. |
| Payment idempotency, late-payment flag, expiry | hotel-ops | Re-implement against Razorpay. |
| Webhook raw-body, HMAC, confirm-with-provider | hotel-ops | Re-implement for the Razorpay webhook. |
| Date-range overlap logic, `YYYY-MM-DD` parsing | hotel-ops | Re-implement with the `room_nights` guard. |
| Domain event bus to sockets | hotel-ops | Typed event bus, plus the Mongo adapter and scoped rooms. |
| AI agent tool-loop safety rules | hotel-ops | Applied to the trip planner. |
| Kitchen board UX (sound, wait times, late warnings) | hotel-ops (README description only) | Design inspiration for the Kitchen dashboard. |
| Test harness (`mongodb-memory-server`) | hotel-ops | Use `MongoMemoryReplSet`, because we need transactions. |
| Full booking and admin UI | arnobt78 / SamiurRahmanMukul (from the first pass) | Optional UI and schema references only. I haven't read their code. |
| Trip planner prompts and flow | Ananya27290 / Safar (from the first pass) | Reference only. I haven't read their code. |

---

## 3. Key architecture decisions

### 3.1 Stack

**Monorepo layout.** Exactly your folder structure, with `pnpm` workspaces. All apps use TypeScript strict mode.

**Stack choices.** Express 5 (async errors handled natively), Mongoose 8/9, Zod for validation (shared in `packages/validation`), Socket.IO, `jsonwebtoken` + `bcrypt`, `helmet`, `express-rate-limit`, `pino` logging, `swagger-ui-express` with OpenAPI generated from the Zod schemas (`zod-to-openapi`), and Vitest for tests.

**Mongo-only mapping.** Everything that usually needs Redis uses MongoDB instead:
- **Refresh tokens and webhook-event idempotency:** collections with TTL indexes.
- **Background jobs:** a `background_jobs` collection polled with `findOneAndUpdate` locking.
- **Socket.IO scale-out:** `@socket.io/mongo-adapter` (uses a capped MongoDB collection).
- **Rate-limit store:** in-memory for v1 (single instance). A Mongo-backed store with a TTL index is the upgrade.
- **Files:** GridFS, behind a small storage interface.

**Transactions.** They need a replica set. Local dev and tests use a single-node replica set (`MongoMemoryReplSet`; a one-node `docker compose` replset for dev). Production uses MongoDB Atlas.

### 3.2 Tenancy and access control (spec sections 6 and 11)

- **Auth context.** Auth middleware validates the JWT, loads the principal, and stores `{kind: 'staff'|'guest', propertyId, role, departments, bookingId?, roomId?}` in `AsyncLocalStorage`. The frontend never supplies `propertyId`, `bookingId`, `roomId` or `role` that we trust. They are derived from the token and re-verified against the DB.
- **Tenant plugin.** A Mongoose plugin applied to every property-scoped schema adds a required indexed `propertyId`. It also adds `pre` hooks on `find`, `findOne`, `update*`, `delete*`, `countDocuments` and `aggregate` that inject the `propertyId` from the context. They **throw** if there is no context and the call isn't explicitly marked platform-level. This is the structural fix for LuxuryStay's defect 8.
- **Roles.** `platform_admin`, `property_admin`, `manager`, `front_desk`, `kitchen`, `housekeeping`, `maintenance`, `spa_recreation`, plus `guest` as a separate principal kind. Managers get all departments within their own property only.
- **Guest sessions.** Scoped to one `{propertyId, bookingId, roomId}`. They expire at check-out plus a short grace period so the guest can still pay the bill.
- **Contract tests.** An automated test seeds two properties and walks every router, asserting a Property A token can never read or write Property B data (HTTP and Socket.IO).

### 3.3 Double-booking prevention (fixes both repos' availability problems)

- **Rooms:** a `room_nights` collection with one document per `(propertyId, roomId, night)` and a **unique index**. A booking inserts all its nights inside a transaction. If any night is taken, the unique-key error aborts the whole booking. This is correct even under concurrent requests.
- **Facilities:** `facility_bookings` has a partial unique index on `(facilityId, slotStart)` over active statuses for exclusive facilities. For capacity facilities (pool, gym), check capacity inside a transaction against a per-slot counter document.

### 3.4 Money

- Integer **minor units** everywhere. `currency` is stored per property.
- **Currency is INR**, stored in paise (integer). Tax is **GST**, driven by effective-dated rules in config, never hardcoded. A rate change must never alter a bill that was already issued, because every bill line stores a snapshot of its rate, SAC code and tax amounts.
- **Default rules to load (my understanding of current GST; to be confirmed by the friend's accountant before real use, and the engine reads them from config so correcting them is a data change, not a code change):**

  | Supply | Default GST |
  |---|---|
  | Room, declared tariff up to ₹1,000 per night | Nil |
  | Room, ₹1,001 to ₹7,500 per night | 5% |
  | Room, above ₹7,500 per night | 18% |
  | Restaurant / food | 5%, or 18% where the room tariff is above ₹7,500 (a "specified premises" rule) |
  | Spa, gym, recreation | 18% |
  | Other services (laundry, transport and similar) | 18% |

  The slab for a room is chosen from that room's **tariff per night**, and the tax is calculated per line item.
- **Split:** if the guest's place of supply is the same state as the property, tax is split into CGST + SGST halves; otherwise it is IGST. The property stores its state and GSTIN. The guest's GSTIN is optional (for business stays).
- **Invoice requirements:** a gap-free invoice number per property per financial year (April to March) using an atomic counter in a `counters` collection; property legal name, address and GSTIN; guest details; place of supply; SAC code, taxable value and CGST/SGST/IGST per line; and a final round-off line. Invoices are immutable once finalized, and corrections are credit notes.
- Bills are a **folio**: an embedded `lines[]` array (room nights, food orders, services, facility bookings), each with a source reference, a snapshot price and a tax snapshot. Totals are computed server-side and stored. Services are billed **by booking** (fixes LuxuryStay defect 6).
- Charges post to the folio when the source completes (for example, a food order reaching `delivered`), using a transaction.

### 3.5 Workflows as explicit state machines (one shared helper)

Each workflow gets a transition table in `packages/constants`, enforced by one `transition()` helper that does an optimistic conditional update and appends to `history[]`.

- **Food order:** Received → Preparing → Ready to Serve → Delivered (plus Cancelled before Preparing).
- **Housekeeping request:** New → In Progress → Completed.
- **Maintenance issue:** New → Assigned → In Progress → Resolved.
- **Facility booking:** Requested → Confirmed → Active → Completed (plus Cancelled and No-show).
- **Booking:** Pending → Confirmed → Checked-in → Checked-out (plus Cancelled and No-show).
- **Payment:** Created → Authorized/Captured → Failed → Refunded. Only the payment service may mark captured.

### 3.6 Real-time

- Domain services emit typed events on an in-process bus. A single `socket gateway` subscribes and forwards. Services never touch sockets.
- **Rooms:** `p:{propertyId}:dept:{department}`, `p:{propertyId}:managers`, `p:{propertyId}:booking:{bookingId}`, `p:{propertyId}:user:{userId}`.
- **Connection auth:** the handshake validates the JWT, and the server decides which rooms to join. Clients cannot join rooms by name.
- **Client emits:** none that mutate state. All mutations go through REST (which enforces RBAC), and sockets are server-to-client only, except an ack/ping.
- **Payloads:** ids plus minimal data, then the client refetches via REST, so authorization stays in one place.

### 3.7 Payments (Razorpay first, other gateways pluggable)

All gateway access goes through a small `PaymentProvider` interface (create order, verify webhook signature, fetch/confirm payment, refund). **Razorpay is the first implementation**; adding another gateway later means adding one adapter, with no change to billing logic. The provider is selected per property in config, and the `payments` collection records which provider handled each payment. A fake provider is used in tests.

Razorpay flow: create a Razorpay order server-side for the **server-computed** outstanding balance, then the client opens Razorpay Checkout (UPI and card). The webhook is verified with `X-Razorpay-Signature` (HMAC-SHA256 over the raw body), then confirmed via the Razorpay payments API, then the amount is checked. The payment is recorded idempotently by Razorpay payment id (unique index) and applied to the bill. Late payments and underpayments are flagged for staff, and refunds are supported. This is the hotel-ops pattern re-implemented.

### 3.8 AI trip planner (spec section 7I) — **Phase 2, deferred; nothing here is built in Phase 1**

**LLM provider is pluggable.** The planner talks to an `LlmProvider` interface with adapters for Claude, Gemini and OpenAI, chosen by an environment variable (and API key). The prompts, JSON schema, validation and guardrails below are provider-independent: whatever the provider returns is parsed and validated against our own Zod schema, and a response that fails validation is retried once and then rejected. Because providers differ in structured-output support, the adapter layer handles each provider's native mode and falls back to "JSON in text, then validate". **Maps are Google Maps Platform** (Places API and Routes API). That needs a Google Cloud project with billing enabled; we set quotas and budget alerts so a bug can't run up a bill.

1. **Candidates.** The server pulls candidate places from the Google Places API near the property, filtered by the guest's interests and budget.
2. **Selection.** The LLM receives **only** those candidates (with their ids) plus the preferences, and returns structured JSON (day-wise plan, order, rationale). Output is schema-validated and any place id not in the candidate set is rejected.
3. **Routing.** The server computes travel times and distances with the Routes API, never the LLM.
4. **Labelling.** Every field carries `source: "verified"` (from Maps API, with a timestamp) or `"estimate"` (LLM or derived, for example expenses). The UI shows the distinction. No live opening hours, prices or availability are ever invented.
5. **Edit and save.** The guest can reorder, remove or swap items. Plans and preferences are stored in `trip_plans`.
6. **Guardrails.** Per-guest and per-day usage caps, a max tool/round cap, and cost logging.

Places API terms restrict long-term caching. `local_places` stores curated/staff-managed recommendations plus place ids, with a short-lived cache for fetched details.

### 3.9 Guest entry (phone login, no QR codes)

**QR codes are removed from Phase 1** (no room QR sheets, no scanning). Guests log in with the **phone number linked to their booking**.

- **How guests reach the app:** a stable per-property link such as `https://<domain>/<property-slug>`. The front desk gives it to the guest at check-in (printed on the check-in slip or room card as plain text, or shared by the front desk). The property comes from the link, and every lookup after that is scoped to it.
- **Login = linked phone number + Booking ID.** The Booking ID is handed over at check-in. I added the Booking ID on purpose: a phone number is not secret, and with the number alone anyone who knows a guest's number could view their bill and place food orders charged to their room. A second thing only the guest holds closes that gap without any extra cost.
- **Phone number + OTP is planned as a later upgrade, and Phase 1 is built so it drops in without rewriting login.** OTP itself is **not** built in Phase 1 (it needs an SMS provider, India's DLT registration and a per-message cost, and I won't ship a fake one). What Phase 1 does build, so the upgrade is small:
  1. **Two-step login shape from day one.** The guest login API is `POST /guest/auth/start` then `POST /guest/auth/verify`, and the `GuestVerifier` interface has the matching two methods (`start` and `verify`). In Phase 1 the phone + Booking ID verifier finishes in `start` and returns a session. An OTP verifier would return a *challenge* from `start` and a session from `verify`, with no API change.
  2. **Server-driven login screen.** The guest app login is a step flow where each server response says what comes next (`done` or `otp`), so adding a code-entry step later changes no existing screen logic.
  3. **A per-property setting `guestLoginMode`:** `phone_booking_id` (Phase 1), `phone_otp`, or `phone_otp_booking_id` (code plus Booking ID, the strongest). Switching is a setting, so the friend can move over when ready, and fall back if the SMS service has a problem.
  4. **Phones stored in one clean format** (E.164) with a `phoneVerifiedAt` field on the guest record, empty in Phase 1 and set when an OTP succeeds.
  5. **Login rate limiting and audit logging** are already per phone, per IP and per booking, which is the same shape OTP needs.

  **Added when OTP is built (about 3 to 4 days, independent of the other phases, can be done any time after P1.12):** an `SmsProvider` interface (like `PaymentProvider`) with one real adapter and a fake one for tests; an `otp_challenges` collection with a TTL index; an `OtpVerifier`; the code-entry screen; the DLT sender ID and message templates; and tests. The OTP rules will be: a random 6-digit code from a cryptographic generator, stored only as a hash, valid 5 minutes, at most 5 attempts per code, a resend cooldown, daily send caps per phone and per IP (to stop SMS-cost abuse), and identical responses whether or not the phone matches a booking (so the login cannot be used to find out who is staying). DLT registration can take days to weeks, so it should be started early if you want OTP at go-live.
- **Only for checked-in bookings.** A booking has no room until check-in, and every guest service needs a room, so before check-in the app says "please check in at the front desk". Cancelled and no-show bookings are refused.
- **Phone matching:** numbers are normalised to E.164 (`+91...`) before comparing. The phone must be the one saved on the booking by the front desk (the primary guest, or an extra contact the front desk adds).
- **The room is never taken from the client.** It comes from the booking record on the server (assigned at check-in, and follows a room change made by the front desk).
- **Abuse protection:** one generic failure message ("those details don't match"), rate limits per IP, per phone and per booking, a temporary lockout after repeated failures (the front desk can reset it), and failed attempts are audit-logged.
- **Session:** scoped to one `{propertyId, bookingId, roomId}`, short-lived access token with a refresh token held in `refresh_tokens` (TTL), valid until check-out plus a short grace period so the bill can still be paid.
- **The verification method is still swappable** (you said it may change later). Verification sits behind the `GuestVerifier` interface; the Phase 1 implementation is phone + Booking ID. Later options (SMS OTP, a public booking site's own accounts) are new verifiers.
- **Bookings are created by front-desk staff only** for now (the front desk logs in with a staff account). Booking creation lives in one service with a `source` field (`front_desk` today), so a future public booking site calls the same service without redesign.

### 3.10 Hosting (my recommendation, since you left it to me)

This is a private app for one friend's property, so the aim is cheap, simple and reliable, not scalable. Hosting is decided late (before P1.13, when Razorpay webhooks need a public URL), so none of it blocks the early sub-phases.

- **Database:** MongoDB Atlas in an **AWS Mumbai** region. The free or small shared tier is fine for development. Atlas tiers are replica sets, so transactions work. Move to a small dedicated tier before real guest data goes in, because that brings backups and better limits. Do not self-host Mongo for production.
- **Backend:** one small always-on container (for example a small VPS in Mumbai or Bangalore, or an always-on Render/Fly.io service). It must be **always-on, not serverless**, because Socket.IO needs long-lived connections and the job worker needs a running process. A single instance is enough, so the Mongo Socket.IO adapter stays in the code but unused until a second instance exists.
- **Frontends:** the Guest and Staff apps are static builds, so host them on a static host (Cloudflare Pages, Netlify or Vercel).
- **TLS and domain:** a real domain with HTTPS is required for Razorpay webhooks and PWA install. Use one stable domain, because the guest login link is printed on check-in slips and room cards.
- **Ops basics:** daily Atlas backups, uptime check on `/health`, structured logs, and secrets only in the host's environment settings.

---

## 4. Data model (single DB `hospitality_platform`)

Every collection below carries `propertyId` except `properties` and `users`. All have `createdAt`/`updatedAt`. Indexes are listed as `(fields)`.

**Phase 1 collections:** everything below **except** `trip_plans` and `local_places`, which belong to Phase 2 and are not created in Phase 1. In Phase 1 the `users` collection holds **guest profiles created by the front desk** and has no password (guest accounts with passwords arrive with the public booking site in Phase 3).

| Collection | Key fields | Indexes |
|---|---|---|
| `properties` | name, type, address, state, GSTIN, legal name, timezone, currency (INR), effective-dated GST rules, payment provider config, department config, branding | unique slug |
| `users` (guests) | name, phone (E.164), phoneVerifiedAt? (empty until OTP exists), email?, GSTIN?, ID details? (Phase 1: no password); passwordHash is added in Phase 3 | (phone); (email) sparse |
| `staff` | propertyId, name, email, passwordHash, role, departments[], active | unique (propertyId, email) |
| `rooms` | propertyId, number, floor, roomTypeId, status, active | unique (propertyId, number) |
| `room_types` (new) | propertyId, name, capacity, rate (minor units), amenities | (propertyId, name) |
| `room_nights` (new) | propertyId, roomId, night, bookingId | **unique (propertyId, roomId, night)** |
| `bookings` | propertyId, bookingCode, guestUserId?, guestSnapshot, roomId, checkIn, checkOut, status, history[] | unique (propertyId, bookingCode); (propertyId, status, checkIn) |
| `food_menus` | propertyId, category, name, price, options[], available, image | (propertyId, available) |
| `food_orders` | propertyId, bookingId, roomId, items[] (snapshots), status, history[], notes, totals | (propertyId, status, createdAt); (propertyId, bookingId) |
| `service_requests` | propertyId, bookingId, roomId, type, notes, status, history[], assignedTo | (propertyId, status, createdAt) |
| `maintenance_issues` | propertyId, bookingId?, roomId, category, description, priority, assignedTo, status, history[] | (propertyId, status, priority) |
| `facilities` | propertyId, type, name, capacity, slot config, hours, price | (propertyId, type) |
| `facility_bookings` | propertyId, facilityId, bookingId, slotStart, slotEnd, status, history[] | partial unique (facilityId, slotStart) on active statuses |
| `bills` | propertyId, bookingId, lines[], taxTotal, total, paid, balance, status, finalizedAt | unique (propertyId, bookingId) |
| `payments` | propertyId, billId, provider, providerPaymentId, amount, status, raw | **unique providerPaymentId**; (propertyId, billId) |
| `notifications` | propertyId, recipient{kind, id}, type, payload, readAt | (recipient, createdAt); TTL on old read items |
| `otp_challenges` (**later, with OTP login; not created in Phase 1**) | phone, codeHash, expiresAt, attempts, sentAt, bookingId? | **TTL on expiresAt**; (phone, sentAt) |
| `trip_plans` (**Phase 2**) | propertyId, bookingId, preferences, days[] (items with source flags), version | (propertyId, bookingId) |
| `local_places` (**Phase 2**) | propertyId, category, name, placeId?, location (2dsphere), curated notes | 2dsphere; (propertyId, category) |
| `audit_logs` | propertyId, actor, action, target, before/after summary, ip | (propertyId, createdAt); (target) |
| `background_jobs` | type, payload, runAt, status, attempts, lockedUntil, lastError | (status, runAt) |
| `refresh_tokens` (new) | principal, tokenHash, family, expiresAt | **TTL on expiresAt** |
| `webhook_events` (new) | provider, eventId, receivedAt | unique (provider, eventId); TTL |
| `counters` (new) | propertyId, key (e.g. `invoice:2026-27`), seq | unique (propertyId, key); atomic `$inc` for gap-free invoice numbers |

Pagination and limits are enforced on every list endpoint. Mongoose schemas validate; Zod validates at the HTTP boundary, with the same schemas shared with both frontends.

---

## 5. Phased delivery

The work is split into **four phases**. **Only Phase 1 is being planned for build now.** It is the hotel management system itself. Phases 2 to 4 are parked and will be detailed and updated later.

| Phase | Scope | Status |
|---|---|---|
| **1** | **Hotel management system** (staff-run operations, billing, real-time, and the guest in-stay app) | **Build now** |
| 2 | Local recommendations, AI trip planner, Google Maps | Deferred |
| 3 | Public online booking site (the "MakeMyTrip-style" app) | Deferred |
| 4 | Advanced features (digital check-in, WhatsApp, analytics, automation) | Deferred |

Rules that apply to every sub-phase of Phase 1: tests are written first (TDD, 80%+ coverage), the code is reviewed, anything touching auth, input, the database or payments gets a security review, docs are updated, and the sub-phase ends with a running demo of its flows. Effort figures are rough, for one full-time developer.

---

## Phase 1: Hotel management system

### P1.0 Scope boundary

**In Phase 1:**
- Everything staff do: front desk, housekeeping, maintenance, kitchen, spa and recreation, manager.
- Bookings **created by front-desk staff**, room inventory, check-in and check-out.
- Billing with GST, invoices, payment recording, and online payment through Razorpay.
- Real-time updates and notifications between all dashboards.
- The **guest in-stay app** (log in with the phone number linked to the booking plus the Booking ID, order food, request services, report problems, book facilities, view and pay the bill). There are **no QR codes** in Phase 1. It is the guest side of hotel operations, so it is part of Phase 1. It is built **last**, after the staff-side system already works, so it can be postponed without affecting anything else.

**Not in Phase 1 (no code, no folders, no accounts):**
- Local recommendations, the AI trip planner, Google Maps, Places, Routes and any LLM provider. No Google or LLM keys are needed. The `trip_plans` and `local_places` collections, the `trip-planner` and `recommendations` backend modules, and the `trip-planner` and `local-recommendations` guest pages are not created until Phase 2.
- A public booking site, online room search for outsiders, and guest self-registration with passwords. In Phase 1 a guest is a **record created by the front desk** (name, phone, optional email, optional GSTIN). The `users` collection holds those guest profiles and has no password in Phase 1.
- Digital check-in (including any QR-based entry), WhatsApp, advanced analytics and automation.

**Hooks left in place so later phases don't need rewrites:** bookings are created through one service with a `source` field (`front_desk` now), guest verification sits behind a `GuestVerifier` interface, and payments sit behind a `PaymentProvider` interface.

### P1.0.1 Order of work and what becomes usable when

```
P1.1 Setup
  └─ P1.2 Backend core
       └─ P1.3 Auth and staff access
            └─ P1.4 Real-time foundation
                 └─ P1.5 Property, rooms, guest records
                      └─ P1.6 Bookings and front desk        ← the front desk can run bookings
                           ├─ P1.7 Housekeeping and maintenance
                           ├─ P1.8 Food menu and kitchen
                           └─ P1.9 Facilities, spa, recreation   ← all departments can work
                                └─ P1.10 Billing, GST, checkout  ← the hotel can bill and check guests out
                                     └─ P1.11 Manager dashboard, notifications, jobs
                                          └─ P1.12 Guest in-stay app      ← guests self-serve
                                               └─ P1.13 Online payments (Razorpay)
                                                    └─ P1.14 Hardening, deployment, acceptance test
```

Sub-phases P1.7, P1.8 and P1.9 depend only on P1.6, so they can be done in any order. Staff-side systems come first on purpose: the friend can start trying the real thing at P1.6 and can run the whole hotel by P1.10, before any guest-facing app exists.

---

### P1.1 Project setup (1-2 days)

**Goal:** an empty but fully working monorepo that builds, lints and tests.

- Create the folder structure exactly as in your spec (`apps/guest-app`, `apps/staff-app`, `apps/backend`, `packages/shared-types`, `validation`, `constants`, `docs/...`), with `pnpm-workspace.yaml`. Leave out the `trip-planner`, `recommendations` and `local-recommendations` folders for now.
- Shared TypeScript config (strict), ESLint, Prettier, Vitest.
- Docker Compose with a **one-node MongoDB replica set** (needed for transactions), and `.env.example`.
- A single `docs/architecture/decisions.md` recording the decisions in section 3.
- A minimal GitHub Actions workflow (install, lint, typecheck, test).

**Done when:** `pnpm install && pnpm lint && pnpm typecheck && pnpm test` pass on the empty skeleton, and the replica set starts with one command.

---

### P1.2 Backend core (4 days)

**Goal:** the shared plumbing every module will use, built and tested once.

- **Config:** `environment.ts` with Zod-validated env that fails at startup when a secret is missing (no fallback secrets), `database.ts`, and `socket.ts` stubbed.
- **HTTP plumbing:** `app.ts` / `server.ts`, `HttpError`, one async error handler, request validation middleware (Zod), pino logging with request ids, helmet, CORS allow-list, rate limiting, `GET /health`.
- **Tenant plugin and request context** (section 3.2): `propertyId` is required on every property-scoped model and injected into every query from the authenticated context. Queries without context throw.
- **State-machine helper** (section 3.5): transition tables plus one `transition()` function with optimistic concurrency and a `history[]` entry.
- **Audit-log helper** and the `audit_logs` model.
- **Test harness:** an in-memory replica set for tests, helpers to seed two properties, and a request helper that acts as a given user.
- Swagger/OpenAPI served at `/docs`, generated from the Zod schemas.

**Tests:** tenant plugin (a query with no context throws; a query for Property A never returns Property B documents, across find, update, delete, count and aggregate); state machine (legal and illegal transitions, and two concurrent transitions give exactly one winner); config (missing secret fails fast).

**Done when:** a dummy tenant-scoped model proves isolation in tests, and `/health` and `/docs` respond.

---

### P1.3 Authentication and staff access (4 days)

**Goal:** staff can log in, and every route is protected by role.

- **Staff login** with bcrypt, a short-lived access token, and a refresh token stored hashed in `refresh_tokens` with a **TTL index**, rotated on use. Logout revokes. Failed logins are rate limited and temporarily locked out.
- **Role-based access control:** roles `property_admin`, `manager`, `front_desk`, `kitchen`, `housekeeping`, `maintenance`, `spa_recreation` (plus `platform_admin` for setup tasks). Role and `propertyId` come only from the token and the database, never from request bodies.
- **Staff management** (property admin and manager): create, edit, deactivate staff, assign role and departments, reset password. Every change is audit-logged. A manager cannot create a role higher than their own.
- **Seed script:** two properties with a staff member in each role, used by all later cross-tenant tests.
- **Staff app:** React + Vite + Tailwind shell, login page, token handling with automatic refresh, route guards by role, department layout, and a typed API client using the shared types.

**Tests:** wrong password, locked-out account, expired and reused refresh tokens, every role against every protected route (403 where not allowed), attempts to set `role` or `propertyId` from the client are ignored, and a Property A token cannot touch Property B.

**Done when:** a seeded user logs in from the staff app and sees only the pages their role allows, and the staff app reaches the backend (this meets your "verify both frontends can communicate with the backend" item for the staff app; the guest app shell is added in P1.12).

---

### P1.4 Real-time foundation (3 days)

**Goal:** the live-update channel exists and is secure before any module needs it.

- A typed in-process event bus. Services emit events, and **only one socket gateway** subscribes and forwards them. Services never touch sockets.
- **Socket.IO gateway** with JWT authentication in the handshake. The server decides which rooms a connection joins: `p:{propertyId}:dept:{department}`, `p:{propertyId}:managers`, `p:{propertyId}:user:{userId}` (guest booking rooms are added in P1.12). Clients cannot join rooms by name, and they cannot send mutating events (all changes go through REST).
- Payloads carry ids and minimal data. The client refetches over REST, so authorization stays in one place.
- Mongo Socket.IO adapter wired in but only needed if a second backend instance is ever run.
- A `useRealtime` hook in the staff app with reconnect handling and a "reconnecting" indicator.

**Tests:** a bad or expired token is rejected; Property B staff never receive Property A events; a kitchen user never receives housekeeping events; a manager receives all events for their own property only.

**Done when:** a test event emitted by a service reaches exactly the right connected clients and no others.

---

### P1.5 Property, rooms and guest records (4 days)

**Goal:** the hotel's physical setup and its guest records exist in the system.

- **Properties:** settings for name, legal name, address, state, GSTIN, timezone, check-in and check-out times, department list, and the effective-dated GST rules (section 3.4). Edited by the property admin only.
- **Room types:** name, capacity, nightly tariff in paise, amenities.
- **Rooms:** number, floor, room type, status (`available`, `occupied`, `reserved`, `cleaning`, `maintenance`, `out_of_service`), active flag. Status changes follow rules, not free edits.
- **Guest records** (`users`): name, phone, optional email, optional GSTIN and ID details. Minimal personal data. ID details are optional and access-logged.
- **Staff app pages:** property settings, room types, rooms (list, create, edit, set out of service), guest search and profile.

**Tests:** tenant isolation on all of these; invalid tariffs and duplicate room numbers are rejected; room status rules; phone numbers are normalised and validated on guest records.

**Done when:** the friend can enter the real property, room types and rooms, and everything shows correctly.

---

### P1.6 Bookings and the front desk (6 days)

**Goal:** the front desk can take and manage bookings and run arrivals and departures. This is the core of the system.

- **Availability search** by dates and room type.
- **Create booking** (front desk only). Uses the `room_nights` collection with its unique index inside a transaction, so concurrent bookings can never double-book (section 3.3). A readable `bookingCode` is generated.
- **Booking lifecycle:** Pending → Confirmed → Checked-in → Checked-out, plus Cancelled and No-show. Change dates, change room, extend stay, cancel (releases the nights). Every change is in `history[]` and the audit log.
- **Check-in:** assigns or confirms the room, sets it `occupied`, records the guest details and time. (Check-out is completed in P1.10 once billing exists.)
- **Front desk dashboard:** today's arrivals and departures, in-house guests, a **room board** (rooms by floor with live status), a booking calendar, and booking search.
- **Events:** booking created, changed, checked in and so on, are emitted to the front desk and manager rooms.

**Tests:** N parallel requests for the same room and dates give exactly one success; overlap edge cases (back-to-back stays are allowed, overlapping ones are not); cancellation frees nights; illegal status moves return 409; time-zone handling for "today" and check-out times; front-desk-only access.

**Done when:** the friend can create, change, cancel and check in real bookings, and the room board updates live on a second browser window.

---

### P1.7 Housekeeping and maintenance (5 days)

**Goal:** housekeeping and maintenance teams work from their own live queues.

- **Housekeeping:** requests (towels, toiletries, room cleaning, pillows and blankets, other) and cleaning tasks. Workflow New → In Progress → Completed. Fields shown: guest, room, service, notes, request time, status. Staff-created requests on behalf of a guest come from the front desk until the guest app exists.
- **Maintenance:** issues (air conditioning, TV, Wi-Fi, plumbing, electrical, other). Workflow New → Assigned → In Progress → Resolved. Fields: room, issue, description, priority, assigned technician, status. A manager or the maintenance lead assigns and reassigns.
- **Room-state chain:** a maintenance issue can take a room out of service, and resolving it releases the room. A completed cleaning task moves a room from `cleaning` to `available`. All of these are transactional, unlike the reference repo.
- **Escalation:** any item can be flagged for the front desk or manager.
- **Dashboards:** Housekeeping and Maintenance, each with live updates through the P1.4 gateway, and department-scoped lists (a housekeeper never sees maintenance items).

**Tests:** illegal transitions (409), wrong role (403), double-assign races, room status rules from both directions, and live delivery to the correct department only.

**Done when:** front desk logs a request, it appears live on the right dashboard, staff move it to completed, and the room status follows.

---

### P1.8 Food menu and kitchen (5 days)

**Goal:** menu management and the kitchen workflow, with orders entered by staff.

- **Menu management** (manager): categories, items, prices, availability toggle, customisation options (for example spice level, add-ons), and images stored in GridFS.
- **Food orders** entered by the front desk or room service on behalf of a guest (the guest app adds self-ordering in P1.12). The server prices items from the menu and snapshots name, price and options, so later menu edits never change an existing order.
- **Kitchen dashboard:** Received → Preparing → Ready to Serve → Delivered, plus Cancelled before Preparing. Shows order id, guest, room, items, customisation, order time and status, with new-order sound and late-order highlighting.
- **Billing hook:** a delivered order emits an `order.delivered` event. Posting to the guest's bill is added in P1.10, and a reconciliation step there picks up any orders delivered earlier, so nothing is missed or posted twice.

**Tests:** price cannot be set by the client; option snapshots; illegal transitions; kitchen sees only kitchen orders; live delivery of new orders.

**Done when:** front desk places an order for Room 204, the kitchen sees it appear, moves it to delivered, and the front desk sees the status change.

---

### P1.9 Facilities, spa and recreation (5 days)

**Goal:** facilities with slots, bookings and a department dashboard.

- **Facilities:** spa, pool, gym, activities, with hours, slot length, capacity and price.
- **Available slots** API per facility and date.
- **Facility bookings** with double-booking protection (section 3.3): a partial unique index for exclusive facilities, and a capacity check inside a transaction for shared ones.
- **Workflow:** Booking Request → Confirmed → Active → Completed, plus Cancelled and No-show.
- **Spa and Recreation dashboard:** guest details, facility, booking date, time slot, availability and status.
- Staff (front desk or spa staff) make bookings on behalf of guests until the guest app exists.

**Tests:** concurrent bookings for the last slot, capacity limits, cancellations free the slot, past-slot rules, department scoping, live updates.

**Done when:** a facility can be booked, confirmed, started and completed, and a full slot cannot be booked again.

---

### P1.10 Billing, GST and checkout (8 days)

**Goal:** accurate bills, GST invoices, payment recording and check-out. This is the sub-phase that most needs the accountant's sign-off.

- **Bill (folio):** one per booking, built from line items (room nights, food orders, facility bookings, other services). Each line stores source reference, quantity, price, SAC code, tax rate and tax amounts as snapshots. A **unique source reference per line** makes posting idempotent.
- **Posting:** a delivered food order, a completed facility booking and room nights post to the bill inside a transaction. A reconciliation step posts anything delivered before billing existed. Staff can add manual charges and discounts with a reason (audit-logged, manager approval above a limit).
- **GST engine:** effective-dated rules from the property config, room slab by nightly tariff, per-line tax, CGST/SGST versus IGST by place of supply, and paise rounding with a round-off line (section 3.4).
- **Invoices:** gap-free numbers per property per financial year from the `counters` collection, GST-style printable and PDF output, immutable once finalized, corrections by credit note.
- **Payments recorded by staff:** cash, UPI or card taken at the desk (and partial payments). Each is a `payments` record against the bill. Refunds and the balance are tracked. (Online payment arrives in P1.13.)
- **Check-out:** one transaction that checks the guest out, finalizes the bill, releases the room, creates the housekeeping cleaning task, and stamps the invoice. It refuses if there is an unpaid balance unless a manager overrides with a reason.
- **Staff app pages:** bill view, add charge, record payment, finalize and print invoice, and a payments ledger.

**Tests:** GST for every slab boundary (for example a ₹1,000, ₹1,001, ₹7,500 and ₹7,501 tariff), intra-state versus inter-state, rounding, idempotent posting (the same order never posts twice), concurrent finalize, invoice numbers with no gaps under parallel finalization, immutability, and checkout rolling back cleanly if any step fails.

**Done when:** a full stay (rooms, food, spa) produces a correct GST invoice that the accountant approves, and check-out leaves the room cleaning-ready.

---

### P1.11 Manager dashboard, notifications and background jobs (5 days)

**Goal:** the manager sees the whole property, and the system looks after itself.

- **Manager dashboard:** every department's queue within the property, assign and reassign, escalations, pending versus completed counts, and **real statistics computed from actual data**: occupancy, room status counts, arrivals and departures, revenue by day and by department, and average response times. There are no placeholder or random values anywhere.
- **Staff account management UI** (built on P1.3) and an **audit log viewer**.
- **Notifications:** a `notifications` module, in-app notification centre for staff, unread counts, and live delivery.
- **Background jobs:** a `background_jobs` collection and a polling worker with locking and retries, used for notification clean-up, SLA reminders (a request open too long pings the manager) and any retries.

**Tests:** statistics match hand-computed fixtures, manager sees only their own property, job worker retries and never runs one job twice, notification delivery scoping.

**Done when:** the manager can see and act on everything for the property from one place, and every number on the screen traces to real data.

---

### P1.12 Guest in-stay app (7 days)

**Goal:** guests serve themselves from their phone, with no app install.

- **Guest app:** React + Vite + Tailwind, mobile-first, installable (manifest plus a simple cache), loading, error and success states. Pages: `auth`, `dashboard`, `food-ordering`, `service-requests`, `maintenance`, `facility-booking`, `billing`.
- **Phone login (section 3.9):** the guest opens the property's link and logs in with the **phone number linked to their booking plus the Booking ID**, through the `GuestVerifier` interface. Login works only for checked-in bookings. It is rate limited per IP, phone and booking, with lockout, a generic failure message and audit-logged failures. A successful login creates a guest session scoped to one `{propertyId, bookingId, roomId}`, valid until check-out plus a short grace period for paying the bill.
- **Front desk support:** the booking screen shows the Booking ID and the login link to hand to the guest, and lets staff reset a lockout.
- **Dashboard:** guest details, property info, room number, check-in and check-out dates, active requests and bookings, and quick links.
- **Self-service:** order food (menu, customisation, cart, order tracking), request housekeeping, report maintenance problems, book facilities (slots, confirmation, status), and view the bill with an itemised, tax-inclusive balance.
- **Live updates:** the guest session joins `p:{propertyId}:booking:{bookingId}` so order and request statuses update in real time.
- **OTP-ready structure (section 3.9):** two-step `start` / `verify` login endpoints, a `GuestVerifier` interface with both methods, a server-driven login step flow in the guest app, the per-property `guestLoginMode` setting, and `phoneVerifiedAt` on guest records. No OTP, SMS or `otp_challenges` code is built in this sub-phase.
- **Backend:** guest-scoped endpoints that take the booking and room only from the session, never from the request.

**Tests:** a guest can only see and create against their own booking; the client cannot override prices, booking, room or property; wrong phone or wrong Booking ID gives the same generic error, phone formats (`98765 43210`, `+91 98765 43210`, `09876543210`) match the same number, login refused before check-in and after check-out plus grace, lockout and front-desk reset, and session expiry after the grace period; a guest never receives another room's events; component tests for the cart.

**Done when:** a checked-in guest logs in with their phone number and Booking ID, orders food from Room 204, watches it move through the kitchen live, and requests housekeeping, all of which show up on the staff dashboards.

---

### P1.13 Online payments with Razorpay (4 days)

**Goal:** guests can pay their bill by UPI or card.

- **`PaymentProvider` interface** with the Razorpay adapter (create order, verify webhook, confirm payment, refund) and a fake provider for tests (section 3.7).
- **Flow:** the server creates a Razorpay order for the **server-computed outstanding balance**, the guest app opens Razorpay Checkout, and the webhook confirms. The webhook checks `X-Razorpay-Signature` over the raw body, confirms with Razorpay's API, checks the amount, and records the payment idempotently by payment id.
- **Edge cases:** duplicate webhooks, underpayment, late payment after an order lapsed (flagged for staff), failed and abandoned payments, and refunds by a manager.
- **Receipts:** payment confirmation in the guest app and in the staff ledger.

**Tests:** bad signature gets 401; a duplicate webhook is recorded once; underpayment is rejected; the amount always comes from the server; out-of-order webhooks never overwrite a newer status; refund flow. A sandbox smoke test runs in Razorpay test mode.

**Done when:** a guest pays the outstanding balance in test mode and the bill, the ledger and the guest's screen all agree.

---

### P1.14 Hardening, deployment and acceptance test (4 days)

**Goal:** safe to run for real at the friend's property.

- **Security pass:** full security review, dependency audit, the cross-tenant contract test over every route and every socket event, rate-limit review, and secret handling check.
- **Data and backup:** indexes verified on realistic data volume, Atlas backups on, a restore test, and a data-retention rule for ID details.
- **Deployment** (section 3.10): Atlas, the always-on backend, static frontends, domain and HTTPS, environment settings, uptime check on `/health`, and the printed check-in slips or room cards carrying the final guest login link.
- **Documentation:** README setup and run guide, API docs export, schema docs, and a short **staff user guide** for each department.
- **Acceptance test with the friend:** the walkthrough below, run on the real deployment.

**Phase 1 acceptance walkthrough:**
1. The front desk creates a booking and checks the guest in.
2. The guest opens the login link, signs in with their phone number and Booking ID, and orders food. (A wrong Booking ID is refused.)
3. The kitchen sees the order live and moves it to delivered.
4. The guest requests towels and reports an air-conditioning fault. Housekeeping and maintenance each see theirs live.
5. The guest books a spa slot, and the spa dashboard confirms it.
6. The manager sees all of it, with correct statistics.
7. The guest pays part of the bill online and the rest is recorded at the desk.
8. The front desk checks the guest out. The GST invoice is correct, the room goes to cleaning, and housekeeping gets the task.

**Done when:** the walkthrough passes on the deployed system and the accountant has approved the sample invoices.

---

### Phase 1 effort summary

| Sub-phase | Days | Becomes usable |
|---|---|---|
| P1.1 Setup | 1-2 | |
| P1.2 Backend core | 4 | |
| P1.3 Auth and staff access | 4 | Staff can log in |
| P1.4 Real-time foundation | 3 | |
| P1.5 Property, rooms, guests | 4 | Property set up |
| P1.6 Bookings and front desk | 6 | **Front desk runs bookings** |
| P1.7 Housekeeping and maintenance | 5 | |
| P1.8 Food menu and kitchen | 5 | |
| P1.9 Facilities, spa, recreation | 5 | **All departments working** |
| P1.10 Billing, GST, checkout | 8 | **Hotel can bill and check out** |
| P1.11 Manager, notifications, jobs | 5 | |
| P1.12 Guest in-stay app | 7 | **Guests self-serve** |
| P1.13 Online payments | 4 | |
| P1.14 Hardening, deploy, acceptance | 4 | **Go live** |
| **Total** | **about 65-66** | about 13 weeks full-time, longer part-time |

These figures are more detailed than my earlier rough ranges, and the total is higher because the front desk, rooms, manager statistics and acceptance work are now itemised instead of folded together. They are estimates, not commitments, and the friend can start using the system at the P1.6 and P1.10 milestones long before the end.

---

## Phase 2 (deferred): local recommendations, AI trip planner and maps

Not built now. When this phase is planned it will use sections 3.8 and the data model rows for `trip_plans` and `local_places`.

- Local recommendations (restaurants, attractions, shopping, transport, activities), curated by staff and discovered through Google Places.
- AI personalised trip planner: Google Places for candidates, Google Routes for travel times, a pluggable LLM (Claude, Gemini or OpenAI), schema-validated output, "verified versus estimate" labels, editable itineraries stored in MongoDB, and usage caps.
- Needs, at that time: a Google Cloud project with billing, and an LLM API key.
- Guest app additions: `trip-planner` and `local-recommendations` pages. Backend additions: `trip-planner` and `recommendations` modules.

## Phase 3 (deferred): public online booking site

Not built now. This is the separate "MakeMyTrip-style" booking experience.

- Public room search and booking, guest accounts, and payment at booking time.
- The final guest-verification method (decided later).
- Phase 1 already leaves the three seams this needs: the booking service with its `source` field, the `GuestVerifier` interface, and the `PaymentProvider` interface. Rate plans, cancellation policy and overbooking rules are new scope that will be designed then.

## Phase 4 (deferred): advanced features

- **Phone number + OTP login** (a small, separate upgrade of about 3 to 4 days, described in section 3.9, that can be pulled forward at any time after P1.12).
- Digital check-in with ID capture (QR-based if wanted), WhatsApp integration (status updates first), advanced analytics, and automation such as SLA escalation and post-stay review requests.

---

## 6. Cross-cutting requirements

**Security checklist (every phase):**
- No hardcoded secrets; env validated at startup.
- All inputs validated (Zod) at the boundary.
- Parameterized queries only. Operator-injection protection (`express-mongo-sanitize` or strict Zod schemas) because Mongo is the target.
- Rate limiting, with stricter limits on staff login, guest login and (from Phase 2) AI endpoints.
- Audit-log sensitive actions: role changes, refunds, check-out, bill edits, staff creation, token revocation.
- Error responses never leak internals.
- Guest PII minimised, ID documents encrypted at rest and access-logged.
- Dependency audit in CI.

**Testing:** unit, integration (replica-set Mongo), and Playwright E2E for the critical flows. Cross-tenant contract tests run in CI on every PR. Target 80%+ coverage.

**Docs (`docs/`):** architecture overview and ADRs, OpenAPI export, database schema doc generated from the Mongoose models, and a setup/run guide in the README.

**Process per rule set:** planner, then test-first implementation, then code review after each module, security review before each commit touching auth/input/DB/payments, conventional commits.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Replica-set requirement for transactions | Docker one-node replset in dev, Atlas in prod, `MongoMemoryReplSet` in tests. |
| Places API terms limit caching (**Phase 2**) | Store place ids and curated data, short-lived cache only. |
| Razorpay business verification takes time | Build against test mode, with a gateway interface so another provider can be swapped in. Online payment is the late sub-phase P1.13, and staff can record cash/UPI/card at the desk from P1.10, so go-live is not blocked by it. |
| LLM cost and abuse (**Phase 2**) | Per-guest and global caps and cost logging from day one. |
| Scope: Phase 1 is 14 sub-phases and about 13 weeks full-time | Sub-phases are independently demoable. The guest in-stay app (P1.12) and online payments (P1.13) come last and can be postponed without affecting the staff-side system, which is usable from P1.6 and billable from P1.10. |
| Reference repos are small personal projects | We take ideas, not dependencies, and nothing is copied from either repo. |
| GST rules are misapplied on a real invoice | Rules are config, effective-dated and snapshotted per line. The accountant signs off on the defaults before first use. |
| Different LLM providers behave differently (structured output, limits) | Provider adapters plus our own schema validation, retry once, then fail cleanly. |
| Tenant plugin misses an edge case (for example `bulkWrite`) | Contract tests, plus a lint rule banning raw collection access outside the data layer. |

---

## 8. Locked decisions and what is still open

### 8.1 Locked (from the owner)

| Topic | Decision |
|---|---|
| Payment gateway | Razorpay first, behind a `PaymentProvider` interface so other gateways can be added (section 3.7). |
| LLM provider | Left open: Claude, Gemini or OpenAI, switched by configuration (section 3.8). |
| Maps | Google Maps Platform (Places and Routes). |
| Region, currency, tax | India, INR, GST by the current rules, configurable and effective-dated (section 3.4). |
| Booking creation | Front desk only, with a staff login. A public booking site may come later, so booking creation is one service with a `source` field. |
| Guest login | **No QR codes in Phase 1.** Guests log in with the phone number linked to their booking plus the Booking ID, only once checked in, behind a swappable two-step `GuestVerifier` interface. **Built so phone number + SMS OTP can be added later as a setting-level switch, without rewriting login** (section 3.9). |
| Reference repos | Everything is re-implemented from scratch. No code copied, no author contact. |
| Audience | Private use for a friend's property. Not published. |
| Hosting | My call: Atlas (Mumbai) plus one always-on backend, static frontends (section 3.10). |
| Frontend libraries | Not specified, so the default stands: React Router, Zustand, TanStack Query. |
| Phase 1 scope | Hotel management system only, including the guest in-stay app (P1.12). Trip planner, recommendations, Maps and the public booking site are deferred to Phases 2 to 4. |

### 8.2 Scope adjustments because this is a private, single-friend project

The architecture stays as your spec describes (multi-property, role-based, MongoDB only), but I will trim ceremony that only matters for public products:

- One `docs/architecture/decisions.md` file instead of a separate ADR file per decision.
- Playwright end-to-end tests for the 4 or 5 critical flows only (guest orders food, kitchen updates it, guest pays, checkout). Unit and integration tests still target 80%+ coverage.
- Rate limiting uses the in-memory store (single instance).
- PWA means installable with a manifest and a simple cache, not full offline support.
- Phases 3 and 4 are optional and will be planned only after Phase 1 is in real use.

### 8.3 Still open (none of these block P1.1 or P1.2)

These are facts about the friend's property and accounts. I'll ask for each one in the sub-phase that needs it:

1. **Property facts** (P1.5): property name and type, number of rooms and room types with nightly tariffs, floors, departments that exist (kitchen, spa, pool and so on), state, and GSTIN.
2. **Billing policy** (P1.8 to P1.10): are food orders always charged to the room bill, and is there a service charge? Is the food menu one menu or several outlets?
3. **GST sign-off** (before P1.10 goes live): the friend's accountant confirms the default rules in section 3.4.
4. **Accounts:** a Razorpay account, with test mode enough until go-live (needed at P1.13). The Google Cloud project and the LLM API key are **not needed until Phase 2**.
5. **Domain name** (before P1.13): needed for HTTPS, webhooks and the guest login link printed for guests.
6. **Guest login method beyond phone + Booking ID, and the public booking site:** to be decided later (Phase 3). Phase 1 uses the linked phone number plus the Booking ID.
7. ~~Is the guest in-stay app (P1.12) in Phase 1?~~ **Resolved: yes, it stays in Phase 1.** It is built last (P1.12) and could still be moved later without touching anything else.
