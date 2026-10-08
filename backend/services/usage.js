'use strict';
// ================================================================
// Metering
// ----------------------------------------------------------------
// Every paid action passes through here. A plan that is not enforced is not a
// plan, and an unmetered AI endpoint is an open tab at someone else's expense.
//
// The month is a calendar month in UTC. Simple to explain on an invoice, and
// it resets without a scheduled job: a new period is simply a key that has no
// row yet.
// ================================================================
const db = require('../config/db');
const { tierOf, costOf } = require('./entitlements');

let schema;
const ready = () => (schema ||= require('../migrations/005_usage_metering')(db));

const periodOf = (at = Date.now()) => new Date(at).toISOString().slice(0, 7); // YYYY-MM

async function usedThisPeriod(userId, period = periodOf()) {
    const row = await db.get(
        'SELECT COALESCE(SUM(credits),0) credits, COALESCE(SUM(calls),0) calls FROM usage_counters WHERE user_id = ? AND period = ?',
        [userId, period]
    );
    return { credits: Number(row?.credits || 0), calls: Number(row?.calls || 0) };
}

// What the person has left, and what their plan is. Used by the meter on
// screen as well as by enforcement, so both always agree.
async function balance(userId, planId) {
    await ready();
    const tier = tierOf(planId);
    const period = periodOf();
    const { credits, calls } = await usedThisPeriod(userId, period);
    return {
        plan: tier.id, label: tier.label, period,
        allowance: tier.credits, used: credits, calls,
        remaining: Math.max(0, tier.credits - credits),
        priority: tier.priority
    };
}

class QuotaError extends Error {
    constructor(state) {
        super('You have used this month’s allowance on your current plan.');
        this.status = 402;                  // Payment Required — the honest code
        this.code = 'QUOTA_EXCEEDED';
        this.state = state;
    }
}

// Charged BEFORE the model runs, not after. Charging afterwards means a
// request that fails halfway still cost real tokens but reads as free, and a
// burst of parallel requests all pass the check before any of them records.
async function charge(userId, { kind, depth, units = 1 }) {
    await ready();
    const tier = tierOf(await planOf(userId));
    const cost = costOf(kind, depth) * Math.max(1, units);
    const period = periodOf();

    const { credits } = await usedThisPeriod(userId, period);
    if (credits + cost > tier.credits) {
        throw new QuotaError({ plan: tier.id, allowance: tier.credits, used: credits, needed: cost });
    }

    const bucket = kind || depth || 'normal';
    const now = Date.now();
    // UPSERT, written for both dialects: a user making two requests at once
    // must not have one of them silently overwrite the other's count.
    if (db.dialect() === 'mysql') {
        await db.run(
            `INSERT INTO usage_counters (user_id, period, kind, credits, calls, updated_at)
             VALUES (?,?,?,?,1,?)
             ON DUPLICATE KEY UPDATE credits = credits + VALUES(credits), calls = calls + 1, updated_at = VALUES(updated_at)`,
            [userId, period, bucket, cost, now]
        );
    } else {
        await db.run(
            `INSERT INTO usage_counters (user_id, period, kind, credits, calls, updated_at)
             VALUES (?,?,?,?,1,?)
             ON CONFLICT(user_id, period, kind) DO UPDATE SET
                credits = credits + excluded.credits, calls = calls + 1, updated_at = excluded.updated_at`,
            [userId, period, bucket, cost, now]
        );
    }
    return { charged: cost, remaining: Math.max(0, tier.credits - credits - cost) };
}

// A charge for work that never happened is a charge the person did not make.
async function refund(userId, { kind, depth, units = 1 }) {
    await ready();
    const cost = costOf(kind, depth) * Math.max(1, units);
    const bucket = kind || depth || 'normal';
    await db.run(
        `UPDATE usage_counters SET credits = CASE WHEN credits > ? THEN credits - ? ELSE 0 END,
                                   calls = CASE WHEN calls > 0 THEN calls - 1 ELSE 0 END
         WHERE user_id = ? AND period = ? AND kind = ?`,
        [cost, cost, userId, periodOf(), bucket]
    );
}

// The active paid plan, or 'free'. Read from the entitlement the payment
// pipeline writes, never from anything the client can set.
async function planOf(userId) {
    try {
        const mode = process.env.PAYMENTS_MODE || 'test';
        const row = await db.get(
            'SELECT plan_id FROM payment_entitlements WHERE user_id=? AND mode=? AND revoked=0 AND ends_at>? ORDER BY ends_at DESC LIMIT 1',
            [userId, mode, Date.now()]
        );
        return row?.plan_id || 'free';
    } catch {
        // No payments schema yet (fresh database, tests): everyone is free.
        return 'free';
    }
}

module.exports = { ready, charge, refund, balance, planOf, periodOf, usedThisPeriod, QuotaError };
