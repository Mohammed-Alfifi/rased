import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { atLeast, useAuth } from '../auth';
import { ago, dateTime, REASON_LABEL, SEVERITY_LABEL, STATUS_LABEL, TAMPER_LABEL, time, TYPE_LABEL } from '../labels';
import { chime, useLive } from '../live';

export interface AlertEvent {
  id: string; type: string; severity: string; confidence: number; status: string; shadow: boolean;
  startedAt: string; receivedAt: string; cameraId: string; cameraName: string; zoneName: string | null;
  areaName: string | null; details: Record<string, any>; hasClip: boolean; hasSnapshot: boolean;
  reviewedAt: string | null; reviewedBy: string | null; reviewReason: string | null; reviewNote: string | null;
}

type View = 'open' | 'reviewed' | 'shadow';

function detailLine(e: AlertEvent): string | null {
  const d = e.details ?? {};
  if (e.type === 'gathering' && d.people) return `${d.people} أشخاص في مجموعة واحدة`;
  if (e.type === 'running' && d.runners) return d.runners > 1 ? `${d.runners} أشخاص يركضون` : 'شخص يركض';
  if (e.type === 'person_down' && d.downSeconds) return `على الأرض منذ ${Math.round(d.downSeconds)} ثانية على الأقل`;
  if (e.type === 'camera_tamper' && d.reason) return TAMPER_LABEL[d.reason] ?? d.reason;
  if (e.type === 'count_mismatch') return `المتوقع ${d.expected}، والمرصود ${d.counted}`;
  if (e.type === 'abandoned_object' && d.aloneSeconds) return `بلا صاحب منذ ${Math.round(d.aloneSeconds / 60)} دقيقة`;
  if (e.type === 'fight' && d.mode) return d.mode === 'classifier' ? 'كشف بالنموذج المدرّب' : 'كشف بالقواعد (حركة الذراعين والقرب)';
  return null;
}

export default function AlertsPage() {
  const { user } = useAuth();
  const live = useLive();
  const { id } = useParams();
  const nav = useNavigate();
  const [view, setView] = useState<View>('open');
  const [items, setItems] = useState<AlertEvent[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const query = useMemo(() => {
    if (view === 'open') return '/events?status=new&limit=100';
    if (view === 'reviewed') return '/events?status=confirmed,dismissed&limit=100';
    return '/events?shadow=true&limit=100';
  }, [view]);

  const load = useCallback(() => {
    setLoading(true);
    api<AlertEvent[]>(query).then((r) => { setItems(r); setError(''); }).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [query]);

  useEffect(load, [load]);

  useEffect(() => live.subscribe((kind, data: AlertEvent) => {
    if (kind === 'event.created') {
      const belongs = view === 'shadow' ? data.shadow : !data.shadow && view === 'open';
      if (!belongs) return;
      setItems((prev) => [data, ...prev.filter((p) => p.id !== data.id)]);
      setFresh((s) => new Set(s).add(data.id));
      if (data.severity === 'critical' && !data.shadow) chime();
    }
    if (kind === 'event.reviewed') {
      setItems((prev) => (view === 'open' ? prev.filter((p) => p.id !== data.id) : prev.map((p) => (p.id === data.id ? data : p))));
    }
  }), [live, view]);

  const selected = items.find((i) => i.id === id);

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="page-head">
        <div>
          <h1>التنبيهات</h1>
          <p>كل تنبيه يحتاج قراراً منك: تأكيد أو رفض مع السبب. القرار يُسجَّل باسمك ويحسّن دقة النظام.</p>
        </div>
        <div className="seg" role="tablist">
          <button className={view === 'open' ? 'on' : ''} onClick={() => setView('open')}>بانتظار المراجعة</button>
          <button className={view === 'reviewed' ? 'on' : ''} onClick={() => setView('reviewed')}>تمت مراجعتها</button>
          {atLeast(user?.role, 'supervisor') && (
            <button className={view === 'shadow' ? 'on' : ''} onClick={() => setView('shadow')}>سجل وضع الظل</button>
          )}
        </div>
      </div>
      <div className="alerts" style={{ flex: 1, minHeight: 480 }}>
        <div className="queue" aria-label="قائمة التنبيهات">
          {error && <div className="error" style={{ padding: 14 }}>{error}</div>}
          {!loading && !items.length && (
            <div className="empty">{view === 'open' ? 'لا توجد تنبيهات بانتظار المراجعة.' : 'لا توجد تنبيهات هنا.'}</div>
          )}
          {items.map((e) => (
            <button
              key={e.id}
              className={`alert-row ${e.severity} ${e.id === id ? 'sel' : ''} ${e.status !== 'new' ? 'reviewed' : ''} ${fresh.has(e.id) ? 'fresh' : ''}`}
              onClick={() => nav(`/alerts/${e.id}`)}
            >
              <span className="bar" />
              <span>
                <span className="title">{TYPE_LABEL[e.type] ?? e.type}</span>
                <span className="where" style={{ display: 'block' }}>{[e.areaName, e.cameraName].filter(Boolean).join('، ')}</span>
              </span>
              <span className="when">
                <span className="num">{time(e.startedAt)}</span>
                <br />{e.status === 'new' ? ago(e.startedAt) : STATUS_LABEL[e.status]}
              </span>
            </button>
          ))}
        </div>
        {selected ? <Detail key={selected.id} ev={selected} onDone={(next) => {
          setItems((prev) => (view === 'open' ? prev.filter((p) => p.id !== next.id) : prev.map((p) => (p.id === next.id ? next : p))));
          const idx = items.findIndex((p) => p.id === next.id);
          const after = items.filter((p) => p.id !== next.id)[idx];
          nav(after && view === 'open' ? `/alerts/${after.id}` : '/alerts');
        }} /> : (
          <div className="empty">اختر تنبيهاً من القائمة لعرض المقطع واتخاذ القرار.</div>
        )}
      </div>
    </div>
  );
}

function Detail({ ev, onDone }: { ev: AlertEvent; onDone: (e: AlertEvent) => void }) {
  const { user } = useAuth();
  const [media, setMedia] = useState<{ clipUrl: string | null; snapshotUrl: string | null } | null>(null);
  const [mediaError, setMediaError] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canDecide = ev.status === 'new' || atLeast(user?.role, 'supervisor');

  useEffect(() => {
    api(`/events/${ev.id}`).catch(() => undefined); // records the view in the audit log
    if (ev.hasClip || ev.hasSnapshot) {
      api(`/events/${ev.id}/media-token`, { method: 'POST', body: {} }).then(setMedia).catch((e) => setMediaError(e.message));
    }
  }, [ev.id, ev.hasClip, ev.hasSnapshot]);

  const decide = useCallback(async (decision: 'confirmed' | 'dismissed') => {
    if (decision === 'dismissed' && !reason) { setError('اختر سبب الرفض.'); return; }
    setBusy(true);
    setError('');
    try {
      const next = await api<AlertEvent>(`/events/${ev.id}/review`, { method: 'POST', body: { decision, reason: reason || undefined, note: note || undefined } });
      onDone(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [ev.id, reason, note, onDone]);

  async function exportClip() {
    const t = await api<{ clipUrl: string }>(`/events/${ev.id}/media-token`, { method: 'POST', body: { download: true } });
    if (t.clipUrl) window.location.href = t.clipUrl;
  }

  const extra = detailLine(ev);
  return (
    <section className="detail" aria-label="تفاصيل التنبيه">
      <div className="detail-head">
        <div>
          <span className={`sev ${ev.severity}`}>{SEVERITY_LABEL[ev.severity]}</span>
          <h2 style={{ fontSize: 24, marginTop: 4 }}>{TYPE_LABEL[ev.type] ?? ev.type}</h2>
          <div className="muted">{[ev.areaName, ev.cameraName, ev.zoneName].filter(Boolean).join('، ')}</div>
        </div>
        <div style={{ textAlign: 'end' }}>
          {ev.shadow && <span className="pill shadow">وضع الظل</span>}{' '}
          <span className={`pill ${ev.status}`}>{STATUS_LABEL[ev.status]}</span>
        </div>
      </div>

      <div className="media">
        {media?.clipUrl ? (
          <video src={media.clipUrl} poster={media.snapshotUrl ?? undefined} controls autoPlay muted playsInline />
        ) : media?.snapshotUrl ? (
          <img src={media.snapshotUrl} alt="لقطة من لحظة التنبيه" />
        ) : (
          <span className="muted">{mediaError || (ev.hasClip ? 'جارٍ تحميل المقطع…' : 'لا يوجد مقطع لهذا التنبيه.')}</span>
        )}
      </div>
      <p className="faint" style={{ margin: '-8px 0 0', fontSize: 13 }}>الوجوه مموّهة تلقائياً في كل المقاطع. مشاهدتك لهذا المقطع مسجّلة.</p>

      <dl className="facts">
        <div><dt>وقت البداية</dt><dd className="num">{dateTime(ev.startedAt)}</dd></div>
        <div><dt>زمن وصول التنبيه</dt><dd><span className="num">{((new Date(ev.receivedAt).getTime() - new Date(ev.startedAt).getTime()) / 1000).toFixed(1)}</span> ثانية</dd></div>
        <div><dt>ثقة النظام</dt><dd className="num">{Math.round(ev.confidence * 100)}%</dd></div>
        {extra && <div><dt>التفاصيل</dt><dd>{extra}</dd></div>}
        {ev.reviewedBy && (
          <div><dt>القرار</dt><dd>{STATUS_LABEL[ev.status]} بواسطة {ev.reviewedBy}{ev.reviewReason ? `، ${REASON_LABEL[ev.reviewReason]}` : ''}</dd></div>
        )}
        {ev.reviewNote && <div><dt>ملاحظة</dt><dd>{ev.reviewNote}</dd></div>}
      </dl>

      {canDecide && (
        <div className="decide">
          <h3>{ev.status === 'new' ? 'القرار' : 'تغيير القرار'}</h3>
          <div className="two" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="reason">سبب الرفض (مطلوب عند الرفض)</label>
              <select id="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">اختر السبب</option>
                {Object.entries(REASON_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="note">ملاحظة (اختياري)</label>
              <textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
            </div>
          </div>
          {error && <div className="error" role="alert">{error}</div>}
          <div className="decide-row">
            <button className="btn confirm" disabled={busy} onClick={() => decide('confirmed')}>تأكيد الحادثة</button>
            <button className="btn" disabled={busy} onClick={() => decide('dismissed')}>رفض التنبيه</button>
            <span className="grow" style={{ flex: 1 }} />
            {atLeast(user?.role, 'supervisor') && ev.hasClip && <button className="btn ghost" onClick={exportClip}>تصدير المقطع</button>}
          </div>
        </div>
      )}
    </section>
  );
}
