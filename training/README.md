# التدريب والتقييم وتحسين الأداء

كل الأوامر من جذر المستودع. التدريب يحتاج كرت شاشة NVIDIA، أو Google Colab (المجاني يكفي).

## 1. نموذج العراك

**البيانات:** [RWF-2000](https://github.com/mchengny/RWF2000-Video-Database-for-Violence-Detection) (2000 مقطع من كاميرات مراقبة، نصفها عراك، ومتاحة للبحث بطلب من أصحابها)، ويمكن إضافة مقاطع تمثيلية بنفس التقسيم. لا تستخدم تسجيلات أي منشأة بدون موافقة رسمية.

```
/data/RWF-2000/train/Fight/*.avi   /data/RWF-2000/train/NonFight/*.avi
/data/RWF-2000/val/Fight/*.avi     /data/RWF-2000/val/NonFight/*.avi
```

```bash
pip install -e services/vision torch onnx onnxruntime scikit-learn
scripts/download_models.sh
# استخراج نقاط الجسم ونوافذ 32 إطاراً بمعدل 15 إطاراً في الثانية (أطول خطوة: حوالي ساعة على كرت متوسط)
python training/prepare_fight_data.py --data /data/RWF-2000 --out training/data --device 0
# التدريب والتقييم والتصدير
python training/train_fight.py --data training/data --out training/runs/fight
```

**المخرجات** في `training/runs/fight/`:
- `report.md` و`report.json`: الدقة (Precision)، والاستدعاء (Recall)، وF1، وAUC، ومصفوفة الالتباس، على مستوى النافذة والمقطع.
- `threshold.txt`: الحد المختار، وهو أعلى حد يحقق Recall بنسبة 85% أو أكثر على بيانات التحقق، لتقليل الإنذارات الخاطئة.
- `fight.onnx`: النموذج الذي تحمّله خدمة الرؤية.

**التشغيل:** انسخ `fight.onnx` إلى `deploy/models/`، واضبط `RASED_FIGHT_MODEL=/app/extra-models/fight.onnx`، وضع الحد في إعدادات الكاميرات `{"fight_threshold": 0.xx}`. صفحة الكاميرات تُظهر «نموذج مدرّب» بدلاً من «قواعد». ارفع التقرير ليظهر في مؤشرات النجاح:

```bash
curl -X POST https://rased.local/api/reports/model-eval -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d "{\"fight\": $(cat training/runs/fight/report.json)}"
```

الخصائص (`services/vision/rased_vision/pose_features.py`) مشتركة بين التدريب والتشغيل، فلا يختلف ما يراه النموذج في الحالتين.

## 2. تقييم الخط كاملاً على مقاطع مصنّفة

يقيس ما سيراه المشغّل فعلاً: هل أطلق النظام التنبيه الصحيح لكل مقطع؟ وكم تنبيهاً خاطئاً على المقاطع العادية؟

```
/data/eval/fight/*.mp4   /data/eval/person_down/*.mp4   /data/eval/gathering/*.mp4   /data/eval/normal/*.mp4
```

```bash
python training/evaluate_clips.py --clips /data/eval --out training/runs/eval
```

## 3. ضبط كاشف الأشخاص على بيئة المنشأة (اختياري)

```bash
python training/finetune_yolo.py --data /data/facility-yolo/data.yaml --epochs 50 --device 0
```

النتائج: mAP50، وmAP50-95، والدقة، والاستدعاء، ومصفوفة الالتباس.

## 4. التحويل وقياس السرعة

```bash
python training/export_models.py --format onnx                 # أي جهاز
python training/export_models.py --format engine --half        # كرت NVIDIA مع TensorRT
python training/benchmark.py --video samples/people-1.mp4 \
  --models services/vision/models/yolo11n-pose.pt services/vision/models/yolo11n-pose.onnx services/vision/models/yolo11n-pose.engine
```

قياسنا على معالج من نواتين بدون كرت (640 بكسل):

| النموذج | متوسط الزمن | إطار/ثانية |
| --- | --- | --- |
| yolo11n-pose.pt | 71 ms | 14.1 |
| yolo11n-pose.onnx | 59 ms | 16.8 |

على كرت شاشة مع TensorRT FP16، تكون السرعة أعلى بكثير. القيمة الفعلية تُقاس على خادم المنشأة بنفس الأمر.

## فحص سريع بدون بيانات

```bash
python training/train_fight.py --synthetic --epochs 2 --out /tmp/fight
```

يتحقق أن التدريب والتقييم والتصدير تعمل. أرقامه بلا معنى، والخادم يرفض رفع تقريره.
