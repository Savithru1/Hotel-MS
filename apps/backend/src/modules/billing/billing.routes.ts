import {
  addBillLineSchema,
  billLineParamsSchema,
  bookingIdParamsSchema,
  creditNoteSchema,
  idParamsSchema,
  listBillsQuerySchema,
  listPaymentsQuerySchema,
  paymentsSummaryQuerySchema,
  recordPaymentSchema,
  refundSchema,
} from '@hospitality/validation';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { MANAGEMENT, requireRole } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { unauthorized } from '../../shared/errors';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import type {
  AddLineInput,
  BillingService,
  ListBillsInput,
  ListPaymentsInput,
  PaymentInput,
  RefundInput,
} from './billing.service';

/** The front desk runs bills and takes payments; management also refunds and corrects invoices. */
export const BILLING_STAFF = ['front_desk', ...MANAGEMENT] as const;

export function billingRouter(
  tokens: TokenService,
  auth: AuthService,
  billing: BillingService,
): Router {
  const router = Router();
  router.use(authenticate(tokens, auth));
  const idParams = validate({ params: idParamsSchema });
  const idOf = (req: { validated?: { params?: unknown } }): string =>
    (req.validated?.params as { id: string }).id;

  router.get(
    '/',
    requireRole(...BILLING_STAFF),
    validate({ query: listBillsQuerySchema }),
    async (req, res) => {
      const query = req.validated?.query as ListBillsInput;
      const { items, total } = await billing.list(query);
      res.json({
        success: true,
        data: items,
        meta: { total, page: query.page, limit: query.limit },
      });
    },
  );

  // Fixed paths come before `/:id`.
  router.get(
    '/by-booking/:bookingId',
    requireRole(...BILLING_STAFF),
    validate({ params: bookingIdParamsSchema }),
    async (req, res) => {
      const { bookingId } = req.validated?.params as { bookingId: string };
      res.json({ success: true, data: await billing.forBooking(bookingId) });
    },
  );

  router.get('/:id', requireRole(...BILLING_STAFF), idParams, async (req, res) => {
    res.json({ success: true, data: await billing.get(idOf(req)) });
  });

  router.post(
    '/:id/lines',
    requireRole(...BILLING_STAFF),
    validate({ params: idParamsSchema, body: addBillLineSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const bill = await billing.addLine(req.staff, idOf(req), req.validated?.body as AddLineInput);
      res.status(201).json({ success: true, data: bill });
    },
  );

  router.delete(
    '/:id/lines/:lineId',
    requireRole(...BILLING_STAFF),
    validate({ params: billLineParamsSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const { id, lineId } = req.validated?.params as { id: string; lineId: string };
      res.json({ success: true, data: await billing.removeLine(req.staff, id, lineId) });
    },
  );

  router.post(
    '/:id/payments',
    requireRole(...BILLING_STAFF),
    validate({ params: idParamsSchema, body: recordPaymentSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const bill = await billing.recordPayment(
        req.staff,
        idOf(req),
        req.validated?.body as PaymentInput,
      );
      res.status(201).json({ success: true, data: bill });
    },
  );

  router.post(
    '/:id/refunds',
    requireRole(...MANAGEMENT),
    validate({ params: idParamsSchema, body: refundSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const bill = await billing.refund(req.staff, idOf(req), req.validated?.body as RefundInput);
      res.status(201).json({ success: true, data: bill });
    },
  );

  router.post('/:id/finalize', requireRole(...BILLING_STAFF), idParams, async (req, res) => {
    if (!req.staff) throw unauthorized();
    res.json({ success: true, data: await billing.finalize(req.staff, idOf(req)) });
  });

  router.post(
    '/:id/credit-notes',
    requireRole(...MANAGEMENT),
    validate({ params: idParamsSchema, body: creditNoteSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const input = req.validated?.body as { lineId: string; reason: string };
      res.status(201).json({
        success: true,
        data: await billing.creditNote(req.staff, idOf(req), input),
      });
    },
  );

  const base = { tag: 'Billing', secured: true } as const;
  documentRoute({
    ...base,
    method: 'get',
    path: '/bills',
    summary: 'Bills, newest first',
    roles: BILLING_STAFF,
    query: listBillsQuerySchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/bills/by-booking/:bookingId',
    summary:
      'The bill of a checked-in guest. Opens it if needed and posts nights, delivered orders and completed bookings, once each',
    roles: BILLING_STAFF,
    params: bookingIdParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/bills/:id',
    summary: 'One bill with its lines, totals, payments and credit notes',
    roles: BILLING_STAFF,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/bills/:id/lines',
    summary:
      'Add a charge or discount by hand. The server works out the tax; above the approval limit a manager is needed',
    roles: BILLING_STAFF,
    params: idParamsSchema,
    body: addBillLineSchema,
  });
  documentRoute({
    ...base,
    method: 'delete',
    path: '/bills/:id/lines/:lineId',
    summary: 'Remove a charge or discount added by hand, while the bill is open',
    roles: BILLING_STAFF,
    params: billLineParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/bills/:id/payments',
    summary: 'Record cash, UPI, card or a transfer taken at the desk. More than is owed is refused',
    roles: BILLING_STAFF,
    params: idParamsSchema,
    body: recordPaymentSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/bills/:id/refunds',
    summary: 'Refund money that was paid. Managers only, with a reason',
    roles: MANAGEMENT,
    params: idParamsSchema,
    body: refundSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/bills/:id/finalize',
    summary:
      'Issue the GST invoice with the next gap-free number. The invoice cannot be changed afterwards',
    roles: BILLING_STAFF,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/bills/:id/credit-notes',
    summary:
      'Correct an issued invoice by reversing one line with a numbered credit note. Managers only',
    roles: MANAGEMENT,
    params: idParamsSchema,
    body: creditNoteSchema,
  });

  return router;
}

/** The payments ledger: every payment and refund, and a day's totals by method. */
export function paymentsRouter(
  tokens: TokenService,
  auth: AuthService,
  billing: BillingService,
): Router {
  const router = Router();
  router.use(authenticate(tokens, auth), requireRole(...BILLING_STAFF));

  router.get('/', validate({ query: listPaymentsQuerySchema }), async (req, res) => {
    const query = req.validated?.query as ListPaymentsInput;
    const { items, total } = await billing.payments(query);
    res.json({ success: true, data: items, meta: { total, page: query.page, limit: query.limit } });
  });

  router.get('/summary', validate({ query: paymentsSummaryQuerySchema }), async (req, res) => {
    const { date } = req.validated?.query as { date: string };
    res.json({ success: true, data: await billing.paymentsSummary(date) });
  });

  const base = { tag: 'Billing', secured: true } as const;
  documentRoute({
    ...base,
    method: 'get',
    path: '/payments',
    summary: 'The payments ledger, newest first, filterable by day, method and kind',
    roles: BILLING_STAFF,
    query: listPaymentsQuerySchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/payments/summary',
    summary: 'A day of payments and refunds: money in, money out and the net, by method',
    roles: BILLING_STAFF,
    query: paymentsSummaryQuerySchema,
  });

  return router;
}
