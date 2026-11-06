// Helpers shared by the routes and the controllers. The response helpers write the
// raw Node response, so Express adds no ETag, body or headers of its own.
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { RequestHandler } from "express";
import getRawBody from "raw-body";

export function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(`${body}\n`);
}

// No body and no content type, as the bridge answers a 401, 404 or 413.
export function empty(res: ServerResponse, status: number, headers?: OutgoingHttpHeaders): void {
  res.writeHead(status, headers).end();
}

// Leaves req.body as the bytes sent, for a route that checks a signature over them.
// Nothing is decompressed. A body over the limit gets an empty 413 as soon as that is
// known, from Content-Length or mid-stream, and the connection closes rather than
// reading the rest. (express.raw() reads all of it before answering.)
export function rawBody(limit: number): RequestHandler {
  return (req, res, next) => {
    getRawBody(req, { length: req.headers["content-length"], limit }).then(
      (body) => {
        req.body = body;
        next();
      },
      (err: getRawBody.RawBodyError) => {
        if (err.type === "entity.too.large") empty(res, 413, { connection: "close" });
        else next(err);
      },
    );
  };
}
