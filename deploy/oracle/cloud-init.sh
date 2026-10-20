#!/bin/bash
# راصد: الصق هذا الملف كاملاً في Oracle Cloud عند إنشاء السيرفر:
#   Create instance ← Show advanced options ← Management ← Paste cloud-init script
# عدّل السطرين تحت فقط، والباقي يشتغل وحده (20 إلى 30 دقيقة).

ADMIN_PASSWORD='اكتب-هنا-كلمة-مرور-قوية'   # كلمة مرور المسؤول admin، عشرة أحرف أو أكثر (إنجليزي وأرقام)
GITHUB_TOKEN=''                               # فقط إذا كان المستودع خاصاً: مفتاح قراءة من GitHub

REPO=Mohammed-Alfifi/rased
DIR=/opt/rased
exec >> /var/log/rased-install.log 2>&1
set -x
apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q git
if [ -n "$GITHUB_TOKEN" ]; then URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"; else URL="https://github.com/${REPO}.git"; fi
[ -d "$DIR/.git" ] || git clone -q "$URL" "$DIR"
RASED_ADMIN_PASSWORD="$ADMIN_PASSWORD" bash "$DIR/deploy/oracle/install.sh"
