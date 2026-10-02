'use strict';
const {config,fail}=require('../config');
const instances={sandbox:new(require('./sandbox'))(),razorpay:new(require('./razorpay'))()};
module.exports=function adapter(order) {
 const c=config();
 if(order && (order.mode!==c.mode || order.provider!==c.provider)) fail(409,'This payment belongs to a different environment.');
 return instances[c.provider];
};
