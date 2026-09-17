import { z } from "zod";
import { getGlucoseHistory } from "../lib/dexcomShare.js";

export const glucoseHistoryTool = {
  name: "get_glucose_history",
  config: {
    title: "Get Blood Glucose History",
    description:
      "Fetches Dexcom CGM readings over a recent time window (up to 24 hours) and summarizes time in range, lows, highs, and average, plus the raw readings.",
    inputSchema: {
      hours: z
        .number()
        .min(1)
        .max(24)
        .optional()
        .describe("How many hours of history to fetch, 1-24. Defaults to 24."),
      lowThreshold: z
        .number()
        .optional()
        .describe("mg/dL below this counts as low. Defaults to 70."),
      highThreshold: z
        .number()
        .optional()
        .describe("mg/dL above this counts as high. Defaults to 180."),
    },
  },
  handler: async ({ hours = 24, lowThreshold = 70, highThreshold = 180 }) => {
    try {
      const readings = await getGlucoseHistory({ hours });

      if (readings.length === 0) {
        return {
          content: [{ type: "text", text: "No glucose readings are available for that window." }],
        };
      }

      const values = readings.map((r) => r.mgdl);
      const average = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
      const lowCount = values.filter((v) => v < lowThreshold).length;
      const highCount = values.filter((v) => v > highThreshold).length;
      const inRangeCount = readings.length - lowCount - highCount;
      const inRangePct = Math.round((inRangeCount / readings.length) * 100);
      const min = Math.min(...values);
      const max = Math.max(...values);

      const summary =
        `Last ${hours}h (${readings.length} readings): ` +
        `avg ${average} mg/dL, range ${min}-${max}. ` +
        `${inRangePct}% in range (${lowThreshold}-${highThreshold}), ` +
        `${lowCount} low reading(s), ${highCount} high reading(s).`;

      const readingsList = readings
        .map((r) => `${r.timestamp?.toISOString() ?? "unknown time"}: ${r.mgdl} mg/dL (${r.trendDescription})`)
        .join("\n");

      return {
        content: [
          { type: "text", text: summary },
          { type: "text", text: readingsList },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to fetch glucose history: ${err.message}` }],
        isError: true,
      };
    }
  },
};
