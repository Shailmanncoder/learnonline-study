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

// ── Does it actually work? ───────────────────────────────────────
// Being configured and being able to deliver are different things, and the
// difference matters: the AI-tool requirement switches on when email is
// available, so a key that is present but wrong would demand a code that can
// never arrive and lock every account out of every tool.
//
// That is not hypothetical — a placeholder key was pasted into production and
// did exactly that. So the provider is checked once at startup, and until it
// answers, "configured" means nothing to anything that gates on it.
let verified = null;          // null = not checked yet, true/false = answer
let verifying = null;

async function verify() {
    const s = settings();
    if (!s.resendKey && !s.host) { verified = false; return false; }

    // SMTP is not probed: a connection test needs the port open from here and
    // proves little. A Resend key can be checked with one cheap call.
    if (!s.resendKey) { verified = true; return true; }

    try {
        const res = await fetch('https://api.resend.com/domains', {
            headers: { Authorization: `Bearer ${s.resendKey}` },
            signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.error(`[MAIL] Resend rejected the key (${res.status}): ${body.slice(0, 160)}`);
            console.error('[MAIL] Email is treated as unavailable, so nothing will be gated behind a code nobody can receive.');
            verified = false;
            return false;
        }

        // A valid key is not the same as a usable sender. Resend refuses any
        // message from a domain that has not been verified, so checking the
        // key alone would let the requirement switch on while every code
        // still failed to send — the same trap as before, one step further in.
        const domain = (settings().from.split('@')[1] || '').toLowerCase();
        try {
            const list = await res.json();
            const rows = Array.isArray(list) ? list : (list && list.data) || null;
            if (Array.isArray(rows)) {
                const match = rows.find(d => String(d.name || '').toLowerCase() === domain);
                if (!match) {
                    console.error(`[MAIL] ${domain} is not added to this Resend account, so nothing can be sent from ${settings().from}.`);
                    verified = false;
                    return false;
                }
                if (match.status && String(match.status).toLowerCase() !== 'verified') {
                    console.error(`[MAIL] ${domain} is in Resend but its status is "${match.status}" — add the DNS records to finish verifying it.`);
                    verified = false;
                    return false;
                }
            }
            // An unrecognised response shape is not evidence of a problem, so
            // the valid key stands on its own.
        } catch {
            // Same: could not read the list, so judge on the key alone.
        }

        verified = true;
        return true;
    } catch (err) {
        // A network blip at boot should not permanently disable email, but it
        // must not switch the requirement on either. Unknown means off.
        console.error('[MAIL] Could not reach Resend to check the key:', err.message);
        verified = false;
        return false;
    }
}

// Checked once, reused. Callers that cannot await simply see `false` until it
// resolves, which is the safe direction.
function ready() {
    if (verified !== null) return Promise.resolve(verified);
    return (verifying ||= verify());
}

// True only when mail is configured AND the provider has accepted the
// credentials. This is what anything user-facing should gate on.
function isWorking() {
    return isConfigured() && verified === true;
}

// Which route mail is taking, for the operator rather than the student.
function describe() {
    const s = settings();
    const state = verified === null ? ' (not checked yet)' : verified ? '' : ' — REJECTED, email disabled';
    if (s.resendKey) return `Resend API, from ${s.from}${state}`;
    if (s.host) return `SMTP ${s.host}:${s.port}, from ${s.from}${state}`;
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

module.exports = { isConfigured, isWorking, ready, verify, send, settings, describe };
