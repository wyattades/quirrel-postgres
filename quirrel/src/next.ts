import {
  QuirrelClient,
  EnqueueJobOptions,
  Job,
  DefaultJobOptions,
  QuirrelJobHandler,
  QuirrelPublishClient,
} from "./client";
import { registerDevelopmentDefaults } from "./client/config";
import type { IncomingHttpHeaders } from "http";

interface NextApiRequest {
  body: any;
  headers: IncomingHttpHeaders;
}

interface NextApiResponse {
  setHeader(key: string, value: string): void;
  status(code: number): void;
  send(body: string): void;
}

export { Job, EnqueueJobOptions, DefaultJobOptions, QuirrelJobHandler };

registerDevelopmentDefaults({
  applicationBaseUrl: "http://localhost:3000",
});

export type Queue<Payload> = QuirrelPublishClient<Payload>
>;

export function Queue<Payload>(
  route: string,
  handler: QuirrelJobHandler<Payload>,
  defaultJobOptions?: DefaultJobOptions
): Queue<Payload> {
  const quirrel = new QuirrelClient<Payload>({
    defaultJobOptions,
    handler,
    route,
  });

  async function nextApiHandler(req: NextApiRequest, res: NextApiResponse) {
    const response = await quirrel.respondTo(req.body, req.headers);
    res.status(response.status);
    for (const [header, value] of Object.entries(response.headers)) {
      res.setHeader(header, value);
    }
    res.send(response.body);
  }

  nextApiHandler.enqueue = (payload: Payload, options: EnqueueJobOptions) =>
    quirrel.enqueue(payload, options);

  nextApiHandler.enqueueMany = (
    jobs: { payload: Payload; options?: EnqueueJobOptions }[]
  ) => quirrel.enqueueMany(jobs);

  nextApiHandler.delete = (jobId: string) => quirrel.delete(jobId);

  nextApiHandler.invoke = (jobId: string) => quirrel.invoke(jobId);

  nextApiHandler.get = () => quirrel.get();

  nextApiHandler.getById = (jobId: string) => quirrel.getById(jobId);

  return nextApiHandler;
}

export function CronJob(
  route: string,
  cronSchedule: string,
  handler: () => Promise<void>
) {
  return Queue(route, handler) as unknown;
}

export const config = {
  api: {
    bodyParser: false,
  },
};
