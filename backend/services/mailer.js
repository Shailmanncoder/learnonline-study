'use strict';
// ================================================================
// Outbound email
// ----------------------------------------------------------------
// The payment receipts already spoke SMTP through nodemailer with
// PAYMENTS_SMTP_* settings. Rather than invent a second set for password
// resets, this reads those and accepts plain SMTP_* as an alias, so one
// mailbox configured once serves both.
//
// Two ways out, preferred in this order:
//
//   RESEND_API_KEY  — Resend's HTTP API. Preferred when present: one secret,
//                     no ports to be blocked, and failures come back as a
//                     readable reason rather than an SMTP code.
//   SMTP_*          — any SMTP provider, including Resend's own relay, Brevo,
//                     Mailjet, or Gmail with an app password.
//
// Resend can also be used over SMTP (host smtp.resend.com, user "resend",
// password the API key). The HTTP path is chosen when the key is set because
// it reports what went wrong — an unverified sending domain, most often.
// ================================================================
const read = (...names) => {
    for (const name of names) {
        const value = process.env[name];
        if (value && String(value).trim()) return String(value).trim();
    }
    return '';
};

function settings() {
    return {
        resendKey: read('RESEND_API_KEY'),
        host: read('SMTP_HOST', 'PAYMENTS_SMTP_HOST'),
        port: Number(read('SMTP_PORT', 'PAYMENTS_SMTP_PORT') || 465),
        user: read('SMTP_USER', 'PAYMENTS_SMTP_USER'),
        pass: read('SMTP_PASSWORD', 'PAYMENTS_SMTP_PASSWORD'),
        // The address students see codes come from. Overridable, but defaulted
        // so it is never accidentally left blank — a blank From is the one
        // field that makes the send fail outright.
        from: read('EMAIL_FROM', 'PAYMENTS_EMAIL_FROM') || 'support@shailmanntech.com'
    };
}

// Without a host and a from-address there is nowhere to send and nothing to
// send it as, so the caller must be told rather than silently dropping mail.
function isConfigured() {
    const s = settings();
    // The From address has a default, so it cannot be the thing that proves a
    // working setup — saying "configured" on the strength of a defaulted From
    // would make every code silently vanish. A Resend key or an SMTP host can.
    return Boolean((s.resendKey || s.host) && s.from);
}

// Which route mail is taking, for the operator rather than the student.
function describe() {
    const s = settings();
    if (s.resendKey) return `Resend API, from ${s.from}`;
    if (s.host) return `SMTP ${s.host}:${s.port}, from ${s.from}`;
    return 'not configured';
}

async function send({ to, subject, text }) {
    const s = settings();
    if (!s.resendKey && !s.host) throw new Error('No email provider is configured');
    if (!s.from) throw new Error('No sending address is configured');

    if (s.resendKey) {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${s.resendKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: s.from, to: [to], subject, text }),
            signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) {
            // Resend says WHY in the body — almost always an unverified
            // sending domain. Passing that through saves a long hunt.
            const detail = await res.text().catch(() => '');
            let reason = detail.slice(0, 300);
            try { const j = JSON.parse(detail); reason = j.message || j.error || reason; } catch { /* keep the raw text */ }
            throw new Error(`Resend refused the message (${res.status}): ${reason}`);
        }
        return;
    }

    const transport = require('nodemailer').createTransport({
        host: s.host,
        port: s.port,
        secure: s.port === 465,
        requireTLS: s.port !== 465,
        auth: s.user ? { user: s.user, pass: s.pass } : undefined,
        connectionTimeout: 10000,
        socketTimeout: 15000
    });
    await transport.sendMail({ from: s.from, to, subject, text });
}

module.exports = { isConfigured, send, settings, describe };
