import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const APP=process.env.TEST_APP_URL??"http://127.0.0.1:3000";
const DB=process.env.NEXT_PUBLIC_SUPABASE_URL??"http://127.0.0.1:3001";
const KEY=process.env.RETELL_API_KEY;const JWT=process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(KEY);assert.ok(JWT);
const AGENT="retell-agent-a1";const AGENT_DB="44444444-4444-4444-4444-444444444444";
const R="11111111-1111-1111-1111-111111111111";const L="22222222-2222-2222-2222-222222222222";
const OMELET="20000000-0000-4000-8000-000000000001";const COKE="20000000-0000-4000-8000-000000000002";
const DIET_SIZE="30000000-0000-4000-8000-000000000004";const PIZZA_MOD="50000000-0000-4000-8000-000000000006";
function sig(raw){const t=Date.now();return `v=${t},d=${createHmac("sha256",KEY).update(raw+t).digest("hex")}`;}
async function tool(op,args={},callId="edge"){
 const raw=JSON.stringify({call:{agent_id:AGENT,call_id:callId},args});
 const r=await fetch(`${APP}/api/ai/${op}`,{method:"POST",headers:{"content-type":"application/json","X-Retell-Signature":sig(raw)},body:raw});
 const b=await r.json();return{status:r.status,body:b};
}
async function db(path,init={}){const r=await fetch(`${DB}/${path}`,{...init,headers:{Authorization:`Bearer ${JWT}`,apikey:JWT,"content-type":"application/json",Prefer:"return=representation",...(init.headers??{})}});const t=await r.text();if(!r.ok)throw new Error(t);return t?JSON.parse(t):null;}
function data(x){assert.equal(x.body.success,true,JSON.stringify(x.body));return x.body.data;}
function code(x,status,c){assert.equal(x.status,status,JSON.stringify(x.body));assert.equal(x.body.error_code,c,JSON.stringify(x.body));}

console.log("EDGE 1: valid UUID but wrong size relationship rejected");
code(await tool("menu/availability",{menu_item_id:COKE,size_id:DIET_SIZE},"edge-size-id"),409,"INVALID_SIZE");

console.log("EDGE 2: modifier from unrelated item rejected");
code(await tool("menu/availability",{menu_item_id:OMELET,modifier_ids:[PIZZA_MOD]},"edge-mod-id"),409,"INVALID_MODIFIER");

console.log("EDGE 3: invalid substitution target from another modifier group rejected");
let x=data(await tool("order/item/add",{item_name:"Veggie Omelet"},"edge-sub"));
code(await tool("order/item/update",{line_id:x.added_line_id,modifier_changes:[{modifier_name:"Square-Cut Potatoes",replaces_modifier_name:"White Toast"}]},"edge-sub"),409,"INVALID_SUBSTITUTION");

console.log("EDGE 4: size-specific required modifier blocks quote before authoritative RPC");
x=data(await tool("order/item/add",{item_name:"Pepperoni Pizza",size_name:"Large"},"edge-size-rule"));
assert.equal(x.readiness.ready,true,"base rule is optional; size-specific preflight must tighten it");
code(await tool("order/quote",{customer_name:"Size Rule",customer_phone:"4165550201",fulfillment_type:"pickup"},"edge-size-rule"),409,"ORDER_NOT_READY");

console.log("EDGE 5: missing size requires clarification");
code(await tool("order/item/add",{item_name:"Pepperoni Pizza"},"edge-size-required"),409,"SIZE_REQUIRED");

console.log("EDGE 6: modifier quantity over authoritative max rejected");
code(await tool("order/item/add",{item_name:"Pepperoni Pizza",size_name:"Large",modifier_changes:[{modifier_name:"Pepperoni",quantity:5}]},"edge-quantity"),409,"INVALID_MODIFIER_QUANTITY");

console.log("EDGE 7: empty calculate_order is ORDER_NOT_READY");
code(await tool("order/quote",{customer_name:"Empty",customer_phone:"4165550202",fulfillment_type:"pickup"},"edge-empty"),409,"ORDER_NOT_READY");

console.log("EDGE 8: stale expected revision is rejected rather than overwriting");
x=data(await tool("order/item/add",{item_name:"Coke"},"edge-stale"));
code(await tool("order/item/update",{line_id:x.added_line_id,quantity:2,expected_revision:x.revision-1},"edge-stale"),409,"STALE_REVISION");

console.log("EDGE 9: expired state cannot be resurrected");
await db("ai_working_orders",{method:"POST",body:JSON.stringify({call_id:"edge-expired",agent_id:AGENT_DB,restaurant_id:R,location_id:L,items:[],revision:0,status:"building",expires_at:new Date(Date.now()-60000).toISOString()})});
code(await tool("order/state",{},"edge-expired"),409,"ORDER_NOT_READY");

console.log("EDGE 10: invalid signature cannot access read-only availability either");
const raw=JSON.stringify({call:{agent_id:AGENT,call_id:"edge-badsig"},args:{menu_item_id:COKE}});
const bad=await fetch(`${APP}/api/ai/menu/availability`,{method:"POST",headers:{"content-type":"application/json","X-Retell-Signature":"v=1,d=00"},body:raw});
assert.equal(bad.status,401);

console.log("RETELL_SHAPED_HTTP_EDGE_PASS");
