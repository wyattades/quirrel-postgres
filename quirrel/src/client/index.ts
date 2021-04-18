import * as z from "zod";
import Encryptor from "secure-e2ee";
import { verify } from "secure-webhooks";
import ms from "ms";
import fetch from "cross-fetch";
import type { IncomingHttpHeaders } from "http";
import { PrismaClient, job as DbJob } from "@prisma/client";

import { Job, JobDTO, JobId } from "./job";
import * as config from "./config";
import pack from "../../package.json";
import * as EnhancedJSON from "./enhanced-json";
import { isValidRegex } from "../shared/is-valid-regex";

export { Job };

export interface JobMeta
  extends Pick<JobDTO, "id" | "count" | "exclusive" | "retry"> {
  /**
   * If this is a repeated job, the next repetition will be scheduled for this Date.
   */
  readonly nextRepetition?: Date;
}

export type QuirrelJobHandler<T> = (job: T, meta: JobMeta) => Promise<void>;
export type DefaultJobOptions = Pick<EnqueueJobOptions, "exclusive" | "retry">;

interface CreateQuirrelClientArgs<T> {
  route: string;
  handler: QuirrelJobHandler<T>;
  defaultJobOptions?: DefaultJobOptions;
  config?: {
    /**
     * Recommended way to set this: process.env.QUIRREL_DATABASE_URL
     */
    databaseUrl?: string;

    /**
     * Recommended way to set this: process.env.QUIRREL_BASE_URL
     */
    applicationBaseUrl?: string;

    /**
     * @deprecated
     * Overrides URL of the Quirrel Endpoint.
     * @default https://api.quirrel.dev or http://localhost:9181
     * Recommended way to set this: process.env.QUIRREL_URL
     */
    quirrelBaseUrl?: string;

    /**
     * Bearer Secret for authenticating with Quirrel.
     * Obtain on quirrel.dev or using the API of a self-hosted instance.
     * Recommended way to set this: process.env.QUIRREL_TOKEN
     */
    token?: string;

    /**
     * Secret used for end-to-end encryption.
     * Needs to be 32 characters long.
     * Recommended way to set this: process.env.QUIRREL_ENCRYPTION_SECRET
     */
    encryptionSecret?: string;

    /**
     * Old Secrets that have been rotated out.
     * @see https://docs.quirrel.dev/docs/faq#my-encryption-secret-has-been-leaked-what-now
     * Recommended way to set this: process.env.QUIRREL_OLD_SECRETS
     */
    oldSecrets?: string[];
  };

  fetch?: typeof fetch;
  catchDecryptionErrors?: (error: Error) => void;
}

const vercelMs = z
  .string()
  .regex(
    /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i,
    "Please provide a valid time span, according to https://github.com/vercel/ms"
  );

const timeDuration = (fieldName = "duration") =>
  z.union([
    z.number().min(1, { message: `${fieldName} must be positive` }),
    vercelMs,
  ]);

export const cron = z
  .string()
  .refine(
    isValidRegex,
    "Please provide a valid Cron expression. See https://github.com/harrisiirak/cron-parser for reference"
  );

const EnqueueJobOptionsSchema = z.object({
  id: z.string().or(z.number()).optional(),
  exclusive: z.boolean().optional(),
  override: z.boolean().optional(),
  retry: z.array(timeDuration("retry")).min(1).max(10).optional(),
  delay: timeDuration("delay").optional(),
  runAt: z
    .date()
    .refine((date) => Date.now() <= +date, {
      message: "runAt must not be in the past",
    })
    .optional(),
  repeat: z
    .object({
      every: timeDuration("every").optional(),
      times: z.number().nonnegative().optional(),
      cron: cron.optional(),
    })
    .optional(),
});

type EnqueueJobOptionsSchema = z.TypeOf<typeof EnqueueJobOptionsSchema>;

const httpRequestSQL = (
  url: string,
  method = "GET",
  body = {},
  headers = {}
) => {
  return `http((
    '${method}',
    '${url}',
    ARRAY[${Object.entries(headers)
      .map((k, v) => `http_header('${k}','${v}')`)
      .join(",")}],
    'application/json',
    '${JSON.stringify(body)}'
  )::http_request)`;
};

// const timestampToCronSchedule = (timestamp: number) => {
//   const date = new Date(timestamp);

//   return `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth()} *`;
// };

// type EnqueueJobOptionssSchemaMatchesDocs = AssertTrue<
//   IsExact<EnqueueJobOptions, EnqueueJobOptionsSchema>
// >;

export interface EnqueueJobOptions {
  /**
   * Can be used to make a job easier to manage.
   * If there's already a job with the same ID, this job will be trashed.
   * @tutorial https://demo.quirrel.dev/managed
   */
  id?: JobId;

  /**
   * If set to `true`,
   * no other job (on the same queue)
   * will be executed at the same time.
   */
  exclusive?: boolean;

  /**
   * If a job fails, retry it at along the specified intervals.
   * @example ["5min", "1h", "1d"] // retries it after 5 minutes, 1:05 hours, and 1 day 1:05 hours
   */
  retry?: (number | string)[];

  /**
   * Determines what to do when a job
   * with the same ID already exists.
   * false: do nothing (default)
   * true: replace the job
   */
  override?: boolean;

  /**
   * Will delay the job's execution by the specified amount of milliseconds.
   * Supports human-readable notation as of @see https://github.com/vercel/ms.
   * If used together with `repeat`, this will delay the first job to be executed.
   */
  delay?: number | string;

  /**
   * Schedules the job for execution at the specified timestamp.
   */
  runAt?: Date;

  repeat?: {
    /**
     * Will make the job repeat every X milliseconds.
     * Supports human-readable notation as of @see https://github.com/vercel/ms.
     * If `delay` isn't set, the first repetition will be executed immediately.
     */
    every?: number | string;

    /**
     * Can be used in conjunction with @field every and @field cron
     * to limit the number of executions.
     */
    times?: number;

    /**
     * Schedules the job according to the Cron expression.
     * @see https://github.com/harrisiirak/cron-parser for supported syntax
     * If `delay` isn't set, the first repetition will be executed immediately.
     */
    cron?: string;
  };
}

function parseDuration(value: number | string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    return ms(value);
  }

  return value;
}

function runAtToDelay(value: Date) {
  return +value - Date.now();
}

function getEncryptor(
  encryptionSecret: string | undefined,
  oldSecrets: string[] = []
) {
  if (!encryptionSecret) {
    return undefined;
  }

  return new Encryptor(encryptionSecret, [encryptionSecret, ...oldSecrets]);
}

function getAuthHeaders(
  token: string | undefined
): { Authorization: string } | {} {
  if (!token) {
    return {};
  }

  return { Authorization: `Bearer ${token}` };
}

let globalPrisma: PrismaClient | undefined;

export class QuirrelClient<T> {
  private handler;
  private route;
  private defaultJobOptions;
  private encryptor;
  private defaultHeaders: Record<string, string>;
  // private quirrelBaseUrl;
  private applicationBaseUrl;
  private databaseUrl;
  // private baseUrl;
  private token;
  private fetch;
  private catchDecryptionErrors;

  constructor(args: CreateQuirrelClientArgs<T>) {
    this.handler = args.handler;
    this.defaultJobOptions = args.defaultJobOptions;

    this.databaseUrl = args.config?.databaseUrl ?? config.getDatabaseUrl();

    const token = args.config?.token ?? config.getQuirrelToken();
    this.defaultHeaders = {
      ...getAuthHeaders(token),
      "X-QuirrelClient-Version": pack.version,
    };

    // const quirrelBaseUrl =
    //   args.config?.quirrelBaseUrl ?? config.getQuirrelBaseUrl();
    let applicationBaseUrl = config.prefixWithProtocol(
      args.config?.applicationBaseUrl ?? config.getApplicationBaseUrl()!
    );

    applicationBaseUrl = applicationBaseUrl.replace(
      "//localhost:",
      "//host.docker.internal:"
    );

    this.applicationBaseUrl = applicationBaseUrl;
    // this.quirrelBaseUrl = quirrelBaseUrl;
    this.route = args.route;
    // this.baseUrl =
    //   quirrelBaseUrl +
    //   "/queues/" +
    //   encodeURIComponent(applicationBaseUrl + "/" + this.route);

    this.token = args.config?.token ?? config.getQuirrelToken();
    this.encryptor = getEncryptor(
      args.config?.encryptionSecret ?? config.getEncryptionSecret(),
      args.config?.oldSecrets ?? config.getOldEncryptionSecrets() ?? undefined
    );
    this.catchDecryptionErrors = args.catchDecryptionErrors;

    this.fetch = args.fetch ?? fetch;
  }

  private get prisma() {
    if (!this.databaseUrl)
      throw new Error("Missing required QUIRREL_DATABASE_URL");

    // only instantiate it once
    globalPrisma ||= new PrismaClient({
      datasources: {
        db: {
          url: this.databaseUrl,
        },
      },
    });

    return globalPrisma;
  }

  beforeExit(cb: () => Promise<void>) {
    this.prisma.$on("beforeExit", async () => {
      await cb();
      // process.exit();
    });
  }

  async getAllCronJobs() {
    const dbJobs = await this.prisma.job.findMany();

    // const endpointsResponse = await this.makeRequest("/queues/");
    // const endpointsResult = z
    //   .array(z.string())
    //   .safeParse(await endpointsResponse.json());
    // const endpoints = endpointsResult.success ? endpointsResult.data : [];

    // const jobs: JobDTO[] = [];

    // await Promise.all(
    //   endpoints.map(async (endpoint) => {
    //     const jobRes = await this.makeRequest(
    //       `/queues/${encodeURIComponent(endpoint)}/${encodeURIComponent("@cron")}`
    //     );

    //     if (jobRes.status !== 200) {
    //       return;
    //     }

    //     jobs.push(await jobRes.json());
    //   })
    // );

    return dbJobs.map((j) => this.dbJobToJob(j));
  }

  // TODO
  async getQueuedEndpoints() {
    return [];
    // const jobs = await this.getAllCronJobs();

    // return jobs.map((j) => j.endpoint);
  }

  // async makeRequest(uri: string, init?: RequestInit) {
  //   return await this.fetch(this.quirrelBaseUrl + uri, {
  //     credentials: "omit",
  //     ...init,
  //     headers: {
  //       ...this.defaultHeaders,
  //       ...init?.headers,
  //     },
  //   });
  // }

  private async payloadAndOptionsToBody(
    payload: T,
    options: EnqueueJobOptionsSchema
  ) {
    if (typeof payload === "undefined") {
      throw new Error("Passing `undefined` as Payload is not allowed");
    }

    if (options.repeat && options.retry?.length) {
      throw new Error("retry and repeat cannot be used together");
    }

    options = EnqueueJobOptionsSchema.parse(options);

    let delay = parseDuration(options.delay);

    if ("runAt" in options && options.runAt) {
      delay = runAtToDelay(options.runAt);
    }

    if (options.repeat) {
      options.repeat.every = parseDuration(options.repeat?.every);
    }

    let stringifiedBody = EnhancedJSON.stringify(payload);

    if (this.encryptor) {
      stringifiedBody = await this.encryptor.encrypt(stringifiedBody);
    }

    return {
      ...this.defaultJobOptions,
      body: stringifiedBody,
      delay,
      id: options.id,
      repeat: options.repeat,
      retry: options.retry?.map(parseDuration),
      override: options.override,
    };
  }

  /**
   * Enqueue a job to the specified endpoint.
   * @param options job options
   */
  async enqueue(payload: T, options: EnqueueJobOptions = {}): Promise<Job<T>> {
    const body = await this.payloadAndOptionsToBody(payload, options);

    const endpoint = this.applicationBaseUrl + "/" + this.route;

    let jobId: JobId;

    const headers = {
      "x-quirrel-secret": "TODO-secret",
    };

    const cronSchedule = body.repeat?.cron;
    if (cronSchedule) {
      const jobName = `cron-job:${this.route}`.substring(0, 64);

      await this.deleteExisting(jobName);

      [{ schedule: jobId }] = await this.prisma.$queryRaw`
        select
        cron.schedule(
          ${jobName},
          ${cronSchedule}, 
          ${`
          select status
          from
            ${httpRequestSQL(endpoint, "POST", {}, headers)}
          `}
        );
      `;
    } else {
      throw new Error("UNIMPLEMENTED: 'schedule' is required");

      // const jobName = `delay-job:${body.id ?? this.route}`.substring(0, 64);

      // const runAt = Date.now() + Math.min(120000, body.delay || 0);

      // const in1Year = new Date();
      // in1Year.setFullYear(in1Year.getFullYear() + 1);
      // if (runAt > in1Year.getTime() - 120000)
      //   throw new Error("Cannot schedule more than 1 year in advance!");

      // [{ schedule: jobId }] = await this.prisma.$queryRaw`
      //   select
      //   cron.schedule(
      //     ${jobName},
      //     ${timestampToCronSchedule(runAt)},
      //     ${`
      //     select status from (
      //       select schedule from cron.unschedule('${jobName}')
      //     ), (
      //       select status from ${httpRequestSQL(
      //         endpoint,
      //         "POST",
      //         payload,
      //         headers
      //       )}
      //     )
      //     `}
      //   );
      // `;
    }

    const job = await this.getById(jobId);

    if (!job) throw new Error(`Job ${jobId} not found`);

    console.log(
      `enqueued job ${job.id}: "${job.repeat?.cron}" at "${job.endpoint}"`
    );

    return job;
  }

  /**
   * Enqueue multiple jobs
   */
  async enqueueMany(
    jobs: { payload: T; options?: EnqueueJobOptions }[]
  ): Promise<Job<T>[]> {
    throw new Error("UNIMPLEMENTED");
    // const body = await Promise.all(
    //   jobs.map(({ payload, options = {} }) =>
    //     this.payloadAndOptionsToBody(payload, options)
    //   )
    // );

    // const res = await this.fetch(this.baseUrl + "/batch", {
    //   method: "POST",
    //   headers: {
    //     "Content-Type": "application/json",
    //     ...this.defaultHeaders,
    //   },
    //   credentials: "omit",
    //   body: JSON.stringify(body),
    // });

    // if (res.status === 201) {
    //   const response = (await res.json()) as any[];
    //   return await Promise.all(response.map((job) => this.toJob(job)));
    // }

    // throw new Error(`Unexpected response: ${await res.text()}`);
  }

  private async decryptAndDecodeBody(body: any): Promise<T> {
    if (body == null || body === "") return {} as T;
    if (typeof body === "object") return body;
    if (typeof body !== "string")
      throw new Error(`Invalid encoded body type: ${typeof body}`);

    if (this.encryptor) {
      if (this.catchDecryptionErrors) {
        try {
          body = await this.encryptor.decrypt(body);
        } catch (error) {
          this.catchDecryptionErrors(error);
          return body as any;
        }
      } else {
        body = await this.encryptor.decrypt(body);
      }
    }

    return EnhancedJSON.parse(body);
  }

  private async toJob(dto: JobDTO): Promise<Job<T>> {
    return {
      ...dto,
      body: await this.decryptAndDecodeBody(dto.body),
      runAt: dto.runAt ? new Date(dto.runAt) : undefined,
      delete: () => this.delete(dto.id),
      invoke: () => this.invoke(dto.id),
    };
  }

  /**
   * Iterate through scheduled jobs for `this.route`.
   * @example
   * for await (const jobs of queue.get()) {
   *   // do smth
   * }
   */
  async *get(): AsyncGenerator<Job<T>[]> {
    const dbJobs = await this.prisma.job.findMany({
      where: {
        jobname: `cron-job:${this.route}`.substring(0, 64),
      },
    });

    yield await Promise.all(dbJobs.map((j) => this.toJob(this.dbJobToJob(j))));

    // let cursor: number | null = 0;
    // while (cursor !== null) {
    //   const res = await this.fetch(this.baseUrl + "?cursor=" + cursor, {
    //     headers: this.defaultHeaders,
    //   });
    //   const json = await res.json();
    //   const { cursor: newCursor, jobs } = json as {
    //     cursor: number | null;
    //     jobs: JobDTO[];
    //   };
    //   cursor = newCursor;
    //   yield await Promise.all(jobs.map((dto) => this.toJob(dto)));
    // }
  }

  private dbJobToJob(dbJob: DbJob): JobDTO {
    const endpoint = dbJob.command.match(/'(https?:\/\/.*?)'/)?.[1];
    if (!endpoint) throw new Error("Failed to parse job endpoint!");

    return {
      id: Number(dbJob.jobid),
      body: "",
      endpoint,
      repeat: {
        cron: dbJob.schedule,
      },
    };
  }

  /**
   * Get a specific job.
   * @returns null if no job was found.
   */
  async getById(id: JobId): Promise<Job<T> | null> {
    const dbJob = await this.prisma.job.findFirst({
      where: {
        jobid: Number(id),
      },
    });

    if (!dbJob) return null;

    return await this.toJob(this.dbJobToJob(dbJob));
  }

  /**
   * Schedule a job for immediate execution.
   * @returns false if job could not be found.
   */
  async invoke(id: JobId): Promise<boolean> {
    throw new Error("UNIMPLEMENTED");

    // const res = await this.fetch(this.baseUrl + "/" + id, {
    //   method: "POST",
    //   headers: this.defaultHeaders,
    // });

    // if (res.status === 404) {
    //   return false;
    // }

    // if (res.status === 204) {
    //   return true;
    // }

    // throw new Error("Unexpected response: " + (await res.text()));
  }

  /**
   * Delete a job, preventing it from executing.
   * @returns false if job could not be found.
   */
  async delete(id: JobId): Promise<boolean> {
    if (id === "@cron") {
      const count = await this.deleteExisting(
        `cron-job:${this.route}`.substring(0, 64)
      );

      return count > 0;
    } else if (typeof id === "number") {
      const { count } = await this.prisma.job.deleteMany({
        where: {
          jobid: Number(id),
        },
      });

      return count > 0;
    } else {
      throw new Error(`Invalid job id for delete: ${id}`);
    }

    // const res = await this.fetch(this.baseUrl + "/" + id, {
    //   method: "DELETE",
    //   headers: this.defaultHeaders,
    // });

    // if (res.status === 404) {
    //   return false;
    // }

    // if (res.status === 204) {
    //   return true;
    // }

    // throw new Error("Unexpected response: " + (await res.text()));
  }

  private async deleteExisting(jobName: string) {
    const { count } = await this.prisma.job.deleteMany({
      where: {
        jobname: jobName,
      },
    });

    if (count > 0)
      console.log(`Deleted ${count} existing job(s) for ${jobName}`);

    return count;
  }

  async deleteAll() {
    const { count } = await this.prisma.job.deleteMany();

    if (count > 0) console.log(`Deleted ${count} job(s) during cleanup`);
  }

  async respondTo(
    body: string,
    headers: IncomingHttpHeaders
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: any;
  }> {
    if (process.env.NODE_ENV === "production") {
      const signature = headers["x-quirrel-signature"];
      if (typeof signature !== "string") {
        return {
          status: 401,
          headers: {},
          body: "Signature missing",
        };
      }

      const valid = verify(body, this.token!, signature);
      if (!valid) {
        return {
          status: 401,
          headers: {},
          body: "Signature invalid",
        };
      }
    }

    const payload = await this.decryptAndDecodeBody(body);

    const { id, count, retry, nextRepetition, exclusive } = JSON.parse(
      (headers["x-quirrel-meta"] as string) ?? "{}"
    );

    console.log(`Received job to ${this.route}: `, payload);

    try {
      await this.handler(payload, {
        id,
        count,
        retry,
        nextRepetition,
        exclusive,
      });

      return {
        status: 200,
        headers: {},
        body: "OK",
      };
    } catch (error) {
      console.error(error);
      return {
        status: 500,
        headers: {},
        body: String(error),
      };
    }
  }
}

export type QuirrelPublishClient<T> = Pick<
  QuirrelClient<T>,
  "enqueue" | "enqueueMany" | "delete" | "get" | "getById" | "invoke"
>;
