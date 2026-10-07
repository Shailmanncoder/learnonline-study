'use strict';
// ================================================================
// Outbound email
// ----------------------------------------------------------------
// The payment receipts already spoke SMTP through nodemailer with
// PAYMENTS_SMTP_* settings. Rather than invent a second set for password
// resets, this reads those and accepts plain SMTP_* as an alias, so one
// mailbox configured once serves both.
//
// Works with any SMTP provider, including the free tiers: Brevo, Resend,
// Mailjet, or a Gmail account with an app password.
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
        host: read('SMTP_HOST', 'PAYMENTS_SMTP_HOST'),
        port: Number(read('SMTP_PORT', 'PAYMENTS_SMTP_PORT') || 465),
        user: read('SMTP_USER', 'PAYMENTS_SMTP_USER'),
        pass: read('SMTP_PASSWORD', 'PAYMENTS_SMTP_PASSWORD'),
        from: read('EMAIL_FROM', 'PAYMENTS_EMAIL_FROM')
    };
}

// Without a host and a from-address there is nowhere to send and nothing to
// send it as, so the caller must be told rather than silently dropping mail.
function isConfigured() {
    const s = settings();
    return Boolean(s.host && s.from);
}

async function send({ to, subject, text }) {
    const s = settings();
    if (!s.host || !s.from) throw new Error('SMTP is not configured');
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

module.exports = { isConfigured, send, settings };
