import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api';
import { REASON_LABEL, SEVERITY_LABEL, TYPE_LABEL } from '../labels';

const KPI_LABEL: Record<string, string> = {
  fightRecall: 'دقة كشف العراك (Recall)',
  fallRecall: 'دقة كشف السقوط (Recall)',
  falseAlertsPerCameraDay: 'التنبيهات الخاطئة لكل كاميرا يومياً',
  alertLatencySecondsP50: 'زمن التنبيه من بداية الحدث (الوسيط)',
  processingFps: 'سرعة المعالجة (أبطأ كاميرا)',
  uptime: 'استمرار التشغيل (أضعف كاميرا)',
  headcountAccuracy: 'دقة العدّ الآلي',
};

function fmt(key: string, v: number | null): string {
  if (v === null) return '–';
  if (['fightRecall', 'fallRecall', 'uptime', 'headcountAccuracy'].includes(key)) return `${(v * 100).toFixed(1)}%`;
  if (key === 'alertLatencySecondsP50') return `${v.toFixed(1)} ث`;
  if (key === 'processingFps') return `${v.toFixed(1)}`;
  return v.toFixed(2);
}
function fmtTarget(key: string, op: string, t: number): string {
  const word = op === '>=' ? 'الهدف: لا يقل عن' : 'الهدف: أقل من';
  return `${word} ${fmt(key, t)}`;
}

export default function ReportsPage() {
  const [days, setDays] = useState(14);
  const [k, setK] = useState<any>(null);
  const [daily, setDaily] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/reports/kpis?days=${days}`).then(setK).catch((e) => setError(e.message));
  }, [days]);
  useEffect(() => { api('/reports/daily').then(setDaily).catch(() => undefined); }, []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>التقارير ومؤشرات النجاح</h1>
          <p>مؤشرات المشروع التجريبي مقاسة من بيانات التشغيل الفعلية، مقابل الأهداف المعتمدة في الخطة.</p>
        </div>
        <div className="seg">
          {[7, 14, 30].map((d) => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>آخر {d} يوماً</button>)}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {k && (
        <div className="stack">
          <div className="kpis">
            {k.indicators.map((i: any) => (
              <div key={i.key} className={`kpi ${i.status}`}>
                <span className="muted">{KPI_LABEL[i.key] ?? i.label}</span>
                <span className="value num">{fmt(i.key, i.value)}</span>
                <span className="target">{fmtTarget(i.key, i.op, i.target)}</span>
                <span className="faint" style={{ fontSize: 12 }}>
                  {i.status === 'met' ? 'محقَّق' : i.status === 'not_met' ? 'غير محقَّق' : i.key.endsWith('Recall') ? 'يُقاس من تقرير تقييم النموذج' : 'لا توجد بيانات كافية'}
                </span>
              </div>
            ))}
          </div>

          <div className="two">
            <div className="panel">
              <h2>المراجعات</h2>
              <dl className="facts" style={{ marginTop: 12 }}>
                <div><dt>مؤكَّدة</dt><dd className="num">{k.reviews.confirmed}</dd></div>
                <div><dt>مرفوضة</dt><dd className="num">{k.reviews.dismissed}</dd></div>
                <div><dt>بانتظار المراجعة</dt><dd className="num">{k.reviews.pending}</dd></div>
                <div><dt>نسبة التنبيهات الصحيحة</dt><dd className="num">{k.reviews.precision === null ? '–' : `${Math.round(k.reviews.precision * 100)}%`}</dd></div>
                <div><dt>وسيط زمن المراجعة</dt><dd>{k.reviewTimeSecondsP50 === null ? '–' : <><span className="num">{Math.round(k.reviewTimeSecondsP50)}</span> ثانية</>}</dd></div>
                <div><dt>زمن التنبيه (95% من الحالات)</dt><dd>{k.latency.p95 === null ? '–' : <><span className="num">{Number(k.latency.p95).toFixed(1)}</span> ثانية</>}</dd></div>
              </dl>
            </div>
            <div className="panel">
              <h2>أسباب رفض التنبيهات</h2>
              <p className="muted" style={{ fontSize: 14 }}>هذه القائمة توجّه ضبط القواعد وإعادة التدريب.</p>
              <table className="grid">
                <tbody>
                  {k.dismissReasons.map((r: any) => <tr key={r.reason}><td>{REASON_LABEL[r.reason] ?? r.reason}</td><td className="num">{r.n}</td></tr>)}
                </tbody>
              </table>
              {!k.dismissReasons.length && <p className="muted">لا توجد تنبيهات مرفوضة في الفترة.</p>}
            </div>
          </div>

          <div className="panel" style={{ padding: 0 }}>
            <table className="grid">
              <thead><tr><th>الكاميرا</th><th>متوسط إطار/ثانية</th><th>استمرار التشغيل</th><th>تنبيهات مرفوضة</th></tr></thead>
              <tbody>
                {k.cameras.map((c: any) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="num">{c.fps === null ? '–' : Number(c.fps).toFixed(1)}</td>
                    <td className="num">{c.uptime === null || c.fps === null ? '–' : `${Math.min(100, Number(c.uptime) * 100).toFixed(1)}%`}</td>
                    <td className="num">{c.dismissed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {daily && (
        <div className="two" style={{ marginTop: 20 }}>
          <div className="panel">
            <h2>تنبيهات اليوم حسب الساعة</h2>
            <div dir="ltr" style={{ height: 220, marginTop: 10 }}>
              <ResponsiveContainer>
                <BarChart data={Array.from({ length: 24 }, (_, h) => ({ h, n: daily.byHour.find((x: any) => x.hour === h)?.n ?? 0 }))} margin={{ left: -24, right: 8 }}>
                  <CartesianGrid stroke="#2f4050" vertical={false} />
                  <XAxis dataKey="h" stroke="#6b7f90" fontSize={12} tickLine={false} />
                  <YAxis allowDecimals={false} stroke="#6b7f90" fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ background: '#1d2a36', border: '1px solid #3d5163' }} formatter={(v: any) => [v, 'تنبيهات']} labelFormatter={(h) => `الساعة ${h} (UTC)`} />
                  <Bar dataKey="n" fill="#e9a33f" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="panel">
            <h2>تنبيهات اليوم حسب النوع</h2>
            <table className="grid" style={{ marginTop: 10 }}>
              <thead><tr><th>النوع</th><th>الخطورة</th><th>العدد</th><th>مؤكَّد</th><th>مرفوض</th></tr></thead>
              <tbody>
                {daily.byType.map((r: any) => (
                  <tr key={r.type + r.severity}><td>{TYPE_LABEL[r.type] ?? r.type}</td><td><span className={`sev ${r.severity}`}>{SEVERITY_LABEL[r.severity]}</span></td><td className="num">{r.n}</td><td className="num">{r.confirmed}</td><td className="num">{r.dismissed}</td></tr>
                ))}
              </tbody>
            </table>
            {!daily.byType.length && <p className="muted">لا تنبيهات اليوم.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
