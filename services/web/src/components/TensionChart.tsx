import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface Point { t: number; actual?: number; pred?: number; band?: [number, number] }

const hourFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });
const dayFmt = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });

/**
 * Past tension (solid) and the 24-hour forecast (dashed, with its likely range as a band).
 * Time runs left to right like every clock-based chart, with "now" marked.
 */
export function TensionChart({
  history, forecast, height = 220,
}: {
  history: { bucket: string; tension: number }[];
  forecast: { hour: string; pred: number; lower: number; upper: number }[];
  height?: number;
}) {
  const now = Date.now();
  const pts: Point[] = [
    ...history.map((h) => ({ t: new Date(h.bucket).getTime(), actual: Number(h.tension) })),
    ...forecast.map((f) => ({ t: new Date(f.hour).getTime(), pred: Number(f.pred), band: [Number(f.lower), Number(f.upper)] as [number, number] })),
  ].sort((a, b) => a.t - b.t);
  if (history.length && forecast.length) {
    // join the two lines at the last actual point
    const last = history[history.length - 1];
    pts.push({ t: new Date(last.bucket).getTime(), pred: Number(last.tension), band: [Number(last.tension), Number(last.tension)] });
    pts.sort((a, b) => a.t - b.t);
  }
  if (!pts.length) return <div className="empty" style={{ padding: 30 }}>لا توجد قراءات كافية بعد.</div>;
  return (
    <div dir="ltr" style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <ComposedChart data={pts} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="#2f4050" vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(v) => hourFmt.format(v)}
            stroke="#6b7f90" fontSize={12} tickLine={false} minTickGap={40} />
          <YAxis domain={[0, 100]} ticks={[0, 40, 70, 100]} stroke="#6b7f90" fontSize={12} tickLine={false} axisLine={false} />
          <ReferenceLine y={70} stroke="#e0614f" strokeOpacity={0.5} strokeDasharray="2 4" />
          <ReferenceLine x={now} stroke="#93a4b3" strokeDasharray="3 3" label={{ value: 'الآن', fill: '#93a4b3', fontSize: 12, position: 'insideTopRight' }} />
          <Area dataKey="band" stroke="none" fill="#7fc4c4" fillOpacity={0.12} isAnimationActive={false} connectNulls />
          <Line dataKey="actual" stroke="#e9a33f" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
          <Line dataKey="pred" stroke="#7fc4c4" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} connectNulls />
          <Tooltip
            contentStyle={{ background: '#1d2a36', border: '1px solid #3d5163', borderRadius: 6, direction: 'rtl' }}
            labelFormatter={(v) => dayFmt.format(Number(v))}
            formatter={(value: any, name: string) => {
              if (name === 'band') return [`${value[0]}–${value[1]}`, 'النطاق المتوقع'];
              return [Math.round(Number(value)), name === 'actual' ? 'المؤشر' : 'المتوقع'];
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export const COMPONENT_LABEL: Record<string, string> = {
  incidents: 'حوادث حديثة',
  cluster: 'تجمّعات أكبر من المعتاد',
  motion: 'حركة أعلى من المعتاد',
  runners: 'ركض',
  occupancy: 'كثافة أعلى من المعتاد',
  anomaly: 'نمط غير معتاد في هذا الوقت',
};

/** What is driving an area's tension right now, largest share first. */
export function Drivers({ shares }: { shares?: Record<string, number> }) {
  const list = Object.entries(shares ?? {}).filter(([, v]) => v >= 0.05).sort((a, b) => b[1] - a[1]);
  if (!list.length) return <p className="muted" style={{ margin: 0 }}>لا يوجد ما يرفع المؤشر الآن.</p>;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {list.map(([k, v]) => (
        <div key={k}>
          <div className="row" style={{ justifyContent: 'space-between', fontSize: 14 }}>
            <span>{COMPONENT_LABEL[k] ?? k}</span><span className="num muted">{Math.round(v * 100)}%</span>
          </div>
          <div style={{ height: 4, background: 'var(--line)', borderRadius: 2 }}>
            <div style={{ height: 4, width: `${v * 100}%`, background: 'var(--high)', borderRadius: 2 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
