import { useEffect, useState } from 'react';
import { api } from '../api';
import { atLeast, useAuth } from '../auth';
import { TensionChart } from '../components/TensionChart';
import { heat, time } from '../labels';
import type { AreaRow } from './Map';

interface Hotspot { areaId: string; areaName: string; peak: number; peakAt: string; peakUpper: number; current: number | null; rising: boolean }

const SIGNAL_LABEL: Record<string, string> = {
  tension: 'مؤشر التوتر', z_cluster: 'حجم التجمّعات', z_motion: 'الحركة', z_runners: 'الركض', z_occupancy: 'الكثافة',
};

export default function ForecastPage() {
  const { user } = useAuth();
  const [hot, setHot] = useState<Hotspot[]>([]);
  const [areas, setAreas] = useState<AreaRow[]>([]);
  const [pre, setPre] = useState<any>(null);

  useEffect(() => {
    api<Hotspot[]>('/analytics/hotspots?threshold=50&hours=12').then(setHot).catch(() => undefined);
    api<AreaRow[]>('/analytics/areas').then(setAreas).catch(() => undefined);
    if (atLeast(user?.role, 'supervisor')) api('/analytics/precursors').then(setPre).catch(() => setPre(null));
  }, [user?.role]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>التنبؤ</h1>
          <p>المناطق المرشّحة للتوتر خلال الـ12 ساعة القادمة، لتوجيه الحراسة مبكراً. التوقع مبني على أنماط كل منطقة في نفس الساعة من الأسابيع السابقة وعلى وضعها الحالي.</p>
        </div>
      </div>
      <div className="stack">
        <div className="panel">
          <h2 style={{ marginBottom: 12 }}>المناطق الساخنة</h2>
          {!hot.length ? (
            <p className="muted" style={{ margin: 0 }}>لا يُتوقع أن تتجاوز أي منطقة 50 خلال الـ12 ساعة القادمة.</p>
          ) : (
            <table className="grid">
              <thead><tr><th>المنطقة</th><th>الذروة المتوقعة</th><th>الوقت</th><th>الآن</th><th>الاتجاه</th></tr></thead>
              <tbody>
                {hot.map((h) => (
                  <tr key={h.areaId}>
                    <td>{h.areaName}</td>
                    <td><span className="num" style={{ color: heat(h.peak), fontWeight: 700 }}>{Math.round(h.peak)}</span> <span className="faint num">(حتى {Math.round(h.peakUpper)})</span></td>
                    <td className="num">{time(h.peakAt)}</td>
                    <td className="num">{h.current === null ? '–' : Math.round(h.current)}</td>
                    <td>{h.rising ? 'في ارتفاع' : 'مستقر'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="two">
          {areas.map((a) => <AreaForecast key={a.id} area={a} />)}
        </div>

        {pre && (
          <div className="panel">
            <h2>ماذا يسبق الحوادث؟</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              مقارنة بين الساعتين اللتين سبقتا {pre.data.incidents} حادثة مؤكدة (عالية الخطورة أو حرجة) وبين بقية الأوقات.
              ارتفاع القيم قبل الحوادث يعني أن المؤشر يعطي إنذاراً مبكراً فعلياً.
            </p>
            {pre.data.signals ? (
              <table className="grid" style={{ marginTop: 10 }}>
                <thead><tr><th>الإشارة</th><th>قبل الحوادث</th><th>بقية الأوقات</th><th>الفرق</th></tr></thead>
                <tbody>
                  {Object.entries(pre.data.signals as Record<string, any>).map(([k, v]) => (
                    <tr key={k}>
                      <td>{SIGNAL_LABEL[k] ?? k}</td>
                      <td className="num">{v.before}</td>
                      <td className="num">{v.other}</td>
                      <td className="num">{k === 'tension' ? `× ${v.lift}` : v.lift > 0 ? `+${v.lift}` : v.lift}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted">لا توجد حوادث مؤكدة كافية للمقارنة بعد.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function AreaForecast({ area }: { area: AreaRow }) {
  const [history, setHistory] = useState<any[]>([]);
  const [forecast, setForecast] = useState<any[]>([]);
  useEffect(() => {
    api(`/analytics/areas/${area.id}/history?hours=12`).then(setHistory).catch(() => undefined);
    api(`/analytics/areas/${area.id}/forecast`).then(setForecast).catch(() => undefined);
  }, [area.id]);
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>{area.name}</h3>
        <span className="num" style={{ color: heat(area.tension), fontWeight: 700 }}>{area.tension === null ? '–' : Math.round(area.tension)}</span>
      </div>
      <TensionChart history={history} forecast={forecast} height={170} />
    </div>
  );
}
