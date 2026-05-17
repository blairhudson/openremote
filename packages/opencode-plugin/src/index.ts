import type { Plugin } from "@opencode-ai/plugin";

export const server: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "openremote",
      level: "info",
      message: "openremote plugin loaded",
    },
  });

  return {
    event: async ({ event }) => {
      if (event.type !== "server.connected") return;
      await client.app.log({
        body: {
          service: "openremote",
          level: "info",
          message: "remote connected",
        },
      });
    },
  };
};
