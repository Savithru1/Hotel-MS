import type { GstRuleSet, PropertyDto } from '@hospitality/shared-types';
import { gstinSchema, timeOfDaySchema } from '@hospitality/validation';
import { useState, type FormEvent } from 'react';
import { useStaff } from '../../auth/AuthContext';
import { isPropertyAdmin } from '../../auth/permissions';
import {
  Async,
  Button,
  Card,
  ErrorNotice,
  PageHeader,
  TextField,
  money,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useGet, useSend } from '../../hooks/queries';

function SettingsForm({ property, editable }: { property: PropertyDto; editable: boolean }) {
  const toast = useToast();
  const [legalName, setLegalName] = useState(property.legalName);
  const [line1, setLine1] = useState(property.address.line1);
  const [line2, setLine2] = useState(property.address.line2);
  const [city, setCity] = useState(property.address.city);
  const [state, setState] = useState(property.address.state);
  const [pincode, setPincode] = useState(property.address.pincode);
  const [stateName, setStateName] = useState(property.stateName);
  const [gstin, setGstin] = useState(property.gstin ?? '');
  const [timezone, setTimezone] = useState(property.timezone);
  const [checkIn, setCheckIn] = useState(property.checkInTime);
  const [checkOut, setCheckOut] = useState(property.checkOutTime);
  const save = useSend<PropertyDto, object>('patch', '/properties/current', ['/properties']);

  const gstinProblem =
    gstin && !gstinSchema.safeParse(gstin).success ? 'Not a valid 15-character GSTIN' : undefined;
  const timesOk =
    timeOfDaySchema.safeParse(checkIn).success && timeOfDaySchema.safeParse(checkOut).success;

  function submit(event: FormEvent): void {
    event.preventDefault();
    save.mutate(
      {
        legalName,
        address: { line1, line2, city, state, pincode },
        stateName,
        gstin: gstin || null,
        timezone,
        checkInTime: checkIn,
        checkOutTime: checkOut,
      },
      { onSuccess: () => toast.success('Property settings saved') },
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={!editable} className="space-y-4">
        <TextField
          label="Legal name"
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          hint="As it must appear on invoices"
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Address line 1"
            value={line1}
            onChange={(e) => setLine1(e.target.value)}
          />
          <TextField
            label="Address line 2"
            value={line2}
            onChange={(e) => setLine2(e.target.value)}
          />
          <TextField label="City" value={city} onChange={(e) => setCity(e.target.value)} />
          <TextField
            label="State (address)"
            value={state}
            onChange={(e) => setState(e.target.value)}
          />
          <TextField
            label="Pincode"
            value={pincode}
            onChange={(e) => setPincode(e.target.value)}
            maxLength={6}
          />
          <TextField
            label="State for GST"
            value={stateName}
            onChange={(e) => setStateName(e.target.value)}
            hint="Decides CGST + SGST or IGST"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="GSTIN"
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
            maxLength={15}
            error={gstinProblem}
          />
          <TextField
            label="Timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            hint="For example Asia/Kolkata"
          />
          <TextField
            label="Check-in time"
            value={checkIn}
            onChange={(e) => setCheckIn(e.target.value)}
            placeholder="14:00"
          />
          <TextField
            label="Check-out time"
            value={checkOut}
            onChange={(e) => setCheckOut(e.target.value)}
            placeholder="11:00"
          />
        </div>
      </fieldset>
      {save.isError && <ErrorNotice error={save.error} />}
      {editable ? (
        <Button type="submit" disabled={save.isPending || Boolean(gstinProblem) || !timesOk}>
          Save settings
        </Button>
      ) : (
        <p className="text-sm text-slate-500">Only the property admin can change these settings.</p>
      )}
    </form>
  );
}

function GstRules({ rules, editable }: { rules: GstRuleSet[]; editable: boolean }) {
  const toast = useToast();
  const latest = [...rules].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1);
  const [from, setFrom] = useState('');
  const [spa, setSpa] = useState(String(latest?.spaRecreation.ratePercent ?? 18));
  const [other, setOther] = useState(String(latest?.other.ratePercent ?? 18));
  const [food, setFood] = useState(String(latest?.food.ratePercent ?? 5));
  const add = useSend<PropertyDto, GstRuleSet>('post', '/properties/current/gst-rules', [
    '/properties',
  ]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!latest) return;
    add.mutate(
      {
        ...latest,
        effectiveFrom: from,
        food: { ...latest.food, ratePercent: Number(food) },
        spaRecreation: { ratePercent: Number(spa) },
        other: { ratePercent: Number(other) },
      },
      {
        onSuccess: () => {
          toast.success('New tax rules added');
          setFrom('');
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-amber-900">
        These are starting values. Have your accountant confirm them before issuing real invoices.
        Earlier rules are never edited, so invoices already issued keep their rates.
      </p>
      <ul className="space-y-3">
        {[...rules]
          .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
          .map((set) => (
            <li
              key={set.effectiveFrom}
              className="rounded-lg bg-stone-50 p-3 text-sm ring-1 ring-stone-200"
            >
              <p className="font-medium">From {set.effectiveFrom}</p>
              <ul className="mt-1 list-inside list-disc text-slate-700">
                {set.room.slabs.map((slab, index) => (
                  <li key={index}>
                    Room {index === 0 ? 'up to' : 'up to'}{' '}
                    {slab.upToPaise === null
                      ? 'any tariff above the last limit'
                      : money(slab.upToPaise)}{' '}
                    a night: {slab.ratePercent}%
                  </li>
                ))}
                <li>
                  Food: {set.food.ratePercent}% ({set.food.highTariffRatePercent}% when the room
                  tariff is above {money(set.food.highTariffThresholdPaise)})
                </li>
                <li>Spa, gym and recreation: {set.spaRecreation.ratePercent}%</li>
                <li>Other services: {set.other.ratePercent}%</li>
              </ul>
            </li>
          ))}
      </ul>
      {editable && latest && (
        <form onSubmit={submit} className="space-y-3 border-t border-stone-200 pt-4">
          <h3 className="text-sm font-semibold text-slate-700">
            Add new rules (room slabs are copied from the latest set)
          </h3>
          <div className="grid gap-3 sm:grid-cols-4">
            <TextField
              label="Effective from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              required
            />
            <TextField
              label="Food %"
              type="number"
              min={0}
              max={100}
              step="0.5"
              value={food}
              onChange={(e) => setFood(e.target.value)}
            />
            <TextField
              label="Spa / recreation %"
              type="number"
              min={0}
              max={100}
              step="0.5"
              value={spa}
              onChange={(e) => setSpa(e.target.value)}
            />
            <TextField
              label="Other %"
              type="number"
              min={0}
              max={100}
              step="0.5"
              value={other}
              onChange={(e) => setOther(e.target.value)}
            />
          </div>
          {add.isError && <ErrorNotice error={add.error} />}
          <Button type="submit" disabled={add.isPending || !from}>
            Add rules
          </Button>
        </form>
      )}
    </div>
  );
}

export function PropertyPage() {
  const { staff } = useStaff();
  const property = useGet<PropertyDto>('/properties/current');
  const editable = isPropertyAdmin(staff.role);
  const data = property.data?.data;

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Property"
        subtitle={data ? `${data.name} · link name ${data.slug}` : undefined}
      />
      <Async query={property}>
        {data && (
          <div className="space-y-6">
            <Card title="Details">
              <SettingsForm key={JSON.stringify(data)} property={data} editable={editable} />
            </Card>
            <Card title="GST rules">
              <GstRules rules={data.gstRules} editable={editable} />
            </Card>
          </div>
        )}
      </Async>
    </div>
  );
}
