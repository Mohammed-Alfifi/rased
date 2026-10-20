import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import { dateTime } from '../labels';

interface Area { id: string; name: string; expectedCount: number | null }
interface Count { id: string; areaName: string; expected: number; counted: number; manual: number | null; matched: boolean; at: string; by: string | null }

export default function HeadcountPage() {
  const [areas, setAreas] = useState<Area[]>([]);
  const [rows, setRows] = useState<Count[]>([]);
  const [areaId, setAreaId] = useState('');
  const [expected, setExpected] = useState('');
  const [manual, setManual] = useState('');
  const [result, setResult] = useState<Count | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api<Count[]>('/headcounts').then(setRows).catch(() => undefined);
  useEffect(() => {
    api<Area[]>('/areas').then((a) => { setAreas(a); if (a[0]) setAreaId(a[0].id); }).catch(() => undefined);
    load();
  }, []);
  const area = areas.find((a) => a.id === areaId);

  async function run(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setResult(null);
    try {
      const r = await api<Count>('/headcounts', {
        method: 'POST',
        body: { areaId, expected: expected ? Number(expected) : undefined, manual: manual ? Number(manual) : undefined },
      });
      setResult(r);
      load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>العدّ</h1>
          <p>عدّ آلي في أوقات العدّ الرسمية من مناطق العدّ في كاميرات المنطقة. أي فرق عن العدد المتوقع يُنشئ تنبيهاً. أدخل عدّكم اليدوي لقياس دقة العدّ الآلي.</p>
        </div>
      </div>
      <div className="two">
        <form className="panel stack" style={{ gap: 14 }} onSubmit={run}>
          <div className="field">
            <label>المنطقة</label>
            <select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>العدد المتوقع {area?.expectedCount != null && <span className="faint">(المسجّل للمنطقة: {area.expectedCount})</span>}</label>
            <input type="number" min="0" value={expected} onChange={(e) => setExpected(e.target.value)} placeholder={area?.expectedCount?.toString() ?? ''} />
          </div>
          <div className="field">
            <label>العدّ اليدوي (اختياري)</label>
            <input type="number" min="0" value={manual} onChange={(e) => setManual(e.target.value)} />
          </div>
          {error && <div className="error">{error}</div>}
          <button className="btn primary" disabled={busy || !areaId}>{busy ? 'جارٍ العدّ…' : 'ابدأ العدّ'}</button>
        </form>
        <div className="panel">
          {result ? (
            <div>
              <div className="muted">{result.areaName ?? area?.name}</div>
              <div className="row" style={{ alignItems: 'baseline', marginTop: 8 }}>
                <span className="big-num num" style={{ color: result.matched ? 'var(--ok)' : 'var(--crit)' }}>{result.counted}</span>
                <span className="muted">من <span className="num">{result.expected}</span> متوقع</span>
              </div>
              <p style={{ marginBottom: 0 }}>{result.matched ? 'العدد مطابق.' : `يوجد فرق ${Math.abs(result.expected - result.counted)}. أُنشئ تنبيه "فرق في العدّ" للمتابعة.`}</p>
            </div>
          ) : <p className="muted" style={{ margin: 0 }}>النتيجة تظهر هنا بعد العدّ.</p>}
        </div>
      </div>
      <div className="panel" style={{ marginTop: 20, padding: 0 }}>
        <table className="grid">
          <thead><tr><th>الوقت</th><th>المنطقة</th><th>المتوقع</th><th>الآلي</th><th>اليدوي</th><th>النتيجة</th><th>بواسطة</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="num">{dateTime(r.at)}</td><td>{r.areaName}</td><td className="num">{r.expected}</td><td className="num">{r.counted}</td>
                <td className="num">{r.manual ?? '–'}</td>
                <td style={{ color: r.matched ? 'var(--ok)' : 'var(--crit)' }}>{r.matched ? 'مطابق' : 'فرق'}</td><td>{r.by ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="empty">لم يُجرَ أي عدّ بعد.</div>}
      </div>
    </div>
  );
}
