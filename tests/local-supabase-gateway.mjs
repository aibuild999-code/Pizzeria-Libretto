import http from "node:http";

const listenPort = Number(process.env.LOCAL_SUPABASE_GATEWAY_PORT ?? 3001);
const postgrestOrigin = process.env.LOCAL_POSTGREST_ORIGIN ?? "http://127.0.0.1:3002";
const REST_PREFIX = "/rest/v1";

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url?.startsWith(REST_PREFIX)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Local Supabase gateway only exposes /rest/v1" }));
      return;
    }

    const upstreamPath = req.url.slice(REST_PREFIX.length) || "/";
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value == null || ["host", "connection", "content-length"].includes(name.toLowerCase())) continue;
      if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
      else headers.set(name, value);
    }

    const upstream = await fetch(`${postgrestOrigin}${upstreamPath}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      redirect: "manual",
    });

    const responseBody = Buffer.from(await upstream.arrayBuffer());
    const responseHeaders = {};
    upstream.headers.forEach((value, name) => {
      if (!["connection", "transfer-encoding", "content-length"].includes(name.toLowerCase())) responseHeaders[name] = value;
    });
    responseHeaders["content-length"] = String(responseBody.length);
    res.writeHead(upstream.status, responseHeaders);
    res.end(responseBody);
  } catch (error) {
    console.error("LOCAL_SUPABASE_GATEWAY_ERROR", error);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Local Supabase gateway failed" }));
  }
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`LOCAL_SUPABASE_GATEWAY_READY http://127.0.0.1:${listenPort}/rest/v1 -> ${postgrestOrigin}`);
});
