# النشر داخل المنشأة

## الخادم

| البند | المشروع التجريبي (4 إلى 8 كاميرات) |
| --- | --- |
| كرت الشاشة | NVIDIA بذاكرة 16 جيجابايت أو أكثر (مثل RTX 4080 أو A4000) |
| المعالج والذاكرة | 8 أنوية، و64 جيجابايت |
| التخزين | 2 تيرابايت SSD (المقاطع والقاعدة) |
| النظام | Ubuntu 22.04 أو 24.04، وDocker، وNVIDIA Container Toolkit |
| الشبكة | منفذ لشبكة الكاميرات (قراءة RTSP فقط)، ومنفذ لشبكة غرفة التحكم. بدون إنترنت |

بدون كرت شاشة يعمل النظام، لكن بسرعة كاميرا أو كاميرتين فقط (حوالي 14 إطاراً في الثانية لنموذج pose على معالج من 2 نواة في قياسنا).

## الخطوات

```bash
git clone <repo> rased && cd rased
cp deploy/.env.example deploy/.env
# ولّد الأسرار:
for k in RASED_DB_PASSWORD RASED_JWT_SECRET RASED_SERVICE_KEY; do sed -i "s|^$k=.*|$k=$(openssl rand -hex 32)|" deploy/.env; done
# اختر كلمة مرور أولية للمسؤول في RASED_ADMIN_PASSWORD
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.gpu.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f vision
```

المنشأة المعزولة تماماً: ابنِ الصور على جهاز متصل، وانقلها بـ`docker save` ثم `docker load`.

## الكاميرات

1. من «الإعدادات»: أضف المناطق (عنبر، ساحة…) والعدد المتوقع لكل منها.
2. من «الكاميرات»: أضف كل كاميرا برابط RTSP (يُفضّل البث الفرعي بدقة 720p لتخفيف الحمل)، واربطها بمنطقتها وموقعها على الخريطة.
3. ارسم مناطق الرصد لكل كاميرا: «سور»، و«محظورة» مع ساعاتها، و«عدّ» عند الأبواب، و`allow_lying` للأسرّة.
4. خدمة الرؤية تقرأ الإعدادات الجديدة خلال دقيقة، بدون إعادة تشغيل.

## الواجهة عبر TLS

اجعل الخدمة تستمع على `127.0.0.1` (القيمة الافتراضية)، وضع أمامها nginx أو Caddy بشهادة الجهة الداخلية. مثال Caddy:

```
rased.facility.local {
  tls /etc/ssl/rased.crt /etc/ssl/rased.key
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1   # البث المباشر (SSE)
  }
}
```

## تحسين السرعة

```bash
# على خادم الكرت:
python training/export_models.py --format engine --half
# ثم في deploy/.env:
RASED_POSE_MODEL=/app/extra-models/yolo11n-pose.engine
```

قِس النتيجة بـ`training/benchmark.py`، كما في [training/README.md](../training/README.md).

## النسخ الاحتياطي

```bash
docker compose -f deploy/docker-compose.yml exec db pg_dump -U rased rased | gzip > /backup/rased-$(date +%F).sql.gz
```
