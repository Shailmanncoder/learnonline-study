'use strict';
const {db,audit}=require('./store');
const {config,admin,fail}=require('./config');
const money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(n/100);
async function get(user,id) {
 const row=await db.get('SELECT i.*,o.mode,o.status FROM payment_invoices i JOIN payment_orders o ON o.id=i.order_id WHERE i.id=?',[id]);
 if(!row||row.mode!==config().mode||row.user_id!==user.id&&!admin(user))fail(404,'Receipt not found.');
 if(admin(user)&&row.user_id!==user.id)await audit(user.id,'ADMIN_VIEWED_INVOICE',id,{},row.mode);
 return {...row,snapshot:JSON.parse(row.snapshot)};
}
async function pdf(row) {
 const PDFDocument=require('pdfkit'),s=row.snapshot,o=s.order;
 const doc=new PDFDocument({size:'A4',margin:50,info:{Title:`${row.mode==='test'?'TEST ':''}Receipt ${row.number}`,Author:'LearnOnline.study'}}),chunks=[];
 const result=new Promise((resolve,reject)=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
 const line=(label,value)=>{doc.fontSize(10).fillColor('#596579').text(label,{continued:true}).fillColor('#14295b').text(`   ${value}`);doc.moveDown(.6);};
 doc.fontSize(23).fillColor('#2563eb').text('LearnOnline.study');doc.moveDown(.5);
 doc.fontSize(17).fillColor('#14295b').text(row.mode==='test'?'TEST PAYMENT RECEIPT':'Payment receipt');
 doc.moveDown();if(row.mode==='test'){doc.fontSize(10).fillColor('#8a5800').text('Sandbox only. No money was charged. Not a tax invoice.');doc.moveDown();}
 line('Receipt',row.number);line('Date',new Date(row.created_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}));line('Seller',s.seller.name);
 if(s.seller.address)line('Address',s.seller.address);if(s.seller.gstin)line('GSTIN',s.seller.gstin);
 line('Customer',o.customer_name);if(o.customer_email)line('Email',o.customer_email);
 doc.moveDown();line('Item',o.product_name+' — one month');line('Order',o.id);line('Transaction',s.transaction.id);line('Method',s.transaction.method||'Provider checkout');
 const asciiMoney=n=>'INR '+(n/100).toFixed(2); // Standard PDF fonts do not contain the rupee glyph.
 line('Listed price',asciiMoney(o.subtotal));line('Discount',asciiMoney(o.discount));line('Included tax',asciiMoney(o.tax));line('Total paid',asciiMoney(o.amount));line('Current payment status',row.status.replace(/_/g,' '));
 doc.moveDown();doc.fontSize(10).fillColor('#596579').text('No automatic renewal. Manage your plan and payment history from Billing.');doc.moveDown().text(`Questions? ${s.seller.support}`);
 if(!s.seller.gstin)doc.moveDown().text('Payment receipt. Tax invoicing is not configured for this seller.');
 doc.end();return result;
}
async function email(user,invoiceId) {
 const row=await get(user,invoiceId),recipient=row.snapshot.order.customer_email;
 if(!config().emailEnabled)fail(503,'Receipt email is not configured. You can download your receipt.');
 if(row.mode==='test')fail(409,'Sandbox receipts are downloadable; email is disabled to avoid sending test purchases.');
 if(!recipient)fail(409,'No receipt email was saved with this order. Download the receipt instead.');
 const claim=await db.run('UPDATE payment_invoices SET email_claimed_at=? WHERE id=? AND (email_claimed_at IS NULL OR email_claimed_at<?)',[Date.now(),row.id,Date.now()-300000]);
 if(!claim.changes)fail(429,'A receipt email was recently requested. Please wait five minutes.');
 const port=Number(process.env.PAYMENTS_SMTP_PORT || 465);
 const transport=require('nodemailer').createTransport({host:process.env.PAYMENTS_SMTP_HOST,port,secure:port===465,requireTLS:port!==465,auth:process.env.PAYMENTS_SMTP_USER?{user:process.env.PAYMENTS_SMTP_USER,pass:process.env.PAYMENTS_SMTP_PASSWORD}:undefined,connectionTimeout:10000,socketTimeout:15000});
 try {
  await transport.sendMail({from:process.env.PAYMENTS_EMAIL_FROM,to:recipient,subject:`Your LearnOnline.study receipt ${row.number}`,text:`Your ${row.snapshot.order.product_name} payment of ${money(row.snapshot.order.amount)} was received. Your receipt is attached. No automatic renewal.`,attachments:[{filename:row.number+'.pdf',content:await pdf(row),contentType:'application/pdf'}]});
  await db.run('UPDATE payment_invoices SET email_sent_at=? WHERE id=?',[Date.now(),row.id]);await audit(user.id,'RECEIPT_EMAILED',row.id,{},row.mode);return {sent:true};
 } catch {fail(503,'The email service did not confirm delivery. Please download your receipt or retry later.');}
 finally {transport.close();}
}
module.exports={get,pdf,email};
