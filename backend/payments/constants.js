'use strict';
const PAYMENT = Object.freeze(Object.fromEntries(['CREATED','PENDING','PROCESSING','AUTHORIZED','PAID','FAILED','EXPIRED','CANCELLED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED','DISPUTED'].map(s => [s,s])));
const SUBSCRIPTION = Object.freeze(Object.fromEntries(['TRIALING','ACTIVE','PAST_DUE','PAUSED','CANCELLED','EXPIRED'].map(s => [s,s])));
const RISK = Object.freeze({ ALLOW:'ALLOW', REVIEW:'REVIEW', BLOCK:'BLOCK' });
const REFUND = Object.freeze({ PENDING:'PENDING', PROCESSED:'PROCESSED', FAILED:'FAILED' });
const METHODS = ['upi','card','netbanking','bank_transfer','wallet','emi','paylater'];
const FINAL = new Set([PAYMENT.PAID,PAYMENT.REFUND_PENDING,PAYMENT.PARTIALLY_REFUNDED,PAYMENT.REFUNDED,PAYMENT.DISPUTED]);
module.exports = { PAYMENT, SUBSCRIPTION, RISK, REFUND, METHODS, FINAL };
