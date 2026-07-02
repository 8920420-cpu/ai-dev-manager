export function createHttpDispatch({ endpoint, token = '', fetchImpl = fetch }) {
  if (!endpoint) throw new Error('Scanner endpoint is required');
  return async (payload) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Orchestrator returned ${response.status}: ${body}`);
    return body ? JSON.parse(body) : {};
  };
}
