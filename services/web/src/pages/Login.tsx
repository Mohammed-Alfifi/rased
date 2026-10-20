import { FormEvent, useState } from 'react';
import { Mark } from '../App';
import { useAuth } from '../auth';

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-form">
        <form onSubmit={submit}>
          <div className="row"><Mark size={36} /><h1>راصد</h1></div>
          <p className="muted" style={{ margin: 0 }}>مركز قيادة تحليل الفيديو. الدخول للمخوّلين فقط، وكل دخول مسجّل.</p>
          <div className="field">
            <label htmlFor="u">اسم المستخدم</label>
            <input id="u" type="text" autoComplete="username" dir="ltr" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="p">كلمة المرور</label>
            <input id="p" type="password" autoComplete="current-password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="error" role="alert">{error}</div>}
          <button className="btn primary" disabled={busy}>{busy ? 'جارٍ الدخول…' : 'تسجيل الدخول'}</button>
        </form>
      </div>
      <div className="login-art" aria-hidden="true">
        <svg viewBox="0 0 400 300" width="100%" style={{ maxWidth: 460 }}>
          {[
            { d: 'M30 30h150v110H30z', t: 22 }, { d: 'M195 30h175v110H195z', t: 64 },
            { d: 'M30 155h220v115H30z', t: 38 }, { d: 'M265 155h105v115H265z', t: 12 },
          ].map((a, i) => (
            <path key={i} d={a.d} fill={`hsl(${30 - a.t * 0.3} ${30 + a.t * 0.6}% ${24 + a.t * 0.25}%)`} stroke="#3d5163" />
          ))}
          {[[80, 70], [140, 110], [240, 80], [330, 110], [90, 200], [200, 240], [320, 200]].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="4" fill="var(--accent)" />
          ))}
        </svg>
      </div>
    </div>
  );
}
