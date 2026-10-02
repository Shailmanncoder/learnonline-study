'use strict';
const {db,ready,lock,audit,notify}=require('./store');
const {config,assertEnabled,plans,price,id,key,clean,fail,hmac,admin}=require('./config');
const {PAYMENT:P,RISK,FINAL,REFUND, SUBSCRIPTION:S}=require('./constants');
const adapter=require('./adapters');
const {assess}=require('./risk');
const now=()=>Date.now();
const orderRow=(orderId,locked=false)=>db.get(`SELECT * FROM payment_orders WHERE id=?${locked?lock():''}`,[orderId]);
function owner(order,user) { if(!order || order.user_id!==user.id)fail(404,'Payment not found.'); if(order.mode!==config().mode)fail(404,'Payment not found in this environment.'); return order; }
function publicOrder(o) {
 const {ip_hash,device_hash,fingerprint,provider_state,risk_decision,idempotency_key,...safe}=o;
 return {...safe,underReview:risk_decision!==RISK.ALLOW && o.status===P.PROCESSING};
}
async function availableMethods() {
 await ready(); const c=config();
 const methods=await db.all('SELECT id,label,enabled FROM payment_methods WHERE mode=?',[c.mode]);
 // Merchant configuration is server-owned. Live availability is confirmed
 // again by hosted checkout; unapproved rails are never presented as active.
 const enabled=new Set((process.env.PAYMENTS_ENABLED_METHODS || 'upi,card,netbanking').split(',').map(s=>s.trim()));
 let banks=[]; try {banks=JSON.parse(process.env.PAYMENTS_BANKS_JSON || '[]');}catch {fail(503,'Bank configuration is unavailable.');}
 if(c.mode==='test' && !banks.length) banks=[{id:'SBIN',name:'State Bank of India'},{id:'HDFC',name:'HDFC Bank'},{id:'ICIC',name:'ICICI Bank'},{id:'UTIB',name:'Axis Bank'},{id:'KKBK',name:'Kotak Mahindra Bank'}];
 banks=banks.filter(b=>b&&/^[A-Za-z0-9_-]{2,20}$/.test(b.id)&&typeof b.name==='string').map(b=>({id:b.id,name:b.name.slice(0,100)}));
 return {methods:methods.map(m=>({...m,enabled:!!m.enabled && c.enabled && (c.mode==='test'||enabled.has(m.id)) && !(c.mode==='live' && m.id==='bank_transfer'),hosted:c.mode==='live'})),banks,upiCollect:false,international:c.mode==='live'&&process.env.PAYMENTS_INTERNATIONAL_ENABLED==='true'};
}
async function catalog(user) {
 const c=config();
 // The catalog drives the whole Plus screen, so it carries two things the UI
 // cannot work without:
 //  • the caller's own subscription, so the page can offer "Manage" instead of
 //    "Upgrade" to someone who already paid;
 //  • which environment actually processes payments, so a local simulation is
 //    never presented as a gateway transaction.
 await ready();
 const subscription = user ? await db.get('SELECT id,plan_id,status,starts_at,ends_at,cancel_at_period_end FROM payment_subscriptions WHERE user_id=? AND mode=?',[user.id,c.mode]) : null;
 const entitlement = user ? await db.get('SELECT plan_id,ends_at FROM payment_entitlements WHERE user_id=? AND mode=? AND revoked=0 AND ends_at>? ORDER BY ends_at DESC LIMIT 1',[user.id,c.mode,now()]) : null;
 return {mode:c.mode,enabled:c.enabled,plans:Object.values(plans),taxBps:c.taxBps,taxIncluded:true,seller:c.seller,renewal:c.renewal,emailEnabled:c.emailEnabled,isAdmin:admin(user),
  provider:c.provider, simulated:c.simulated, environmentLabel:c.environmentLabel,
  subscription: subscription || null,
  entitlement: entitlement || null,
  plusActive: !!entitlement,
  ...(await availableMethods())};
}
async function createOrder(user,input,request={}) {
 await ready(); const c=assertEnabled(),k=key(input.idempotencyKey),q=price(input.planId,input.coupon);
 // Checked against the plan's own list rather than a single role: the student
 // workspace is what a teacher account actually uses day to day, so refusing it
 // Student Plus left that account with the whole app and no way to pay for it.
 const buyers = plans[q.planId].roles || [plans[q.planId].role];
 if(!buyers.includes(user.role))fail(403,`This plan is for a ${plans[q.planId].role} account. Sign in to that workspace to subscribe.`);
 const customerName=clean(input.customerName)||user.username,customerEmail=clean(input.customerEmail,254);
 if(customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))fail(400,'Enter a valid receipt email.');
 if(input.acceptedTerms!==true)fail(400,'Please accept the payment terms.');
 const fingerprint=hmac(JSON.stringify({plan:q.planId,coupon:q.coupon,customerName,customerEmail}));
 return db.transaction(async()=>{
  await db.get(`SELECT id FROM users WHERE id=?${lock()}`,[user.id]);
  const existing=await db.get('SELECT * FROM payment_orders WHERE user_id=? AND mode=? AND idempotency_key=?',[user.id,c.mode,k]);
  if(existing) {if(existing.fingerprint!==fingerprint)fail(409,'This request key was already used for different details.');return publicOrder(existing);}
  const count=await db.get('SELECT COUNT(*) n FROM payment_orders WHERE user_id=? AND mode=? AND created_at>?',[user.id,c.mode,now()-3600000]);
  if(count.n>=20)fail(429,'Too many checkouts. Please wait before trying again.');
  const row={id:id('ord'),user_id:user.id,mode:c.mode,provider:c.provider,plan_id:q.planId,product_name:q.productName,subtotal:q.subtotal,discount:q.discount,tax:q.tax,amount:q.total,currency:q.currency,coupon:q.coupon,customer_name:customerName,customer_email:customerEmail,status:P.CREATED,idempotency_key:k,fingerprint,provider_order_id:null,provider_state:null,risk_decision:RISK.ALLOW,ip_hash:request.ipHash||null,device_hash:request.deviceHash||null,created_at:now(),updated_at:now(),expires_at:now()+c.orderMs};
  const columns=Object.keys(row);await db.run(`INSERT INTO payment_orders (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,Object.values(row));
  const risk=await assess(row);row.risk_decision=risk.decision;
  if(risk.decision===RISK.BLOCK)row.status=P.CANCELLED;
  await db.run('UPDATE payment_orders SET risk_decision=?,status=? WHERE id=?',[risk.decision,row.status,row.id]);
  await audit(user.id,'ORDER_CREATED',row.id,{plan:q.planId,amount:q.total,termsAccepted:true},c.mode,request.ipHash);
  return publicOrder(row);
 });
}
async function ensureProviderOrder(order) {
 if(order.provider_order_id)return order;
 const claimed=await db.run('UPDATE payment_orders SET provider_state=? WHERE id=? AND provider_state IS NULL',['CREATING',order.id]);
 if(!claimed.changes) {
   const latest=await orderRow(order.id);if(latest.provider_order_id)return latest;
   fail(409,'Checkout is being prepared. Check again shortly; do not start another payment.','PROVIDER_ORDER_PENDING');
 }
 try {
  const remote=await adapter(order).createOrder(order);
  if(!remote.id||remote.amount!==order.amount||remote.currency!==order.currency)fail(502,'The provider returned inconsistent order details.');
  await db.run('UPDATE payment_orders SET provider_order_id=?,provider_state=? WHERE id=?',[remote.id,'READY',order.id]);
  return orderRow(order.id);
 } catch(error) {
  // An ambiguous create is never blindly retried. No checkout is exposed
  // without a persisted provider order. Admin reconciliation can inspect it.
  await db.run('UPDATE payment_orders SET provider_state=? WHERE id=?',['UNCERTAIN',order.id]);
  await audit(null,'PROVIDER_ORDER_UNCERTAIN',order.id,{},order.mode);throw error;
 }
}
async function createSession(user,input,request={}) {
 assertEnabled();const method=clean(input.method,30),availability=await availableMethods();
 if(!availability.methods.some(m=>m.id===method&&m.enabled))fail(409,'This payment method is not currently enabled.');
 const bank=clean(input.bank,40)||null;
 if(bank&&!availability.banks.some(b=>b.id===bank))fail(400,'Select a bank from the available list.');
 let order=owner(await orderRow(input.orderId),user);
 if(order.risk_decision===RISK.BLOCK)fail(409,'This checkout needs support assistance.');
 if(FINAL.has(order.status)||order.status===P.PROCESSING||order.status===P.AUTHORIZED)fail(409,'This payment is already completed or being verified. Check its status.');
 if(order.expires_at<=now()||order.status===P.CANCELLED)fail(409,'This order has expired or was cancelled. Start a new checkout.');
 order=await ensureProviderOrder(order);
 const session=await db.transaction(async()=>{
  order=owner(await orderRow(order.id,true),user);
  if(FINAL.has(order.status)||[P.PROCESSING,P.AUTHORIZED,P.CANCELLED].includes(order.status)||order.expires_at<=now())fail(409,'The order is no longer available for payment.');
  const active=await db.get('SELECT * FROM payment_sessions WHERE order_id=? AND status=? AND expires_at>? ORDER BY created_at DESC LIMIT 1',[order.id,P.PENDING,now()]);
  if(active&&active.method===method&&active.bank===bank)return active;
  const attempts=await db.get('SELECT COUNT(*) n FROM payment_attempts WHERE order_id=?',[order.id]);
  if(attempts.n>=8)fail(429,'Too many payment attempts. Please contact support.');
  await db.run('UPDATE payment_sessions SET status=? WHERE order_id=? AND status=?',[P.EXPIRED,order.id,P.PENDING]);
  const s={id:id('ses'),order_id:order.id,method,bank,status:P.PENDING,created_at:now(),expires_at:Math.min(now()+config().sessionMs,order.expires_at)};
  await db.run('INSERT INTO payment_sessions (id,order_id,method,bank,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?)',Object.values(s));
  await db.run('INSERT INTO payment_attempts (id,order_id,user_id,mode,session_id,status,method,ip_hash,device_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',[id('att'),order.id,user.id,order.mode,s.id,P.PENDING,method,request.ipHash||null,request.deviceHash||null,now()]);
  await db.run('UPDATE payment_orders SET status=?,updated_at=? WHERE id=?',[P.PENDING,now(),order.id]);
  return s;
 });
 const provider=adapter(order),extra=await provider.createPaymentSession(order,session);
 return {...session,...extra,mode:order.mode,...(order.mode==='test'&&method==='upi'?{qr:await provider.generateUPIQR(order,session)}:{}),...(method==='bank_transfer'?{transfer:await provider.createBankTransfer(order)}:{})};
}
async function getSession(user,sessionId) {
 const session=await db.get('SELECT * FROM payment_sessions WHERE id=?',[sessionId]);
 const order=owner(session&&await orderRow(session.order_id),user),provider=adapter(order);
 return {...session,...(await provider.createPaymentSession(order,session)),mode:order.mode,...(order.mode==='test'&&session.method==='upi'&&session.expires_at>now()?{qr:await provider.generateUPIQR(order,session)}:{}),...(session.method==='bank_transfer'?{transfer:await provider.createBankTransfer(order)}:{})};
}
function monthAfter(ms) {const d=new Date(ms),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+1);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.getTime();}
async function syncSubscription(userId,mode) {
 await ready();
 return db.transaction(async()=>{
 await db.get(`SELECT id FROM users WHERE id=?${lock()}`,[userId]);
 const sub=await db.get('SELECT * FROM payment_subscriptions WHERE user_id=? AND mode=?',[userId,mode]);if(!sub)return null;
 const grants=await db.all('SELECT * FROM payment_entitlements WHERE user_id=? AND mode=? AND revoked=0 AND ends_at>? ORDER BY starts_at',[userId,mode,now()]);
 const current=grants.find(g=>g.starts_at<=now());
 const end=grants.length?Math.max(...grants.map(g=>g.ends_at)):sub.ends_at;
 const status=current?S.ACTIVE:sub.cancel_at_period_end?S.CANCELLED:S.EXPIRED;
 await db.run('UPDATE payment_subscriptions SET status=?,ends_at=?,updated_at=? WHERE id=?',[status,end,now(),sub.id]);
 return {...sub,status,ends_at:end};
 });
}
async function activate(order,transaction) {
 if(await db.get('SELECT id FROM payment_invoices WHERE order_id=?',[order.id]))return;
 // Account row serializes different orders for this subscriber on MySQL.
 await db.get(`SELECT id FROM users WHERE id=?${lock()}`,[order.user_id]);
 const previous=await db.get('SELECT * FROM payment_subscriptions WHERE user_id=? AND mode=?',[order.user_id,order.mode]);
 const grant=await db.get('SELECT MAX(ends_at) ends_at FROM payment_entitlements WHERE user_id=? AND mode=? AND revoked=0',[order.user_id,order.mode]);
 const start=Math.max(now(),grant?.ends_at||0),end=monthAfter(start);
 await db.run('INSERT INTO payment_entitlements (order_id,user_id,mode,plan_id,starts_at,ends_at) VALUES (?,?,?,?,?,?)',[order.id,order.user_id,order.mode,order.plan_id,start,end]);
 if(previous)await db.run('UPDATE payment_subscriptions SET plan_id=?,status=?,current_order_id=?,ends_at=?,cancel_at_period_end=0,next_plan_id=NULL,updated_at=? WHERE id=?',[order.plan_id,S.ACTIVE,order.id,end,now(),previous.id]);
 else await db.run('INSERT INTO payment_subscriptions (id,user_id,mode,plan_id,status,current_order_id,starts_at,ends_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',[id('sub'),order.user_id,order.mode,order.plan_id,S.ACTIVE,order.id,start,end,now()]);
 const invoiceId=id('inv'),number=`${order.mode==='test'?'TEST':'LO'}-${new Date().getUTCFullYear()}-${invoiceId.slice(-12).toUpperCase()}`;
 const snapshot={seller:config().seller,order:publicOrder({...order,status:P.PAID,paid_at:now()}),transaction:{id:transaction.id,method:transaction.method,reference:transaction.provider_reference},number,createdAt:now(),taxIncluded:true};
 await db.run('INSERT INTO payment_invoices (id,number,order_id,transaction_id,user_id,snapshot,created_at) VALUES (?,?,?,?,?,?,?)',[invoiceId,number,order.id,transaction.id,order.user_id,JSON.stringify(snapshot),now()]);
 await notify(order,previous?'Plus renewed':'Payment successful',`${order.product_name} is active. Your receipt is available in Billing. ${order.mode==='test'?'This is a sandbox subscription; no money was charged.':'Renew manually before your access ends. No automatic charge.'}`);
 await audit(null,'SUBSCRIPTION_ACTIVATED',order.id,{subscriptionEndsAt:end,invoice:invoiceId},order.mode);
}
// Only the adapter's server fetch/signed webhook or the explicitly isolated
// test simulator calls this function. Client redirects cannot activate access.
async function applyPayment(orderId,payment,extraRisk=[]) {
 return db.transaction(async()=>{
  const order=await orderRow(orderId,true);if(!order)return null;
  if(!payment.id || typeof payment.id!=='string')fail(400,'Missing payment reference.');
  const mismatch=payment.order_id!==order.provider_order_id||payment.amount!==order.amount||payment.currency!==order.currency;
  if(mismatch) {
    await assess(order,[['provider_amount_currency_or_order_mismatch',100]]);
    await db.run('UPDATE payment_orders SET risk_decision=? WHERE id=?',[RISK.BLOCK,order.id]);
    await audit(null,'PAYMENT_MISMATCH',order.id,{},order.mode);return {rejected:true};
  }
  const existing=await db.get('SELECT * FROM payment_transactions WHERE provider=? AND mode=? AND provider_reference=?',[order.provider,order.mode,payment.id]);
  if(existing && existing.order_id!==order.id) {await assess(order,[['duplicate_payment_reference',100]]);await db.run('UPDATE payment_orders SET risk_decision=? WHERE id=?',[RISK.BLOCK,order.id]);return {rejected:true};}
  if(existing && [P.PAID,P.REFUNDED,P.PARTIALLY_REFUNDED,P.REFUND_PENDING,P.DISPUTED].includes(existing.status))return {duplicate:true};
  const status=payment.status==='captured'?P.PAID:payment.status==='authorized'?P.AUTHORIZED:payment.status==='failed'?P.FAILED:P.PROCESSING;
  // Only server-supplied provider references are used; no PAN, CVV or UPI PIN.
  // A keyed hash lets risk detect instrument reuse without retaining the VPA.
  const instrument=clean(payment.card_id||payment.vpa,200),instrumentHash=instrument?hmac(instrument):null;
  const signals=[...extraRisk];
  if(instrumentHash) {
   const reused=await db.get('SELECT COUNT(DISTINCT user_id) n FROM payment_transactions WHERE instrument_hash=? AND mode=? AND user_id<>? AND created_at>?',[instrumentHash,order.mode,order.user_id,now()-86400000]);
   if(reused.n>=3)signals.push(['instrument_reused_across_accounts',60]);
  }
  if(order.customer_email&&payment.email&&String(payment.email).toLowerCase()!==order.customer_email.toLowerCase())signals.push(['billing_email_mismatch',15]);
  let risk={decision:order.risk_decision};
  if(status===P.PAID)risk=await assess(order,[...signals,...(order.risk_decision===RISK.BLOCK?[['unresolved_block',100]]:[])]);
  const tx=existing || {id:id('txn'),provider_reference:payment.id,method:clean(payment.method,30)||'unknown'};
  if(existing)await db.run('UPDATE payment_transactions SET status=?,risk_decision=?,paid_at=? WHERE id=?',[status,risk.decision,status===P.PAID?now():null,tx.id]);
  else await db.run('INSERT INTO payment_transactions (id,order_id,user_id,provider,mode,provider_reference,amount,currency,method,status,authorization_reference,risk_decision,created_at,paid_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[tx.id,order.id,order.user_id,order.provider,order.mode,payment.id,payment.amount,payment.currency,tx.method,status,clean(payment.acquirer_data?.rrn || payment.acquirer_data?.auth_code,120)||null,risk.decision,now(),status===P.PAID?now():null]);
  if(instrumentHash)await db.run('UPDATE payment_transactions SET instrument_hash=? WHERE id=?',[instrumentHash,tx.id]);
  // Late failure/authorization never rolls back a successful payment. A
  // second captured payment is recorded for reconciliation, not fulfilled twice.
  if(FINAL.has(order.status)) {
   if(status===P.PAID){await assess(order,[['extra_capture',65]]);await db.run('UPDATE payment_orders SET risk_decision=? WHERE id=?',[RISK.REVIEW,order.id]);await audit(null,'EXTRA_CAPTURE_REQUIRES_REVIEW',order.id,{transaction:tx.id},order.mode);}
   return {duplicate:true};
  }
  const next=status===P.PAID&&risk.decision!==RISK.ALLOW?P.PROCESSING:status;
  await db.run('UPDATE payment_orders SET status=?,risk_decision=?,paid_at=?,updated_at=? WHERE id=?',[next,risk.decision,status===P.PAID?now():null,now(),order.id]);
  await db.run('UPDATE payment_attempts SET status=? WHERE order_id=? AND status=?',[status,order.id,P.PENDING]);
  await db.run('UPDATE payment_sessions SET status=? WHERE order_id=? AND status=?',[status,order.id,P.PENDING]);
  await audit(null,'PAYMENT_VERIFIED',order.id,{transaction:tx.id,status,risk:risk.decision},order.mode);
  if(next===P.PAID)await activate(order,tx);
  else if(status===P.FAILED)await notify(order,'Payment not completed','Check Billing for the latest status before trying again.');
  else if(status===P.PAID)await notify(order,'Payment received — under review','We received your payment. Access will be activated after review; do not pay again.');
  return {status:next};
 });
}
async function reconcile(order,actor=null,force=false) {
 if(order.mode==='test')return;
 const claim=await db.run('UPDATE payment_orders SET last_checked_at=? WHERE id=? AND last_checked_at<?',[now(),order.id,now()-(force?5000:15000)]);
 if(!claim.changes)return;
 if(!order.provider_order_id) {
  if(!order.provider_state)return;
  const matches=await adapter(order).findOrder(order);
  if(matches.length!==1){await db.run('INSERT INTO payment_reconciliation_records (id,order_id,status,note,checked_by,created_at) VALUES (?,?,?,?,?,?)',[id('rec'),order.id,'NEEDS_REVIEW',matches.length?'Multiple provider orders need manual review.':'Provider order not found yet. Retry reconciliation before creating a new checkout.',actor,now()]);return;}
  await db.run('UPDATE payment_orders SET provider_order_id=?,provider_state=? WHERE id=? AND provider_order_id IS NULL',[matches[0].id,'READY',order.id]);order=await orderRow(order.id);
 }
 const payments=await adapter(order).getPaymentStatus(order);
 for(const p of payments)await applyPayment(order.id,p);
 await db.run('INSERT INTO payment_reconciliation_records (id,order_id,status,note,checked_by,created_at) VALUES (?,?,?,?,?,?)',[id('rec'),order.id,'MATCHED',`Checked ${payments.length} provider payment(s).`,actor,now()]);
}
async function getOrder(user,orderId,poll=false) {
 let order=owner(await orderRow(orderId),user);
 if(poll&&!FINAL.has(order.status))await reconcile(order);
 order=await orderRow(order.id);
 if(!FINAL.has(order.status)&&![P.AUTHORIZED,P.PROCESSING].includes(order.status)&&order.expires_at<=now())await db.run('UPDATE payment_orders SET status=? WHERE id=? AND status IN (?,?,?) AND expires_at<=?',[P.EXPIRED,order.id,P.CREATED,P.PENDING,P.FAILED,now()]);
 order=await orderRow(order.id);
 const invoice=await db.get('SELECT id,number FROM payment_invoices WHERE order_id=?',[order.id]);
 const sessions=await db.get('SELECT id,method,expires_at,status FROM payment_sessions WHERE order_id=? ORDER BY created_at DESC LIMIT 1',[order.id]);
 return {...publicOrder(order),invoice,session:sessions};
}
async function simulate(user,input) {
 if(config().mode!=='test')fail(404,'Not found.');assertEnabled();
 const session=await db.get('SELECT * FROM payment_sessions WHERE id=?',[input.sessionId]);
 const order=owner(session&&await orderRow(session.order_id),user);
 const outcome=input.outcome;
 if(!['success','failure','pending','expired','review'].includes(outcome))fail(400,'Choose a sandbox result.');
 if(session.expires_at<=now())fail(409,'This test session has expired. Refresh it.');
 if(FINAL.has(order.status)||session.status===P.PAID)return getOrder(user,order.id);
 if(session.status!==P.PENDING)fail(409,'This session is no longer active.');
 if(outcome==='expired') {
   await db.run('UPDATE payment_sessions SET status=?,expires_at=? WHERE id=?',[P.EXPIRED,now()-1,session.id]);
 } else if(outcome!=='pending')await applyPayment(order.id,{id:`test_pay_${session.id}`,order_id:order.provider_order_id,amount:order.amount,currency:order.currency,method:session.method,status:outcome==='failure'?'failed':'captured'},outcome==='review'?[['sandbox_review',65]]:[]);
 return getOrder(user,order.id);
}
async function verify(user,input) {
 const order=owner(await orderRow(input.orderId),user);assertEnabled();
 if(order.mode==='test')fail(400,'Use the clearly marked sandbox controls to simulate a payment.');
 const payment=await adapter(order).verifyPayment(order,input);
 const result=await applyPayment(order.id,payment);if(result?.rejected)fail(409,'The provider payment does not match this order.');
 return getOrder(user,order.id);
}
async function billing(user) {
 await ready();const mode=config().mode;
 await db.run('UPDATE payment_orders SET status=? WHERE user_id=? AND mode=? AND status IN (?,?,?) AND expires_at<?',[P.EXPIRED,user.id,mode,P.CREATED,P.PENDING,P.FAILED,now()]);
 const [orders,transactions,invoices,refunds,subscription]=await Promise.all([
  db.all('SELECT * FROM payment_orders WHERE user_id=? AND mode=? ORDER BY created_at DESC LIMIT 100',[user.id,mode]),
  db.all('SELECT id,order_id,amount,currency,method,status,created_at FROM payment_transactions WHERE user_id=? AND mode=? ORDER BY created_at DESC LIMIT 100',[user.id,mode]),
  db.all('SELECT i.id,i.order_id,i.number,i.created_at FROM payment_invoices i JOIN payment_orders o ON o.id=i.order_id WHERE i.user_id=? AND o.mode=? ORDER BY i.created_at DESC LIMIT 100',[user.id,mode]),
  db.all('SELECT r.id,r.order_id,r.amount,r.reason,r.status,r.created_at FROM payment_refunds r JOIN payment_orders o ON o.id=r.order_id WHERE o.user_id=? AND o.mode=? ORDER BY r.created_at DESC LIMIT 100',[user.id,mode]),
  syncSubscription(user.id,mode)
 ]);
 return {mode,orders:orders.map(publicOrder),transactions,invoices,refunds,subscription,renewal:'manual',isAdmin:admin(user)};
}
async function subscriptionAction(user,action) {
 if(!['cancel','resume','downgrade'].includes(action))fail(400,'Choose a subscription action.');
 return db.transaction(async()=>{
  await db.get(`SELECT id FROM users WHERE id=?${lock()}`,[user.id]);
  const s=await syncSubscription(user.id,config().mode);if(!s||s.status!==S.ACTIVE)fail(409,'No active subscription.');
  const cancel=action!=='resume';
  await db.run('UPDATE payment_subscriptions SET cancel_at_period_end=?,next_plan_id=?,updated_at=? WHERE id=?',[cancel?1:0,cancel?'free':null,now(),s.id]);
  await audit(user.id,'SUBSCRIPTION_'+action.toUpperCase(),s.id,{effectiveAt:s.ends_at},s.mode);
  return {...s,cancel_at_period_end:cancel?1:0,next_plan_id:cancel?'free':null};
 });
}
module.exports={catalog,availableMethods,createOrder,createSession,getSession,applyPayment,getOrder,simulate,verify,billing,subscriptionAction,syncSubscription,activate,publicOrder,orderRow,reconcile,monthAfter};
