// Notificaciones push al celular de la familia (Web Push con claves VAPID).
// Las claves se generan la primera vez y quedan guardadas en la base.

import webpush from 'web-push';

export function createPush(q, { subject = process.env.VAPID_SUBJECT || 'mailto:tata@example.com' } = {}) {
  let keys = q.get("SELECT value FROM settings WHERE key = 'vapid'");
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else if (keys) keys = JSON.parse(keys.value);
  else {
    keys = webpush.generateVAPIDKeys();
    q.run("INSERT INTO settings (key, value) VALUES ('vapid', ?)", JSON.stringify(keys));
  }
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);

  return {
    publicKey: keys.publicKey,
    subscribe(memberId, sub) {
      q.run(`INSERT INTO push_subs (member_id, endpoint, sub) VALUES (?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET member_id = excluded.member_id, sub = excluded.sub`, memberId, sub.endpoint, JSON.stringify(sub));
    },
    unsubscribe(endpoint) { q.run('DELETE FROM push_subs WHERE endpoint = ?', endpoint); },
    async toMember(memberId, payload) {
      const subs = q.all('SELECT * FROM push_subs WHERE member_id = ?', memberId);
      await Promise.all(subs.map(async s => {
        try {
          await webpush.sendNotification(JSON.parse(s.sub), JSON.stringify(payload), { TTL: 3600, urgency: payload.kind === 'alert' ? 'high' : 'normal' });
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) q.run('DELETE FROM push_subs WHERE id = ?', s.id);
          else console.error('push', e.statusCode || e.message);
        }
      }));
    }
  };
}
