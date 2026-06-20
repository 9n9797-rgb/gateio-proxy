# Gate.io AI Trading Autopilot (Multi-User)

منصة تداول آلي على Gate.io: كل مستخدم يسجّل دخوله برمز يُرسل لبريده (بدون
كلمة مرور)، يربط مفاتيح Gate.io الخاصة به (تُشفّر قبل الحفظ)، ويختار إما
تلقي "توصيات" يقرر تنفيذها بنفسه، أو تفعيل التداول الآلي الكامل. محرك
القرار يتعلّم من نتائج صفقات كل مستخدم على حدة، مع شبكة أمان ثابتة (إدارة
مخاطر) لا يمكن للذكاء الصناعي تجاوزها بغض النظر عن "ثقته" بالقرار.

## تسجيل الدخول (بدون كلمة مرور)

```
POST /auth/request-code   { "email": "you@example.com" }   # يرسل رمز 6 أرقام
POST /auth/verify-code    { "email": "...", "code": "123456" }  # يرجع token
```
استخدم `Authorization: Bearer <token>` في كل الطلبات التالية.

⚠️ بدون ضبط `SMTP_HOST/SMTP_USER/SMTP_PASS` في `.env`، يُطبع الرمز في سجل
الخادم فقط (Console) — هذا للتجربة المحلية ولا يصلح للإنتاج لأن أي شخص
يقرأ السجلات سيرى رموز دخول الجميع. لإنتاج حقيقي اضبط بيانات SMTP فعلية
(مثل Gmail App Password أو خدمة بريد معاملات مثل Resend/SendGrid).

## ربط حساب Gate.io الخاص بالمستخدم

```
POST /account/exchange-keys   { "api_key": "...", "api_secret": "..." }
GET  /account/exchange-keys/status
DELETE /account/exchange-keys
```
المفاتيح تُشفّر بـ AES-256-GCM قبل الحفظ في قاعدة البيانات، ولا تُفكّ إلا
لحظة تنفيذ أمر حقيقي على Gate.io. **لازم** ضبط `APP_ENCRYPTION_KEY` في
`.env` (أنشئه بـ `openssl rand -hex 32`) قبل استخدام هذه الميزة.

## إعدادات الأوتوبايلوت لكل مستخدم

```
POST /autopilot/settings
{ "execution": "paper", "decision_mode": "recommend_only", "pairs": ["BTC_USDT","ETH_USDT"] }
```

| الحقل | القيم | الوصف |
|---|---|---|
| `execution` | `off` \| `paper` \| `live` | وضع التنفيذ: متوقف، محفظة وهمية، أو حساب حقيقي |
| `decision_mode` | `recommend_only` \| `auto` | توصيات فقط (تقرر بنفسك)، أو تداول تلقائي كامل |

- وضع `live` معطّل على مستوى الخادم بالكامل ما لم تضبط `AUTOPILOT_ALLOW_LIVE=true`
  عمداً في `.env`، **و** يتطلب أن يكون المستخدم قد ربط مفاتيحه أولاً.
- وقف الخسارة وجني الربح يُنفَّذان تلقائياً دائماً لحماية رأس المال، حتى في
  وضع `recommend_only` — فقط فتح صفقات جديدة والإغلاق العادي يحتاج تأكيدك.

## كيف "يتعلّم" النظام من أخطائه

كل مؤشر فني (RSI, MACD, الاتجاه, OBV) له وزن مستقل **لكل مستخدم** في
`lib/strategy.js`. عند إغلاق أي صفقة، تُحدَّث الأوزان تلقائياً: المؤشرات
التي أعطت إشارة صحيحة في صفقة رابحة يزيد وزنها، والتي تسببت بخسارة يقل
وزنها — فيتفادى النظام تدريجياً أنماط الإشارات التي خذلته سابقاً مع هذا
المستخدم وهذا الزوج.

**ذاكرة الأخطاء البرمجية (تعمل دائماً، بدون أي اعتماد على نموذج لغوي):**
في كل تحليل، يقارن `lib/strategy.js` نمط أصوات المؤشرات الحالي (متجه RSI/
MACD/الاتجاه/OBV) بأنماط الأصوات التي رافقت آخر صفقات خاسرة لهذا المستخدم
على هذا الزوج (مسافة إقليدية بين المتجهين). كل ما زاد التشابه مع خطأ سابق،
يُخفَّف القرار تلقائياً نحو "انتظار" (HOLD) بدل تكرار نفس الخطأ — وتُعرض هذه
النسبة (`mistake_risk`) وعدد الحالات المشابهة في صفحة `/app/analyze.html`
وفي استجابة `GET /autopilot/analyze/:pair`. إن أضفت `OPENAI_API_KEY` يضيف
نموذج لغوي طبقة تفسير/تأكيد فوق هذا القرار الكمّي، ويُطلَع أيضاً على تحذير
ذاكرة الأخطاء هذه ليكون أكثر تحفّظاً عند التشابه مع أخطاء سابقة.

## التوصيات (Recommendations)

لمن اختار `recommend_only`: كل إشارة شراء/بيع تُسجَّل كتوصية معلّقة بدلاً
من تنفيذها مباشرة.

```
GET  /autopilot/recommendations?status=pending
POST /autopilot/recommendations/:id/execute
POST /autopilot/recommendations/:id/dismiss
```

## واجهة الاستخدام (متعددة الصفحات)

بعد تشغيل الخادم، افتح `/app/login.html` في المتصفح:

```
/app/login.html      تسجيل الدخول (بريد → رمز → جلسة)
/app/dashboard.html  الحالة، المراكز، التوصيات المعلّقة، الأوزان المتعلَّمة، آخر الصفقات
/app/settings.html   ربط مفاتيح Gate.io، وضع التنفيذ/القرار، الأزواج المتابَعة
/app/analyze.html    تحليل فوري لأي زوج بأوزانك الشخصية + تنفيذ مباشر
```

صفحة التحليل تستخدم نقطتين جديدتين تعتمدان على محرك القرار نفسه المستخدم في
الأوتوبايلوت (بنفس الأوزان المتعلَّمة لكل مستخدم):

```
GET  /autopilot/analyze/:pair            # تحليل كامل: مؤشرات + أصوات + قرار + رسم بياني
POST /autopilot/analyze/:pair/execute    # تحليل فوري + تنفيذ القرار مباشرة حسب وضعك الحالي
```

## نقاط أخرى

```
GET  /autopilot/status        # الوضع الحالي والمراكز المفتوحة
GET  /autopilot/portfolio     # المحفظة الوهمية: سيولة/مراكز/ربح-خسارة
POST /autopilot/portfolio/reset
GET  /autopilot/trades?limit=50
GET  /autopilot/weights       # أوزان المؤشرات المتعلَّمة لهذا المستخدم
POST /autopilot/weights/reset
```

نقاط `/proxy/*` الأصلية (الأرصدة، الأوامر، التحليل) ما زالت تعمل كما هي
وتستخدم `GATEIO_API_KEY/GATEIO_API_SECRET` العامين في `.env` — هذه منفصلة
تماماً عن نظام المستخدمين المتعددين وتخدم الاستخدام الشخصي السابق (مثل
ربط GPT Actions بحسابك أنت فقط).

## التشغيل محلياً

```bash
cp .env.example .env   # عدّل القيم، وأهمها APP_ENCRYPTION_KEY
npm install
npm start
```

## النشر على VPS

### الطريقة 1: Docker (الأسهل)
```bash
cp .env.example .env   # عدّل القيم
docker compose up -d --build
```

### الطريقة 2: سكربت تثبيت جاهز (Ubuntu/Debian)
```bash
sudo bash deploy/setup-vps.sh
```
يثبّت Node.js، ينسخ المشروع إلى `/opt/gateio-autopilot`، ويشغّله كخدمة
systemd دائمة (`gateio-autopilot.service`) تعمل تلقائياً بعد كل إعادة إقلاع.

### الطريقة 3: PM2
```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

قاعدة البيانات (SQLite) ومفاتيح/صفقات المستخدمين تُخزَّن في `data/app.db`
— احرص على نسخها احتياطياً بشكل دوري على أي VPS تنشر عليه.
