const clients = new Set();
let nextEventId = 1;

function writeEvent(res, event, data) {
  res.write(`id: ${nextEventId++}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function openTaskEventsStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write('retry: 2000\n\n');
  writeEvent(res, 'ready', { ok: true, generatedAt: new Date().toISOString() });

  const client = { res };
  clients.add(client);
  const ping = setInterval(() => {
    if (!res.destroyed) writeEvent(res, 'ping', { generatedAt: new Date().toISOString() });
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

export function publishTaskChange(reason, data = {}) {
  if (clients.size === 0) return;
  const payload = {
    reason,
    generatedAt: new Date().toISOString(),
    ...data,
  };
  for (const client of [...clients]) {
    if (client.res.destroyed) {
      clients.delete(client);
      continue;
    }
    writeEvent(client.res, 'tasks_changed', payload);
  }
}
