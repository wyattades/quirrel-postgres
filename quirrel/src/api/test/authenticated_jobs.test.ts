import { run } from "./runQuirrel";
import fastify, { FastifyInstance } from "fastify";
import delay from "delay";
import { verify } from "secure-webhooks";
import type http from "http";
import request from "supertest";
import { describeAcrossBackends } from "../../client/test/util";

const passphrase = "hello";

describeAcrossBackends("Authenticated Jobs", (backend) => {
  let quirrel: http.Server;
  let teardown: () => Promise<void>;

  let server: FastifyInstance;
  let endpoint: string;
  let lastBody: any;
  let lastSignature: any;

  beforeAll(async () => {
    const res = await run(backend, [passphrase]);
    quirrel = res.server;
    teardown = res.teardown;

    await res.redis.flushall();

    const server = fastify();
    server.post("/", (request, reply) => {
      lastBody = request.body;
      lastSignature = request.headers["x-quirrel-signature"];
      reply.status(200).send("OK");
    });

    endpoint = encodeURIComponent(await server.listen(0));
  });

  afterAll(async () => {
    await Promise.all([teardown(), server.close()]);
  });

  test("post a job", async () => {
    const { text: token } = await request(quirrel)
      .put("/tokens/testproject")
      .auth("ignored", passphrase)
      .expect(201);

    await request(quirrel)
      .post("/queues/" + endpoint)
      .send({
        body: JSON.stringify({ foo: "bar" }),
      })
      .expect(401);

    await request(quirrel)
      .post("/queues/" + endpoint)
      .auth(token, { type: "bearer" })
      .send({
        body: JSON.stringify({ foo: "bar" }),
      })
      .expect(201);

    await delay(300);

    expect(lastBody).toEqual('{"foo":"bar"}');
    expect(lastSignature).toMatch(/v=(\d+),d=([\da-f]+)/);
    expect(verify(lastBody, token, lastSignature)).toBe(true);

    await request(quirrel)
      .delete("/tokens/non-existant")
      .auth("ignored", passphrase)
      .expect(404);

    await request(quirrel)
      .delete("/tokens/testproject")
      .auth("ignored", passphrase)
      .expect(204);

    await request(quirrel)
      .post("/queues/" + endpoint)
      .auth(token, { type: "bearer" })
      .send({
        body: JSON.stringify({ foo: "bar" }),
      })
      .expect(401);

    await request(quirrel)
      .delete("/usage")
      .auth("ignored", passphrase)
      .expect(200, {
        testproject: 2, // one for the initial call, one for execution
      });

    await request(quirrel)
      .delete("/usage")
      .auth("ignored", passphrase)
      .expect(200, {});
  });
  test("admin impersonation", async () => {
    await request(quirrel)
      .delete("/usage")
      .auth("ignored", passphrase)
      .expect(200);

    const { text: token } = await request(quirrel)
      .put("/tokens/this.is.a.project")
      .auth("ignored", passphrase)
      .expect(201);

    await request(quirrel)
      .post("/queues/" + endpoint)
      .auth("this.is.a.project", passphrase)
      .send({
        body: JSON.stringify({ foo: "bar" }),
      })
      .expect(201);

    await delay(300);

    expect(lastBody).toEqual('{"foo":"bar"}');
    expect(lastSignature).toMatch(/v=(\d+),d=([\da-f]+)/);
    expect(verify(lastBody, token, lastSignature)).toBe(true);

    await request(quirrel)
      .delete("/usage")
      .auth("ignored", passphrase)
      .expect(200, {
        // only one for execution
        "this.is.a.project": 1,
      });

    await request(quirrel)
      .post("/queues/" + endpoint)
      .set("x-quirrel-count-usage", "true")
      .auth("this.is.a.project", passphrase)
      .send({
        body: JSON.stringify({ foo: "bar" }),
      })
      .expect(201);

    await delay(300);

    await request(quirrel)
      .delete("/usage")
      .auth("ignored", passphrase)
      .expect(200, {
        // one for enqueueing, one for execution
        "this.is.a.project": 2,
      });
  });
});
