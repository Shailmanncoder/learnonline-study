'use strict';
const express=require('express'),jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs');
const auth=require('../middleware/auth');
const {rateLimit}=require('../middleware/rateLimit');
const {getJwtSecret}=require('../config/security');
const {db,ready,audit}=require('./store');
const {config,price,admin,fail,clean,hmac,PaymentError}=require('./config');
const service=require('./service'),management=require('./admin'),receipts=require('./receipts');
const router=express.Router();
const route=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
const context=req=>({ipHash:hmac(req.ip||''),deviceHash:req.get('X-Payment-Device')?hmac(String(req.get('X-Payment-Device')).slice(0,200)):null});
// Reject, rather than silently accept, client totals, card details or new
// privileged fields accidentally sent by a future UI revision.
const body=(req,keys)=>{if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).some(k=>!keys.includes(k)))fail(400,'Unexpected payment fields. Amounts and payment status are controlled by the server.');return req.body;};
function headers(req,res,next) {
 res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin'});
 if(process.env.NODE_ENV==='production') {
  res.set('Strict-Transport-Security','max-age=31536000');
  if(!req.secure)return res.status(426).json({message:'Payments require HTTPS.'});
 }
 // Existing auth uses explicit Bearer headers, never ambient cookies. Enforce
 // same-origin mutations as an extra guard; do not add cookie-based authority.
 const origin=req.get('Origin');
 if(origin&&req.method!=='GET'&&req.method!=='HEAD') {
  const expected=process.env.PAYMENTS_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  if(origin!==new URL(expected).origin)return res.status(403).json({message:'Payment requests must come from this site.'});
 }
 next();
}
function errorHandler(error,req,res,next) {
 if(res.headersSent)return next(error);
 if(!(error instanceof PaymentError))console.error('[PAYMENTS]',error.code||error.name);
 res.status(error instanceof PaymentError?error.status:500).json({message:error instanceof PaymentError?error.message:'Payments are temporarily unavailable. Please retry.',code:error.code||'PAYMENT_ERROR'});
}
router.use(headers,auth);
router.use((req,res,next)=>ready().then(()=>next(),next));
router.use(rateLimit({name:'payment-api',windowMs:60000,max:120,message:'Please wait a moment before checking payment status again.'}));
router.get('/catalog',route(async(req,res)=>res.json(await service.catalog(req.user))));
router.post('/quote',route(async(req,res)=>{const input=body(req,['planId','coupon']);res.json(price(input.planId,input.coupon));}));
router.post('/orders',route(async(req,res)=>res.status(201).json(await service.createOrder(req.user,body(req,['planId','coupon','customerName','customerEmail','idempotencyKey','acceptedTerms']),context(req)))));
router.get('/orders/:id',route(async(req,res)=>res.json(await service.getOrder(req.user,req.params.id,req.query.refresh==='1'))));
router.post('/session',route(async(req,res)=>res.json(await service.createSession(req.user,body(req,['orderId','method','bank']),context(req)))));
router.get('/session/:id',route(async(req,res)=>res.json(await service.getSession(req.user,req.params.id))));
router.post('/verify',route(async(req,res)=>res.json(await service.verify(req.user,body(req,['orderId','razorpay_order_id','razorpay_payment_id','razorpay_signature'])))));
router.post('/sandbox',route(async(req,res)=>res.json(await service.simulate(req.user,body(req,['sessionId','outcome'])))));
router.get('/billing',route(async(req,res)=>res.json(await service.billing(req.user))));
router.post('/subscription',route(async(req,res)=>res.json(await service.subscriptionAction(req.user,body(req,['action']).action))));
router.get('/invoices/:id',route(async(req,res)=>{const row=await receipts.get(req.user,req.params.id);res.json({id:row.id,number:row.number,status:row.status,mode:row.mode,snapshot:row.snapshot});}));
router.get('/invoices/:id/pdf',route(async(req,res)=>{const row=await receipts.get(req.user,req.params.id);res.type('pdf').set('Content-Disposition',`attachment; filename="${row.number}.pdf"`).send(await receipts.pdf(row));}));
router.post('/invoices/:id/email',route(async(req,res)=>{body(req,[]);res.json(await receipts.email(req.user,req.params.id));}));
const privileged=express.Router();
privileged.use((req,res,next)=>admin(req.user)?next():res.status(403).json({message:'Payment administrator access is required.'}));
privileged.post('/reauth',rateLimit({name:'payment-reauth',windowMs:15*60000,max:8,message:'Too many confirmation attempts. Please wait.'}),route(async(req,res)=>{
 const input=body(req,['password']);if(typeof input.password!=='string'||Buffer.byteLength(input.password)>72)fail(400,'Enter your password.');
 const account=await db.get('SELECT password FROM users WHERE id=?',[req.user.id]);
 if(!account||!await bcrypt.compare(input.password,account.password))fail(403,'Password confirmation failed.');
 await audit(req.user.id,'ADMIN_REAUTHENTICATED',String(req.user.id));
 res.json({approval:jwt.sign({sub:String(req.user.id),purpose:'payments-admin'},getJwtSecret(),{algorithm:'HS256',expiresIn:'5m',audience:'payments'})});
}));
function approval(req,res,next) {
 try{const v=jwt.verify(req.get('X-Payment-Approval')||'',getJwtSecret(),{algorithms:['HS256'],audience:'payments'});if(v.sub!==String(req.user.id)||v.purpose!=='payments-admin')throw new Error();next();}catch {res.status(403).json({message:'Confirm your password before changing payments.',code:'APPROVAL_REQUIRED'});}
}
privileged.get('/overview',route(async(req,res)=>res.json(await management.overview())));
privileged.get('/settings',route(async(req,res)=>res.json({...(await service.catalog(req.user)),webhookPath:'/api/payments/webhooks/'+config().provider,configured:config().enabled})));
privileged.get('/orders/:id',route(async(req,res)=>res.json(await management.detail(req.user,req.params.id))));
privileged.post('/orders/:id/review',approval,route(async(req,res)=>res.json(await management.review(req.user,req.params.id,body(req,['decision','reason','confirm'])))));
privileged.post('/transactions/:id/refund',approval,route(async(req,res)=>res.json(await management.requestRefund(req.user,req.params.id,body(req,['amount','reason','confirm','idempotencyKey','outcome'])))));
privileged.post('/refunds/:id/reconcile',approval,route(async(req,res)=>{body(req,[]);res.json(await management.retryRefund(req.user,req.params.id));}));
privileged.post('/orders/:id/reconcile',approval,route(async(req,res)=>{
 body(req,[]);const order=await service.orderRow(req.params.id);if(!order||order.mode!==config().mode)fail(404,'Order not found.');
 await service.reconcile(order,req.user.id,true);await audit(req.user.id,'ADMIN_RECONCILED',order.id,{},order.mode);res.json(await management.detail(req.user,order.id));
}));
privileged.post('/methods/:id',approval,route(async(req,res)=>{
 const input=body(req,['enabled','confirm']);if(typeof input.enabled!=='boolean'||input.confirm!==true)fail(400,'Confirm the payment method change.');
 const before=await db.get('SELECT * FROM payment_methods WHERE id=? AND mode=?',[req.params.id,config().mode]);if(!before)fail(404,'Method not found.');
 await db.transaction(async()=>{await db.run('UPDATE payment_methods SET enabled=? WHERE id=? AND mode=?',[input.enabled?1:0,req.params.id,config().mode]);await audit(req.user.id,'PAYMENT_METHOD_CHANGED',req.params.id,{before:!!before.enabled,after:input.enabled});});res.json(await service.availableMethods());
}));
privileged.get('/:kind',route(async(req,res)=>res.json(await management.list(req.params.kind,req.query))));
router.use('/admin',privileged);router.use(errorHandler);
function installWebhooks(app) {
 app.post('/api/payments/webhooks/:source',headers,rateLimit({name:'payment-webhook',windowMs:60000,max:300,message:'Please retry webhook delivery later.'}),express.raw({type:'application/json',limit:'256kb'}),route(async(req,res)=>res.json(await require('./webhooks').handle(req.params.source,req.body,req.headers))),errorHandler);
}
module.exports={router,installWebhooks,headers};
