import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";

type Json = Record<string, any>;
type Context = { supabase: ReturnType<typeof createServerSupabase>; agentId: string; restaurantId: string; locationId: string; callId: string; args: Json };
type Selection = { modifier_id: string; quantity?: number; side?: "whole"|"left"|"right"; quantity_level_id?: string; notes?: string };
type Line = { line_id: string; menu_item_id: string; item_name: string; size_id?: string; size_name?: string; quantity: number; special_instructions?: string; selections: Selection[] };

const ZERO="00000000-0000-0000-0000-000000000000";
const ok=(data:unknown,status=200)=>NextResponse.json({success:true,data},{status});
const fail=(error_code:string,message:string,status=400,recoverable=true)=>NextResponse.json({success:false,error_code,message,recoverable},{status});
const stable=(v:any):string=>v===null||typeof v!=="object"?JSON.stringify(v):Array.isArray(v)?`[${v.map(stable).join(",")}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
const hash=(v:any)=>createHash("sha256").update(stable(v)).digest("hex");
const token=(v:any)=>{const secret=process.env.RETELL_API_KEY;if(!secret)throw new Error("AI pricing confirmation is not configured");return createHmac("sha256",secret).update(hash(v)).digest("hex")};
const safeEqual=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));

function verify(raw:string,signature:string|null){const key=process.env.RETELL_API_KEY;if(!key||!signature)return false;const m=/^v=(\d+),d=([a-f0-9]+)$/i.exec(signature.trim());if(!m)return false;const ts=Number(m[1]);if(!Number.isFinite(ts)||Math.abs(Date.now()-ts)>300000)return false;const expected=createHmac("sha256",key).update(raw+m[1]).digest("hex");return safeEqual(expected,m[2].toLowerCase())}
function normalizePhone(phone:string){const d=phone.replace(/\D/g,"");return d.length===10?`1${d}`:d.length===11&&d.startsWith("1")?d:""}
function lineId(){return `li_${crypto.randomUUID()}`}

async function auth(request:Request):Promise<Context|NextResponse>{
  const raw=await request.text();
  if(!verify(raw,request.headers.get("X-Retell-Signature")))return fail("UNAUTHORIZED","This request is not an authenticated Retell request.",401,false);
  let payload:Json;try{payload=JSON.parse(raw)}catch{return fail("INVALID_JSON","The AI request body is not valid JSON.",400,false)}
  const args=payload.args&&typeof payload.args==="object"?payload.args:payload;
  const retellAgentId=payload?.call?.agent_id??payload.agent_id??args.agent_id;
  const callId=payload?.call?.call_id??payload.call_id??args.call_id;
  if(typeof retellAgentId!=="string")return fail("AGENT_REQUIRED","The authenticated AI request did not identify an agent.",400,false);
  if(typeof callId!=="string"||!callId.trim())return fail("CALL_ID_REQUIRED","A Retell call_id is required for order state.",400,false);
  const supabase=createServerSupabase();
  const {data:agent,error}=await supabase.from("ai_agents").select("id,restaurant_id,location_id,status").eq("retell_agent_id",retellAgentId).neq("status","disabled").limit(1).maybeSingle();
  if(error||!agent)return fail("AGENT_NOT_AUTHORIZED","This AI agent is not authorized.",403,false);
  let locationId=agent.location_id as string|null;
  if(!locationId){const {data:location}=await supabase.from("restaurant_locations").select("id").eq("restaurant_id",agent.restaurant_id).eq("is_active",true).limit(1).maybeSingle();locationId=location?.id??null}
  if(!locationId)return fail("LOCATION_NOT_CONFIGURED","No active restaurant location is configured for this AI agent.",409,false);
  return {supabase,agentId:agent.id,restaurantId:agent.restaurant_id,locationId,callId,args};
}

async function getState(c:Context,create=true){
  const {data,error}=await c.supabase.from("ai_working_orders").select("*").eq("restaurant_id",c.restaurantId).eq("location_id",c.locationId).eq("call_id",c.callId).limit(1).maybeSingle();
  if(error)throw error;
  if(data){if(new Date(data.expires_at).getTime()<Date.now())throw new Error("WORKING_ORDER_EXPIRED");return data}
  if(!create)return null;
  const {data:created,error:createError}=await c.supabase.from("ai_working_orders").insert({call_id:c.callId,agent_id:c.agentId,restaurant_id:c.restaurantId,location_id:c.locationId}).select("*").single();
  if(createError)throw createError;return created;
}
async function save(c:Context,state:any,items:Line[]){const {data,error}=await c.supabase.from("ai_working_orders").update({items,revision:Number(state.revision)+1,quoted_revision:null,quote_token:null,quote_payload:null,quote_result:null,status:"building",updated_at:new Date().toISOString(),expires_at:new Date(Date.now()+4*60*60*1000).toISOString()}).eq("id",state.id).eq("revision",state.revision).select("*").single();if(error)throw error;return data}

async function resolveItem(c:Context,name:string,sizeName?:string){
  const {data:items,error}=await c.supabase.from("menu_items").select("id,name,price,is_available,category_id,item_type").eq("restaurant_id",c.restaurantId).ilike("name",name.trim()).limit(5);if(error)throw error;
  const available=(items??[]).filter((i:any)=>i.is_available);if(available.length===0)return {error:fail("ITEM_NOT_FOUND","I could not find an available menu item with that name.",404)};if(available.length>1)return {error:fail("ITEM_AMBIGUOUS","More than one menu item matches that name. Ask the customer to clarify.",409)};
  const item=available[0];let size:any=null;
  const {data:sizes,error:sizeError}=await c.supabase.from("menu_item_sizes").select("id,name,price,is_available").eq("menu_item_id",item.id).order("display_order");if(sizeError)throw sizeError;
  const availableSizes=(sizes??[]).filter((s:any)=>s.is_available);
  if(sizeName){const matches=availableSizes.filter((s:any)=>s.name.toLowerCase()===sizeName.trim().toLowerCase());if(matches.length!==1)return {error:fail("SIZE_NOT_FOUND","That size is not available for this item.",409)};size=matches[0]}
  else if(availableSizes.length===1)size=availableSizes[0];else if(availableSizes.length>1)return {error:fail("SIZE_REQUIRED","This item has multiple sizes. Ask the customer which size they want.",409)};
  return {item,size};
}

async function resolveSelections(c:Context,itemId:string,modifierNames:string[]|undefined):Promise<{selections?:Selection[];error?:NextResponse}>{
  if(!modifierNames?.length)return {selections:[]};
  const {data:links,error:linkError}=await c.supabase.from("menu_item_modifier_groups").select("modifier_group_id").eq("menu_item_id",itemId);if(linkError)throw linkError;const groupIds=(links??[]).map((x:any)=>x.modifier_group_id);
  const {data:mods,error}=await c.supabase.from("modifiers").select("id,name,modifier_group_id,is_available").in("modifier_group_id",groupIds.length?groupIds:[ZERO]).eq("is_available",true);if(error)throw error;
  const selections:Selection[]=[];for(const requested of modifierNames){const matches=(mods??[]).filter((m:any)=>m.name.toLowerCase()===requested.trim().toLowerCase());if(matches.length!==1)return {error:fail("MODIFIER_NOT_FOUND",`I could not uniquely resolve the modifier '${requested}' for this item.`,409)};selections.push({modifier_id:matches[0].id})}return {selections};
}

const addSchema=z.object({item_name:z.string().trim().min(1).max(120),size_name:z.string().trim().max(100).optional(),quantity:z.coerce.number().int().min(1).max(99).default(1),modifier_names:z.array(z.string().trim().min(1).max(120)).max(30).optional(),special_instructions:z.string().max(500).optional()});
const updateSchema=z.object({line_id:z.string().min(4),quantity:z.coerce.number().int().min(1).max(99).optional(),size_name:z.string().trim().max(100).optional(),modifier_names:z.array(z.string().trim().min(1).max(120)).max(30).optional(),special_instructions:z.string().max(500).optional()});
const quoteSchema=z.object({customer_name:z.string().trim().min(1).max(120),customer_phone:z.string().trim().min(10).max(30),customer_email:z.string().email().max(320).optional(),fulfillment_type:z.enum(["pickup","delivery","dine_in"]),notes:z.string().max(1000).optional(),scheduled_for:z.string().datetime().optional(),delivery_address_line1:z.string().max(200).optional(),delivery_address_line2:z.string().max(200).optional(),delivery_city:z.string().max(100).optional(),delivery_province:z.string().max(100).optional(),delivery_postal_code:z.string().max(30).optional(),delivery_instructions:z.string().max(1000).optional(),table_number:z.string().max(30).optional()});

function rpcItems(items:Line[]){return items.map(({menu_item_id,size_id,quantity,special_instructions,selections})=>({menu_item_id,size_id,quantity,special_instructions,selections}))}

export async function handleWorkingOrderRequest(request:Request,operation:string[]){
  const authorized=await auth(request);if(authorized instanceof NextResponse)return authorized;const c=authorized;const op=operation.join("/");
  try{
    if(op==="order/state"){const state=await getState(c,false);return ok({working_order:state?{call_id:c.callId,revision:state.revision,status:state.status,items:state.items,quoted_revision:state.quoted_revision}:null})}
    if(op==="order/item/add"){
      const input=addSchema.parse(c.args);const state=await getState(c);if(state.status==="created")return fail("ORDER_ALREADY_CREATED","This call already created an order.",409,false);
      const resolved=await resolveItem(c,input.item_name,input.size_name);if(resolved.error)return resolved.error;const selectionResult=await resolveSelections(c,resolved.item.id,input.modifier_names);if(selectionResult.error)return selectionResult.error;
      const items=[...(state.items as Line[]),{line_id:lineId(),menu_item_id:resolved.item.id,item_name:resolved.item.name,size_id:resolved.size?.id,size_name:resolved.size?.name,quantity:input.quantity,special_instructions:input.special_instructions,selections:selectionResult.selections??[]}];const saved=await save(c,state,items);return ok({revision:saved.revision,items:saved.items})
    }
    if(op==="order/item/update"){
      const input=updateSchema.parse(c.args);const state=await getState(c,false);if(!state)return fail("ORDER_NOT_READY","There is no working order for this call.",409);const items=[...(state.items as Line[])];const index=items.findIndex(x=>x.line_id===input.line_id);if(index<0)return fail("LINE_ITEM_NOT_FOUND","That working-order line item could not be found.",404);
      const current=items[index];let sizeId=current.size_id,sizeName=current.size_name;if(input.size_name!==undefined){const resolved=await resolveItem(c,current.item_name,input.size_name);if(resolved.error)return resolved.error;sizeId=resolved.size?.id;sizeName=resolved.size?.name}
      let selections=current.selections;if(input.modifier_names!==undefined){const r=await resolveSelections(c,current.menu_item_id,input.modifier_names);if(r.error)return r.error;selections=r.selections??[]}
      items[index]={...current,size_id:sizeId,size_name:sizeName,quantity:input.quantity??current.quantity,special_instructions:input.special_instructions??current.special_instructions,selections};const saved=await save(c,state,items);return ok({revision:saved.revision,items:saved.items})
    }
    if(op==="order/item/remove"){
      const input=z.object({line_id:z.string().min(4)}).parse(c.args);const state=await getState(c,false);if(!state)return fail("ORDER_NOT_READY","There is no working order for this call.",409);const items=(state.items as Line[]).filter(x=>x.line_id!==input.line_id);if(items.length===(state.items as Line[]).length)return fail("LINE_ITEM_NOT_FOUND","That working-order line item could not be found.",404);const saved=await save(c,state,items);return ok({revision:saved.revision,items:saved.items})
    }
    if(op==="order/quote"){
      const input=quoteSchema.parse(c.args);const state=await getState(c,false);const items=(state?.items??[]) as Line[];if(!state||items.length===0)return fail("ORDER_NOT_READY","The order has no resolved line items. Resolve the customer's items before calculating a total.",409);
      const phone=normalizePhone(input.customer_phone);if(!phone)return fail("INVALID_PHONE","A valid 10-digit North American phone number is required.",409);
      const payload={...input,customer_phone:phone,items:rpcItems(items),working_order_revision:state.revision};
      const {data,error}=await c.supabase.rpc("quote_complex_order_atomic",{p_restaurant_id:c.restaurantId,p_location_id:c.locationId,p_customer_name:input.customer_name,p_customer_phone:phone,p_fulfillment_type:input.fulfillment_type,p_notes:input.notes??null,p_scheduled_for:input.scheduled_for??null,p_delivery_address_line1:input.delivery_address_line1??null,p_delivery_address_line2:input.delivery_address_line2??null,p_delivery_city:input.delivery_city??null,p_delivery_province:input.delivery_province??null,p_delivery_postal_code:input.delivery_postal_code??null,p_delivery_instructions:input.delivery_instructions??null,p_table_number:input.table_number??null,p_items:rpcItems(items)});if(error)throw error;const quoteToken=token(payload);
      const {error:updateError}=await c.supabase.from("ai_working_orders").update({quoted_revision:state.revision,quote_token:quoteToken,quote_payload:payload,quote_result:data,status:"quoted",updated_at:new Date().toISOString()}).eq("id",state.id).eq("revision",state.revision);if(updateError)throw updateError;return ok({quote:data,quote_token:quoteToken,working_order_revision:state.revision,items})
    }
    if(op==="order/create"){
      const input=z.object({customer_confirmed:z.literal(true),quote_token:z.string().regex(/^[a-f0-9]{64}$/i),idempotency_key:z.string().trim().min(8).max(200).optional()}).parse(c.args);const state=await getState(c,false);if(!state||!state.quote_payload||!state.quote_token||state.quoted_revision!==state.revision)return fail("ORDER_NOT_READY","The working order changed or has not been successfully quoted. Calculate the order again before creating it.",409);if(!safeEqual(input.quote_token,state.quote_token))return fail("QUOTE_MISMATCH","The quote token does not match the validated working order.",409);
      if(state.status==="created"&&state.created_order_id)return ok({order_id:state.created_order_id,already_created:true});const q=state.quote_payload as Json;const items=rpcItems(state.items as Line[]);const requestHash=hash({...q,items});const idempotencyKey=input.idempotency_key??hash(`${c.callId}:order.create:${requestHash}`).slice(0,48);
      const {data,error}=await c.supabase.rpc("create_ai_order_idempotent",{p_agent_id:c.agentId,p_restaurant_id:c.restaurantId,p_location_id:c.locationId,p_idempotency_key:idempotencyKey,p_request_hash:requestHash,p_customer_name:q.customer_name,p_customer_phone:q.customer_phone,p_fulfillment_type:q.fulfillment_type,p_notes:q.notes??null,p_scheduled_for:q.scheduled_for??null,p_delivery_address_line1:q.delivery_address_line1??null,p_delivery_address_line2:q.delivery_address_line2??null,p_delivery_city:q.delivery_city??null,p_delivery_province:q.delivery_province??null,p_delivery_postal_code:q.delivery_postal_code??null,p_delivery_instructions:q.delivery_instructions??null,p_table_number:q.table_number??null,p_items:items});if(error)throw error;const order=data as any;
      await c.supabase.from("ai_working_orders").update({status:"created",created_order_id:order?.id??null,updated_at:new Date().toISOString()}).eq("id",state.id);return ok({order},201)
    }
    return fail("UNKNOWN_WORKING_ORDER_OPERATION","That working-order operation is not available.",404,false);
  }catch(error){console.error(`Working order ${op}`,error);const raw=error instanceof Error?error.message:String(error);if(raw.includes("WORKING_ORDER_EXPIRED"))return fail("ORDER_NOT_READY","The working order expired. Start resolving the order again.",409);return fail("REQUEST_REJECTED","The restaurant could not complete that order-state request. Please retry or escalate to staff.",400,true)}
}
