export type ManagedServerState =
  | 'running'
  | 'exited'
  | 'created'
  | 'restarting'
  | 'paused'
  | 'missing'
  | 'reachable'
  | 'unreachable'
  | string;

export type ManagedServerAction = 'start' | 'stop' | 'restart' | 'pull' | 'probe';

export interface ManagedServer {
  id: string;
  name: string;
  type?: 'docker-compose' | 'k3s' | string;
  composeFile?: string;
  composeProfiles?: string[];
  service: string;
  containerName: string;
  image: string;
  runtimeImage: string | null;
  profile?: string;
  host?: string;
  namespace?: string;
  registry?: string;
  description: string;
  state: ManagedServerState;
  status: string;
  ports: string;
  requiresDocker?: boolean;
  buildOnPull?: boolean;
  actions: ManagedServerAction[];
}

export interface ServersResponse {
  servers: ManagedServer[];
  dockerAvailable: boolean;
  error?: string;
}
