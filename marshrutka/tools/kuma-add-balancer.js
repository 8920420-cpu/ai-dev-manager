// Балансировщик Timeweb «Humble Hoopoe» (id 134251, 85.198.81.20) и вход k3s:
// мониторы ping/HTTP на LB + HTTP на оба бэкенда (базовая giga:30080 и VPS:30080).
// Запуск (см. грабли ESM в README): KUMA_PASS=... node kuma-add-balancer.cjs
const { io } = require("socket.io-client");

const base = {
  interval: 60, retryInterval: 60, resendInterval: 0, maxretries: 2, timeout: 30,
  upsideDown: false, notificationIDList: {}, httpBodyEncoding: "json",
  method: "GET", body: null, headers: null, accepted_statuscodes: ["200-299"],
  authMethod: "", ignoreTls: false, expiryNotification: false, maxredirects: 10,
  packetSize: 56, proxyId: null, description: null,
};

const monitors = [
  { ...base, type: "ping", name: "LB Timeweb: ping", hostname: "85.198.81.20" },
  { ...base, type: "http", name: "LB Timeweb: k3s ingress (80/healthz)", url: "http://85.198.81.20/healthz" },
  { ...base, type: "http", name: "k3s вход: базовая (giga 30080)", url: "http://195.98.86.63:30080/healthz" },
  { ...base, type: "http", name: "k3s вход: резерв VPS (30080)", url: "http://72.56.73.96:30080/healthz" },
];

const socket = io("http://localhost:4232", { transports: ["websocket"] });
const emit = (ev, ...args) => new Promise((res) => socket.emit(ev, ...args, (r) => res(r)));

socket.on("connect", async () => {
  const login = await emit("login", { username: "admin", password: process.env.KUMA_PASS, token: "" });
  if (!login.ok) { console.error("LOGIN FAILED:", JSON.stringify(login)); process.exit(1); }
  for (const m of monitors) {
    const r = await emit("add", m);
    console.log(`add "${m.name}":`, r.ok ? `ok (id=${r.monitorID})` : JSON.stringify(r));
  }
  process.exit(0);
});
socket.on("connect_error", (e) => { console.error("connect_error:", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 60000);
