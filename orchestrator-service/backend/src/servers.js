import { execFile } from 'node:child_process';
import net from 'node:net';

const MANAGED_SERVERS = [
  {
    id: 'albia',
    name: 'Albia',
    type: 'docker-compose',
    composeFile: 'server/docker-compose.yml',
    service: 'albia',
    containerName: 'albia',
    image: process.env.ALBIA_RUNTIME_IMAGE || 'server-albia:latest',
    buildOnPull: true,
    description: 'Отдельный Docker-сервер Albia, запускается из compose-профиля servers.',
  },
  {
    id: 'ps-prod-k3s',
    name: 'PS prod k3s',
    type: 'k3s',
    host: '192.168.1.122',
    namespace: 'ps-prod',
    registry: '192.168.1.122:5000',
    description: 'Linux-сервер production-деплоя PS: k3s namespace ps-prod, registry 192.168.1.122:5000.',
  },
  {
    id: 'server-pxe-dnsmasq',
    name: 'Server PXE dnsmasq',
    type: 'docker-compose',
    composeFile: 'server/docker-compose.yml',
    service: 'dnsmasq',
    containerName: 'server-dnsmasq',
    image: 'server-dnsmasq:latest',
    description: 'DHCP, PXE and TFTP service for provisioning clean servers from the LAN.',
    buildOnPull: true,
  },
  {
    id: 'server-pxe-nginx',
    name: 'Server PXE nginx',
    type: 'docker-compose',
    composeFile: 'server/docker-compose.yml',
    service: 'nginx',
    containerName: 'server-nginx',
    image: 'nginx:1.27-alpine',
    description: 'HTTP server for iPXE script, Ubuntu ISO/casper files, autoinstall seed and firstboot script.',
  },
  {
    id: 'server-registry',
    name: 'Server registry',
    type: 'docker-compose',
    composeFile: 'server/docker-compose.yml',
    composeProfiles: ['registry'],
    service: 'registry',
    containerName: 'server-registry',
    image: 'registry:2',
    description: 'Локальный Docker registry :5000 для образов Albia и прод-деплоя в k3s.',
  },
  {
    id: 'server-netbootxyz',
    name: 'Server netboot.xyz',
    type: 'docker-compose',
    composeFile: 'server/docker-compose.yml',
    composeProfiles: ['netbootxyz'],
    service: 'netbootxyz',
    containerName: 'server-netbootxyz',
    image: 'lscr.io/linuxserver/netbootxyz:latest',
    description: 'Optional netboot.xyz service for manual network boot utilities and installers.',
  },
];

function httpError(statusCode, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (extra) Object.assign(error, extra);
  return error;
}

function runDocker(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !allowFailure) {
        const code = err.code === 'ENOENT' ? 'docker_cli_unavailable' : 'docker_command_failed';
        const message = stderr?.trim() || err.message || code;
        reject(httpError(err.code === 'ENOENT' ? 503 : 502, code, { code, detail: message }));
        return;
      }
      resolve({ ok: !err, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function composeArgs(server, args) {
  const out = ['compose'];
  if (server.composeFile) out.push('--env-file', '.env');
  for (const profile of server.composeProfiles || []) {
    out.push('--profile', profile);
  }
  if (server.composeFile) out.push('-f', server.composeFile);
  out.push(...args);
  return out;
}

function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function parsePsLine(line) {
  const parts = line.split('\t');
  if (parts.length < 5) return null;
  return {
    name: parts[0],
    image: parts[1],
    state: parts[2],
    status: parts[3],
    ports: parts[4],
  };
}

function mapDockerServer(server, runtime) {
  const state = runtime?.state || 'missing';
  return {
    ...server,
    state,
    status: runtime?.status || (state === 'missing' ? 'Контейнер не создан' : ''),
    runtimeImage: runtime?.image || null,
    ports: runtime?.ports || '',
    requiresDocker: true,
    actions: ['start', 'stop', 'restart', 'pull'],
  };
}

async function mapK3sServer(server) {
  const [api, ssh, registry] = await Promise.all([
    probeTcp(server.host, 6443),
    probeTcp(server.host, 22),
    probeTcp(server.host, 5000),
  ]);
  const reachable = api || ssh || registry;
  return {
    ...server,
    service: server.namespace,
    containerName: '',
    image: server.registry,
    runtimeImage: null,
    state: reachable ? 'reachable' : 'unreachable',
    status: [
      `k3s api :6443 ${api ? 'доступен' : 'недоступен'}`,
      `ssh :22 ${ssh ? 'доступен' : 'недоступен'}`,
      `registry :5000 ${registry ? 'доступен' : 'недоступен'}`,
    ].join('; '),
    ports: `6443, 22, 5000 на ${server.host}`,
    requiresDocker: false,
    actions: ['probe'],
  };
}

export async function listServers() {
  const dockerServers = MANAGED_SERVERS.filter((server) => server.type === 'docker-compose');
  const externalServers = MANAGED_SERVERS.filter((server) => server.type !== 'docker-compose');
  const result = await runDocker(
    ['ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}'],
    { allowFailure: true },
  );
  if (!result.ok) {
    return {
      servers: [
        ...dockerServers.map((server) => mapDockerServer(server, null)),
        ...(await Promise.all(externalServers.map((server) => mapK3sServer(server)))),
      ],
      dockerAvailable: false,
      error: result.stderr || 'docker_cli_unavailable',
    };
  }

  const rows = new Map();
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const parsed = parsePsLine(line);
    if (parsed) rows.set(parsed.name, parsed);
  }
  return {
    servers: [
      ...dockerServers.map((server) => mapDockerServer(server, rows.get(server.containerName))),
      ...(await Promise.all(externalServers.map((server) => mapK3sServer(server)))),
    ],
    dockerAvailable: true,
  };
}

export async function runServerAction(id, action) {
  const server = MANAGED_SERVERS.find((item) => item.id === id);
  if (!server) throw httpError(404, 'server_not_found', { code: 'server_not_found' });

  const normalized = String(action || '').trim();
  if (server.type === 'k3s') {
    if (normalized !== 'probe') {
      throw httpError(422, 'server_action_invalid', { code: 'server_action_invalid' });
    }
    return listServers();
  }

  if (!['start', 'stop', 'restart', 'pull'].includes(normalized)) {
    throw httpError(422, 'server_action_invalid', { code: 'server_action_invalid' });
  }

  if (normalized === 'pull') {
    if (server.buildOnPull) {
      await runDocker(composeArgs(server, ['build', server.service]));
    } else {
      await runDocker(['pull', server.image]);
    }
  } else if (normalized === 'start') {
    await runDocker(composeArgs(server, ['up', '-d', server.service]));
  } else {
    await runDocker(composeArgs(server, [normalized, server.service]));
  }
  return listServers();
}
