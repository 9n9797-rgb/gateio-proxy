// تشغيل بدون Docker عبر PM2: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "gateio-autopilot",
      script: "server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000
      // ملاحظة: server.js يحمّل .env تلقائياً عبر dotenv، لا حاجة لتمريره هنا
    }
  ]
};
