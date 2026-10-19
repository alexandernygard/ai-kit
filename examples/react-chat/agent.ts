import { anthropic } from "@ai-sdk/anthropic"
import { clientContext, currentTime, defineAgent, defineCommand, defineContext, definePlugin, jsonSchema, tool, toolkit } from "@alexandernygard/ai-kit"
import { aiSdk } from "@alexandernygard/ai-kit-ai-sdk"
import { claudeAgent } from "@alexandernygard/ai-kit-claude-agent"
import { loadSkills } from "@alexandernygard/ai-kit-node"

/** With ANTHROPIC_API_KEY, call the API; without it, run on your Claude subscription. */
const model = process.env.ANTHROPIC_API_KEY ? aiSdk(anthropic("claude-opus-5-5")) : claudeAgent({ model: "claude-opus-5-5" })
const cheap = process.env.ANTHROPIC_API_KEY ? aiSdk(anthropic("claude-haiku-5-5")) : claudeAgent({ model: "claude-haiku-5-5" })

const getWeather = tool({
  name: "get_weather",
  description: "Current weather and a 3-day forecast for a city.",
  input: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
  readOnly: true,
  title: ({ city }) => `Checking the weather in ${city}`,
  execute: async ({ city }) => {
    await new Promise((r) => setTimeout(r, 600))
    return { city, now: { tempC: 6, sky: "light rain" }, next3Days: [8, 11, 9] }
  },
})

/** A client tool: no `execute`, so the browser answers it (see clientTools in App.tsx). */
const getLocation = tool({
  name: "get_location",
  description: "The user's approximate location, from their browser.",
  readOnly: true,
  title: () => "Asking the browser for your location",
})

/** Deferred: the agent finds these with search_tools when it needs them. */
const bookings = toolkit({
  name: "bookings",
  description: "Search and book flights and hotels",
  defer: true,
  instructions: "Always confirm dates and the traveller count before booking.",
  tools: [
    tool({
      name: "search_flights",
      description: "Find flights between two airports on a date.",
      input: jsonSchema<{ from: string; to: string; date: string }>({
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" } },
        required: ["from", "to", "date"],
      }),
      readOnly: true,
      title: (i) => `Searching flights ${i.from} to ${i.to}`,
      execute: ({ from, to, date }) => [
        { id: "SK4021", from, to, date, departs: "07:40", priceNok: 1290 },
        { id: "DY612", from, to, date, departs: "12:15", priceNok: 990 },
      ],
    }),
    tool({
      name: "book_flight",
      description: "Book a flight by id. Charges the saved card.",
      input: jsonSchema<{ flightId: string; travellers: number }>({
        type: "object",
        properties: { flightId: { type: "string" }, travellers: { type: "integer" } },
        required: ["flightId", "travellers"],
      }),
      needsApproval: true,
      destructive: true,
      title: (i) => `Booking ${i.flightId} for ${i.travellers}`,
      execute: ({ flightId }) => ({ confirmation: `ABC${flightId.slice(-3)}`, status: "booked" }),
    }),
  ],
})

const researcher = defineAgent({
  name: "researcher",
  description: "Looks up facts about destinations: seasons, neighbourhoods, transport.",
  instructions: "Answer the question in under 120 words with concrete facts.",
  model: cheap,
})

const travel = definePlugin({
  name: "travel",
  tools: [getWeather, getLocation, bookings],
  commands: [
    defineCommand({
      name: "plan",
      description: "Plan a trip",
      argumentHint: "<destination>",
      prompt: (dest) => `Plan a weekend trip to ${dest || "somewhere nearby"}. Use the trip-planning skill.`,
    }),
  ],
})

export async function createAgent() {
  return defineAgent({
    name: "concierge",
    description: "A travel concierge",
    instructions: "You are a friendly travel concierge. Be concise. Ask with ask_user when you need a decision.",
    model,
    plugins: [travel],
    skills: await loadSkills(new URL("./skills", import.meta.url).pathname),
    subagents: [researcher],
    builtins: { askUser: true, todos: true },
    contextProviders: [
      // Trusted, from the server's auth (server.ts).
      defineContext({ name: "traveller", get: ({ context }) => ({ name: context?.name, homeAirport: "OSL", currency: "NOK" }) }),
      currentTime({ timeZone: "Europe/Oslo" }),
      // Untrusted, from the browser (App.tsx getContext).
      clientContext({ pick: ["locale", "screen"] }),
    ],
  })
}
