// Giga перешёл на SSH: удалить монитор telnet (id=7), добавить SSH (22).
const { io } = require("socket.io-client");

const base = {
  interval: 60, retryInterval: 60, resendInterval: 0, maxretries: 2, timeout: 30,
  upsideDown: false, notificationIDList: {}, httpBodyEncoding: "json",
  method: "GET", body: null, headers: null, accepted_statuscodes: ["200-299"],
  authMethod: "", ignoreTls: false, expiryNotification: false, maxredirects: 10,
  packetSize: 56, proxyId: null, description: null,
};

const socket = io("http://localhost:4232", { transports: ["websocket"] });
const emit = (ev, ...args) => new Promise((res) => socket.emit(ev, ...args, (r) => res(r)));

socket.on("connect", async () => {
  const login = await emit("login", { username: "admin", password: process.env.KUMA_PASS, token: "" });
  if (!login.ok) { console.error("LOGIN FAILED:", JSON.stringify(login)); process.exit(1); }
  const del = await emit("deleteMonitor", 7);
  console.log("delete telnet monitor:", JSON.stringify(del));
  const add = await emit("add", { ...base, type: "port", name: "Giga (LAN): SSH (22)", hostname: "192.168.1.1", port: 22 });
  console.log("add ssh monitor:", add.ok ? `ok (id=${add.monitorID})` : JSON.stringify(add));
  process.exit(0);
});
socket.on("connect_error", (e) => { console.error("connect_error:", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 60000);
