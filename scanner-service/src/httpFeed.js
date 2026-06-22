// HTTP-клиент обратного моста: забрать следующую задачу для Claude и, при
// неудаче записи файла, вернуть её в пул. Парный к httpDispatch.js.
export function createHttpFeed({ nextEndpoint, releaseEndpoint, token = '', fetchImpl = fetch }) {
  if (!nextEndpoint) throw new Error('Feeder nextEndpoint is required');
  const headers = () => {
    const h = { 'content-type': 'application/json' };
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  };

  const claimNext = async () => {
    const response = await fetchImpl(nextEndpoint, { method: 'GET', headers: headers() });
    const body = await response.text();
    if (!response.ok) throw new Error(`Orchestrator returned ${response.status}: ${body}`);
    return body ? JSON.parse(body) : { task: null };
  };

  const release = releaseEndpoint
    ? async (taskId) => {
        const response = await fetchImpl(releaseEndpoint, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ taskId }),
        });
        if (!response.ok) throw new Error(`Orchestrator returned ${response.status}: ${await response.text()}`);
      }
    : undefined;

  return { claimNext, release };
}
