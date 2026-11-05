// Response helpers shared by the routes and the controllers. They write the raw
// Node response, so Express adds no ETag, body or headers of its own.
import type { ServerResponse } from "node:http";

export function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(`${body}\n`);
}

// No body and no content type, as the bridge answers a 401, 404 or 413.
export function empty(res: ServerResponse, status: number): void {
  res.writeHead(status).end();
}
