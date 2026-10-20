import { FormEvent, MouseEvent, useEffect, useState } from 'react';
import { api } from '../api';
import { atLeast, useAuth } from '../auth';
import { ago, ZONE_KIND_LABEL } from '../labels';
import { useLive } from '../live';

interface Cam {
  id: string; name: string; url: string; areaId: string | null; areaName: string | null; enabled: boolean;
  params: Record<string, unknown>; status: string | null; fps: number | null; latencyMs: number | null;
  tracks: number | null; fightMode: string | null; lastSeenAt: string | null; isOnline: boolean; mapX: number | null; mapY: number | null;
}
interface Zone { id: string; cameraId: string; name: string; kind: string; polygon: [number, number][]; restrictedHours: number[]; params: Record<string, unknown> }
interface Area { id: string; name: string }

export default function CamerasPage() {
  const { user } = useAuth();
  const live = useLive();
  const admin = atLeast(user?.role, 'admin');
  const [cams, setCams] = useState<Cam[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [editing, setEditing] = useState<Cam | 'new' | null>(null);
  const [zonesFor, setZonesFor] = useState<Cam | null>(null);

  const load = () => {
    api<Cam[]>('/cameras').then(setCams).catch(() => undefined);
    api<Area[]>('/areas').then(setAreas).catch(() => undefined);
  };
  useEffect(() => {
    load();
    const t = window.setInterval(load, 15_000);
    const off = live.subscribe((k) => { if (k === 'camera.status') load(); });
    return () => { window.clearInterval(t); off(); };
  }, [live]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>الكاميرات</h1>
          <p>حالة كل كاميرا وسرعة معالجتها. الكاميرا تُعد غير متصلة إذا لم يصل منها نبض خلال 30 ثانية.</p>
        </div>
        {admin && <button className="btn primary" onClick={() => setEditing('new')}>إضافة كاميرا</button>}
      </div>

      <div className="panel" style={{ padding: 0, overflow: 'auto' }}>
        <table className="grid">
          <thead>
            <tr><th>الكاميرا</th><th>المنطقة</th><th>الحالة</th><th>إطار/ثانية</th><th>زمن المعالجة</th><th>أشخاص الآن</th><th>كشف العراك</th>{admin && <th />}</tr>
          </thead>
          <tbody>
            {cams.map((c) => (
              <tr key={c.id}>
                <td><div>{c.name}</div><div className="faint num" style={{ fontSize: 12 }}>{c.id}</div></td>
                <td>{c.areaName ?? <span className="faint">بدون منطقة</span>}</td>
                <td>
                  <span className="status-dot" style={{ background: !c.enabled ? 'var(--faint)' : c.isOnline ? 'var(--ok)' : 'var(--crit)' }} />
                  {!c.enabled ? 'موقوفة' : c.isOnline ? 'متصلة' : 'غير متصلة'}
                  {c.lastSeenAt && !c.isOnline && <div className="faint" style={{ fontSize: 12 }}>آخر نبض {ago(c.lastSeenAt)}</div>}
                </td>
                <td className="num" style={{ color: c.fps !== null && c.fps < 15 ? 'var(--high)' : undefined }}>{c.fps?.toFixed(1) ?? '–'}</td>
                <td className="num">{c.latencyMs != null ? `${c.latencyMs} ms` : '–'}</td>
                <td className="num">{c.tracks ?? '–'}</td>
                <td>{c.fightMode === 'classifier' ? 'نموذج مدرّب' : c.fightMode === 'rules' ? 'قواعد' : '–'}</td>
                {admin && (
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn ghost" onClick={() => setZonesFor(c)}>المناطق</button>{' '}
                    <button className="btn ghost" onClick={() => setEditing(c)}>تعديل</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!cams.length && <div className="empty">لا توجد كاميرات بعد.{admin ? ' أضف أول كاميرا.' : ''}</div>}
      </div>

      {editing && <CameraForm cam={editing === 'new' ? null : editing} areas={areas} onClose={() => { setEditing(null); load(); }} />}
      {zonesFor && <ZoneEditor cam={zonesFor} onClose={() => setZonesFor(null)} />}
    </div>
  );
}

function CameraForm({ cam, areas, onClose }: { cam: Cam | null; areas: Area[]; onClose: () => void }) {
  const [f, setF] = useState({
    id: cam?.id ?? '', name: cam?.name ?? '', url: cam?.url ?? 'rtsp://', areaId: cam?.areaId ?? '',
    enabled: cam?.enabled ?? true, params: JSON.stringify(cam?.params ?? {}, null, 2),
    mapX: cam?.mapX?.toString() ?? '', mapY: cam?.mapY?.toString() ?? '',
  });
  const [error, setError] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    let params: Record<string, unknown>;
    try { params = JSON.parse(f.params || '{}'); } catch { setError('الإعدادات المتقدمة ليست JSON صحيحاً.'); return; }
    const body: Record<string, unknown> = {
      name: f.name, url: f.url.includes('***') ? undefined : f.url, areaId: f.areaId || null, enabled: f.enabled, params,
      mapX: f.mapX === '' ? null : Number(f.mapX), mapY: f.mapY === '' ? null : Number(f.mapY),
    };
    try {
      if (cam) await api(`/cameras/${cam.id}`, { method: 'PATCH', body });
      else await api('/cameras', { method: 'POST', body: { ...body, id: f.id } });
      onClose();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="panel" style={{ marginTop: 20 }}>
      <h2 style={{ marginBottom: 14 }}>{cam ? `تعديل ${cam.name}` : 'كاميرا جديدة'}</h2>
      <form onSubmit={save} className="stack" style={{ gap: 14 }}>
        <div className="two" style={{ gap: 14 }}>
          {!cam && <div className="field"><label>المعرّف (حروف إنجليزية صغيرة وأرقام وشرطة)</label><input type="text" dir="ltr" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} required pattern="[a-z0-9-]{2,40}" /></div>}
          <div className="field"><label>الاسم</label><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
          <div className="field"><label>رابط البث (RTSP)</label><input type="text" dir="ltr" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required /></div>
          <div className="field">
            <label>المنطقة</label>
            <select value={f.areaId} onChange={(e) => setF({ ...f, areaId: e.target.value })}>
              <option value="">بدون منطقة</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div className="field"><label>الموقع على الخريطة أفقياً (0 إلى 1)</label><input type="number" step="0.01" min="0" max="1" value={f.mapX} onChange={(e) => setF({ ...f, mapX: e.target.value })} /></div>
          <div className="field"><label>الموقع على الخريطة رأسياً (0 إلى 1)</label><input type="number" step="0.01" min="0" max="1" value={f.mapY} onChange={(e) => setF({ ...f, mapY: e.target.value })} /></div>
        </div>
        <div className="field">
          <label>إعدادات متقدمة للقواعد (JSON)، مثل {'{"gathering_min": 6, "fight_threshold": 0.7}'}. التفاصيل في docs/rules.md</label>
          <textarea dir="ltr" rows={4} value={f.params} onChange={(e) => setF({ ...f, params: e.target.value })} />
        </div>
        <label className="toggle"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />الكاميرا مفعّلة</label>
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="btn primary">حفظ</button><button type="button" className="btn ghost" onClick={onClose}>إلغاء</button></div>
      </form>
    </div>
  );
}

/** Draw zone polygons on a 16:9 frame: click to add points, then save. */
function ZoneEditor({ cam, onClose }: { cam: Cam; onClose: () => void }) {
  const [zones, setZones] = useState<Zone[]>([]);
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('restricted');
  const [hours, setHours] = useState('');
  const [error, setError] = useState('');
  const load = () => api<Zone[]>(`/zones?cameraId=${cam.id}`).then(setZones).catch(() => undefined);
  useEffect(() => { load(); }, [cam.id]);

  function add(e: MouseEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * 1000) / 1000;
    const y = Math.round(((e.clientY - r.top) / r.height) * 1000) / 1000;
    setDraft((d) => [...d, [x, y]]);
  }

  async function save() {
    setError('');
    if (draft.length < 3) { setError('ارسم ثلاث نقاط على الأقل.'); return; }
    const restrictedHours = hours.trim() ? hours.split(',').map((h) => Number(h.trim())).filter((h) => h >= 0 && h <= 23) : [];
    try {
      await api('/zones', { method: 'POST', body: { cameraId: cam.id, name: name || ZONE_KIND_LABEL[kind], kind, polygon: draft, restrictedHours } });
      setDraft([]); setName(''); load();
    } catch (err) { setError((err as Error).message); }
  }

  async function remove(id: string) {
    await api(`/zones/${id}`, { method: 'DELETE' });
    load();
  }

  const color: Record<string, string> = { restricted: 'var(--high)', perimeter: 'var(--crit)', count: 'var(--accent)', visit: 'var(--med)', general: 'var(--low)' };
  return (
    <div className="panel" style={{ marginTop: 20 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2>مناطق {cam.name}</h2>
        <button className="btn ghost" onClick={onClose}>إغلاق</button>
      </div>
      <div className="two">
        <div>
          <div className="zone-canvas">
            <svg viewBox="0 0 1 1" preserveAspectRatio="none" onClick={add} role="img" aria-label="رسم المنطقة">
              {zones.map((z) => (
                <polygon key={z.id} points={z.polygon.map((p) => p.join(',')).join(' ')} fill={color[z.kind]} fillOpacity="0.25" stroke={color[z.kind]} strokeWidth="0.004" />
              ))}
              {draft.length > 0 && <polygon points={draft.map((p) => p.join(',')).join(' ')} fill="var(--accent)" fillOpacity="0.2" stroke="var(--accent)" strokeWidth="0.004" strokeDasharray="0.01 0.008" />}
              {draft.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="0.008" fill="var(--accent)" />)}
            </svg>
          </div>
          <p className="faint" style={{ fontSize: 13 }}>الإطار يمثل صورة الكاميرا كاملة. انقر لإضافة نقاط المنطقة بالترتيب. القواعد تعتمد على موضع قدمي الشخص.</p>
        </div>
        <div className="stack" style={{ gap: 12 }}>
          <div className="field"><label>اسم المنطقة</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field">
            <label>النوع</label>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(ZONE_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          {kind === 'restricted' && (
            <div className="field"><label>ساعات الحظر (مثل 22,23,0,1,2,3,4,5). فارغ يعني محظورة دائماً.</label><input type="text" dir="ltr" value={hours} onChange={(e) => setHours(e.target.value)} /></div>
          )}
          {error && <div className="error">{error}</div>}
          <div className="row"><button className="btn primary" onClick={save}>حفظ المنطقة</button><button className="btn ghost" onClick={() => setDraft([])}>مسح الرسم</button></div>
          <table className="grid">
            <tbody>
              {zones.map((z) => (
                <tr key={z.id}><td><span className="status-dot" style={{ background: color[z.kind] }} />{z.name}</td><td className="muted">{ZONE_KIND_LABEL[z.kind]}</td><td><button className="btn ghost" onClick={() => remove(z.id)}>حذف</button></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
