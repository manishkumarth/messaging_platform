import { useCallback, useEffect, useState } from 'react';
import { api, newEventId } from './api.js';

const STATUSES = ['SENT', 'DELIVERED', 'READ', 'FAILED'];

function Badge({ status }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

function JsonBox({ result }) {
  if (!result) return null;
  return (
    <pre className={`json ${result.ok ? 'ok' : 'err'}`}>
      HTTP {result.status || 'ERR'}
      {'\n'}
      {JSON.stringify(result.json, null, 2)}
    </pre>
  );
}

function Health() {
  const [state, setState] = useState('checking');
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const r = await api('/health');
      if (alive) setState(r.ok ? 'up' : 'down');
    };
    check();
    const t = setInterval(check, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return <span className={`pill pill-${state}`}>API {state}</span>;
}

function SendMessage({ tenant, conversationId, onCreated }) {
  const [to, setTo] = useState('+919876543210');
  const [text, setText] = useState('Your order has shipped');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const r = await api('/api/v1/messages', {
      method: 'POST',
      tenant,
      body: { tenantId: tenant, conversationId, to, text },
    });
    setResult(r);
    setBusy(false);
    if (r.ok) onCreated(r.json.data);
  };

  return (
    <section className="card">
      <h2>1. Create message</h2>
      <form onSubmit={submit}>
        <label>
          To (E.164)
          <input value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Text
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <button disabled={busy}>{busy ? 'Sending…' : 'POST /messages'}</button>
      </form>
      <JsonBox result={result} />
    </section>
  );
}

function Conversation({ tenant, conversationId, refreshKey, selectedId, onSelect }) {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(null);
  const [limit, setLimit] = useState(5);

  const load = useCallback(
    async (after) => {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (after) qs.set('cursor', after);
      const r = await api(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?${qs}`, { tenant });
      if (!r.ok) {
        setError(r.json?.error?.message ?? 'Request failed');
        return;
      }
      setError(null);
      setItems((prev) => (after ? [...prev, ...r.json.data] : r.json.data));
      setCursor(r.json.pagination.nextCursor);
      setHasMore(r.json.pagination.hasMore);
    },
    [tenant, conversationId, limit],
  );

  useEffect(() => {
    load(null);
  }, [load, refreshKey]);

  return (
    <section className="card">
      <h2>2. Conversation history</h2>
      <div className="row">
        <label className="inline">
          Page size
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[2, 5, 10, 20].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <button className="ghost" onClick={() => load(null)}>
          Refresh
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!error && items.length === 0 && <p className="muted">No messages for this tenant and conversation yet.</p>}
      <ul className="messages">
        {items.map((m) => (
          <li key={m.id} className={m.id === selectedId ? 'selected' : ''} onClick={() => onSelect(m.id)}>
            <div className="msg-top">
              <Badge status={m.status} />
              <code>{m.id.slice(0, 12)}…</code>
            </div>
            <div className="msg-text">{m.text}</div>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button className="ghost" onClick={() => load(cursor)}>
          Load more
        </button>
      )}
    </section>
  );
}

function Timeline({ message }) {
  const rows = [
    ['Created', message.createdAt],
    ['Sent', message.timestamps.sentAt],
    ['Delivered', message.timestamps.deliveredAt],
    ['Read', message.timestamps.readAt],
    ['Failed', message.timestamps.failedAt],
  ];
  return (
    <table className="timeline">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th>{label}</th>
            <td>{value ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WebhookSimulator({ tenant, messageId, setMessageId, onApplied }) {
  const [status, setStatus] = useState('DELIVERED');
  const [eventId, setEventId] = useState(newEventId());
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString());
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState(null);

  const loadMessage = useCallback(async () => {
    if (!messageId) return setMessage(null);
    const r = await api(`/api/v1/messages/${encodeURIComponent(messageId)}`, { tenant });
    setMessage(r.ok ? r.json.data : null);
  }, [messageId, tenant]);

  useEffect(() => {
    loadMessage();
  }, [loadMessage]);

  const send = async () => {
    const r = await api('/api/v1/webhooks/provider', {
      method: 'POST',
      body: { eventId, messageId, status, occurredAt: new Date(occurredAt).toISOString() },
    });
    setResult(r);
    await loadMessage();
    onApplied();
  };

  const sendNew = () => {
    setEventId(newEventId());
    setOccurredAt(new Date().toISOString());
  };

  return (
    <section className="card">
      <h2>3. Provider webhook simulator</h2>
      <label>
        Message ID
        <input value={messageId} onChange={(e) => setMessageId(e.target.value)} placeholder="click a message in the list" />
      </label>
      <div className="grid2">
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Event ID
          <input value={eventId} onChange={(e) => setEventId(e.target.value)} />
        </label>
      </div>
      <label>
        Occurred at (ISO)
        <input value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
      </label>
      <div className="row">
        <button disabled={!messageId} onClick={send}>
          Send event
        </button>
        <button className="ghost" onClick={sendNew}>
          New event ID
        </button>
      </div>
      <p className="hint">
        Press <b>Send event</b> twice without changing the Event ID to see idempotency (<code>duplicate: true</code>).
        Send READ, then SENT, to see an out-of-order event ignored.
      </p>
      <JsonBox result={result} />
      {message && (
        <div className="detail">
          <h3>
            Message <Badge status={message.status} />
          </h3>
          <Timeline message={message} />
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [tenant, setTenant] = useState('tenant-a');
  const [conversationId, setConversationId] = useState('conv-100');
  const [selectedId, setSelectedId] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((k) => k + 1);

  return (
    <div className="app">
      <header>
        <div>
          <h1>Messaging Console</h1>
          <p className="muted">Multi-tenant messaging API · idempotent provider webhooks</p>
        </div>
        <Health />
      </header>

      <section className="card scope">
        <label>
          Tenant (sent as <code>x-tenant-id</code>)
          <input value={tenant} onChange={(e) => setTenant(e.target.value)} />
        </label>
        <label>
          Conversation ID
          <input value={conversationId} onChange={(e) => setConversationId(e.target.value)} />
        </label>
        <p className="hint">
          Switch the tenant to see isolation: another tenant sees an empty history and gets a 404 for these message IDs.
        </p>
      </section>

      <main>
        <SendMessage
          tenant={tenant}
          conversationId={conversationId}
          onCreated={(m) => {
            setSelectedId(m.id);
            refresh();
          }}
        />
        <Conversation
          tenant={tenant}
          conversationId={conversationId}
          refreshKey={refreshKey}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        <WebhookSimulator tenant={tenant} messageId={selectedId} setMessageId={setSelectedId} onApplied={refresh} />
      </main>
    </div>
  );
}
