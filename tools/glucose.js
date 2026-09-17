import { getLatestGlucose } from "../lib/dexcomShare.js";

export const glucoseTool = {
  name: "get_glucose",
  config: {
    title: "Get Latest Blood Glucose",
    description:
      "Fetches the most recent Dexcom CGM blood glucose reading in mg/dL, the trend direction, and how many minutes old the reading is.",
    inputSchema: {},
  },
  handler: async () => {
    try {
      const reading = await getLatestGlucose();
      if (!reading) {
        return {
          content: [{ type: "text", text: "No recent glucose reading is available." }],
        };
      }

      const age = reading.minutesAgo === null ? "" : ` (${reading.minutesAgo} min ago)`;
      return {
        content: [
          {
            type: "text",
            text: `${reading.mgdl} mg/dL, ${reading.trendDescription}${age}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to fetch glucose reading: ${err.message}` }],
        isError: true,
      };
    }
  },
};
