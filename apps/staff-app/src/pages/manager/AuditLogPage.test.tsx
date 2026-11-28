import type { AuditEntryDto } from '@hospitality/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { createFakeApi, staffDto } from '../../test/fakeApi';
import { auditEntry } from '../../test/managerFixtures';
import { mountAt } from '../../test/mount';
import { dateTimeLabel } from './format';

function open(entries: AuditEntryDto[] = [auditEntry()], total = entries.length) {
  const api = createFakeApi(staffDto('manager'));
  const queries: Record<string, unknown>[] = [];
  api.on('GET /audit-logs', (_body: unknown, query: unknown) => {
    queries.push(query as Record<string, unknown>);
    return { data: entries, meta: { total, page: 1, limit: 25 } };
  });
  mountAt(api, '/audit');
  return { api, queries };
}

const type = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

describe('the audit log page', () => {
  it('lists who did what, to what, and when, with redacted values as the server returned them', async () => {
    open([
      auditEntry(),
      auditEntry({
        id: 'a2',
        actor: { kind: 'system', id: 'system', role: null, name: null },
        action: 'job.failed',
        target: { type: 'job', id: 'j7' },
        summary: null,
      }),
    ]);
    const table = await screen.findByRole('table', { name: 'Audit log' });
    const first = within(within(table).getByRole('row', { name: 'Meera Nair staff.update' }));
    expect(first.getByText('Meera Nair')).toBeInTheDocument();
    expect(first.getByText('manager')).toBeInTheDocument();
    expect(first.getByText('staff.update')).toBeInTheDocument();
    expect(first.getByText('staff')).toBeInTheDocument();
    expect(first.getByText('st9')).toBeInTheDocument();
    expect(first.getByText('role: kitchen, password: [redacted]')).toBeInTheDocument();
    expect(first.getByText(dateTimeLabel('2026-11-27T05:00:00.000Z'))).toBeInTheDocument();

    const second = within(within(table).getByRole('row', { name: 'System job.failed' }));
    expect(second.getByText('System')).toBeInTheDocument();
    expect(second.getByText('job.failed')).toBeInTheDocument();
  });

  it('asks for the first page with no filters to begin with', async () => {
    const { queries } = open();
    await screen.findByRole('table', { name: 'Audit log' });
    expect(queries[0]).toEqual({ page: 1, limit: 25 });
  });

  it('turns the filter form into the right query', async () => {
    const { queries } = open();
    await screen.findByRole('table', { name: 'Audit log' });
    type('From', '2026-11-01');
    type('To', '2026-11-27');
    type('Action', 'staff.update');
    type('Person', 'system');
    type('Record type', 'staff');
    type('Record id', 'st9');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() =>
      expect(queries).toContainEqual({
        page: 1,
        limit: 25,
        from: '2026-11-01',
        to: '2026-11-27',
        action: 'staff.update',
        actorId: 'system',
        targetType: 'staff',
        targetId: 'st9',
      }),
    );
  });

  it('clears the filters and shows everything again', async () => {
    const api = createFakeApi(staffDto('manager'));
    api.on('GET /audit-logs', (_body: unknown, query: unknown) => {
      const filtered = (query as { action?: string }).action === 'staff.update';
      const entry = filtered
        ? auditEntry({ actor: { kind: 'system', id: 'system', role: null, name: null } })
        : auditEntry({ action: 'room.update' });
      return { data: [entry], meta: { total: 1, page: 1, limit: 25 } };
    });
    mountAt(api, '/audit');
    expect(await screen.findByText('room.update')).toBeInTheDocument();
    type('Action', 'staff.update');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('System')).toBeInTheDocument();
    expect(screen.queryByText('room.update')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('room.update')).toBeInTheDocument();
    expect(screen.getByLabelText('Action')).toHaveValue('');
  });

  it('does not ask the server for a range that runs backwards', async () => {
    const { queries } = open();
    await screen.findByRole('table', { name: 'Audit log' });
    type('From', '2026-11-20');
    type('To', '2026-11-10');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('must not be after "to"')).toBeInTheDocument();
    expect(queries.some((q) => q.from === '2026-11-20')).toBe(false);
  });

  it('pages with the total from the server', async () => {
    const { queries } = open([auditEntry()], 60);
    await screen.findByRole('table', { name: 'Audit log' });
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByText('60 entries')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(queries.at(-1)).toEqual({ page: 2, limit: 25 }));
    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Page 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('goes back to page 1 when a filter changes', async () => {
    const { queries } = open([auditEntry()], 60);
    await screen.findByRole('table', { name: 'Audit log' });
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Page 2 of 3');
    type('Action', 'x.y');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(queries.at(-1)).toEqual({ page: 1, limit: 25, action: 'x.y' }));
  });

  it('cuts a huge summary instead of dumping it on screen', async () => {
    open([auditEntry({ summary: { note: 'x'.repeat(5_000) } })]);
    const table = await screen.findByRole('table', { name: 'Audit log' });
    expect(table.textContent?.includes('x'.repeat(500))).toBe(false);
    expect(within(table).getByText(/^note: x+…$/)).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    open([]);
    expect(await screen.findByText('No audit entries match these filters.')).toBeInTheDocument();
  });

  it('shows an error with a retry button', async () => {
    const api = createFakeApi(staffDto('manager'));
    let failing = true;
    api.on('GET /audit-logs', () => {
      if (failing) throw new ApiError(403, 'forbidden', 'The audit log is not available.');
      return { data: [auditEntry()], meta: { total: 1, page: 1, limit: 25 } };
    });
    mountAt(api, '/audit');
    expect(await screen.findByRole('alert')).toHaveTextContent('The audit log is not available.');
    failing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Audit log' })).toBeInTheDocument();
  });
});
