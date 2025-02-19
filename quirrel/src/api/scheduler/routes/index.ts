import { FastifyPluginCallback } from "fastify";

const welcomePage = `
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/water.css">

<h1>
Welcome to the Quirrel API!
</h1>

<p>
As an end-user, you're most likely looking for something else:
</p>

<ul>
  <li>
    <a href="https://quirrel.dev">Landing Page</a>
  </li>
  <li>
    <a href="https://docs.quirrel.dev">Documentation</a>
  </li>
  <li>
    <a href="https://github.com/quirrel-dev">Github</a>
  </li>
</ul>

<p>
If you didn't get here by accident, but want to interface directly with the Quirrel API,
take a look at the <a href="/documentation">OpenAPI spec</a>.
</p>

<footer>
  Built with &#10084; by <a href="https://twitter.com/skn0tt">@skn0tt</a>.
</footer>
`.trim();

const index: FastifyPluginCallback = (fastify, opts, done) => {
  fastify.get(
    "/",
    { schema: { tags: ["Admin"], summary: "About Page" } },
    (request, reply) => {
      reply.status(200).header("Content-Type", "text/html").send(welcomePage);
    }
  );
  done();
};

export default index;
