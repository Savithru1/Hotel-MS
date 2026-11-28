import { describe, expect, it } from 'vitest';
import { AUDIT_PAGE_SIZE, EMPTY_FILTERS, buildAuditQuery, summaryText } from './audit-query';

describe('buildAuditQuery', () => {
  it('sends only the page and the page size when nothing is filtered', () => {
    expect(buildAuditQuery(EMPTY_FILTERS, 1)).toEqual({ page: 1, limit: AUDIT_PAGE_SIZE });
  });

  it('sends each filled filter under the name the server expects, trimmed', () => {
    const query = buildAuditQuery(
      {
        from: '2026-11-01',
        to: '2026-11-27',
        action: ' staff.update ',
        actor: 'system',
        targetType: 'staff',
        targetId: ' st9 ',
      },
      3,
    );
    expect(query).toEqual({
      page: 3,
      limit: AUDIT_PAGE_SIZE,
      from: '2026-11-01',
      to: '2026-11-27',
      action: 'staff.update',
      actorId: 'system',
      targetType: 'staff',
      targetId: 'st9',
    });
  });

  it('leaves out filters that are only spaces', () => {
    expect(buildAuditQuery({ ...EMPTY_FILTERS, action: '   ' }, 1)).toEqual({
      page: 1,
      limit: AUDIT_PAGE_SIZE,
    });
  });
});

describe('summaryText', () => {
  it('shows the values as "key: value" pairs, exactly as the server redacted them', () => {
    expect(summaryText({ role: 'kitchen', password: '[redacted]' }, 200)).toBe(
      'role: kitchen, password: [redacted]',
    );
  });

  it('shows nested values as short JSON and numbers as numbers', () => {
    expect(summaryText({ rooms: 3, change: { from: 'a', to: 'b' } }, 200)).toBe(
      'rooms: 3, change: {"from":"a","to":"b"}',
    );
  });

  it('cuts a huge summary instead of dumping it', () => {
    const text = summaryText({ note: 'x'.repeat(5_000) }, 100);
    expect(text).toHaveLength(100);
    expect(text.endsWith('…')).toBe(true);
  });

  it('says there are no details when the summary is empty or null', () => {
    expect(summaryText(null, 100)).toBe('');
    expect(summaryText({}, 100)).toBe('');
  });
});
