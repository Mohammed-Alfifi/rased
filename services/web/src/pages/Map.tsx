import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Drivers, TensionChart } from '../components/TensionChart';
import { heat, tensionWord, time } from '../labels';
import { useLive } from '../live';

export interface AreaRow {
  id: string; name: string; mapPolygon: [number, number][]; expectedCount: number | null;
  tension: number | null; anomaly: number | null; components: { shares?: Record<string, number> } | null;
  change1h: number | null; peak12h: number | null; peakAt: string | null;
  openAlerts: number; camerasOnline: number; camerasTotal: number;
}
interface Cam { id: string; name: string; mapX: number | null; mapY: number | null; isOnline: boolean; areaId: string | null }

const W = 1000;
const H = 600;

export default function MapPage() {
  const live = useLive();
  const [areas, setAreas] = useState<AreaRow[]>([]);
  const [cams, setCams] = useState<Cam[]>([]);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      api<AreaRow[]>('/analytics/areas').then((a) => { setAreas(a); setSel((s) => s ?? a[0]?.id ?? null); }).catch(() => undefined);
      api<Cam[]>('/cameras').then(setCams).catch(() => undefined);
    };
    load();
    const t = window.setInterval(load, 60_000);
    const off = live.subscribe((k) => { if (k === 'event.created' || k === 'event.reviewed') load(); });
    return () => { window.clearInterval(t); off(); };
  }, [live]);

  const area = areas.find((a) => a.id === sel);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>خريطة المنشأة</h1>
          <p>لون كل منطقة يمثل مؤشر التوتر الحالي من 0 إلى 100، محسوباً من الحوادث والتجمعات والحركة مقارنةً بالمعتاد لهذا الوقت. المؤشر يقيس الأماكن، ولا يقيّم أي شخص.</p>
        </div>
      </div>
      <div className="map-layout">
        <div className="map-wrap">
          <div className="map">
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="خريطة مناطق المنشأة ومؤشر التوتر">
              <rect x="0" y="0" width={W} height={H} fill="#121b23" rx="8" />
              {areas.map((a) => {
                if (!a.mapPolygon?.length) return null;
                const pts = a.mapPolygon.map(([x, y]) => `${x * W},${y * H}`).join(' ');
                // label in the top corner of the area (reading start), clear of camera markers in the middle
                const xs = a.mapPolygon.map((p) => p[0] * W);
                const ys = a.mapPolygon.map((p) => p[1] * H);
                const right = Math.max(...xs) - 18;
                const top = Math.min(...ys) + 34;
                return (
                  <g key={a.id} onClick={() => setSel(a.id)} style={{ cursor: 'pointer' }}>
                    <polygon points={pts} fill={heat(a.tension)} fillOpacity={0.88} stroke={a.id === sel ? '#e7edf2' : '#3d5163'} strokeWidth={a.id === sel ? 3 : 1.5} />
                    <text className="map-label" x={right} y={top} textAnchor="start" direction="rtl" fill="#0f1a22" fontSize="22" fontWeight="700">{a.name}</text>
                    <text className="map-label" x={right} y={top + 42} textAnchor="start" direction="rtl" fill="#0f1a22" fontSize="36" fontWeight="700">
                      {a.tension === null ? '–' : Math.round(a.tension)}
                    </text>
                    {a.openAlerts > 0 && (
                      <g>
                        <title>{a.openAlerts} تنبيه مفتوح</title>
                        <circle cx={Math.min(...xs) + 26} cy={Math.min(...ys) + 26} r="16" fill="var(--crit)" stroke="#121b23" strokeWidth="3" />
                        <text className="map-label" x={Math.min(...xs) + 26} y={Math.min(...ys) + 32} textAnchor="middle" fill="#2a0d09" fontSize="16" fontWeight="700">{a.openAlerts}</text>
                      </g>
                    )}
                  </g>
                );
              })}
              {cams.filter((c) => c.mapX !== null && c.mapY !== null).map((c) => (
                <g key={c.id}>
                  <title>{c.name}{c.isOnline ? '' : ' (غير متصلة)'}</title>
                  <circle cx={c.mapX! * W} cy={c.mapY! * H} r="7" fill={c.isOnline ? '#e7edf2' : 'var(--crit)'} stroke="#121b23" strokeWidth="3" />
                </g>
              ))}
            </svg>
          </div>
          <div className="legend">
            <span>هادئ</span><span className="heat-bar" /><span>مرتفع</span>
            <span style={{ marginInlineStart: 18 }}><span className="status-dot" style={{ background: '#e7edf2' }} />كاميرا متصلة</span>
            <span><span className="status-dot" style={{ background: 'var(--crit)' }} />غير متصلة</span>
          </div>
        </div>
        {area ? <AreaPanel area={area} /> : <div className="panel muted">لم تُعرَّف مناطق بعد. أضفها من صفحة الإعدادات.</div>}
      </div>
    </div>
  );
}

function AreaPanel({ area }: { area: AreaRow }) {
  const [history, setHistory] = useState<any[]>([]);
  const [forecast, setForecast] = useState<any[]>([]);
  useEffect(() => {
    api(`/analytics/areas/${area.id}/history?hours=36`).then(setHistory).catch(() => setHistory([]));
    api(`/analytics/areas/${area.id}/forecast`).then(setForecast).catch(() => setForecast([]));
  }, [area.id, area.tension]);

  const change = area.change1h;
  return (
    <aside className="side">
      <div className="panel">
        <h2>{area.name}</h2>
        <div className="row" style={{ alignItems: 'baseline', marginTop: 10 }}>
          <span className="big-num num" style={{ color: heat(area.tension) }}>{area.tension === null ? '–' : Math.round(area.tension)}</span>
          <span className="muted">{tensionWord(area.tension)}</span>
        </div>
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 14 }}>
          {change === null ? 'لا توجد قراءة قبل ساعة للمقارنة.' : change > 5 ? `ارتفع ${Math.round(change)} نقطة خلال الساعة الماضية.` : change < -5 ? `انخفض ${Math.round(-change)} نقطة خلال الساعة الماضية.` : 'مستقر خلال الساعة الماضية.'}
          {area.peak12h !== null && area.peakAt && ` المتوقع أن يبلغ ${Math.round(area.peak12h)} قرابة الساعة ${time(area.peakAt)}.`}
        </p>
        <div className="row" style={{ marginTop: 12, fontSize: 14 }}>
          <Link to="/alerts">{area.openAlerts ? `${area.openAlerts} تنبيه مفتوح` : 'لا تنبيهات مفتوحة'}</Link>
          <span className="muted">الكاميرات <span className="num">{area.camerasOnline}/{area.camerasTotal}</span></span>
        </div>
      </div>
      <div className="panel">
        <h3 style={{ marginBottom: 10 }}>آخر 36 ساعة والـ24 القادمة</h3>
        <TensionChart history={history} forecast={forecast} />
        <p className="faint" style={{ fontSize: 13, margin: '6px 0 0' }}>الخط المتصل: المؤشر الفعلي. المتقطع: التوقع، والظل حوله النطاق المرجّح.</p>
      </div>
      <div className="panel">
        <h3 style={{ marginBottom: 10 }}>ما الذي يرفع المؤشر الآن</h3>
        <Drivers shares={area.components?.shares} />
      </div>
    </aside>
  );
}
