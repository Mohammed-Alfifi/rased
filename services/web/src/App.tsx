import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { api, Role } from './api';
import { atLeast, useAuth } from './auth';
import { ROLE_LABEL } from './labels';
import { LiveProvider, useLive } from './live';
import AlertsPage from './pages/Alerts';
import AuditPage from './pages/Audit';
import CamerasPage from './pages/Cameras';
import ForecastPage from './pages/Forecast';
import HeadcountPage from './pages/Headcount';
import LoginPage from './pages/Login';
import MapPage from './pages/Map';
import ReportsPage from './pages/Reports';
import SettingsPage from './pages/Settings';
import StudioPage from './pages/Studio';

interface SystemStatus { camerasEnabled: number; camerasOnline: number; shadowMode: boolean; demoData: boolean }

const NAV: { to: string; label: string; min: Role }[] = [
  { to: '/alerts', label: 'التنبيهات', min: 'operator' },
  { to: '/map', label: 'خريطة المنشأة', min: 'operator' },
  { to: '/forecast', label: 'التنبؤ', min: 'operator' },
  { to: '/headcount', label: 'العدّ', min: 'operator' },
  { to: '/cameras', label: 'الكاميرات', min: 'operator' },
  { to: '/reports', label: 'التقارير', min: 'supervisor' },
  { to: '/audit', label: 'سجل التدقيق', min: 'manager' },
  { to: '/studio', label: 'تحسين النظام', min: 'admin' },
  { to: '/settings', label: 'الإعدادات', min: 'admin' },
];

export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="12" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      <path d="M16 4 A12 12 0 0 1 28 16" fill="none" stroke="var(--high)" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="4" fill="var(--high)" />
    </svg>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(t); }, []);
  const fmt = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });
  return <time className="muted">{fmt.format(now)}</time>;
}

function Shell() {
  const { user, logout } = useAuth();
  const live = useLive();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [open, setOpen] = useState(0);

  useEffect(() => {
    const load = () => {
      api<SystemStatus>('/system/status').then(setStatus).catch(() => undefined);
      api<{ openAlerts: number }>('/events/summary').then((s) => setOpen(s.openAlerts)).catch(() => undefined);
    };
    load();
    const t = window.setInterval(load, 20_000);
    const off = live.subscribe((kind) => { if (kind.startsWith('event.')) load(); });
    return () => { window.clearInterval(t); off(); };
  }, [live]);

  const camsOk = status && status.camerasOnline === status.camerasEnabled;
  return (
    <div className="shell">
      <nav className="rail" aria-label="الأقسام">
        <div className="brand"><Mark /><span className="brand-name">راصد</span></div>
        {NAV.filter((n) => atLeast(user?.role, n.min)).map((n) => (
          <NavLink key={n.to} to={n.to}>
            <span>{n.label}</span>
            {n.to === '/alerts' && open > 0 && <span className="count num">{open}</span>}
          </NavLink>
        ))}
        <div className="rail-foot">
          <div>{user?.fullName}</div>
          <div className="muted">{ROLE_LABEL[user?.role ?? 'operator']}</div>
          <button onClick={logout} style={{ marginTop: 8 }}>تسجيل الخروج</button>
        </div>
      </nav>
      <div className="main">
        <header className="topbar">
          <span>
            <span className="status-dot" style={{ background: camsOk ? 'var(--ok)' : 'var(--high)' }} />
            الكاميرات المتصلة <span className="num">{status ? `${status.camerasOnline}/${status.camerasEnabled}` : '–'}</span>
          </span>
          <span className="muted">
            <span className="status-dot" style={{ background: live.connected ? 'var(--ok)' : 'var(--crit)' }} />
            {live.connected ? 'البث المباشر متصل' : 'البث المباشر منقطع، جارٍ إعادة الاتصال'}
          </span>
          <span className="grow" />
          <Clock />
        </header>
        {status?.shadowMode && (
          <div className="banner shadow">
            وضع الظل مفعّل: النظام يسجل التنبيهات للقياس فقط ولا يرسلها للمشغّلين.
          </div>
        )}
        {status?.demoData && (
          <div className="banner demo">بيانات تجريبية: الأرقام والتنبيهات المعروضة مولّدة للعرض وليست من كاميرات حقيقية.</div>
        )}
        <Routes>
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/alerts/:id" element={<AlertsPage />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/forecast" element={<ForecastPage />} />
          <Route path="/headcount" element={<HeadcountPage />} />
          <Route path="/cameras" element={<CamerasPage />} />
          {atLeast(user?.role, 'supervisor') && <Route path="/reports" element={<ReportsPage />} />}
          {atLeast(user?.role, 'manager') && <Route path="/audit" element={<AuditPage />} />}
          {atLeast(user?.role, 'admin') && <Route path="/settings" element={<SettingsPage />} />}
          {atLeast(user?.role, 'admin') && <Route path="/studio" element={<StudioPage />} />}
          <Route path="*" element={<Navigate to="/alerts" replace />} />
        </Routes>
      </div>
    </div>
  );
}

export default function App() {
  const { user, ready } = useAuth();
  if (!ready) return null;
  if (!user) return <LoginPage />;
  return (
    <LiveProvider>
      <Shell />
    </LiveProvider>
  );
}
