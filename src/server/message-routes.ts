import { z } from "zod";
import { messageDeliveryModes } from "./message-delivery.ts";
import { saveMessageImages } from "./message-images.ts";
import { confirmedMessages } from "./message-status.ts";
import { eventStream } from "./sse.ts";
import { attachmentOwner, errorMessage, type App, type Ctx, type RouteContext } from "./route-context.ts";

/**
 * Sending to an agent: staged attachments, direct messages (send, steer, interrupt), and the
 * server-side queue that delivers a message when the agent next goes idle.
 */
export function registerMessageRoutes(app: App, { store, hosts, attachments, sendQueue, streamValidity, encodingOf }: RouteContext) {
  const target = (c: Ctx) => [c.req.param("host")!, c.req.param("agent")!] as const;

  // ---- Attachments -----------------------------------------------------------------------------
  app.get("/api/hosts/:host/agents/:agent/attachments/capabilities", async (c) =>
    c.json(await attachments.capabilities(hosts, ...target(c))));
  app.post("/api/hosts/:host/agents/:agent/attachments", async (c) => {
    const [host, agent] = target(c);
    hosts.get(host);
    try {
      const name = decodeURIComponent(c.req.header("x-file-name") ?? "");
      const mime = c.req.header("content-type")?.split(";")[0].trim().toLowerCase() || "application/octet-stream";
      return c.json(attachments.put(attachmentOwner(c), host, agent, name, mime, Buffer.from(await c.req.arrayBuffer())), 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });
  app.delete("/api/hosts/:host/agents/:agent/attachments/:id", (c) => {
    try {
      attachments.remove(c.req.param("id"), attachmentOwner(c), ...target(c));
    } catch {
      return c.json({ error: "Attachment already expired or unavailable" }, 404);
    }
    return c.json({ ok: true });
  });

  // ---- Queue -----------------------------------------------------------------------------------
  /** Runs a queue operation; its refusal (being sent, gone, …) is a 409 with the reason. */
  const queueOp = async (c: Ctx, op: () => unknown) => {
    try {
      await op();
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 409);
    }
    return c.json({ ok: true });
  };
  app.get("/api/queue/stream", (c) => eventStream(c.req.raw.signal, (send) => {
    const publish = () => send(sendQueue.summary());
    const stop = sendQueue.onChange(publish), stopHosts = hosts.onAgentsChanged(publish);
    publish();
    return () => { stop(); stopHosts(); };
  }, streamValidity(c), encodingOf(c)));
  app.get("/api/hosts/:host/agents/:agent/queue/stream", (c) => eventStream(c.req.raw.signal, (send) => {
    const publish = () => send(sendQueue.list(...target(c)));
    const stop = sendQueue.onChange(publish);
    publish();
    return stop;
  }, streamValidity(c), encodingOf(c)));
  app.get("/api/hosts/:host/agents/:agent/queue", (c) => c.json(sendQueue.list(...target(c))));
  app.post("/api/hosts/:host/agents/:agent/queue", async (c) => {
    const input = z.object({ id: z.string().uuid(), text: z.string().trim().max(100000),
      attachmentIds: z.array(z.string().uuid()).max(4).default([]) })
      .refine((v) => !!v.text || !!v.attachmentIds.length).parse(await c.req.json());
    const [host, agent] = target(c);
    hosts.get(host);
    if (sendQueue.accepted(host, agent, input.id)) return c.json({ ok: true });
    try {
      const attachmentNames = input.attachmentIds.map((id) => attachments.get(id, attachmentOwner(c), host, agent).name);
      const prepared = await attachments.prepare(hosts, attachmentOwner(c), host, agent, input.attachmentIds);
      sendQueue.add({ id: input.id, text: input.text, host, agent, attachmentNames, prepared });
      attachments.consumed(input.attachmentIds);
      return c.json({ ok: true }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });
  app.post("/api/hosts/:host/agents/:agent/queue/:id/control", async (c) => {
    const { action } = z.object({ action: z.enum(["pause", "resume", "up", "check"]) }).parse(await c.req.json());
    return queueOp(c, () => sendQueue.control(...target(c), c.req.param("id"), action));
  });
  app.delete("/api/hosts/:host/agents/:agent/queue/:id", (c) =>
    queueOp(c, () => sendQueue.remove(...target(c), c.req.param("id"))));
  app.patch("/api/hosts/:host/agents/:agent/queue/:id", async (c) => {
    const { text } = z.object({ text: z.string().max(100000) }).parse(await c.req.json());
    return queueOp(c, () => sendQueue.edit(...target(c), c.req.param("id"), text));
  });
  app.post("/api/hosts/:host/agents/:agent/queue/:id/send", (c) =>
    queueOp(c, () => sendQueue.interrupt(...target(c), c.req.param("id"))));

  // ---- Direct messages -------------------------------------------------------------------------
  app.post("/api/hosts/:host/agents/:agent/messages/status", async (c) => {
    const { messageIds } = z.object({ messageIds: z.array(z.string().uuid()).min(1).max(20) }).parse(await c.req.json());
    const { driver } = hosts.get(c.req.param("host"));
    return c.json({ confirmed: await confirmedMessages(driver, c.req.param("agent"), messageIds) });
  });
  app.post("/api/hosts/:host/agents/:agent/messages", async (c) => {
    const input = z
      .object({
        text: z.string().trim().max(100000),
        attachmentIds: z.array(z.string().uuid()).max(4).refine((ids) => new Set(ids).size === ids.length).default([]),
        messageId: z.string().uuid(),
        behavior: z.enum(["send", "steer", "interrupt"]),
      })
      .refine((input) => !!input.text || input.attachmentIds.length > 0)
      .parse(await c.req.json());
    const [host, agent] = target(c);
    if (input.behavior === "steer") {
      const provider = hosts.get(host).directory.facts(agent)?.provider;
      if (!provider || !messageDeliveryModes(provider).includes("steer"))
        return c.json({ error: "Steer is unavailable for this provider. Your message was not sent. Choose Queue or Interrupt.", delivery: "not-sent" }, 409);
      const summary = hosts.agents.get(`${host}:${agent}`);
      const active = summary && summary.status !== "initializing" &&
        (summary.turnActive === true || (summary.turnActive === undefined && summary.status === "running"));
      if (!active)
        return c.json({ error: "There is no active turn to steer. Your message was not sent. Wait for the agent or send a new message.", delivery: "not-sent" }, 409);
    }
    if (input.behavior === "send") {
      const summary = hosts.agents.get(`${host}:${agent}`);
      const idle = summary && (summary.turnActive === false ||
        (summary.turnActive === undefined && summary.status !== "running" && summary.status !== "initializing"));
      if (!idle)
        return c.json({ error: "The agent is no longer idle. Your message was not sent. Choose Queue or Interrupt.", delivery: "not-sent" }, 409);
    }
    let prepared;
    try {
      prepared = await attachments.prepare(hosts, attachmentOwner(c), host, agent, input.attachmentIds);
      saveMessageImages(store, host, agent, input.messageId, prepared.images);
    } catch (error) {
      return c.json({ error: errorMessage(error), delivery: "not-sent" }, 400);
    }
    try {
      await hosts
        .get(host)
        .api.agents.ref(agent)
        .send(input.text, { messageId: input.messageId, activeTurnBehavior: input.behavior === "send" ? "steer" : input.behavior,
          ...(prepared.images.length ? { images: prepared.images } : {}),
          ...(prepared.attachments.length ? { attachments: prepared.attachments } : {}),
        });
      attachments.consumed(input.attachmentIds);
      return c.json({ status: "acknowledged", messageId: input.messageId });
    } catch {
      return c.json({ error: "Delivery outcome unknown. Refresh the conversation before retrying.", messageId: input.messageId }, 502);
    }
  });
}
