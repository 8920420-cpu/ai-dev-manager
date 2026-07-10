// Настройка Uptime Kuma через socket.io API: логин + добавление мониторов.
const { io } = require("socket.io-client");

const URL = "http://localhost:4232";
const USER = "admin";
const PASS = process.env.KUMA_PASS;

// Общая база полей (как шлёт uptime-kuma-api), чтобы не напороться на NOT NULL
const base = {
  interval: 60,
  retryInterval: 60,
  resendInterval: 0,
  maxretries: 2,
  timeout: 30,
  upsideDown: false,
  notificationIDList: {},
  httpBodyEncoding: "json",
  method: "GET",
  body: null,
  headers: null,
  accepted_statuscodes: ["200-299"],
  authMethod: "",
  ignoreTls: false,
  expiryNotification: false,
  maxredirects: 10,
  packetSize: 56,
  proxyId: null,
  description: null,
};

const monitors = [
  { ...base, type: "ping", name: "Каскад: ping", hostname: "kaskadvrn.keenetic.link" },
  { ...base, type: "port", name: "Каскад: SSH (22)", hostname: "kaskadvrn.keenetic.link", port: 22 },
  { ...base, type: "http", name: "Каскад: веб-конфигуратор (443)", url: "https://kaskadvrn.keenetic.link", expiryNotification: true },
  { ...base, type: "http", name: "Маршрутка: Semaphore", url: "http://host.docker.internal:4231/api/ping", interval: 120 },
  { ...base, type: "http", name: "Маршрутка: Oxidized", url: "http://host.docker.internal:4233/nodes.json", interval: 120 },
];

const socket = io(URL, { transports: ["websocket"] });
const emit = (ev, ...args) =>
  new Promise((res) => socket.emit(ev, ...args, (r) => res(r)));

socket.on("connect", async () => {
  const login = await emit("login", { username: USER, password: PASS, token: "" });
  if (!login.ok) { console.error("LOGIN FAILED:", JSON.stringify(login)); process.exit(1); }
  console.log("login: ok");
  for (const m of monitors) {
    const r = await emit("add", m);
    console.log(`add "${m.name}":`, r.ok ? `ok (id=${r.monitorID})` : JSON.stringify(r));
  }
  process.exit(0);
});

socket.on("connect_error", (e) => { console.error("connect_error:", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 60000);
