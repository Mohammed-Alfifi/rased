export const TYPE_LABEL: Record<string, string> = {
  fight: 'عراك',
  person_down: 'شخص ساقط على الأرض',
  perimeter_breach: 'اقتراب من السور',
  restricted_zone: 'دخول منطقة محظورة',
  gathering: 'تجمّع غير معتاد',
  camera_tamper: 'عبث بالكاميرا',
  camera_offline: 'انقطاع الكاميرا',
  running: 'ركض',
  abandoned_object: 'غرض متروك',
  prolonged_inactivity: 'خمول طويل',
  count_mismatch: 'فرق في العدّ',
};

export const SEVERITY_LABEL: Record<string, string> = { critical: 'حرج', high: 'عالٍ', medium: 'متوسط', low: 'منخفض' };
export const STATUS_LABEL: Record<string, string> = { new: 'بانتظار المراجعة', confirmed: 'مؤكَّد', dismissed: 'مرفوض' };
export const REASON_LABEL: Record<string, string> = {
  false_detection: 'كشف خاطئ',
  normal_activity: 'نشاط طبيعي',
  duplicate: 'تنبيه مكرر',
  camera_issue: 'مشكلة في الكاميرا',
  other: 'سبب آخر',
};
export const ROLE_LABEL: Record<string, string> = { operator: 'مشغّل', supervisor: 'مشرف', manager: 'مدير', admin: 'مسؤول النظام' };
export const ZONE_KIND_LABEL: Record<string, string> = {
  general: 'عامة', restricted: 'محظورة', perimeter: 'سور', visit: 'زيارات', count: 'عدّ',
};
export const TAMPER_LABEL: Record<string, string> = { covered: 'العدسة مغطاة', blurred: 'الصورة مشوشة', moved: 'الكاميرا حُرّكت' };

const rtf = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' });
export function ago(iso: string | number | Date): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'الآن';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

const timeFmt = new Intl.DateTimeFormat('ar-SA-u-nu-latn', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });
const dateTimeFmt = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Riyadh',
});
export const time = (d: string | Date) => timeFmt.format(new Date(d));
export const dateTime = (d: string | Date) => dateTimeFmt.format(new Date(d));

/** Area tension 0..100 on the heat scale (cool steel -> amber -> red). */
export function heat(t: number | null | undefined): string {
  if (t === null || t === undefined) return '#2a3946';
  const stops = [[47, 93, 110], [201, 162, 74], [224, 97, 79]];
  const x = Math.max(0, Math.min(1, t / 100)) * 2;
  const i = Math.min(1, Math.floor(x));
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c.join(',')})`;
}

export function tensionWord(t: number | null | undefined): string {
  if (t === null || t === undefined) return 'لا توجد بيانات';
  if (t >= 70) return 'مرتفع';
  if (t >= 40) return 'متوسط';
  return 'هادئ';
}
