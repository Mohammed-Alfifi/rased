import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api';
import { dateTime, TYPE_LABEL } from '../labels';

type Tab = 'data' | 'train' | 'models' | 'tuning';
type Counts = Record<string, { positive: number; negative: number }>;
interface Summary {
  counts: Counts; minimums: Record<string, number>; missing: string[]; canTrain: boolean;
  availableFromReviews: { fight: number; normal: number };
  active: { version: number; threshold: number; activatedAt: string } | null;
  runningJob: { id: string; status: string; progress: number; stage: string } | null;
  gate: { minRecall: number; maxF1Drop: number };
}

const SPLIT_LABEL: Record<string, string> = { train: 'التدريب', val: 'التحقق', test: 'الاختبار', unassigned: 'غير موزّعة' };
const LABEL: Record<string, string> = { positive: 'عراك', negative: 'ليس عراكاً' };
const STAGE: Record<string, string> = {
  starting: 'يبدأ', features: 'استخراج حركة الأجسام من المقاطع', training: 'التدريب', evaluation: 'التقييم', export: 'حفظ النموذج',
  succeeded: 'اكتمل', failed: 'فشل', cancelled: 'أُلغي',
};
const JOB_STATUS: Record<string, string> = { queued: 'في الانتظار', running: 'قيد التشغيل', succeeded: 'اكتمل', failed: 'فشل', cancelled: 'أُلغي' };
const MODEL_STATUS: Record<string, string> = { candidate: 'بانتظار القرار', active: 'مفعّل الآن', archived: 'سابق', rejected: 'مرفوض' };
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);

export default function StudioPage() {
  const [tab, setTab] = useState<Tab>('data');
  const [summary, setSummary] = useState<Summary | null>(null);
  const loadSummary = useCallback(() => api<Summary>('/training/summary').then(setSummary).catch(() => undefined), []);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>تحسين النظام</h1>
          <p>
            قرارات المشغّلين على التنبيهات تتحول هنا إلى بيانات تدريب. من هذه الصفحة تدرّب نموذج كشف العراك
            وتقارنه بالحالي قبل تفعيله، وتضبط حساسية القواعد لكل كاميرا. كل خطوة مسجّلة في سجل التدقيق.
          </p>
        </div>
        <div className="seg" role="tablist">
          {([['data', 'البيانات'], ['train', 'التدريب'], ['models', 'النماذج'], ['tuning', 'ضبط القواعد']] as [Tab, string][]).map(([k, v]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); loadSummary(); }}>{v}</button>
          ))}
        </div>
      </div>
      {summary && <ModelBanner s={summary} />}
      {tab === 'data' && summary && <DataTab s={summary} reload={loadSummary} />}
      {tab === 'train' && summary && <TrainTab s={summary} reload={loadSummary} />}
      {tab === 'models' && <ModelsTab reload={loadSummary} />}
      {tab === 'tuning' && <TuningTab />}
    </div>
  );
}

function ModelBanner({ s }: { s: Summary }) {
  return (
    <div className="panel row" style={{ marginBottom: 20, justifyContent: 'space-between' }}>
      <span>
        كشف العراك يعمل الآن بـ{' '}
        <b>{s.active ? `النموذج المدرّب، الإصدار ${s.active.version}` : 'القواعد (حركة الذراعين والقرب)'}</b>
        {s.active && <span className="muted"> · حد التنبيه {s.active.threshold}</span>}
      </span>
      {s.runningJob && <span className="muted">تدريب جارٍ: {STAGE[s.runningJob.stage] ?? s.runningJob.stage} ({pct(s.runningJob.progress)})</span>}
    </div>
  );
}

// ------------------------------------------------------------------ data

function DataTab({ s, reload }: { s: Summary; reload: () => void }) {
  const [msg, setMsg] = useState('');
  const [normal, setNormal] = useState(true);
  const [items, setItems] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const loadItems = useCallback(() => api<any[]>(`/training/items${filter ? `?split=${filter}` : ''}`).then(setItems), [filter]);
  useEffect(() => { loadItems(); }, [loadItems]);
  const refresh = () => { reload(); loadItems(); };

  async function fromReviews() {
    setMsg('');
    try {
      const r = await api<{ added: number; missingFiles: number }>('/training/items/from-reviews', { method: 'POST', body: { includeNormalActivity: normal } });
      setMsg(`أُضيف ${r.added} مقطعاً.${r.missingFiles ? ` ${r.missingFiles} مقطعاً حُذف ملفه بانتهاء مدة الاحتفاظ.` : ''} وزّع الجديد على المجموعات من الأسفل.`);
      refresh();
    } catch (e) { setMsg((e as Error).message); }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await api(`/training/items/${id}`, { method: 'PATCH', body });
    refresh();
  }
  async function show(id: string) {
    const r = await api<{ url: string }>(`/training/items/${id}/media-token`, { method: 'POST', body: {} });
    setPreview(r.url);
  }

  const total = (l: 'positive' | 'negative') => Object.values(s.counts).reduce((a, c) => a + c[l], 0);
  return (
    <div className="stack">
      <div className="two">
        <div className="panel">
          <h2 style={{ marginBottom: 10 }}>المقاطع المصنّفة</h2>
          <table className="grid">
            <thead><tr><th>المجموعة</th><th>عراك</th><th>ليس عراكاً</th><th>الحد الأدنى لكل نوع</th></tr></thead>
            <tbody>
              {['train', 'val', 'test', 'unassigned'].map((k) => (
                <tr key={k}>
                  <td>{SPLIT_LABEL[k]}</td>
                  {(['positive', 'negative'] as const).map((l) => (
                    <td key={l} className="num" style={{ color: s.missing.includes(`${k}.${l}`) ? 'var(--high)' : undefined }}>{s.counts[k][l]}</td>
                  ))}
                  <td className="num muted">{s.minimums[k] ?? '–'}</td>
                </tr>
              ))}
              <tr><td><b>المجموع</b></td><td className="num"><b>{total('positive')}</b></td><td className="num"><b>{total('negative')}</b></td><td /></tr>
            </tbody>
          </table>
          <p className="faint" style={{ fontSize: 13, marginBottom: 0 }}>
            الحد الأدنى يسمح بتجربة التدريب فقط. لنموذج يُعتمد عليه، اجمع 100 مقطع أو أكثر من كل نوع، من كاميرات وأوقات مختلفة.
          </p>
        </div>
        <div className="panel stack" style={{ gap: 14 }}>
          <h2>إضافة بيانات</h2>
          <div>
            <p style={{ margin: '0 0 8px' }}>
              من مراجعات المشغّلين: <span className="num">{s.availableFromReviews.fight}</span> تنبيه عراك مراجَع
              {normal && <> و<span className="num">{s.availableFromReviews.normal}</span> مقطع نشاط طبيعي</>} لم تُضف بعد.
            </p>
            <label className="toggle" style={{ fontSize: 14 }}>
              <input type="checkbox" checked={normal} onChange={(e) => setNormal(e.target.checked)} />
              أضف المقاطع المرفوضة بسبب «نشاط طبيعي» كأمثلة على ما ليس عراكاً
            </label>
            <div style={{ marginTop: 10 }}><button className="btn primary" onClick={fromReviews}>إضافة من المراجعات</button></div>
          </div>
          <Upload onDone={refresh} />
          {msg && <div className="muted">{msg}</div>}
        </div>
      </div>
      <SplitForm onDone={refresh} hasTest={s.counts.test.positive + s.counts.test.negative > 0} />
      <div className="panel" style={{ padding: 0 }}>
        <div className="row" style={{ padding: 12, justifyContent: 'space-between' }}>
          <h3>المقاطع</h3>
          <div className="seg">
            {[['', 'الكل'], ['train', 'التدريب'], ['val', 'التحقق'], ['test', 'الاختبار'], ['unassigned', 'غير موزّعة']].map(([k, v]) => (
              <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{v}</button>
            ))}
          </div>
        </div>
        <table className="grid">
          <thead><tr><th>التصنيف</th><th>المصدر</th><th>المجموعة</th><th>نوافذ الحركة</th><th>أُضيف</th><th /></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} style={{ opacity: it.excluded ? 0.5 : 1 }}>
                <td>
                  <select value={it.label} onChange={(e) => patch(it.id, { label: e.target.value })}>
                    <option value="positive">عراك</option><option value="negative">ليس عراكاً</option>
                  </select>
                </td>
                <td>{it.source === 'review' ? `مراجعة: ${TYPE_LABEL[it.eventType] ?? 'تنبيه'}${it.cameraName ? `، ${it.cameraName}` : ''}` : `رفع يدوي${it.note ? `: ${it.note}` : ''}`}</td>
                <td>{SPLIT_LABEL[it.split ?? 'unassigned']}</td>
                <td className="num">{it.windows ?? <span className="faint">لم تُستخرج</span>}</td>
                <td className="num">{dateTime(it.createdAt)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn ghost" onClick={() => show(it.id)}>عرض</button>{' '}
                  <button className="btn ghost" onClick={() => patch(it.id, { excluded: !it.excluded })}>{it.excluded ? 'إرجاع' : 'استبعاد'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && <div className="empty">لا توجد مقاطع هنا بعد.</div>}
      </div>
      {preview && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}><h3>معاينة</h3><button className="btn ghost" onClick={() => setPreview(null)}>إغلاق</button></div>
          <div className="media"><video src={preview} controls autoPlay muted playsInline /></div>
        </div>
      )}
    </div>
  );
}

function Upload({ onDone }: { onDone: () => void }) {
  const [label, setLabel] = useState('positive');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const files = Array.from(fileRef.current?.files ?? []);
    if (!files.length) { setMsg('اختر ملف فيديو أو أكثر.'); return; }
    setBusy(true); setMsg('');
    let ok = 0;
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('label', label);
      if (note) fd.append('note', note);
      const res = await fetch('/api/training/items/upload', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: fd });
      if (res.ok) ok++;
    }
    setBusy(false);
    setMsg(`رُفع ${ok} من ${files.length}.`);
    if (fileRef.current) fileRef.current.value = '';
    onDone();
  }

  return (
    <form onSubmit={submit} className="stack" style={{ gap: 10, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div>رفع مقاطع مصنّفة (مقاطع تمثيلية أو بيانات عامة مرخّصة)</div>
      <div className="row">
        <input ref={fileRef} type="file" accept="video/*" multiple />
        <select value={label} onChange={(e) => setLabel(e.target.value)} style={{ width: 'auto' }}>
          <option value="positive">عراك</option><option value="negative">ليس عراكاً</option>
        </select>
      </div>
      <input type="text" placeholder="ملاحظة (اختياري)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row"><button className="btn" disabled={busy}>{busy ? 'جارٍ الرفع…' : 'رفع'}</button>{msg && <span className="muted">{msg}</span>}</div>
    </form>
  );
}

function SplitForm({ onDone, hasTest }: { onDone: () => void; hasTest: boolean }) {
  const [p, setP] = useState({ train: 70, val: 15, test: 15 });
  const [mode, setMode] = useState<'random' | 'by_camera'>('random');
  const [keepTest, setKeepTest] = useState(true);
  const [msg, setMsg] = useState('');
  const sum = p.train + p.val + p.test;

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ moved: number }>('/training/split', { method: 'POST', body: { ...p, mode, keepTest } });
      setMsg(`وُزّع ${r.moved} مقطعاً.`);
      onDone();
    } catch (err) { setMsg((err as Error).message); }
  }

  return (
    <form className="panel stack" style={{ gap: 12 }} onSubmit={submit}>
      <h2>تقسيم البيانات</h2>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        التدريب يتعلم منه النموذج، والتحقق يُختار به حد التنبيه، والاختبار امتحان نهائي لا يراه النموذج أثناء التدريب.
        التقسيم يحافظ على نسبة العراك نفسها في كل مجموعة.
      </p>
      <div className="row">
        {(['train', 'val', 'test'] as const).map((k) => (
          <div className="field" key={k} style={{ width: 130 }}>
            <label>{SPLIT_LABEL[k]} %</label>
            <input type="number" min={5} max={90} value={p[k]} onChange={(e) => setP({ ...p, [k]: Number(e.target.value) })} />
          </div>
        ))}
        <div className="field" style={{ width: 260 }}>
          <label>طريقة التقسيم</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="random">عشوائي متوازن</option>
            <option value="by_camera">حسب الكاميرا (الاختبار من كاميرات لم يتدرب عليها)</option>
          </select>
        </div>
      </div>
      {hasTest && (
        <label className="toggle" style={{ fontSize: 14 }}>
          <input type="checkbox" checked={keepTest} onChange={(e) => setKeepTest(e.target.checked)} />
          أبقِ مجموعة الاختبار كما هي، ووزّع الجديد فقط (يجعل المقارنة بين الإصدارات عادلة)
        </label>
      )}
      <div className="row">
        <button className="btn primary" disabled={sum !== 100}>تقسيم</button>
        {sum !== 100 && <span className="error">المجموع {sum}%، ويجب أن يكون 100%.</span>}
        {msg && <span className="muted">{msg}</span>}
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ training

const MISSING_TEXT = (m: string) => {
  const [split, label] = m.split('.');
  return `${SPLIT_LABEL[split]}: ${LABEL[label]}`;
};

function TrainTab({ s, reload }: { s: Summary; reload: () => void }) {
  const [jobs, setJobs] = useState<any[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
  const [epochs, setEpochs] = useState(30);
  const [error, setError] = useState('');
  const loadJobs = useCallback(() => api<any[]>('/training/jobs').then((j) => { setJobs(j); setSel((x) => x ?? j[0]?.id ?? null); }), []);
  useEffect(() => { loadJobs(); }, [loadJobs]);

  useEffect(() => {
    if (!sel) return;
    let t: number | undefined;
    const tick = () => api(`/training/jobs/${sel}`).then((j) => {
      setJob(j);
      if (['queued', 'running'].includes(j.status)) t = window.setTimeout(tick, 3000);
      else { loadJobs(); reload(); }
    });
    tick();
    return () => window.clearTimeout(t);
  }, [sel, loadJobs, reload]);

  async function start() {
    setError('');
    try {
      const r = await api<{ id: string }>('/training/jobs', { method: 'POST', body: { epochs } });
      setSel(r.id);
      loadJobs(); reload();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="stack">
      <div className="panel stack" style={{ gap: 12 }}>
        <h2>تدريب إصدار جديد</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          التدريب يعمل في الخلفية ويمكنك مغادرة الصفحة. ينتهي بإصدار «بانتظار القرار» تقارنه بالنموذج الحالي في تبويب النماذج.
          لا يتغير شيء في التشغيل حتى تفعّله.
        </p>
        {!s.canTrain && s.missing.length > 0 && (
          <div className="error">البيانات لا تكفي بعد. ينقص: {s.missing.map(MISSING_TEXT).join('، ')}.</div>
        )}
        <div className="row">
          <div className="field" style={{ width: 160 }}>
            <label>عدد دورات التدريب</label>
            <input type="number" min={5} max={200} value={epochs} onChange={(e) => setEpochs(Number(e.target.value))} />
          </div>
          <button className="btn primary" style={{ alignSelf: 'flex-end' }} disabled={!s.canTrain} onClick={start}>ابدأ التدريب</button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      <div className="two">
        <div className="panel" style={{ padding: 0 }}>
          <table className="grid">
            <thead><tr><th>البداية</th><th>الحالة</th><th>التقدم</th><th>الإصدار</th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} onClick={() => setSel(j.id)} style={{ cursor: 'pointer', background: j.id === sel ? 'var(--panel-2)' : undefined }}>
                  <td className="num">{dateTime(j.createdAt)}</td>
                  <td>{JOB_STATUS[j.status]}</td>
                  <td><Progress v={j.progress} /></td>
                  <td className="num">{j.modelVersion ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!jobs.length && <div className="empty">لم يُشغَّل أي تدريب بعد.</div>}
        </div>
        <div className="panel">
          {job ? (
            <div className="stack" style={{ gap: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3>{JOB_STATUS[job.status]} · {STAGE[job.stage] ?? job.stage ?? ''}</h3>
                {['queued', 'running'].includes(job.status) && (
                  <button className="btn ghost" onClick={() => api(`/training/jobs/${job.id}/cancel`, { method: 'POST' }).then(loadJobs)}>إلغاء</button>
                )}
              </div>
              <Progress v={job.progress} wide />
              <pre dir="ltr" style={{ margin: 0, maxHeight: 360, overflow: 'auto', fontSize: 12, background: 'var(--bg)', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap' }}>
                {job.log || 'بانتظار أن يبدأ العامل…'}
              </pre>
            </div>
          ) : <p className="muted">اختر تدريباً لعرض تفاصيله.</p>}
        </div>
      </div>
    </div>
  );
}

function Progress({ v, wide }: { v: number; wide?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ height: 6, width: wide ? '100%' : 90, background: 'var(--line)', borderRadius: 3 }}>
        <div style={{ height: 6, width: `${Math.round(v * 100)}%`, background: 'var(--accent)', borderRadius: 3 }} />
      </div>
      <span className="num muted" style={{ fontSize: 12 }}>{Math.round(v * 100)}%</span>
    </div>
  );
}

// ------------------------------------------------------------------ models

function ModelsTab({ reload }: { reload: () => void }) {
  const [models, setModels] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const [override, setOverride] = useState<{ id: string; problems: string[] } | null>(null);
  const [reason, setReason] = useState('');
  const load = () => api<any[]>('/training/models').then(setModels);
  useEffect(() => { load(); }, []);

  async function activate(id: string, force = false) {
    setMsg('');
    const res = await fetch(`/api/training/models/${id}/activate`, {
      method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(force ? { force: true, reason } : {}),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) { setMsg(`فُعّل الإصدار ${body.version}. الكاميرات تبدأ استخدامه خلال دقيقة.`); setOverride(null); setReason(''); load(); reload(); return; }
    const m = body.message;
    if (Array.isArray(body.problems)) setOverride({ id, problems: body.problems });
    else setMsg(typeof m === 'string' ? (m.includes('written reason') ? 'تجاوز بوابة الجودة يحتاج سبباً مكتوباً (10 أحرف على الأقل).' : m) : 'تعذّر التفعيل.');
  }

  return (
    <div className="stack">
      <div className="panel">
        <h2>بوابة الجودة</h2>
        <p className="muted" style={{ margin: '6px 0 0', fontSize: 14 }}>
          يُفعَّل الإصدار الجديد مباشرة إذا كشف 85% أو أكثر من مقاطع العراك في مجموعة الاختبار، ولم يكن أسوأ من النموذج الحالي على المجموعة نفسها.
          غير ذلك يحتاج تجاوزاً بسبب مكتوب يُسجَّل في سجل التدقيق.
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn ghost" onClick={() => api('/training/models/deactivate', { method: 'POST' }).then(() => { setMsg('رجع كشف العراك إلى القواعد.'); load(); reload(); })}>
            الرجوع إلى القواعد بدون نموذج
          </button>
          {msg && <span className="muted">{msg}</span>}
        </div>
      </div>
      {override && (
        <div className="panel stack" style={{ gap: 10, borderColor: 'var(--high)' }}>
          <h3>الإصدار لم يجتز بوابة الجودة</h3>
          <ul style={{ margin: 0 }}>{override.problems.map((p) => <li key={p} dir="ltr" style={{ textAlign: 'right' }}>{p}</li>)}</ul>
          <div className="field"><label>سبب التفعيل رغم ذلك (يُسجَّل باسمك)</label><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="row"><button className="btn confirm" onClick={() => activate(override.id, true)}>تفعيل مع التجاوز</button><button className="btn ghost" onClick={() => setOverride(null)}>إلغاء</button></div>
        </div>
      )}
      <div className="panel" style={{ padding: 0 }}>
        <table className="grid">
          <thead>
            <tr><th>الإصدار</th><th>الحالة</th><th>الاستدعاء (Recall)</th><th>الدقة (Precision)</th><th>F1</th><th>مقارنة بالحالي</th><th>البيانات</th><th>حد التنبيه</th><th /></tr>
          </thead>
          <tbody>
            {models.map((m) => {
              const t = m.metrics?.test?.video ?? {};
              const b = m.metrics?.baseline?.video;
              const meets = t.recall >= 0.85 && (!b || t.f1 >= b.f1 - 0.01);
              return (
                <tr key={m.id}>
                  <td className="num">v{m.version}<div className="faint" style={{ fontSize: 12 }}>{dateTime(m.createdAt)}</div></td>
                  <td>{MODEL_STATUS[m.status]}{m.activatedBy && m.status === 'active' ? <div className="faint" style={{ fontSize: 12 }}>{m.activatedBy}</div> : null}</td>
                  <td className="num" style={{ color: t.recall >= 0.85 ? 'var(--ok)' : 'var(--crit)' }}>{pct(t.recall)}</td>
                  <td className="num">{pct(t.precision)}</td>
                  <td className="num">{t.f1 ?? '–'}</td>
                  <td>{b ? <span className="num">F1 الحالي {b.f1} (v{m.metrics.baseline.version})</span> : <span className="faint">لا يوجد نموذج مفعّل</span>}</td>
                  <td className="num faint" style={{ fontSize: 12 }}>
                    تدريب {m.data?.train?.clips ?? '–'} · تحقق {m.data?.val?.clips ?? '–'} · اختبار {m.data?.test?.clips ?? '–'} مقطع
                  </td>
                  <td className="num">{m.threshold}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {(m.status === 'candidate' || m.status === 'archived') && (
                      <button className={`btn ${meets ? 'primary' : ''}`} onClick={() => activate(m.id)}>{m.status === 'archived' ? 'إرجاع هذا الإصدار' : 'تفعيل'}</button>
                    )}{' '}
                    {m.status === 'candidate' && <button className="btn ghost" onClick={() => api(`/training/models/${m.id}/reject`, { method: 'POST' }).then(load)}>رفض</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!models.length && <div className="empty">لا توجد إصدارات بعد. درّب أول إصدار من تبويب التدريب.</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ rule tuning

function TuningTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [days, setDays] = useState(14);
  const [done, setDone] = useState<Set<string>>(new Set());
  useEffect(() => { api<any[]>(`/tuning/suggestions?days=${days}`).then(setRows); }, [days]);
  const key = (r: any) => `${r.cameraId}:${r.zoneId ?? ''}:${r.param}`;

  async function apply(r: any) {
    await api('/tuning/apply', { method: 'POST', body: { cameraId: r.cameraId, zoneId: r.zoneId ?? undefined, param: r.param, value: r.param === 'allow_lying' ? 1 : r.suggested, type: r.type } });
    setDone((d) => new Set(d).add(key(r)));
  }

  return (
    <div className="stack">
      <div className="panel row" style={{ justifyContent: 'space-between' }}>
        <p className="muted" style={{ margin: 0, maxWidth: '70ch', fontSize: 14 }}>
          إذا رُفض معظم تنبيه معيّن في كاميرا معيّنة بأنه «كشف خاطئ» أو «نشاط طبيعي»، يقترح النظام تخفيف حساسيته في تلك الكاميرا فقط.
          طبّق الاقتراح بنقرة، وراقب أثره في صفحة التقارير.
        </p>
        <div className="seg">{[7, 14, 30].map((d) => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>آخر {d} يوماً</button>)}</div>
      </div>
      <div className="panel" style={{ padding: 0 }}>
        <table className="grid">
          <thead><tr><th>الكاميرا</th><th>التنبيه</th><th>المراجعات</th><th>المقترح</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={key(r)}>
                <td>{r.cameraName}{r.zoneName && <div className="faint" style={{ fontSize: 12 }}>المنطقة: {r.zoneName}</div>}</td>
                <td>{TYPE_LABEL[r.type] ?? r.type}</td>
                <td><span className="num">{r.dismissed}</span> مرفوض من <span className="num">{r.dismissed + r.confirmed}</span> <span className="faint">({pct(r.falseShare)} خاطئ أو طبيعي)</span></td>
                <td>{r.why}: {r.param === 'allow_lying' ? 'تفعيل' : <>من <span className="num">{String(r.current)}</span> إلى <span className="num">{String(r.suggested)}</span></>}</td>
                <td>{done.has(key(r)) ? <span className="muted">طُبّق</span> : <button className="btn" onClick={() => apply(r)}>تطبيق</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="empty">لا توجد اقتراحات: لا يوجد تنبيه يُرفض معظم الوقت في أي كاميرا خلال هذه الفترة.</div>}
      </div>
    </div>
  );
}
