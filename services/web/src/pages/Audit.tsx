import { useEffect, useState } from 'react';
import { api } from '../api';
import { dateTime, ROLE_LABEL } from '../labels';

interface Row { id: number; at: string; username: string; role: string; action: string; targetType: string | null; targetId: string | null; details: Record<string, unknown>; ip: string | null }

const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'تسجيل دخول', 'auth.login_failed': 'محاولة دخول فاشلة', 'auth.password_changed': 'تغيير كلمة المرور',
  'event.viewed': 'عرض تنبيه', 'event.reviewed': 'قرار على تنبيه', 'event.review_changed': 'تغيير قرار',
  'clip.viewed': 'مشاهدة مقطع', 'clip.exported': 'تصدير مقطع',
  'user.created': 'إنشاء مستخدم', 'user.updated': 'تعديل مستخدم',
  'camera.created': 'إضافة كاميرا', 'camera.updated': 'تعديل كاميرا', 'camera.deleted': 'حذف كاميرا',
  'zone.created': 'إضافة منطقة رصد', 'zone.updated': 'تعديل منطقة رصد', 'zone.deleted': 'حذف منطقة رصد',
  'area.created': 'إضافة منطقة', 'area.updated': 'تعديل منطقة', 'area.deleted': 'حذف منطقة',
  'settings.updated': 'تغيير الإعدادات', 'headcount.run': 'عدّ', 'retention.purged': 'حذف بيانات منتهية المدة',
  'model_eval.uploaded': 'رفع تقرير تقييم النموذج', 'demo.seeded': 'تحميل بيانات تجريبية',
};

const FILTERS = [['', 'الكل'], ['clip', 'المقاطع'], ['event', 'التنبيهات'], ['auth', 'الدخول'], ['settings', 'الإعدادات'], ['user', 'المستخدمون']];

export default function AuditPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [action, setAction] = useState('');
  const [more, setMore] = useState(true);

  const load = (before?: number) =>
    api<Row[]>(`/audit?limit=100${action ? `&action=${action}` : ''}${before ? `&before=${before}` : ''}`).then((r) => {
      setRows((prev) => (before ? [...prev, ...r] : r));
      setMore(r.length === 100);
    });
  useEffect(() => { load(); }, [action]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>سجل التدقيق</h1>
          <p>من شاهد ماذا، ومتى، وما القرار الذي اتخذه. السجل للإضافة فقط: لا يمكن تعديله أو حذفه من أي واجهة.</p>
        </div>
        <div className="seg">
          {FILTERS.map(([k, v]) => <button key={k} className={action === k ? 'on' : ''} onClick={() => setAction(k)}>{v}</button>)}
        </div>
      </div>
      <div className="panel" style={{ padding: 0 }}>
        <table className="grid">
          <thead><tr><th>الوقت</th><th>المستخدم</th><th>الإجراء</th><th>الهدف</th><th>التفاصيل</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>{dateTime(r.at)}</td>
                <td>{r.username}<div className="faint" style={{ fontSize: 12 }}>{ROLE_LABEL[r.role] ?? r.role}{r.ip ? ` · ${r.ip}` : ''}</div></td>
                <td>{ACTION_LABEL[r.action] ?? r.action}</td>
                <td className="num faint" style={{ fontSize: 12 }}>{r.targetType ? `${r.targetType}:${(r.targetId ?? '').slice(0, 8)}` : ''}</td>
                <td className="num faint" dir="ltr" style={{ fontSize: 12, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>
                  {Object.keys(r.details ?? {}).length ? JSON.stringify(r.details) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {more && rows.length > 0 && <div style={{ padding: 12 }}><button className="btn ghost" onClick={() => load(rows[rows.length - 1].id)}>عرض المزيد</button></div>}
      </div>
    </div>
  );
}
