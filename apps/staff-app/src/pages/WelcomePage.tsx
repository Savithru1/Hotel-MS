import { useStaff } from '../auth/AuthContext';
import { Card, PageHeader, words } from '../components/ui';

/** For roles whose dashboards are built in a later sub-phase. It says so, rather than faking one. */
export function WelcomePage() {
  const { staff, property } = useStaff();
  return (
    <div className="max-w-xl">
      <PageHeader title={`Welcome, ${staff.name}`} subtitle={property.name} />
      <Card>
        <p className="text-sm text-slate-700">
          You are signed in as <strong className="capitalize">{words(staff.role)}</strong>. Your
          department&rsquo;s screen has not been built yet, so there is nothing to work from here
          for now.
        </p>
      </Card>
    </div>
  );
}
