// Добавление мониторов Keenetic Giga (LAN) в Uptime Kuma.
const { io } = require("socket.io-client");

const base = {
  interval: 60, retryInterval: 60, resendInterval: 0, maxretries: 2, timeout: 30,
  upsideDown: false, notificationIDList: {}, httpBodyEncoding: "json",
  method: "GET", body: null, headers: null, accepted_statuscodes: ["200-299"],
  authMethod: "", ignoreTls: false, expiryNotification: false, maxredirects: 10,
  packetSize: 56, proxyId: null, description: null,
};

const monitors = [
  { ...base, type: "ping", name: "Giga (LAN): ping", hostname: "192.168.1.1" },
  { ...base, type: "port", name: "Giga (LAN): telnet (23)", hostname: "192.168.1.1", port: 23 },
  { ...base, type: "http", name: "Giga (LAN): веб (80)", url: "http://192.168.1.1" },
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
