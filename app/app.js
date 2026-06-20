// app/app.js — أدوات مشتركة لكل صفحات الواجهة: مصادقة، نداء API، شريط تنقّل، تنسيق أرقام

const API = {
  token() { return localStorage.getItem("token"); },
  setToken(t) { localStorage.setItem("token", t); },
  clear() { localStorage.removeItem("token"); },

  async req(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    const token = this.token();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(path, { ...opts, headers });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }

    if (res.status === 401) {
      this.clear();
      location.href = "/app/login.html";
      throw new Error("الجلسة منتهية، سجّل الدخول مجدداً");
    }
    if (!res.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || `خطأ (${res.status})`);
    }
    return data;
  }
};

function requireAuthPage() {
  if (!API.token()) location.href = "/app/login.html";
}

function formatNum(n) {
  if (n == null || n === "") return "—";
  n = parseFloat(n);
  if (Number.isNaN(n)) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return n.toPrecision(4);
}

function showToast(msg, type = "") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function navBar(active) {
  const items = [
    { id: "dashboard", icon: "🏠", label: "الرئيسية", href: "/app/dashboard.html" },
    { id: "analyze", icon: "📊", label: "تحليل", href: "/app/analyze.html" },
    { id: "settings", icon: "⚙️", label: "الإعدادات", href: "/app/settings.html" },
    { id: "logout", icon: "↩️", label: "خروج", href: "#logout" }
  ];
  const html = items.map(it => `
    <div class="nav-item ${it.id === active ? "active" : ""}" data-href="${it.href}" data-id="${it.id}">
      <span class="nav-icon">${it.icon}</span>
      <span>${it.label}</span>
    </div>
  `).join("");

  const nav = document.createElement("div");
  nav.className = "nav-bottom";
  nav.innerHTML = html;
  document.body.appendChild(nav);

  nav.querySelectorAll(".nav-item").forEach(el => {
    el.addEventListener("click", async () => {
      if (el.dataset.id === "logout") {
        try { await API.req("/auth/logout", { method: "POST" }); } catch (e) {}
        API.clear();
        location.href = "/app/login.html";
      } else {
        location.href = el.dataset.href;
      }
    });
  });
}
