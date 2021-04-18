import { Logger } from "./logger";
import chalk from "chalk";
import { JobDTO } from "../../client/job";

function getQueueName(endpoint: string) {
  return new URL(endpoint).pathname;
}

export class DxLogger implements Logger {
  started(address = "localhost:9181", telemetryEnabled = true) {
    console.log(
      chalk`
{yellow Quirrel}
{yellow =======}
Welcome to the Quirrel development server.

Open your browser and go to
    {yellow https://ui.quirrel.dev}
to get a better overview over pending jobs.
${
  telemetryEnabled
    ? chalk`
Quirrel collects {black completely anonymous}
telemetry data about general usage,
opt-out by setting the {yellow DISABLE_TELEMETRY}
environment variable.
`
    : ""
}
Listening on {yellow ${address}}.`.trim()
    );
  }

  executionErrored(
    job: { tokenId: string; id: string; endpoint: string; body: string },
    error: string
  ): void {
    console.error("Caught error during execution:", error, job);
  }
  jobCreated(
    job: JobDTO & {
      tokenId: string;
    }
  ): void {
    if (job.id === "@cron") {
      console.log(
        chalk`
⏰Registered a Cron Job
   {gray endpoint:} {yellow ${getQueueName(job.endpoint)}}
   {gray schedule:} {yellow ${job.repeat?.cron}}`
      );

      return;
    }

    console.log(
      chalk`
📝Created Job
   {gray queue:} {yellow ${getQueueName(job.endpoint)}}
      {gray id:} {yellow ${job.id}}
    {gray body:} {yellow ${job.body}}`
    );
  }

  // @ts-ignore
  jobDeleted(
    job: JobDTO & {
      tokenId: string;
    }
  ): void {
    if (job.id === "@cron") {
      console.log(
        chalk`
⏰Unregistered a Cron Job
   {gray endpoint:} {yellow ${getQueueName(job.endpoint)}}`
      );

      return;
    }
  }

  startingExecution(job: {
    id: string;
    tokenId: string;
    endpoint: string;
    body: string;
  }): () => void {
    console.log(
      chalk`
👟Executing job
  {gray queue:} {yellow ${getQueueName(job.endpoint)}}
     {gray id:} {yellow ${job.id}}
   {gray body:} {yellow ${job.body}}`
    );
    return () => {
      console.log("\n" + chalk`✔️ Successfully executed {yellow ${job.id}}.`);
    };
  }
}
