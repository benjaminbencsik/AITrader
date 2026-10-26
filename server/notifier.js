'use strict';
// Phone alerts through ntfy (https://ntfy.sh): install the free ntfy app, subscribe to a hard-to-guess topic name,
// and set NTFY_TOPIC to the same name. Anyone who knows the topic can read the alerts, so make it long and random.
// Messages carry symbols and dollar P&L only: no account numbers, keys or balances.

function createNotifier(env = process.env, fetchImpl = fetch, { actions } = {}) {
  const topic = env.NTFY_TOPIC;
  const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const send = async (title, message, { priority = 3, tags = '' } = {}) => {
    if (!topic) return false;
    try {
      const headers = { Title: String(title).replace(/[^\x20-\x7e]/g, ''), Priority: String(priority), Tags: tags };
      // Optional phone buttons ("Pause", "Sell everything"). Built per message so each carries a fresh signed command.
      const act = actions ? await actions().catch(() => null) : null;
      if (act) headers.Actions = act;
      const r = await fetchImpl(`${server}/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers,
        body: String(message),
      });
      return r.ok;
    } catch {
      return false;
    }
  };
  send.enabled = Boolean(topic);
  return send;
}

// Dead-man's switch: ping an external monitor (healthchecks.io, UptimeRobot heartbeat) after each good scan.
// If the pings stop, THEY alert you. A crashed server can't alert on its own.
async function pingHealthcheck(env = process.env, fetchImpl = fetch) {
  if (!env.HEALTHCHECK_URL) return false;
  try {
    const r = await fetchImpl(env.HEALTHCHECK_URL);
    return r.ok;
  } catch {
    return false;
  }
}

module.exports = { createNotifier, pingHealthcheck };
