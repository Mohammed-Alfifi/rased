import { FormEvent, useEffect, useState } from 'react';
import { api, Role } from '../api';
import { useAuth } from '../auth';
import { ago, ROLE_LABEL } from '../labels';

interface UserRow { id: string; username: string; fullName: string; role: Role; active: boolean; lastLoginAt: string | null }
interface Area { id: string; name: string; expectedCount: number | null; cameras: number }

export default function SettingsPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>الإعدادات</h1>
          <p>كل تغيير هنا يُسجَّل في سجل التدقيق مع القيمة السابقة والجديدة.</p>
        </div>
      </div>
      <div className="stack">
        <SystemSettings />
        <Users />
        <Areas />
      </div>
    </div>
  );
}

function SystemSettings() {
  const [s, setS] = useState<Record<string, any> | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api('/settings').then(setS); }, []);
  if (!s) return null;

  async function patch(body: Record<string, unknown>) {
    setMsg('');
    try {
      setS(await api('/settings', { method: 'PATCH', body }));
      setMsg('حُفظ التغيير.');
    } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <div className="panel stack" style={{ gap: 16 }}>
      <h2>التشغيل والاحتفاظ بالبيانات</h2>
      <label className="toggle">
        <input type="checkbox" checked={!!s.shadow_mode} onChange={(e) => {
          if (!e.target.checked && !window.confirm('إيقاف وضع الظل يعني أن التنبيهات ستصل للمشغّلين مباشرة. هل تريد المتابعة؟')) return;
          patch({ shadow_mode: e.target.checked });
        }} />
        <span>
          وضع الظل
          <span className="muted" style={{ display: 'block', fontSize: 14 }}>النظام يسجل التنبيهات للقياس ولا يرسلها للمشغّلين. يُستخدم في أسبوعي التجربة الأوليين.</span>
        </span>
      </label>
      <div className="two" style={{ gap: 14 }}>
        <div className="field">
          <label>مدة الاحتفاظ بالتنبيهات والبيانات (أيام)</label>
          <input type="number" min={1} max={3650} defaultValue={s.retention_days} onBlur={(e) => Number(e.target.value) !== s.retention_days && patch({ retention_days: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label>مدة الاحتفاظ بالمقاطع واللقطات (أيام)</label>
          <input type="number" min={1} max={3650} defaultValue={s.clip_retention_days} onBlur={(e) => Number(e.target.value) !== s.clip_retention_days && patch({ clip_retention_days: Number(e.target.value) })} />
        </div>
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 14 }}>البيانات الأقدم من هذه المدة تُحذف تلقائياً كل ساعة، ويُسجَّل الحذف. سجل التدقيق لا يُحذف.</p>
      {msg && <div className="muted">{msg}</div>}
    </div>
  );
}

function Users() {
  const { user: me } = useAuth();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [f, setF] = useState({ username: '', fullName: '', role: 'operator' as Role, password: '' });
  const [error, setError] = useState('');
  const load = () => api<UserRow[]>('/users').then(setRows);
  useEffect(() => { load(); }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/users', { method: 'POST', body: f });
      setF({ username: '', fullName: '', role: 'operator', password: '' });
      load();
    } catch (err) { setError((err as Error).message); }
  }
  async function update(id: string, body: Partial<UserRow>) {
    try { await api(`/users/${id}`, { method: 'PATCH', body }); load(); } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="panel">
      <h2 style={{ marginBottom: 6 }}>المستخدمون والصلاحيات</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        المشغّل يراجع التنبيهات. المشرف يرى سجل وضع الظل والتقارير ويصدّر المقاطع. المدير يرى سجل التدقيق. مسؤول النظام يدير الكاميرات والمستخدمين والإعدادات.
      </p>
      <table className="grid">
        <thead><tr><th>الاسم</th><th>المستخدم</th><th>الدور</th><th>آخر دخول</th><th>الحالة</th></tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td>{u.fullName}</td>
              <td className="num">{u.username}</td>
              <td>
                <select value={u.role} disabled={u.id === me?.id} onChange={(e) => update(u.id, { role: e.target.value as Role })}>
                  {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </td>
              <td className="muted">{u.lastLoginAt ? ago(u.lastLoginAt) : 'لم يدخل بعد'}</td>
              <td>
                <label className="toggle"><input type="checkbox" checked={u.active} disabled={u.id === me?.id} onChange={(e) => update(u.id, { active: e.target.checked })} />{u.active ? 'مفعّل' : 'موقوف'}</label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={create} className="row" style={{ marginTop: 16, alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: '1 1 160px' }}><label>الاسم الكامل</label><input type="text" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} required /></div>
        <div className="field" style={{ flex: '1 1 140px' }}><label>اسم المستخدم</label><input type="text" dir="ltr" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} required pattern="[a-z0-9._-]{3,32}" /></div>
        <div className="field" style={{ flex: '0 1 150px' }}>
          <label>الدور</label>
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </div>
        <div className="field" style={{ flex: '1 1 160px' }}><label>كلمة مرور مؤقتة (10 أحرف على الأقل)</label><input type="password" dir="ltr" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} minLength={10} required /></div>
        <button className="btn primary">إضافة المستخدم</button>
      </form>
      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function Areas() {
  const [rows, setRows] = useState<Area[]>([]);
  const [name, setName] = useState('');
  const [expected, setExpected] = useState('');
  const load = () => api<Area[]>('/areas').then(setRows);
  useEffect(() => { load(); }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    await api('/areas', { method: 'POST', body: { name, expectedCount: expected ? Number(expected) : undefined } });
    setName(''); setExpected(''); load();
  }

  return (
    <div className="panel">
      <h2 style={{ marginBottom: 6 }}>مناطق المنشأة</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>المنطقة وحدة قياس التوتر والتنبؤ (عنبر، ساحة، قاعة). تُربط الكاميرات بها من صفحة الكاميرات.</p>
      <table className="grid">
        <thead><tr><th>المنطقة</th><th>العدد المتوقع</th><th>الكاميرات</th></tr></thead>
        <tbody>{rows.map((a) => <tr key={a.id}><td>{a.name}</td><td className="num">{a.expectedCount ?? '–'}</td><td className="num">{a.cameras}</td></tr>)}</tbody>
      </table>
      <form onSubmit={add} className="row" style={{ marginTop: 16, alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: '1 1 200px' }}><label>اسم المنطقة</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} required /></div>
        <div className="field" style={{ flex: '0 1 160px' }}><label>العدد المتوقع</label><input type="number" min="0" value={expected} onChange={(e) => setExpected(e.target.value)} /></div>
        <button className="btn primary">إضافة المنطقة</button>
      </form>
    </div>
  );
}
