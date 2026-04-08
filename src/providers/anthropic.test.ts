import { ANTHROPIC_API_KEY } from "../config";
import { TOKENS_PER_SEC_observe } from "../metrics";
import { callAnthropic, streamAnthropic } from "./anthropic";
import { ChatMessage, OllamaResponse } from "../types";

jest.mock("../config", () => ({
  ANTHROPIC_API_KEY: "mocked_key",
}));

jest.mock("../metrics", () => ({
  TOKENS_PER_SEC_observe: jest.fn(),
}));

describe("callAnthropic", () => {
  it("should call the Anthropic API and return a response", async () => {
    const mockResponse = { content: [{ text: "Hello world" }] };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(mockResponse),
    });

    const model = "test_model";
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
    ];

    const response = await callAnthropic(model, messages);
    expect(response).toEqual({
      message: { content: "Hello world" },
      done: true,
      prompt_eval_count: 1,
      eval_count: 1,
    });
    expect(global.fetch).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "mocked_key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 8096, messages }),
      signal: expect.any(AbortSignal),
    });
    expect(TOKENS_PER_SEC_observe).toHaveBeenCalledWith(expect.any(Object), 1);
  });

  it("should return an error if the API key is not set", async () => {
    jest.mock("../config", () => ({
      ANTHROPIC_API_KEY: undefined,
    }));

    const model = "test_model";
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
    ];

    const response = await callAnthropic(model, messages);
    expect(response).toEqual({ error: "ANTHROPIC_API_KEY not set" });
  });

  it("should handle HTTP errors", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: jest.fn(),
    });

    const model = "test_model";
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
    ];

    const response = await callAnthropic(model, messages);
    expect(response).toEqual({ error: "Error calling Anthropic API" });
  });
});

describe("streamAnthropic", () => {
  it("should stream responses from the Anthropic API", async () => {
    const mockEvents = [
      { type: "message_delta", usage: { output_tokens: 1 } },
      { type: "content_block_delta", delta: { text: "Hello world" } },
      { type: "message_stop" },
    ];

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: jest.fn(() =>
            Promise.resolve({ done: false, value: `data: ${JSON.stringify(mockEvents[0])}\n\n` })
          ),
        }),
      },
    });

    const model = "test_model";
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
    ];

    for await (const chunk of streamAnthropic(model, messages)) {
      expect(chunk).toEqual(`data: ${JSON.stringify(mockEvents[1])}\n\n`);
    }
  });

  it("should handle errors during streaming", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      body: {
        getReader: () => ({
          read: jest.fn(() =>
            Promise.resolve({ done: false, value: `data: ${JSON.stringify(mockEvents[0])}\n\n` })
          ),
        }),
      },
    });

    const model = "test_model";
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
    ];

    for await (const chunk of streamAnthropic(model, messages)) {
      expect(chunk).toEqual(`data: ${JSON.stringify(mockEvents[1])}\n\n`);
      break;
    }
  });
});
