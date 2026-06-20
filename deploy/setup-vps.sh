#!/usr/bin/env bash
# تثبيت ونشر النظام على VPS أوبنتو/ديبيان جديد (يُشغَّل بصلاحيات root/sudo)
# الاستخدام: sudo bash deploy/setup-vps.sh

set -euo pipefail

APP_DIR="/opt/gateio-autopilot"
APP_USER="gateio"

echo "==> تثبيت Node.js 18 LTS إن لم يكن مثبتاً"
if ! command -v node >/dev/null || [[ "$(node -v)" < "v18" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs
fi

echo "==> إنشاء مستخدم تشغيل غير root (إن لم يوجد)"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

echo "==> نسخ الملفات إلى $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --exclude node_modules --exclude data --exclude .git ./ "$APP_DIR/"
mkdir -p "$APP_DIR/data"

if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "‼️  عدّل القيم في $APP_DIR/.env قبل التشغيل (مفاتيح Gate.io وإعدادات المخاطر)"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> تثبيت الحزم"
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev

echo "==> تثبيت خدمة systemd"
cp deploy/gateio-autopilot.service /etc/systemd/system/gateio-autopilot.service
systemctl daemon-reload
systemctl enable gateio-autopilot
systemctl restart gateio-autopilot

echo "==> تم. تحقق من الحالة بالأمر: systemctl status gateio-autopilot"
echo "==> السجلات: journalctl -u gateio-autopilot -f"
