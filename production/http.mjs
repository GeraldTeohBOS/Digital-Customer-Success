import {createServer} from "node:http";
import {Readable} from "node:stream";

export function listen(app,{origin,port,host}) {
  const server = createServer(async (incoming,outgoing) => {
    try {
      if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) {
        outgoing.writeHead(400).end();
        return;
      }
      const url = new URL(origin + incoming.url);
      const body = incoming.method === "POST" ? Readable.toWeb(incoming) : undefined;
      const request = new Request(url,{method:incoming.method,headers:incoming.headers,body,...(body ? {duplex:"half"} : {})});
      const response = await app(request);
      outgoing.statusCode = response.status;
      for (const [name,value] of response.headers) if (name !== "set-cookie") outgoing.setHeader(name,value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("Set-Cookie",cookies);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error("CS pilot request failed:",error.code || error.name);
      if (!outgoing.headersSent) outgoing.writeHead(500,{"Cache-Control":"no-store"});
      outgoing.end();
    }
  });
  server.requestTimeout = 30000;
  return server.listen(port,host);
}
