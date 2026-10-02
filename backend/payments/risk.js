'use strict';
const {db,audit}=require('./store');
const {id}=require('./config');
const {RISK}=require('./constants');
const positive=(key,fallback)=>{const n=Number(process.env[key]);return Number.isFinite(n)&&n>0?n:fallback;};
async function assess(order,extra=[]) {
 const now=Date.now(),since=now-3600000;
 const [attempts,devices,ips,refunds,user]=await Promise.all([
  db.get('SELECT COUNT(*) n, SUM(CASE WHEN status=\'FAILED\' THEN 1 ELSE 0 END) failures FROM payment_attempts WHERE user_id=? AND mode=? AND created_at>?',[order.user_id,order.mode,since]),
  db.get('SELECT COUNT(DISTINCT user_id) n FROM payment_orders WHERE device_hash=? AND mode=? AND created_at>?',[order.device_hash,order.mode,since]),
  db.get('SELECT COUNT(*) n FROM payment_orders WHERE ip_hash=? AND mode=? AND created_at>?',[order.ip_hash,order.mode,since]),
  db.get('SELECT COUNT(*) n FROM payment_refunds r JOIN payment_orders o ON o.id=r.order_id WHERE o.user_id=? AND o.mode=? AND r.created_at>?',[order.user_id,order.mode,now-30*86400000]),
  db.get('SELECT created_at FROM users WHERE id=?',[order.user_id])
 ]);
 const rules=[...extra];
 if(attempts.n>=positive('PAYMENTS_RISK_ATTEMPTS',12))rules.push(['attempt_velocity',65]);
 if(attempts.failures>=positive('PAYMENTS_RISK_FAILURES',5))rules.push(['repeated_failures',55]);
 if(order.device_hash && devices.n>=positive('PAYMENTS_RISK_DEVICE_ACCOUNTS',4))rules.push(['multiple_device_accounts',45]);
 // School networks share public IPs, so IP alone must not block a learner.
 if(ips.n>=positive('PAYMENTS_RISK_IP_ORDERS',40))rules.push(['ip_velocity',25]);
 if(order.amount>=positive('PAYMENTS_RISK_HIGH_AMOUNT',1000000))rules.push(['high_amount',60]);
 if(refunds.n>=positive('PAYMENTS_RISK_REFUNDS',4))rules.push(['refund_velocity',50]);
 const created=Date.parse(String(user?.created_at || '').replace(' ','T')+'Z');
 if(Number.isFinite(created) && now-created<300000)rules.push(['new_account',10]);
 const score=Math.min(100,rules.reduce((n,r)=>n+r[1],0)),decision=score>=90?RISK.BLOCK:score>=50?RISK.REVIEW:RISK.ALLOW;
 await db.run('INSERT INTO payment_risk_assessments (id,order_id,score,decision,rules,created_at) VALUES (?,?,?,?,?,?)',[id('rsk'),order.id,score,decision,JSON.stringify(rules.map(r=>r[0])),now]);
 await audit(null,'RISK_ASSESSED',order.id,{score,decision},order.mode);
 return {score,decision};
}
module.exports={assess};
