'use client';

import Link from 'next/link';
import { rpc, type Row } from '@/lib/data/office-db';
import { useLoad } from '../hooks';
import { E, fEur, fNum, fPct, T } from '../i18n';
import { Card, Empty, Loading, Notice, Stat } from '../ui';

const BANDS = ['green', 'amber', 'red', 'blocked'];
const AGES = ['0-7', '8-14', '15-30', '30+'];

function pctTone(v: unknown, good: number, ok: number): 'ok' | 'warn' | 'bad' | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return n >= good ? 'ok' : n >= ok ? 'warn' : 'bad';
}

/** Owner dashboard (spec 12.6): four panels, every number opens the list behind it. */
export function DashboardScreen() {
  const dash = useLoad(() => rpc<Row>('rpc_dashboard'), []);
  if (dash.error) return <Notice>{dash.error}</Notice>;
  if (!dash.data) return <Loading />;
  const h: Row = dash.data.stock_health ?? {};
  const s: Row = dash.data.service ?? {};
  const r: Row = dash.data.stock_risk ?? {};
  const c: Row = dash.data.campaigns_plan ?? {};
  const live: Row[] = c.live ?? [];
  const families: Row[] = c.forecast_by_family ?? [];
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2" data-testid="dashboard">
      <Card title={T('dash.health')}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label={T('dash.ira7')} value={fPct(h.ira_7d)} hint={`${T('dash.yesterday')}: ${fPct(h.ira_yesterday)}`} tone={pctTone(h.ira_7d, 99, 97)} href="/stock?tab=ira" />
          <Stat label={T('dash.scan7')} value={fPct(h.scan_compliance_7d)} tone={pctTone(h.scan_compliance_7d, 98, 95)} href="/stock?tab=ira" />
          <Stat label={T('dash.openCounts')} value={fNum(h.open_counts, 0)} href="/stock?tab=counts" />
          <Stat label={T('dash.reconOpen')} value={fNum(h.recon_open, 0)} href="/reconciliation?tab=diffs" />
          <Stat label={T('dash.recon48')} value={fNum(h.recon_unexplained_48h, 0)} tone={Number(h.recon_unexplained_48h) > 0 ? 'bad' : 'ok'} hint={T('dash.recon48Hint')} href="/reconciliation?tab=diffs&old=1" />
        </div>
      </Card>

      <Card title={T('dash.service')}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label={T('dash.fillDomestic')} value={fPct(s.fill_rate_domestic)} tone={pctTone(s.fill_rate_domestic, 97, 93)} hint={T('dash.otif')} href="/orders?tab=list" />
          <Stat label={T('dash.fillExport')} value={fPct(s.fill_rate_export)} tone={pctTone(s.fill_rate_export, 97, 93)} hint={T('dash.otif')} href="/orders?tab=list" />
          <Stat label={T('dash.truckWindow')} value={fPct(s.truck_window_first_time_pct)} hint={T('dash.truckWindowHint')} href="/shipping?tab=shipments" />
          <Stat label={T('dash.backorders')} value={fNum(s.backorders, 0)} tone={Number(s.backorders) > 0 ? 'warn' : 'ok'} href="/orders?tab=backorders" />
          {AGES.map((a) => (
            <Stat key={a} label={T('dash.backorderAge', { a })} value={fNum(s.backorders_by_age?.[a] ?? 0, 0)} href={`/orders?tab=backorders&age=${encodeURIComponent(a)}`} />
          ))}
        </div>
      </Card>

      <Card title={T('dash.risk')}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={T('dash.belowSafety')} value={fNum(r.below_safety_4w, 0)} tone={Number(r.below_safety_4w) > 0 ? 'bad' : 'ok'} hint={T('dash.belowSafetyHint')} href="/planning?tab=projection" />
          <Stat label={T('dash.slowItems')} value={fNum(r.slow_items, 0)} hint={fEur(r.slow_value_eur)} href="/planning?tab=slow" />
          {BANDS.map((b) => (
            <Stat key={b} label={`${T('dash.band')}: ${E(b)}`} value={fEur(r.ageing?.[b]?.value_eur ?? 0)} hint={T('dash.lots', { n: r.ageing?.[b]?.lots ?? 0 })} tone={b === 'green' ? 'ok' : b === 'amber' ? 'warn' : 'bad'} href={`/stock?tab=lots&band=${b}`} />
          ))}
        </div>
      </Card>

      <Card title={T('dash.plan')}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label={T('dash.pendingApprovals')} value={fNum(c.pending_approvals, 0)} tone={Number(c.pending_approvals) > 0 ? 'warn' : 'ok'} href="/approvals" />
          <Stat label={T('dash.openSuggestions')} value={fNum(c.open_suggestions, 0)} href="/planning?tab=suggestions" />
          <Stat label={T('dash.liveCampaigns')} value={fNum(live.length, 0)} href="/campaigns?tab=list&state=live" />
        </div>
        <h4 className="mb-2 mt-4 text-xs font-bold uppercase text-muted">{T('dash.liveVsForecast')}</h4>
        {live.length === 0 ? <Empty>{T('dash.noLive')}</Empty> : (
          <ul className="divide-y divide-line rounded-md border border-line text-sm">
            {live.map((x) => {
              const dev = Number(x.forecast_qty) > 0 ? ((Number(x.actual_qty) - Number(x.forecast_qty)) / Number(x.forecast_qty)) * 100 : null;
              return (
                <li key={x.id}>
                  <Link href={`/campaigns?tab=list&id=${x.id}`} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-surface">
                    <span className="font-medium">{x.code} · {x.name}</span>
                    <span className="tabular-nums text-muted">
                      {fNum(x.actual_qty, 0)} / {fNum(x.forecast_qty, 0)}{' '}
                      <strong className={dev !== null && Math.abs(dev) > 30 ? 'text-brand' : 'text-ink'}>{dev === null ? '' : `(${dev > 0 ? '+' : ''}${fNum(dev, 0)}%)`}</strong>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <h4 className="mb-2 mt-4 text-xs font-bold uppercase text-muted">{T('dash.forecastByFamily')}</h4>
        {families.length === 0 ? <Empty>{T('dash.noAccuracy')}</Empty> : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {families.map((f) => (
              <Stat key={f.family} label={String(f.family)} value={`WAPE ${fNum(Number(f.wape) * 100, 0)}%`} hint={`${T('dash.bias')}: ${fNum(Number(f.bias) * 100, 0)}%`} href="/planning?tab=accuracy" />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
