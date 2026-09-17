import { z } from "zod";

export const helloTool = {
  name: "hello",
  config: {
    title: "Hello World",
    description: "Says hello, optionally to a specific name.",
    inputSchema: { name: z.string().optional() },
  },
  handler: async ({ name }) => ({
    content: [{ type: "text", text: `Hello, ${name ?? "world"}!` }],
  }),
};
