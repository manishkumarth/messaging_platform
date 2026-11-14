/** Thin fetch wrapper. Always resolves with { ok, status, json } so the UI can show API errors verbatim. */
export async function api(path, { method = 'GET', tenant, body } = {}) {
  try {
    const res = await fetch(path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(tenant ? { 'x-tenant-id': tenant } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: { error: { code: 'NETWORK_ERROR', message: err.message } } };
  }
}

export const newEventId = () => `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
