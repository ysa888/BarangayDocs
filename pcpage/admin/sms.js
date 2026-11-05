const TEXTBEE_API_KEY   = 'txb_FzwdbVaNzyYihckj6MgFUKT2QQULGXrM';
const TEXTBEE_DEVICE_ID = '6aeccecd57bff70ef2eab158';

function normalizePH(num) {
  if (!num) return null;
  const n = String(num).replace(/[\s-]/g, '');
  if (n.startsWith('+63')) return n;
  if (n.startsWith('63'))  return '+' + n;
  if (n.startsWith('0'))   return '+63' + n.slice(1);
  return null;
}

export async function sendSMS(phone, message) {
  try {
    const to = normalizePH(phone);
    if (!to) return console.warn('SMS skipped: no valid number');
    const res = await fetch(`https://api.textbee.dev/api/v1/gateway/devices/${TEXTBEE_DEVICE_ID}/send-sms`, {
      method: 'POST',
      headers: { 'x-api-key': TEXTBEE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: [to], message })
    });
    if (!res.ok) console.error('TextBee error:', res.status, await res.text());
  } catch (e) { console.error('SMS failed:', e); }
}