// @vitest-environment happy-dom
import { clientContext, createKit, defineAgent, jsonSchema, textOf, tool } from "@alexandernygard/ai-kit"
import { mockModel } from "@alexandernygard/ai-kit/testing"
import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { AIKitProvider, directTransport, MessageParts, settingsStore, useAssistant, useChat, useSessions, useSettings } from "../src/index"

const weather = tool({
  name: "get_weather",
  description: "Weather",
  input: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } } }),
  execute: ({ city }) => ({ city, tempC: 4 }),
})

function setup() {
  const model = mockModel([{ toolCalls: [{ name: "get_weather", input: { city: "Oslo" } }] }, { text: "It's **4°C**." }])
  const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [weather] })] })
  const transport = directTransport(kit)
  const wrapper = ({ children }: { children: React.ReactNode }) => <AIKitProvider transport={transport}>{children}</AIKitProvider>
  return { kit, transport, wrapper }
}

describe("react", () => {
  it("useChat sends and renders with MessageParts", async () => {
    const { wrapper } = setup()
    const { result } = renderHook(() => useChat(), { wrapper })
    expect(result.current.status).toBe("idle")
    await act(() => result.current.send("Weather in Oslo?"))
    expect(result.current.path).toHaveLength(2)
    expect(result.current.isRunning).toBe(false)

    const assistant = result.current.path[1]!
    render(
      <MessageParts
        message={assistant}
        render={{
          text: (p) => <p data-testid="text">{p.text}</p>,
          tool: { get_weather: (t) => <div data-testid="weather">{(t.output as { tempC: number }).tempC}°C in Oslo</div> },
        }}
      />,
    )
    expect(screen.getByTestId("weather").textContent).toBe("4°C in Oslo")
    expect(screen.getByTestId("text").textContent).toBe("It's **4°C**.")
  })

  it("useChat reads the latest getContext", async () => {
    const model = mockModel([{ text: "a" }, { text: "b" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, contextProviders: [clientContext()] })] })
    const wrapper = ({ children }: { children: React.ReactNode }) => <AIKitProvider transport={directTransport(kit)}>{children}</AIKitProvider>
    const { result, rerender } = renderHook(({ page }) => useChat({ getContext: () => ({ page }) }), { wrapper, initialProps: { page: "/one" } })
    await act(() => result.current.send("hi"))
    rerender({ page: "/two" })
    await act(() => result.current.send("again"))
    expect(JSON.stringify(model.requests[1]!.messages)).toContain("/two")
  })

  it("useSessions lists, renames and removes", async () => {
    const { wrapper, transport } = setup()
    await transport.createSession({ title: "First" })
    const { result } = renderHook(() => useSessions(), { wrapper })
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    await act(() => result.current.rename(result.current.sessions[0]!.id, "Renamed"))
    expect(result.current.sessions[0]!.title).toBe("Renamed")
    await act(() => result.current.remove(result.current.sessions[0]!.id))
    expect(result.current.sessions).toHaveLength(0)
  })

  it("switches sessions when sessionId changes", async () => {
    const { wrapper, transport } = setup()
    const a = await transport.createSession({ title: "A" })
    const { result, rerender } = renderHook(({ id }) => useChat({ sessionId: id }), { wrapper, initialProps: { id: undefined as string | undefined } })
    rerender({ id: a.id })
    await waitFor(() => expect(result.current.session?.title).toBe("A"))
    rerender({ id: undefined })
    await waitFor(() => expect(result.current.sessionId).toBeNull())
  })

  it("useAssistant keeps one conversation per document", async () => {
    const model = mockModel([{ text: "About doc A." }, { text: "About doc B." }])
    const transport = directTransport(createKit({ agents: [defineAgent({ name: "a", model })] }))
    const { result, rerender } = renderHook(({ documentId }) => useAssistant({ transport, documentId }), { initialProps: { documentId: "A" } })
    await waitFor(() => expect(result.current.status).toBe("idle"))
    await act(() => result.current.send("Tell me about A"))
    expect(result.current.path.map(textOf)).toEqual(["Tell me about A", "About doc A."])

    rerender({ documentId: "B" })
    await waitFor(() => expect(result.current.status).toBe("idle"))
    expect(result.current.path).toEqual([])
    await act(() => result.current.send("And B?"))
    expect(result.current.path.map(textOf)).toEqual(["And B?", "About doc B."])

    rerender({ documentId: "A" })
    await waitFor(() => expect(result.current.path.map(textOf)).toEqual(["Tell me about A", "About doc A."]))
    expect(result.current.documentId).toBe("A")
  })

  it("useSettings follows a settings store", () => {
    const store = settingsStore({ model: "claude-opus-5-5" }, { storage: { getItem: () => null, setItem: () => {} } })
    const { result } = renderHook(() => useSettings(store))
    act(() => result.current[1]({ model: "claude-sonnet-5-5" }))
    expect(result.current[0].model).toBe("claude-sonnet-5-5")
  })
})
