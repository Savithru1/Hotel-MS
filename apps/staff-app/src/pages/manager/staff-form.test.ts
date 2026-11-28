import { describe, expect, it } from 'vitest';
import { staffDto } from '../../test/fakeApi';
import { assignableRoles, buildStaffUpdate, draftFrom } from './staff-form';

const original = staffDto('front_desk', {
  name: 'Asha Rao',
  departments: ['front_desk'],
});

describe('assignableRoles', () => {
  it('offers only roles strictly below the actor, and never platform_admin', () => {
    expect(assignableRoles('manager')).toEqual([
      'front_desk',
      'kitchen',
      'housekeeping',
      'maintenance',
      'spa_recreation',
    ]);
    expect(assignableRoles('property_admin')).toContain('manager');
    expect(assignableRoles('property_admin')).not.toContain('property_admin');
    expect(assignableRoles('platform_admin')).not.toContain('platform_admin');
    expect(assignableRoles('front_desk')).toEqual([]);
  });
});

describe('buildStaffUpdate', () => {
  it('returns null when nothing changed', () => {
    expect(buildStaffUpdate(original, draftFrom(original))).toBeNull();
  });

  it('sends only the name when only the name changed, trimmed', () => {
    const draft = { ...draftFrom(original), name: '  Asha R. Rao ' };
    expect(buildStaffUpdate(original, draft)).toEqual({ name: 'Asha R. Rao' });
  });

  it('does not send the name when only spaces were added around it', () => {
    const draft = { ...draftFrom(original), name: ' Asha Rao ' };
    expect(buildStaffUpdate(original, draft)).toBeNull();
  });

  it('sends only the role when only the role changed, leaving departments to the server', () => {
    const draft = { ...draftFrom(original), role: 'kitchen' as const };
    expect(buildStaffUpdate(original, draft)).toEqual({ role: 'kitchen' });
  });

  it('sends departments only when they were edited, in a stable order', () => {
    const draft = {
      ...draftFrom(original),
      departments: ['kitchen', 'front_desk'] as const,
      departmentsEdited: true,
    };
    expect(buildStaffUpdate(original, { ...draft, departments: [...draft.departments] })).toEqual({
      departments: ['front_desk', 'kitchen'],
    });
  });

  it('does not send departments that were edited back to the original', () => {
    const draft = { ...draftFrom(original), departmentsEdited: true };
    expect(buildStaffUpdate(original, draft)).toBeNull();
  });

  it('sends several changed fields together', () => {
    const draft = {
      ...draftFrom(original),
      name: 'Asha Nair',
      role: 'housekeeping' as const,
      departments: ['housekeeping' as const, 'kitchen' as const],
      departmentsEdited: true,
    };
    expect(buildStaffUpdate(original, draft)).toEqual({
      name: 'Asha Nair',
      role: 'housekeeping',
      departments: ['housekeeping', 'kitchen'],
    });
  });
});
