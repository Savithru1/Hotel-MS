# Project instructions for every Claude session

This is a private hotel management system (hospitality platform) for a friend's property. These rules apply to every session, whatever it was asked to do.

## 1. First thing, every session: read the checklist

1. Read `PROGRESS.md` (the live checklist). Start with the **RESUME POINT** block at the top.
2. Read the relevant part of `IMPLEMENTATION_PLAN.md` for the sub-phase you are about to work on (architecture rules are in its section 3, data model in section 4, sub-phase detail in section 5).
3. Tell the owner in one or two lines where the project stands and what you will do next, then continue from the resume point. Do not restart, redo or re-plan finished work.

`PROGRESS.md` is the single source of truth. If it disagrees with your memory or with a chat summary, trust `PROGRESS.md` and the code, and fix whichever is wrong.

## 2. Keep the checklist updated as you work (not only at the end)

- **When you start a task:** add `(IN PROGRESS)` after its line and update the RESUME POINT block ("Currently in progress").
- **When a task is finished and verified:** change `[ ]` to `[x]` and remove `(IN PROGRESS)`. Verified means the relevant tests, type check and lint actually ran and passed. Never tick an item that is untested, partly done, or only stubbed.
- **When something is blocked:** add `(BLOCKED: reason)` and say so in the RESUME POINT block.
- **When you make a decision or the owner gives one:** append a row to the Decisions log, and update `IMPLEMENTATION_PLAN.md` if it changes the plan.
- **At the end of every working session or turn that changed anything:** update the RESUME POINT block (last updated date, current sub-phase, in progress, next action, blockers) and add one row to the Session log saying what happened and **exactly where it stopped**. A different session must be able to continue from that row alone.
- If you add, remove or change a task, change it in `PROGRESS.md` too. Do not leave the checklist behind the real state of the code.

## 3. Save and push the checklist

After updating `PROGRESS.md` (or any project file), commit it with a conventional commit message (`docs:`, `feat:`, `fix:`, `test:`, `chore:` ...) and push to the `origin` remote. If no remote is configured yet, or a push fails, do not hide it: write it in the RESUME POINT block and tell the owner. Never commit secrets, `.env` files or `.claude/settings.local.json`.

## 4. Work order

- Build **Phase 1 only**, one sub-phase at a time, **in the order listed** in `PROGRESS.md` (P1.7, P1.8 and P1.9 may be swapped). Do not skip ahead, and do not start Phases 2 to 4 unless the owner says so.
- Do not start building a new sub-phase unless the owner has told you to proceed (the first go-ahead is for P1.1). Once the owner has said to build, continue through the sub-phases in order and report at each "Done when" check.
- Follow the rules in the global config: tests first (TDD) with 80%+ coverage, code review after writing code, security review for anything touching auth, input, database or payments.

## 5. Non-negotiable project rules

- **MongoDB is the only database.** Mongoose is the ODM. No Redis, Postgres, MySQL, SQLite, Firebase, Supabase or any other store or database-backed service. Use TTL indexes, transactions and GridFS inside MongoDB.
- **Every property-related document has `propertyId`**, enforced by the tenant plugin. Never trust a `propertyId`, `bookingId`, `roomId` or role sent by a frontend. Derive them from the token and verify against the database.
- **No QR codes in Phase 1.** Guests log in with the phone number linked to the booking plus the Booking ID, only after check-in, through the two-step `GuestVerifier` interface so phone + SMS OTP can be added later.
- **Everything is written from scratch.** Do not copy code from the reference repos (LuxuryStay, hotel-ops). Ideas only.
- **Money** is integer paise (INR). **GST** rules come from effective-dated config and are snapshotted on every bill line. Never hardcode rates in logic.
- **Payments** go through the `PaymentProvider` interface (Razorpay first). Only a verified payment can mark a bill paid. The amount to charge always comes from the server.
- **Do not present placeholder or fake behaviour as a working feature.** No random or fallback numbers on dashboards.
- **No Google Maps, Places, recommendations or LLM code in Phase 1**, and no keys for them.
- Keep the structure from the spec: `apps/guest-app`, `apps/staff-app`, `apps/backend`, `packages/shared-types|validation|constants`, `docs/`. Backend modules use `model.ts`, `controller.ts`, `service.ts`, `routes.ts`, `validation.ts`, `types.ts`.

## 6. Files to know

| File | Purpose |
|---|---|
| `PROGRESS.md` | Live checklist, resume point, decisions log, session log. **Read first, update always.** |
| `IMPLEMENTATION_PLAN.md` | Architecture, data model, detailed sub-phases and acceptance walkthrough. |
| `docs/architecture/decisions.md` | Decision record (created in P1.1). |
