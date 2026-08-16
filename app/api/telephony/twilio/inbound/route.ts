import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RETELL_AGENT_ID = "agent_924244c1b1086d65ca801c29df";
const EXPECTED_TWILIO_NUMBER = "+17372508034";

function xmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function twiml(body: string, status = 200) {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function safeFailure() {
  return twiml(
    "<Say>I'm sorry, the restaurant phone system is temporarily unavailable. Please try again shortly.</Say><Hangup />",
    200,
  );
}

function timingSafeBase64Equal(expected: string, received: string) {
  const expectedBuffer = Buffer.from(expected, "base64");
  const receivedBuffer = Buffer.from(received, "base64");
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function isValidTwilioRequest(request: Request, params: URLSearchParams) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = request.headers.get("X-Twilio-Signature");
  if (!authToken || !signature) return false;

  const url = new URL(request.url);
  const sortedParams = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const data = url.toString().split("?")[0] + sortedParams.map(([key, value]) => `${key}${value}`).join("");
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  return timingSafeBase64Equal(expected, signature);
}

export async function POST(request: Request) {
  const formBody = await request.text();
  const params = new URLSearchParams(formBody);

  if (!(await isValidTwilioRequest(request, params))) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const fromNumber = params.get("From")?.trim() ?? "";
  const toNumber = params.get("To")?.trim() ?? "";
  const callSid = params.get("CallSid")?.trim() ?? "";

  if (!fromNumber || !toNumber || toNumber !== EXPECTED_TWILIO_NUMBER || !callSid) {
    return safeFailure();
  }

  const retellApiKey = process.env.RETELL_API_KEY;
  if (!retellApiKey) {
    console.error("Twilio inbound: RETELL_API_KEY is not configured");
    return safeFailure();
  }

  try {
    const retellResponse = await fetch("https://api.retellai.com/v2/register-phone-call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${retellApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: RETELL_AGENT_ID,
        from_number: fromNumber,
        to_number: toNumber,
        direction: "inbound",
        metadata: { twilio_call_sid: callSid },
      }),
      cache: "no-store",
    });

    if (!retellResponse.ok) {
      console.error("Twilio inbound: Retell registration failed", {
        status: retellResponse.status,
        callSid,
      });
      return safeFailure();
    }

    const registration = (await retellResponse.json()) as { call_id?: unknown };
    if (typeof registration.call_id !== "string" || !registration.call_id) {
      console.error("Twilio inbound: Retell registration returned no call_id", { callSid });
      return safeFailure();
    }

    const sipUri = `sip:${registration.call_id}@sip.retellai.com`;
    return twiml(`<Dial><Sip>${xmlEscape(sipUri)}</Sip></Dial>`);
  } catch (error) {
    console.error("Twilio inbound: unexpected Retell registration error", {
      callSid,
      error: error instanceof Error ? error.message : "unknown error",
    });
    return safeFailure();
  }
}
