import connect from "connect";
import {
  DefaultJobOptions,
  QuirrelClient,
  QuirrelJobHandler,
  EnqueueJobOptions,
  Job,
  QuirrelPublishClient,
} from "./client";
import bodyParser from "body-parser";

export { DefaultJobOptions, QuirrelJobHandler, EnqueueJobOptions, Job };

export type Queue<Payload> = connect.Server & QuirrelPublishClient<Payload>;

declare module "connect" {
  export interface IncomingMessage {
    body: string;
  }
}

export function Queue<Payload>(
  route: string,
  handler: QuirrelJobHandler<Payload>,
  defaultJobOptions?: DefaultJobOptions
): Queue<Payload> {
  const quirrel = new QuirrelClient({
    route,
    handler,
    defaultJobOptions,
  });

  const server = connect() as Queue<Payload>;

  server.use(bodyParser.text());
  server.use(async (req, res, next) => {
    if (req.url !== "/" + route) {
      return next();
    }

    const { body, status, headers } = await quirrel.respondTo(
      req.body,
      req.headers as Record<string, string>
    );

    res.statusCode = status;
    for (const [header, value] of Object.entries(headers)) {
      res.setHeader(header, value);
    }
    res.write(body);
    res.end();
  });

  server.enqueue = (payload, options) => quirrel.enqueue(payload, options);
  server.enqueueMany = (jobs) => quirrel.enqueueMany(jobs);
  server.get = () => quirrel.get();
  server.delete = (id) => quirrel.delete(id);
  server.getById = (id) => quirrel.getById(id);
  server.invoke = (id) => quirrel.invoke(id);

  return server;
}

export function CronJob(
  route: string,
  cronSchedule: string,
  handler: () => Promise<void>
) {
  return Queue(route, handler) as unknown;
}
