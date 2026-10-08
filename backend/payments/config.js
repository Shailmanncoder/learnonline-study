'use strict';
const { createHmac, timingSafeEqual, randomUUID } = require('node:crypto');
const { getJwtSecret } = require('../config/security');
// Prices in paise. What each tier GRANTS lives in services/entitlements.js;
// this file owns only what is billed. The two are joined by the plan id.
const everyone = ['student','teacher','admin','developer'];
const plans = Object.freeze({
    starter: { id:'starter', name:'Starter', amount:49900, currency:'INR', interval:'month', role:'student', roles:everyone, tier:'starter',
        features:['10 core AI tools','AI Companion with memory','Detailed answers and study plans','1,200 credits a month'] },
    plus:    { id:'plus',    name:'Plus',    amount:79900, currency:'INR', interval:'month', role:'student', roles:everyone, tier:'plus',
        features:['25 AI tools','Everything in Starter','PDF, image and video summarising','12,000 credits a month — 10x Starter'] },
    pro:     { id:'pro',     name:'Pro',     amount:99900, currency:'INR', interval:'month', role:'student', roles:everyone, tier:'pro',
        features:['All 50 AI tools','Everything in Plus','Exam prep, roadmaps and the Developer Hub','24,000 credits a month — 20x Starter'] },
    max:     { id:'max',     name:'Max',     amount:149900, currency:'INR', interval:'month', role:'student', roles:everyone, tier:'max',
        features:['All 50 AI tools and every feature','Priority routing — the strongest model, first in the queue','48,000 credits a month','Highest limits on uploads and generation'] }
});
class PaymentError extends Error { constructor(status, message, code='PAYMENT_ERROR') { super(message); this.status=status; this.code=code; } }
function fail(status, message, code) { throw new PaymentError(status,message,code); }
function config() {
    const mode = process.env.PAYMENTS_MODE || 'test';
    const enabled = mode === 'test' ? process.env.NODE_ENV !== 'production' || process.env.PAYMENTS_TEST_ENABLED === 'true'
        : mode === 'live' && process.env.PAYMENTS_LIVE_ENABLED === 'true' && /^rzp_live_/.test(process.env.RAZORPAY_KEY_ID || '') && !!process.env.RAZORPAY_KEY_SECRET && !!process.env.RAZORPAY_WEBHOOK_SECRET && !!process.env.PAYMENTS_SELLER_NAME && /^https:\/\//.test(process.env.PAYMENTS_PUBLIC_URL || '') && process.env.PAYMENTS_TERMS_APPROVED === 'true';
    const taxBps = Number(process.env.PAYMENTS_TAX_BPS || 0);
    if (!['test','live'].includes(mode) || !Number.isInteger(taxBps) || taxBps < 0 || taxBps > 3000) fail(503,'Payment configuration needs attention.');
    // "test" mode has TWO distinct meanings and conflating them would let a
    // local simulation be reported as a gateway-tested transaction:
    //   • local simulator  — no network call, no Razorpay involvement at all.
    //   • Razorpay Test Mode — real calls to api.razorpay.com with rzp_test_
    //     credentials, real signature verification, real webhooks.
    // The provider is chosen by whether genuine rzp_test_ credentials exist,
    // and `simulated` is surfaced so every screen and receipt can say which
    // one actually processed the payment.
    const hasRazorpayTest = /^rzp_test_/.test(process.env.RAZORPAY_KEY_ID || '') && !!process.env.RAZORPAY_KEY_SECRET;
    const provider = mode === 'live' ? 'razorpay' : (hasRazorpayTest ? 'razorpay' : 'sandbox');
    return { mode, enabled:!!enabled && (taxBps === 0 || !!process.env.PAYMENTS_GSTIN), provider, taxBps,
        simulated: provider === 'sandbox',
        environmentLabel: mode === 'live' ? 'Razorpay Live'
            : provider === 'razorpay' ? 'Razorpay Test Mode'
            : 'Local simulator — not connected to Razorpay',
        seller: { name:process.env.PAYMENTS_SELLER_NAME || 'LearnOnline.study', address:process.env.PAYMENTS_SELLER_ADDRESS || '', gstin:process.env.PAYMENTS_GSTIN || '', support:process.env.PAYMENTS_SUPPORT_EMAIL || 'support@learnonline.study' },
        sessionMs:300000, orderMs:1800000,
        emailEnabled: !!(process.env.PAYMENTS_SMTP_HOST && process.env.PAYMENTS_EMAIL_FROM),
        renewal:'manual', // No mandate is collected; never imply automatic charging.
    };
}
function assertEnabled() { const c=config(); if (!c.enabled) fail(503,'Checkout is not enabled yet. Your account has not been charged.','PAYMENTS_DISABLED'); return c; }
function admin(user) { return !!user && String(process.env.PAYMENTS_ADMIN_IDS || '').split(',').map(s=>s.trim()).includes(String(user.id)); }
function id(prefix) { return `${prefix}_${randomUUID().replace(/-/g,'')}`; }
function hmac(value, secret=getJwtSecret()) { return createHmac('sha256',secret).update(value).digest('hex'); }
function equal(a,b) { return typeof a==='string' && typeof b==='string' && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b)); }
function key(value) { if (typeof value!=='string' || !/^[a-zA-Z0-9_-]{10,90}$/.test(value)) fail(400,'A valid idempotency key is required.'); return value; }
function clean(value,max=160) { return typeof value==='string' ? value.trim().slice(0,max) : ''; }
function price(planId,coupon='') {
    const plan=typeof planId==='string'&&Object.hasOwn(plans,planId)?plans[planId]:null; if(!plan) fail(400,'Choose an available Plus plan.');
    const c=config(), code=clean(coupon,40).toUpperCase(); let discount=0;
    if(code) {
        let coupons; try { coupons=JSON.parse(process.env.PAYMENTS_COUPONS_JSON || '{}'); } catch { fail(503,'Coupon configuration is unavailable.'); }
        const rule=coupons[code] || (c.mode==='test' && code==='TEST10' ? {percent:10}:null);
        if(!rule || !Number.isInteger(rule.percent) || rule.percent < 1 || rule.percent > 90 || (rule.expiresAt && Date.parse(rule.expiresAt)<Date.now()) || (rule.plan && rule.plan!==planId)) fail(400,'This coupon is invalid or has expired.');
        discount=Math.round(plan.amount*rule.percent/100);
    }
    // Published prices include configured tax. This prevents surprise surcharges.
    const total=plan.amount-discount, taxable=Math.round(total*10000/(10000+c.taxBps)), tax=total-taxable;
    return {planId, productName:plan.name, subtotal:plan.amount, discount, tax, total, currency:plan.currency, coupon:code, taxBps:c.taxBps, taxIncluded:true};
}
module.exports={plans,config,assertEnabled,admin,id,hmac,equal,key,clean,price,fail,PaymentError};
